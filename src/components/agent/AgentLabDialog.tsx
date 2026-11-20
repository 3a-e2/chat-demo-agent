import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeAgentLab, useAgentLab } from './agentLabState.js'
import styles from './AgentLab.module.css'
import { hasNativeTerminal, openNativeTerminal } from './terminalBridge.js'
import { ToolCallCard } from './ToolCallCard.js'
import { useAgentRun } from './useAgentRun.js'

const SYSTEM_PROMPT = [
  '你是一个可以执行本机 shell 命令的助手。',
  '需要了解环境或验证结论时，先调用 execute_shell 取得真实输出，再依据输出回答；不要臆造命令结果。',
  '一次只调用一个命令，输出过长时用 head、tail、grep 收窄。',
].join('')

const EXAMPLE = '看看当前目录有什么文件，再用 python 打印 42'

/**
 * 工具调用演示：把 runAgent 的流式事件直接摊在面板里，
 * 便于在接入聊天页之前验证分片入参、卡片状态与中止行为。
 */
export const AgentLabDialog = () => {
  const t = useTranslate()
  const open = useAgentLab((state) => state.open)
  const apiKey = useSettings((state) => state.apiKey)
  const [prompt, setPrompt] = useState(EXAMPLE)
  const nativeTerminal = hasNativeTerminal()
  const { items, running, turns, run, runLocal, stop, reset } = useAgentRun(SYSTEM_PROMPT)

  if (!open) {
    return null
  }

  const close = () => {
    if (running) {
      stop()
    }
    reset()
    closeAgentLab()
  }

  return (
    <Modal
      title={t('agentLabTitle')}
      closable
      className={styles.dialog}
      onClose={close}
      footer={
        <div className={styles.footer}>
          <span className={styles.turn}>{running && turns > 0 ? t('agentLabTurn', { turn: turns }) : null}</span>
          {nativeTerminal ? (
            <Button variant="outlined" size="m" onClick={() => void openNativeTerminal()}>
              {t('agentTerminalOpen')}
            </Button>
          ) : null}
          <Button variant="outlined" size="m" onClick={() => void runLocal(prompt)} disabled={running}>
            {t('agentLabLocalRun')}
          </Button>
          {running ? (
            <Button variant="outlined" size="m" onClick={stop}>
              {t('agentLabStop')}
            </Button>
          ) : null}
          <Button
            size="m"
            disabled={running || !apiKey || !prompt.trim()}
            onClick={() => void run(prompt.trim(), apiKey ?? '')}
          >
            {t('agentLabRun')}
          </Button>
        </div>
      }
    >
      <label className={styles.field}>
        <span className={styles.label}>{t('agentLabPromptLabel')}</span>
        <textarea
          className={styles.prompt}
          rows={2}
          value={prompt}
          placeholder={t('agentLabPromptPlaceholder')}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      {apiKey ? null : (
        <p className={styles.warning}>
          {t('agentLabNoKey')}
          <Button variant="outlined" size="s" onClick={() => openSettings('data')}>
            {t('agentLabOpenSettings')}
          </Button>
        </p>
      )}
      <div className={styles.timeline}>
        {items.length === 0 ? (
          <p className={styles.empty}>{t('agentLabEmpty')}</p>
        ) : (
          items.map((item) => {
            if (item.kind === 'tool') {
              return (
                <ToolCallCard
                  key={item.id}
                  name={item.name}
                  command={item.command}
                  state={item.state}
                  outcome={item.outcome}
                />
              )
            }
            if (item.kind === 'note') {
              return (
                <p key={item.id} className={clsx(styles.note, item.error && styles.noteError)}>
                  {item.text}
                </p>
              )
            }
            return (
              <p
                key={item.id}
                className={clsx(styles.prose, item.kind === 'thinking' && styles.thinking)}
              >
                {item.text}
              </p>
            )
          })
        )}
      </div>
    </Modal>
  )
}
