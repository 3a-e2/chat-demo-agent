/** Agent 工具层的公共类型：与 UI、协议层解耦，mock 与真机执行共用同一套签名。 */

export type ShellRequest = {
  command: string
  /** 执行目录，缺省由执行端决定 */
  cwd?: string
  /** 执行端超时（毫秒），缺省 30 秒 */
  timeoutMs?: number
}

export type ShellResult = {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  /** 实际执行目录，供 UI 展示；mock 也会回填 */
  cwd: string
  /** true 表示由前端 mock 产出，不是真实执行，UI 应明确提示 */
  mock: boolean
}

export type ShellExecutorOptions = {
  signal?: AbortSignal
}

/** 可替换的执行器：默认走 Capacitor 原生桥，没有桥时退化为 mock */
export type ShellExecutor = (
  request: ShellRequest,
  options?: ShellExecutorOptions
) => Promise<ShellResult>

/** 模型发起的一次工具调用；input 已由流式分片拼成对象 */
export type AgentToolCall = {
  id: string
  name: string
  input: unknown
}

/** 工具执行结果，content 会原样写回 tool_result 块 */
export type AgentToolOutcome = {
  content: string
  isError: boolean
  durationMs: number
}

export type ToolRunner = (
  call: AgentToolCall,
  options: { signal: AbortSignal }
) => Promise<AgentToolOutcome>
