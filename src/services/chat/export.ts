import { translate } from '../../i18n/index.js'
import { showToast } from '../../components/base/toastState.js'
import { getVisibleMessages } from './branches.js'
import { getReplyText } from './reply.js'
import { readSessionsForExport, useChatStore } from './store.js'
import type { Message, Session } from './types.js'

/**
 * 聊天记录导出：整理成 Markdown（带时间、附件名），
 * 安卓端交给原生插件写进 /sdcard/Download，浏览器端退化成普通下载。
 * 三种粒度共用同一套渲染：单条对话、单个会话、全部会话。
 */

/** 原生侧约定：插件名 ChatExport，方法 saveToDownloads({ filename, content }) => { path } */
type SaveOptions = { filename: string; content: string }

type NativeExportPlugin = {
  saveToDownloads: (options: SaveOptions) => Promise<{ path?: string }>
}

const nativePlugin = (): NativeExportPlugin | null => {
  const capacitor = (globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  const plugin = capacitor?.Plugins?.ChatExport
  if (!plugin || typeof plugin !== 'object') {
    return null
  }
  return typeof (plugin as NativeExportPlugin).saveToDownloads === 'function'
    ? (plugin as NativeExportPlugin)
    : null
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 2026-11-20 13:41 */
const readTime = (time: number) => {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

/** 20261120-1341 */
const fileNameTime = (time: number) => {
  const date = new Date(time)
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}`
}

/** 标题层级：单会话用 ##，全部会话里会话本身占 ##，消息降到 ###。 */
const pushMessage = (lines: string[], message: Message, level: 2 | 3) => {
  const heading = '#'.repeat(level)
  if (message.role === 'user') {
    const text = message.content.trim()
    const files = message.files.map((file) => file.name).filter(Boolean)
    if (!text && files.length === 0) {
      return
    }
    lines.push(`${heading} ${translate('exportRoleUser')} · ${readTime(message.createdAt)}`, '')
    if (text) {
      lines.push(text, '')
    }
    if (files.length > 0) {
      lines.push(`**${translate('exportAttachmentsLabel')}**：${files.join('、')}`, '')
    }
    return
  }

  const text = getReplyText(message).trim()
  if (!text) {
    return
  }
  lines.push(`${heading} ${translate('exportRoleAssistant')} · ${readTime(message.createdAt)}`, '')
  lines.push(text, '')
}

const sessionTitle = (session: Session) => session.title.trim() || translate('exportUntitled')

/** 单条消息连同它的提问（助手回复取当前分支里的上一条用户消息）。 */
const pickExchange = (session: Session, message: Message): Message[] => {
  const path = getVisibleMessages(session)
  const index = path.findIndex((item) => item.id === message.id)
  if (index >= 0) {
    const current = path[index]
    return current.role === 'assistant' && index > 0 && path[index - 1].role === 'user'
      ? [path[index - 1], current]
      : [current]
  }
  // 未选中的分支：按 parentId 找提问，找不到就只导这一条。
  const parent =
    message.role === 'assistant' && message.parentId
      ? session.messages.find((item) => item.id === message.parentId)
      : undefined
  return parent && parent.role === 'user' ? [parent, message] : [message]
}

export const buildExportMarkdown = (session: Session): string => {
  const lines: string[] = [
    `# ${sessionTitle(session)}`,
    '',
    `> ${translate('exportTimeLabel')}：${readTime(Date.now())}`,
    '',
  ]

  for (const message of getVisibleMessages(session)) {
    pushMessage(lines, message, 2)
  }

  return `${lines.join('\n').trimEnd()}\n`
}

export const buildMessageMarkdown = (session: Session, message: Message): string => {
  const lines: string[] = [
    `# ${sessionTitle(session)}`,
    '',
    `> ${translate('exportTimeLabel')}：${readTime(Date.now())}`,
    '',
  ]
  for (const item of pickExchange(session, message)) {
    pushMessage(lines, item, 2)
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export const buildAllMarkdown = (sessions: Session[]): string => {
  const lines: string[] = [
    `# ${translate('exportAllChatsTitle')}`,
    '',
    `> ${translate('exportTimeLabel')}：${readTime(Date.now())}`,
    `> ${translate('exportAllChatsCount', { count: sessions.length })}`,
    '',
  ]
  sessions.forEach((session, index) => {
    if (index > 0) {
      lines.push('---', '')
    }
    lines.push(`## ${sessionTitle(session)}`, '')
    for (const message of getVisibleMessages(session)) {
      pushMessage(lines, message, 3)
    }
  })
  return `${lines.join('\n').trimEnd()}\n`
}

const browserDownload = (filename: string, content: string) => {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 落盘并提示结果；安卓走原生插件进 Download，网页走浏览器下载。 */
const saveMarkdown = async (filename: string, markdown: string): Promise<void> => {
  try {
    const plugin = nativePlugin()
    if (plugin) {
      const result = await plugin.saveToDownloads({ filename, content: markdown })
      showToast(translate('exportChatSaved', { path: result?.path || `Download/${filename}` }))
      return
    }
    browserDownload(filename, markdown)
    showToast(translate('exportChatSaved', { path: filename }))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    showToast(translate('exportChatFailed', { reason }))
  }
}

/** 导出整个会话；成功与失败都给 toast，保存位置写清楚。 */
export const exportChat = async (session: Session): Promise<void> => {
  if (getVisibleMessages(session).length === 0) {
    showToast(translate('exportChatEmpty'))
    return
  }
  await saveMarkdown(
    `deepseek-chat-${fileNameTime(Date.now())}.md`,
    buildExportMarkdown(session)
  )
}

/** 导出单条对话（助手消息会带上它对应的提问）。 */
export const exportMessage = async (session: Session, message: Message): Promise<void> => {
  const hasContent = pickExchange(session, message).some((item) =>
    item.role === 'user' ? item.content.trim() !== '' || item.files.length > 0 : getReplyText(item).trim() !== ''
  )
  // 只有思考块、或者回复还没吐出正文的消息，不落一个空文件。
  if (!hasContent) {
    showToast(translate('exportChatEmpty'))
    return
  }
  await saveMarkdown(
    `deepseek-chat-${fileNameTime(message.createdAt)}.md`,
    buildMessageMarkdown(session, message)
  )
}

/** 会话列表里的导出：内容还没进缓存时直接从本地库读。 */
export const exportChatById = async (id: string): Promise<void> => {
  const [session] = await readSessionsForExport([id])
  if (!session) {
    showToast(translate('exportChatEmpty'))
    return
  }
  await exportChat(session)
}

/** 导出全部对话：按列表顺序读库，跳过一个读失败的会话，不打断整批。 */
export const exportAllChats = async (): Promise<void> => {
  const summaries = useChatStore.getState().sessions
  if (summaries.length === 0) {
    showToast(translate('exportAllChatsEmpty'))
    return
  }
  showToast(translate('exportAllChatsProgress', { count: summaries.length }))
  const sessions = (await readSessionsForExport(summaries.map((item) => item.id))).filter(
    (session) => getVisibleMessages(session).length > 0
  )
  if (sessions.length === 0) {
    showToast(translate('exportAllChatsEmpty'))
    return
  }
  await saveMarkdown(`deepseek-chats-${fileNameTime(Date.now())}.md`, buildAllMarkdown(sessions))
}
