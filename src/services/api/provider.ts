import { useSettings, type Settings } from '../settings.js'

/** 第三方接口未填模型时的默认值：多数 OpenAI 兼容服务都提供这个别名 */
export const DEFAULT_CUSTOM_MODEL = 'gpt-4o-mini'

export type ChatProvider =
  /** DeepSeek 官方接口（Anthropic 兼容） */
  | { kind: 'deepseek'; apiKey: string }
  /** 任意 OpenAI 兼容接口（/chat/completions） */
  | { kind: 'custom'; baseUrl: string; apiKey: string; model: string }

type SettingsLike = Pick<Settings, 'apiKey' | 'customBaseUrl' | 'customApiKey' | 'customModel'>

/** 去掉末尾斜杠，避免拼出 //chat/completions */
export const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, '')

/**
 * 选择本次请求使用哪个接口：
 * - 第三方接口的地址与 Key 都填了 → 用第三方（模型留空时取默认值）；
 * - 否则用 DeepSeek 官方接口；
 * - 都没有 → null，调用方负责引导用户去设置。
 */
export const resolveProvider = (settings: SettingsLike = useSettings.getState()): ChatProvider | null => {
  const baseUrl = normalizeBaseUrl(settings.customBaseUrl)
  const customApiKey = settings.customApiKey?.trim() ?? ''
  if (baseUrl && customApiKey) {
    return {
      kind: 'custom',
      baseUrl,
      apiKey: customApiKey,
      model: settings.customModel.trim() || DEFAULT_CUSTOM_MODEL,
    }
  }
  const apiKey = settings.apiKey?.trim() ?? ''
  return apiKey ? { kind: 'deepseek', apiKey } : null
}

/** 是否已经配置了可用的接口（DeepSeek 或第三方） */
export const hasProvider = (settings?: SettingsLike) => resolveProvider(settings) !== null

/** 当前是否走第三方接口；附件、Agent、联网搜索都据此降级 */
export const isCustomProvider = (settings?: SettingsLike) =>
  resolveProvider(settings)?.kind === 'custom'
