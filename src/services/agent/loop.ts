import { streamMessage } from '../api/client.js'
import type {
  AssistantBlockParam,
  ChatModel,
  CreateMessageRequest,
  CustomToolDef,
  MessageParam,
  StopReason,
  ThinkingBlock,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '../api/types.js'
import { AGENT_TOOLS, runTool } from './tools.js'
import type { AgentToolCall, AgentToolOutcome, ToolRunner } from './types.js'

/**
 * Agent 流式循环：把「模型 → 工具 → 模型」的多轮往返收敛成一个异步函数。
 *
 * 一轮的流程：
 *   1. 发 messages（含历史 tool_use / tool_result）
 *   2. 消费 SSE，按 content_block 索引累积正文、思考与 tool_use 的 input_json_delta 分片
 *   3. stop_reason === 'tool_use' 时执行工具，把 assistant 块与 tool_result 追加进 messages
 *   4. 继续下一轮，直到模型不再调用工具、被中止或触及 maxTurns
 *
 * 只负责编排，不碰 UI 和存储；所有中间态通过 onEvent 抛给调用方。
 */

const DEFAULT_MAX_TURNS = 8
const SAFETY_CHECK: CreateMessageRequest['safety_check'] = { level: 'high' }

export type AgentStreamEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: AgentToolCall }
  | { type: 'tool_result'; call: AgentToolCall; outcome: AgentToolOutcome }
  | { type: 'turn_end'; turn: number; stopReason: StopReason }
  | { type: 'turn_error'; turn: number; call: AgentToolCall; message: string }
  | { type: 'done'; turns: number; stopReason: StopReason | 'max_turns'; messages: MessageParam[] }

export type AgentOptions = {
  apiKey: string
  system: string
  /** 初始上下文，函数内只追加不修改入参 */
  messages: MessageParam[]
  signal: AbortSignal
  model?: ChatModel
  /** 是否开启思考；开启时思考块会带签名回传，保证工具往返连续 */
  thinking?: boolean
  /** 思考预算（仅 thinking 为 true 时生效），缺省交给服务端 */
  thinkingBudget?: number | null
  /** 客户端工具，缺省用内置注册表 */
  clientTools?: CustomToolDef[]
  /** 服务端工具（联网搜索等），与客户端工具共存声明 */
  serverTools?: CreateMessageRequest['tools']
  maxTurns?: number
  onEvent?: (event: AgentStreamEvent) => void
  executeTool?: ToolRunner
}

export type AgentRunResult = {
  stopReason: StopReason | 'max_turns'
  turns: number
  /** 完整上下文，含所有 tool_use / tool_result，可直接落库或继续追加提问 */
  messages: MessageParam[]
}

/** 单个内容块的累积状态，pending 表示还在流式接收 */
type Accumulator =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; json: string; parseError: boolean }

const abortError = () => {
  const error = new Error('Agent 已中止')
  error.name = 'AbortError'
  return error
}

/** 分片 JSON 收齐后再解析；解析失败不让整轮崩，交给工具层回填错误 */
const parseToolInput = (accumulator: Extract<Accumulator, { type: 'tool_use' }>) => {
  const raw = accumulator.json.trim()
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    accumulator.parseError = true
    return {}
  }
}

const toAssistantBlocks = (
  blocks: (Accumulator | undefined)[]
): AssistantBlockParam[] =>
  blocks.flatMap((block): AssistantBlockParam[] => {
    if (!block) {
      return []
    }
    if (block.type === 'text') {
      return block.text ? [{ type: 'text', text: block.text }] : []
    }
    if (block.type === 'thinking') {
      const thinking: ThinkingBlock = {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      }
      return block.thinking ? [thinking] : []
    }
    const toolUse: ToolUseBlockParam = {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: parseToolInput(block),
    }
    return [toolUse]
  })

/** 只收集本轮真正要执行的调用，顺带把解析失败的入参标出来 */
const collectCalls = (blocks: (Accumulator | undefined)[]): AgentToolCall[] =>
  blocks.flatMap((block) =>
    block?.type === 'tool_use'
      ? [{ id: block.id, name: block.name, input: parseToolInput(block) }]
      : []
  )

/**
 * 跑完一次完整的 Agent 任务。中止时抛出 name 为 AbortError 的错误，
 * 其余异常（网络、协议、工具层以外的问题）原样抛出，由调用方决定如何展示。
 */
export const runAgent = async (options: AgentOptions): Promise<AgentRunResult> => {
  const {
    apiKey,
    system,
    signal,
    model = 'deepseek-flash',
    thinking = true,
    thinkingBudget = null,
    clientTools = AGENT_TOOLS,
    serverTools = [],
    maxTurns = DEFAULT_MAX_TURNS,
    onEvent,
    executeTool = runTool,
  } = options
  const messages: MessageParam[] = [...options.messages]
  const emit = (event: AgentStreamEvent) => onEvent?.(event)

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal.aborted) {
      throw abortError()
    }
    emit({ type: 'turn_start', turn })
    const body: CreateMessageRequest = {
      model,
      system,
      messages,
      thinking: {
        type: thinking ? 'enabled' : 'disabled',
        ...(thinking && thinkingBudget ? { budget_tokens: thinkingBudget } : {}),
      },
      tools: [...serverTools, ...clientTools],
      safety_check: SAFETY_CHECK,
    }

    const blocks: (Accumulator | undefined)[] = []
    let stopReason: StopReason = 'end_turn'

    for await (const event of streamMessage(apiKey, body, signal)) {
      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block
          if (block.type === 'text') {
            blocks[event.index] = { type: 'text', text: block.text }
            if (block.text) {
              emit({ type: 'text', text: block.text })
            }
          } else if (block.type === 'thinking') {
            blocks[event.index] = {
              type: 'thinking',
              thinking: block.thinking,
              signature: block.signature ?? '',
            }
            if (block.thinking) {
              emit({ type: 'thinking', text: block.thinking })
            }
          } else if (block.type === 'tool_use') {
            // input 此时基本是 {}，真正的入参从 delta 里一片片拼
            blocks[event.index] = {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              json: '',
              parseError: false,
            }
          }
          // 服务端工具块（搜索、读链接）不在本循环消费，直接跳过
          break
        }
        case 'content_block_delta': {
          const block = blocks[event.index]
          const delta = event.delta
          if (!block) {
            break
          }
          if (block.type === 'text' && delta.type === 'text_delta') {
            block.text += delta.text
            emit({ type: 'text', text: delta.text })
          } else if (block.type === 'thinking' && delta.type === 'thinking_delta') {
            block.thinking += delta.thinking
            emit({ type: 'thinking', text: delta.thinking })
          } else if (block.type === 'thinking' && delta.type === 'signature_delta') {
            block.signature += delta.signature
          } else if (block.type === 'tool_use' && delta.type === 'input_json_delta') {
            block.json += delta.partial_json
          }
          break
        }
        case 'message_delta':
          stopReason = event.delta.stop_reason
          break
        default:
          break
      }
    }

    emit({ type: 'turn_end', turn, stopReason })

    const calls = collectCalls(blocks)
    const assistantBlocks = toAssistantBlocks(blocks)

    // 没有工具调用：对话结束
    if (stopReason !== 'tool_use' || calls.length === 0) {
      if (assistantBlocks.length) {
        messages.push({ role: 'assistant', content: assistantBlocks })
      }
      emit({ type: 'done', turns: turn, stopReason, messages })
      return { stopReason, turns: turn, messages }
    }

    if (assistantBlocks.length) {
      messages.push({ role: 'assistant', content: assistantBlocks })
    }
    for (const call of calls) {
      emit({ type: 'tool_call', call })
    }

    const results: ToolResultBlockParam[] = []
    for (const call of calls) {
      if (signal.aborted) {
        throw abortError()
      }
      let outcome: AgentToolOutcome
      try {
        outcome = await executeTool(call, { signal })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof Error && error.name === 'AbortError') {
          throw abortError()
        }
        outcome = { content: `工具执行失败：${message}`, isError: true, durationMs: 0 }
        emit({ type: 'turn_error', turn, call, message })
      }
      emit({ type: 'tool_result', call, outcome })
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      })
    }

    // 工具结果必须紧随本轮 assistant，成对回传后继续下一轮
    messages.push({ role: 'user', content: results })
  }

  emit({ type: 'done', turns: maxTurns, stopReason: 'max_turns', messages })
  return { stopReason: 'max_turns', turns: maxTurns, messages }
}
