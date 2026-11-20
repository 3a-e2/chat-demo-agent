import type { CustomToolDef } from '../api/types.js'
import { executeShell } from './shell.js'
import type { AgentToolOutcome, AgentToolCall, ToolRunner } from './types.js'

/**
 * Agent 的工具注册表。
 * 新增工具时：在这里加 CustomToolDef + runTool 的分支即可，循环层不需要改动。
 */

export const EXECUTE_SHELL_TOOL: CustomToolDef = {
  name: 'execute_shell',
  description: [
    '在本机执行一条 shell 命令并返回输出。',
    '适合查看文件、运行构建、跑脚本；命令必须有明确目的，禁止执行删除根目录、格式化磁盘等破坏性操作。',
    '输出过长会被截断，请用 head/tail/grep 收窄范围。',
  ].join(''),
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的完整命令，例如 ls -la 或 python3 -c "print(1)"' },
      cwd: { type: 'string', description: '执行目录，缺省为工程根目录' },
      timeout_ms: { type: 'number', description: '超时毫秒数，缺省 30000，上限 120000' },
    },
    required: ['command'],
  },
}

export const AGENT_TOOLS: CustomToolDef[] = [EXECUTE_SHELL_TOOL]

const MAX_COMMAND_LENGTH = 2_000
const MAX_TIMEOUT = 120_000
const DEFAULT_TIMEOUT = 30_000

type ShellInput = { command: string; cwd?: string; timeoutMs?: number }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 入参来自模型生成的 JSON，一律当不可信数据处理 */
const readShellInput = (input: unknown): ShellInput => {
  if (!isRecord(input)) {
    throw new Error('入参必须是对象')
  }
  const { command, cwd, timeout_ms: timeout } = input
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('缺少 command')
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`command 超过 ${MAX_COMMAND_LENGTH} 字符`)
  }
  return {
    command: command.trim(),
    cwd: typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined,
    timeoutMs:
      typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
        ? Math.min(Math.round(timeout), MAX_TIMEOUT)
        : DEFAULT_TIMEOUT,
  }
}

/** 回填给模型的文本：先给元信息，再给输出，方便模型判断该看哪一段 */
const formatOutcome = (result: Awaited<ReturnType<typeof executeShell>>) =>
  [
    `exitCode: ${result.exitCode}${result.mock ? '（模拟执行，非真机结果）' : ''}`,
    `cwd: ${result.cwd}`,
    `durationMs: ${result.durationMs}`,
    '--- stdout ---',
    result.stdout || '(empty)',
    ...(result.stderr ? ['--- stderr ---', result.stderr] : []),
  ].join('\n')

const runExecuteShell = async (
  call: AgentToolCall,
  signal: AbortSignal
): Promise<AgentToolOutcome> => {
  const startedAt = performance.now()
  let input: ShellInput
  try {
    input = readShellInput(call.input)
  } catch (error) {
    return {
      content: `工具入参有误：${error instanceof Error ? error.message : String(error)}`,
      isError: true,
      durationMs: Math.round(performance.now() - startedAt),
    }
  }
  if (signal.aborted) {
    return { content: '工具调用已中止', isError: true, durationMs: 0 }
  }
  try {
    const result = await executeShell(input, { signal })
    return {
      content: formatOutcome(result),
      // 非零退出码交给模型自行决策，不当成调用失败
      isError: false,
      durationMs: result.durationMs,
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { content: '工具调用已中止', isError: true, durationMs: 0 }
    }
    return {
      content: `执行异常：${error instanceof Error ? error.message : String(error)}`,
      isError: true,
      durationMs: Math.round(performance.now() - startedAt),
    }
  }
}

/** 默认工具执行器：只认注册表里的工具，未注册的一律报错回填 */
export const runTool: ToolRunner = async (call, { signal }) => {
  switch (call.name) {
    case EXECUTE_SHELL_TOOL.name:
      return runExecuteShell(call, signal)
    default:
      return { content: `未知工具：${call.name}`, isError: true, durationMs: 0 }
  }
}
