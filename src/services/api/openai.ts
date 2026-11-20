import { ApiError } from './client.js'
import { readServerSentEvents } from './sse.js'
import { loadFile } from '../chat/db.js'
import type {
  CreateMessageRequest,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
} from './types.js'

/**
 * 第三方 OpenAI 兼容接口（POST {baseUrl}/chat/completions, stream: true）。
 * 只依赖最通用的字段：messages / stream / choices[].delta，思考内容读 reasoning_content。
 * 与 DeepSeek 通道的事件协议保持一致，上层的 applyEvent 无需区分来源。
 */

type OpenAITextPart = { type: 'text'; text: string }
type OpenAIImagePart = { type: 'image_url'; image_url: { url: string } }
type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | (OpenAITextPart | OpenAIImagePart)[] }
  | { role: 'assistant'; content: string }

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })

const imageToPart = async (fileId: string, signal: AbortSignal): Promise<OpenAIImagePart | null> => {
  if (signal.aborted) {
    return null
  }
  const blob = await loadFile(fileId)
  if (!blob) {
    return null
  }
  return { type: 'image_url', image_url: { url: await blobToDataUrl(blob) } }
}

/**
 * Anthropic 风格的消息转 OpenAI：
 * - latest_reminder 作为一条 system 消息留在原位；
 * - 图片按本地原件内联为 data URL（第三方没有 Files API），文档附件跳过；
 * - assistant 只回传正文，思考与工具块不回传。
 */
const toOpenAIMessages = async (
  system: string,
  messages: CreateMessageRequest['messages'],
  signal: AbortSignal
): Promise<OpenAIMessage[]> => {
  const result: OpenAIMessage[] = [{ role: 'system', content: system }]
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      result.push({ role: 'system', content: message.content })
      continue
    }
    if (message.role === 'assistant') {
      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
      if (text.trim()) {
        result.push({ role: 'assistant', content: text })
      }
      continue
    }
    if (typeof message.content === 'string') {
      result.push({ role: 'user', content: message.content })
      continue
    }
    const parts: (OpenAITextPart | OpenAIImagePart)[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image' && block.source.type === 'file') {
        const part = await imageToPart(block.source.file_id, signal)
        if (part) {
          parts.push(part)
        }
      }
    }
    if (parts.length === 1 && parts[0].type === 'text') {
      result.push({ role: 'user', content: parts[0].text })
    } else if (parts.length > 0) {
      result.push({ role: 'user', content: parts })
    }
  }
  return result
}

const toStopReason = (reason: unknown): StopReason => {
  if (reason === 'length') {
    return 'max_tokens'
  }
  if (reason === 'tool_calls' || reason === 'function_call') {
    return 'tool_use'
  }
  if (reason === 'content_filter') {
    return 'refusal'
  }
  return 'end_turn'
}

const toUsage = (raw: unknown): MessageUsage | undefined => {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const usage = raw as {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  return {
    input_tokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: usage.completion_tokens ?? 0,
  }
}

const readError = async (response: Response): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || response.statusText
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } }
    if (typeof body.error?.message === 'string') {
      message = body.error.message
    }
  } catch {
    // 非 JSON 错误体直接用原文
  }
  return new ApiError('http', message, response.status)
}

/** 思考块与正文块各占一个 index，按首次出现顺序创建 */
const THINKING_INDEX = 0
const TEXT_INDEX = 1

export async function* streamCustomMessage(
  endpoint: { baseUrl: string; apiKey: string; model: string },
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const messages = await toOpenAIMessages(body.system, body.messages, signal)
  let response: Response
  try {
    response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify({ model: endpoint.model, messages, stream: true }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readError(response)
  }
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('event-stream')) {
    throw new ApiError('protocol', '')
  }

  const id = `custom-${Date.now()}`
  yield { type: 'message_start', message: { id, model: endpoint.model } }

  let thinkingOpen = false
  let textOpen = false
  let finishReason: unknown
  let usage: MessageUsage | undefined
  let rawUsage: unknown

  for await (const { data } of readServerSentEvents(response.body, signal)) {
    if (data === '[DONE]') {
      break
    }
    let payload: {
      error?: { message?: unknown }
      usage?: unknown
      choices?: {
        delta?: { content?: string | null; reasoning_content?: string | null }
        finish_reason?: unknown
      }[]
    }
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    if (payload.error) {
      throw new ApiError(
        'stream',
        typeof payload.error.message === 'string' ? payload.error.message : data
      )
    }
    if (payload.usage) {
      rawUsage = payload.usage
    }
    const choice = payload.choices?.[0]
    if (!choice) {
      continue
    }
    const reasoning = choice.delta?.reasoning_content
    if (reasoning) {
      if (!thinkingOpen) {
        thinkingOpen = true
        yield {
          type: 'content_block_start',
          index: THINKING_INDEX,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: THINKING_INDEX,
        delta: { type: 'thinking_delta', thinking: reasoning },
      }
    }
    const text = choice.delta?.content
    if (text) {
      if (!textOpen) {
        textOpen = true
        yield {
          type: 'content_block_start',
          index: TEXT_INDEX,
          content_block: { type: 'text', text: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: TEXT_INDEX,
        delta: { type: 'text_delta', text },
      }
    }
    if (choice.finish_reason) {
      finishReason = choice.finish_reason
    }
  }

  if (!finishReason && !thinkingOpen && !textOpen) {
    throw new ApiError('interrupted', '')
  }
  if (thinkingOpen) {
    yield { type: 'content_block_stop', index: THINKING_INDEX }
  }
  if (textOpen) {
    yield { type: 'content_block_stop', index: TEXT_INDEX }
  }
  usage = toUsage(rawUsage)
  yield {
    type: 'message_delta',
    delta: { stop_reason: toStopReason(finishReason), stop_sequence: null },
    usage,
  }
  yield { type: 'message_stop' }
}
