import type { ShellExecutor, ShellRequest, ShellResult, ShellExecutorOptions } from './types.js'

/**
 * executeShell：Agent 唯一的执行入口。
 * 有原生桥（Capacitor 插件 ShellExecutor）就走真机，没有就跑前端 mock。
 * 与 UI 无关，纯 TS，可在浏览器、WebView 与单测里直接调用。
 */

const DEFAULT_CWD = '/root/111/chat-demo'
const DEFAULT_TIMEOUT = 30_000
const MAX_OUTPUT = 12_000

/** 原生侧约定：插件名 ShellExecutor，方法 execute(options) => { exitCode, stdout, stderr } */
type NativeShellPlugin = {
  execute?: (options: ShellRequest) => Promise<Partial<ShellResult>>
}

const nativePlugin = (): NativeShellPlugin | null => {
  const capacitor = (
    globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } }
  ).Capacitor
  const plugin = capacitor?.Plugins?.ShellExecutor
  if (!plugin || typeof plugin !== 'object') {
    return null
  }
  return typeof (plugin as NativeShellPlugin).execute === 'function'
    ? (plugin as NativeShellPlugin)
    : null
}

const abortError = () => {
  const error = new Error('工具调用已中止')
  error.name = 'AbortError'
  return error
}

const clip = (text: string) =>
  text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…（输出已截断）` : text

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

// ---------- mock 侧状态：故意做成模块级，模拟 cd 这类跨命令副作用 ----------

let mockCwd = DEFAULT_CWD

const MOCK_FILES: Record<string, string> = {
  [`${DEFAULT_CWD}/capacitor.config.ts`]: [
    "import type { CapacitorConfig } from '@capacitor/cli'",
    '',
    'const config: CapacitorConfig = {',
    "  appId: 'com.deepseek.web',",
    "  appName: 'DeepSeek ce',",
    "  webDir: 'dist'",
    '}',
  ].join('\n'),
  [`${DEFAULT_CWD}/package.json`]: ['{', '  "name": "deepseek-web",', '  "private": true', '}'].join(
    '\n'
  ),
  [`${DEFAULT_CWD}/README.md`]: '# DeepSeek ce\n\nCapacitor + React 的网页壳。\n',
  '/tmp/agent-demo.txt': 'shell mock is alive\n',
}

const MOCK_DIRS = [DEFAULT_CWD, `${DEFAULT_CWD}/src`, `${DEFAULT_CWD}/android`, '/tmp']

/** 故意拦截，用来验证 is_error 与前端提示链路 */
const DANGEROUS = /(^|\s)(rm\s+-rf\s+\/|mkfs|dd\s+if=|\/dev\/sd)/

/** 极简分词：支持单双引号，够 mock 用，不追求 shell 兼容性 */
const tokenize = (command: string): string[] => {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasToken = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += char
    hasToken = true
  }
  if (hasToken) {
    tokens.push(current)
  }
  return tokens
}

const resolvePath = (path: string) =>
  path.startsWith('/') ? path.replace(/\/+$/, '') || '/' : `${mockCwd}/${path}`.replace(/\/+/g, '/')

const ok = (stdout: string, exitCode = 0): { stdout: string; stderr: string; exitCode: number } => ({
  stdout,
  stderr: '',
  exitCode,
})

const fail = (
  stderr: string,
  exitCode = 1
): { stdout: string; stderr: string; exitCode: number } => ({ stdout: '', stderr, exitCode })

/** mock 命令表：覆盖 Agent 演示与自测需要的几条，其余按 127 处理 */
const runMockCommand = (command: string) => {
  const tokens = tokenize(command.trim())
  if (tokens.length === 0) {
    return ok('')
  }
  if (DANGEROUS.test(command)) {
    return fail('mock: 该命令被判为危险操作，已拒绝执行（真机侧同样需要拦截）', 126)
  }
  const [name, ...args] = tokens
  switch (name) {
    case 'pwd':
      return ok(mockCwd)
    case 'cd': {
      const target = resolvePath(args[0] ?? DEFAULT_CWD)
      if (!MOCK_DIRS.includes(target)) {
        return fail(`cd: no such file or directory: ${args[0] ?? ''}`)
      }
      mockCwd = target
      return ok('')
    }
    case 'ls':
    case 'ls -l': {
      const dir = args.find((arg) => !arg.startsWith('-')) ?? mockCwd
      const target = resolvePath(dir)
      const entries = [
        ...MOCK_DIRS.filter((item) => item !== target && item.startsWith(`${target}/`)).map(
          (item) => `${item.slice(target.length + 1).split('/')[0]}/`
        ),
        ...Object.keys(MOCK_FILES)
          .filter((file) => file.startsWith(`${target}/`))
          .map((file) => file.slice(target.length + 1)),
      ]
      const unique = [...new Set(entries)].sort()
      return unique.length ? ok(unique.join('\n')) : ok('')
    }
    case 'cat': {
      const contents = args.map((arg) => {
        const file = MOCK_FILES[resolvePath(arg)]
        return file ?? `cat: ${arg}: No such file or directory`
      })
      return contents.some((text) => text.startsWith('cat: '))
        ? fail(contents.join('\n'))
        : ok(contents.join('\n'))
    }
    case 'echo':
      return ok(args.join(' '))
    case 'whoami':
      return ok('deepseek-agent')
    case 'date':
      return ok(new Date().toISOString())
    case 'uname':
      return ok('Linux localhost 6.6.0 aarch64 GNU/Linux')
    case 'python':
    case 'python3': {
      const code = args[0] === '-c' ? (args[1] ?? '') : args.join(' ')
      const printed = [...code.matchAll(/print\((['"]?)(.*?)\1\)/g)].map((match) => match[2])
      if (!code) {
        return fail('mock: 只支持 python -c "print(...)"')
      }
      return ok(printed.join('\n'))
    }
    case 'gradlew':
    case './gradlew':
      return ok(
        [
          '> Task :app:preBuild UP-TO-DATE',
          '> Task :app:assembleDebug',
          '',
          'BUILD SUCCESSFUL in 42s',
          '（mock 输出，未真正执行）',
        ].join('\n')
      )
    default:
      return fail(`sh: 1: ${name}: not found`, 127)
  }
}

const mockShell = async (
  request: ShellRequest,
  options?: ShellExecutorOptions
): Promise<ShellResult> => {
  const startedAt = performance.now()
  const latency = 90 + Math.floor(Math.random() * 180)
  await delay(Math.min(latency, request.timeoutMs ?? DEFAULT_TIMEOUT), options?.signal)
  const { stdout, stderr, exitCode } = runMockCommand(request.command)
  return {
    exitCode,
    stdout: clip(stdout),
    stderr: clip(stderr),
    durationMs: Math.round(performance.now() - startedAt),
    cwd: request.cwd ?? mockCwd,
    mock: true,
  }
}

const nativeShell = async (
  plugin: NativeShellPlugin,
  request: ShellRequest,
  options?: ShellExecutorOptions
): Promise<ShellResult> => {
  const startedAt = performance.now()
  if (options?.signal?.aborted) {
    throw abortError()
  }
  const result = await plugin.execute!(request)
  return {
    exitCode: result.exitCode ?? 0,
    stdout: clip(result.stdout ?? ''),
    stderr: clip(result.stderr ?? ''),
    durationMs: result.durationMs ?? Math.round(performance.now() - startedAt),
    cwd: result.cwd ?? request.cwd ?? DEFAULT_CWD,
    mock: false,
  }
}

/** 默认策略：有原生桥用原生，否则 mock；测试或预览可整体替换 */
export const executeShell: ShellExecutor = async (request, options) => {
  const plugin = nativePlugin()
  return plugin ? nativeShell(plugin, request, options) : mockShell(request, options)
}

/** 纯 mock 版本，演示界面想要确定性的假数据时直接用 */
export const executeShellMock: ShellExecutor = mockShell

/** 当前是否具备真机执行能力，UI 可据此展示「模拟执行」标记 */
export const hasNativeShell = () => nativePlugin() !== null

/** 重置 mock 的 cwd，避免单测之间相互影响 */
export const resetShellMock = () => {
  mockCwd = DEFAULT_CWD
}
