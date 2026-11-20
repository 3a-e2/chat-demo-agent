import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 思考强度：off 关闭，low→max 预算递增 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max'

export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max']

/** 传给服务端的思考预算；off 时不发 budget_tokens */
export const thinkingBudget = (level: ThinkingLevel): number | null => THINKING_BUDGETS[level]

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、思考强度、Agent 与联网搜索开关、侧边栏收起状态 */
export type Settings = {
  apiKey: string | null
  /** 第三方 OpenAI 兼容接口；三项都填了才启用，优先于 DeepSeek */
  customBaseUrl: string
  customApiKey: string | null
  customModel: string
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  thinkingLevel: ThinkingLevel
  /** Agent 模式：聊天时允许模型调用本机终端执行命令 */
  agent: boolean
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  customBaseUrl: 'chat-demo:custom-base-url',
  customApiKey: 'chat-demo:custom-api-key',
  customModel: 'chat-demo:custom-model',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  thinkingLevel: 'chat-demo:thinking-level',
  agent: 'chat-demo:agent',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 老版本只存了布尔开关，升级后按 true→high 迁移 */
const initialThinkingLevel = (): ThinkingLevel => {
  const saved = read(KEYS.thinkingLevel)
  if (saved && (THINKING_LEVELS as string[]).includes(saved)) {
    return saved as ThinkingLevel
  }
  return read(KEYS.thinking) === 'true' ? 'high' : 'off'
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  customBaseUrl: read(KEYS.customBaseUrl) ?? '',
  customApiKey: read(KEYS.customApiKey),
  customModel: read(KEYS.customModel) ?? '',
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinkingLevel: initialThinkingLevel(),
  thinking: initialThinkingLevel() !== 'off',
  agent: read(KEYS.agent) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export type CustomEndpoint = { baseUrl: string; apiKey: string | null; model: string }

/** 保存第三方接口的三项配置；留空即视为不使用 */
export const setCustomEndpoint = ({
  baseUrl,
  apiKey,
  model,
}: { baseUrl?: string; apiKey?: string | null; model?: string }) => {
  const next = {
    customBaseUrl: baseUrl ?? useSettings.getState().customBaseUrl,
    customApiKey: apiKey === undefined ? useSettings.getState().customApiKey : apiKey,
    customModel: model ?? useSettings.getState().customModel,
  }
  write(KEYS.customBaseUrl, next.customBaseUrl)
  write(KEYS.customApiKey, next.customApiKey)
  write(KEYS.customModel, next.customModel)
  useSettings.setState(next)
}

/** 各档思考强度的预算；off 时不发 thinking 也不发预算 */
export const THINKING_BUDGETS: Record<ThinkingLevel, number | null> = {
  off: null,
  low: 1024,
  medium: 2048,
  high: 4096,
  max: 16384,
}

/** 兼容旧调用：布尔开关等价于 off / high */
export const setThinking = (thinking: boolean) => {
  setThinkingLevel(thinking ? 'high' : 'off')
}

export const setThinkingLevel = (thinkingLevel: ThinkingLevel) => {
  write(KEYS.thinkingLevel, thinkingLevel)
  write(KEYS.thinking, String(thinkingLevel !== 'off'))
  useSettings.setState({ thinkingLevel, thinking: thinkingLevel !== 'off' })
}

export const setAgent = (agent: boolean) => {
  write(KEYS.agent, String(agent))
  useSettings.setState({ agent })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
