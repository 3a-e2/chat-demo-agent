import { useCallback, useRef, useState } from 'react'
import { runAgent } from '../../services/agent/loop.js'
import { runTool } from '../../services/agent/tools.js'
import type { AgentToolOutcome } from '../../services/agent/types.js'
import type { MessageParam } from '../../services/api/types.js'

/**
 * 把 runAgent 的事件流摊成可直接渲染的条目列表。
 * 只服务于演示面板；聊天页接入时复用同一套 AgentItem 结构即可。
 */

export type AgentItem =
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'text'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      toolUseId: string
      name: string
      command: string | null
      state: 'running' | 'done'
      outcome?: AgentToolOutcome
    }
  | { kind: 'note'; id: string; text: string; error?: boolean }

let sequence = 0
const nextId = () => {
  sequence += 1
  return `item-${sequence}`
}

const readCommand = (input: unknown): string | null => {
  if (typeof input !== 'object' || input === null) {
    return null
  }
  const { command } = input as { command?: unknown }
  return typeof command === 'string' ? command : null
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'

export const useAgentRun = (system: string) => {
  const [items, setItems] = useState<AgentItem[]>([])
  const [running, setRunning] = useState(false)
  const [turns, setTurns] = useState(0)
  const controller = useRef<AbortController | null>(null)
  const messages = useRef<MessageParam[]>([])

  const pushText = useCallback((kind: 'text' | 'thinking', text: string) => {
    setItems((previous) => {
      const last = previous.at(-1)
      // 连续增量并进同一条，避免每个 delta 生成一行
      if (last?.kind === kind) {
        return [...previous.slice(0, -1), { ...last, text: last.text + text }]
      }
      return [...previous, { kind, id: nextId(), text }]
    })
  }, [])

  const patchTool = useCallback((toolUseId: string, outcome: AgentToolOutcome) => {
    setItems((previous) =>
      previous.map((item) =>
        item.kind === 'tool' && item.toolUseId === toolUseId
          ? { ...item, state: 'done', outcome }
          : item
      )
    )
  }, [])

  const stop = useCallback(() => controller.current?.abort(), [])

  const run = useCallback(
    async (prompt: string, apiKey: string) => {
      if (controller.current) {
        return
      }
      const abort = new AbortController()
      controller.current = abort
      setItems([])
      setTurns(0)
      setRunning(true)
      try {
        const result = await runAgent({
          apiKey,
          system,
          messages: [...messages.current, { role: 'user', content: prompt }],
          signal: abort.signal,
          onEvent: (event) => {
            switch (event.type) {
              case 'turn_start':
                setTurns(event.turn)
                break
              case 'thinking':
                pushText('thinking', event.text)
                break
              case 'text':
                pushText('text', event.text)
                break
              case 'tool_call':
                setItems((previous) => [
                  ...previous,
                  {
                    kind: 'tool',
                    id: nextId(),
                    toolUseId: event.call.id,
                    name: event.call.name,
                    command: readCommand(event.call.input),
                    state: 'running',
                  },
                ])
                break
              case 'tool_result':
                patchTool(event.call.id, event.outcome)
                break
              case 'turn_error':
                setItems((previous) => [
                  ...previous,
                  { kind: 'note', id: nextId(), text: event.message, error: true },
                ])
                break
              case 'done':
                messages.current = result.messages
                break
              default:
                break
            }
          },
        })
        messages.current = result.messages
      } catch (error) {
        if (!isAbort(error)) {
          setItems((previous) => [
            ...previous,
            { kind: 'note', id: nextId(), text: errorText(error), error: true },
          ])
        }
      } finally {
        controller.current = null
        setRunning(false)
      }
    },
    [patchTool, pushText, system]
  )

  /** 不经过模型直接跑一条命令，用于没有 API Key 时验证执行链路 */
  const runLocal = useCallback(
    async (command: string) => {
      const toolUseId = nextId()
      setItems((previous) => [
        ...previous,
        {
          kind: 'tool',
          id: nextId(),
          toolUseId,
          name: 'execute_shell',
          command,
          state: 'running',
        },
      ])
      const outcome = await runTool(
        { id: toolUseId, name: 'execute_shell', input: { command } },
        { signal: new AbortController().signal }
      )
      patchTool(toolUseId, outcome)
    },
    [patchTool]
  )

  const reset = useCallback(() => {
    messages.current = []
    setItems([])
    setTurns(0)
  }, [])

  return { items, running, turns, run, runLocal, stop, reset }
}
