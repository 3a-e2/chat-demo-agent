import clsx from 'clsx'
import { useMemo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { AgentToolOutcome } from '../../services/agent/types.js'
import styles from './ToolCallCard.module.css'

/** 工具回填文本里拆出退出码、stdout、stderr；格式由 services/agent/tools.ts 保证 */
const splitOutcome = (content: string) => {
  const exitCode = /^exitCode:\s*(-?\d+)/m.exec(content)?.[1]
  const cwd = /^cwd:\s*(.+)$/m.exec(content)?.[1]
  const mock = /^exitCode:.*模拟执行/m.test(content)
  const [stdout = '', stderr = ''] = (content.split('--- stdout ---\n')[1] ?? '').split(
    '\n--- stderr ---\n'
  )
  return { exitCode, cwd, mock, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() }
}

const MAX_LINES = 12

/**
 * 单次工具调用：命令行 + 状态 + 输出。
 * 输出超过 12 行时折叠，避免一条命令把对话顶走。
 */
export const ToolCallCard = ({
  name,
  command,
  state,
  outcome,
}: {
  name: string
  /** 入参里的 command，尚未解析出时为 null */
  command: string | null
  state: 'running' | 'done'
  outcome?: AgentToolOutcome
}) => {
  const t = useTranslate()
  const parsed = useMemo(() => splitOutcome(outcome?.content ?? ''), [outcome?.content])
  const exitOk = parsed.exitCode === undefined || parsed.exitCode === '0'
  const failed = state === 'done' && (outcome?.isError || !exitOk)
  const lines = useMemo(
    () => [...parsed.stdout.split('\n'), ...(parsed.stderr ? parsed.stderr.split('\n') : [])],
    [parsed.stdout, parsed.stderr]
  )
  const shown = lines.slice(0, MAX_LINES).join('\n')

  const status =
    state === 'running'
      ? t('agentToolRunning')
      : failed
        ? (parsed.exitCode ? `exit ${parsed.exitCode}` : t('agentToolFailed'))
        : `${t('agentToolDone')} · ${outcome?.durationMs ?? 0}ms`

  return (
    <section className={clsx(styles.card, failed && styles.failed)}>
      <header className={styles.head}>
        <span className={styles.tool}>{name}</span>
        <code className={styles.command}>{command === null ? '…' : `$ ${command}`}</code>
        <span className={styles.meta}>{status}</span>
      </header>
      {parsed.mock ? <p className={styles.note}>{t('agentToolMock')}</p> : null}
      {shown ? <pre className={styles.output}>{shown}</pre> : null}
      {lines.length > MAX_LINES ? (
        <p className={styles.truncated}>{t('agentToolMoreLines', { count: lines.length - MAX_LINES })}</p>
      ) : null}
    </section>
  )
}
