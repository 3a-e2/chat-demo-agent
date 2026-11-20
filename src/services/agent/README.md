# Agent 工具层（tool_calls 流式循环）

纯前端 TS，不依赖 UI 与存储。当前**尚未接入聊天界面**，只提供可调用的框架。

## 文件

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 执行器、工具调用、执行结果等公共类型 |
| `shell.ts` | `executeShell`：有原生桥走真机，否则跑 mock；含危险命令拦截与输出截断 |
| `tools.ts` | 工具注册表（`execute_shell`）、入参校验、结果格式化 |
| `loop.ts` | `runAgent`：多轮「模型 → 工具 → 模型」流式循环 |

## 用法

```ts
import { runAgent } from '../../services/agent/loop.js'

const abort = new AbortController()
const { messages, stopReason } = await runAgent({
  apiKey,
  system: '你是一个能执行本机命令的助手。',
  messages: [{ role: 'user', content: '看看当前目录有什么，再用 python 打印 Hello Agent' }],
  signal: abort.signal,
  onEvent: (event) => {
    if (event.type === 'text') appendText(event.text)
    if (event.type === 'tool_call') showToolCard(event.call)
    if (event.type === 'tool_result') updateToolCard(event.call.id, event.outcome)
  },
})
```

事件顺序：`turn_start` → (`thinking` / `text`) → (`tool_call` → `tool_result`)\* → `turn_end` → … → `done`。

`messages` 是完整上下文，含 assistant 的 `tool_use` 与 user 的 `tool_result`，可直接落库；下次追问时把它拼在新提问前面即可。

## 循环规则

- 只认 `stop_reason === 'tool_use'` 且本轮确实收到 `tool_use` 块时继续，否则结束。
- `tool_use.input` 由 `input_json_delta` 分片拼成，`content_block_stop` 后才 `JSON.parse`；解析失败按空对象执行并回填错误。
- 开启思考时，思考块连同 `signature` 一起回传，保证工具往返连续。
- `maxTurns` 缺省 8，达到上限返回 `stopReason: 'max_turns'`。
- 中止（`signal.aborted`）抛 `name === 'AbortError'` 的错误，不写回 tool_result。
- 多个工具调用并行下发时串行执行，全部结果塞进**同一条** user 消息的多个 `tool_result` 块。

## mock 与真机

`executeShell` 自动探测 `globalThis.Capacitor.Plugins.ShellExecutor.execute(request)`：

```
request  = { command, cwd?, timeoutMs? }
response = { exitCode, stdout, stderr, durationMs?, cwd? }
```

没有原生桥时走 mock：`pwd` / `ls` / `cat` / `echo` / `whoami` / `date` / `uname` / `python3 -c "print(...)"` / `./gradlew`，其余返回 127；`rm -rf /`、`mkfs`、`dd` 之类返回 126 并标记拒绝。结果里的 `mock: true` 会透传到 `tool_result`，提示模型这是模拟结果。

真机侧要求：

1. 只能在用户显式开启「允许执行命令」后注册插件；
2. 原生侧必须再做一次危险命令拦截与超时强杀，不能只信前端校验；
3. 输出按 12000 字符截断，避免撑爆上下文。

## 已知边界

- 未处理服务端工具块（`server_tool_use` / `web_search_tool_result`），需要联网搜索时把它们留在原有 `reply` 流程里，两条链路暂不合并。
- `input_json_delta` 之外，暂不支持工具入参走完整 `input` 下发的情形（有些实现会在 `content_block_start` 直接给全量）。
- 中断后已执行的命令不会回滚，真机侧请自行提示用户。
