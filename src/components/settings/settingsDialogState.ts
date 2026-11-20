import { create } from 'zustand'
import { hasProvider } from '../../services/api/provider.js'
import { translate } from '../../i18n/index.js'
import { showToast } from '../base/toastState.js'

/** 设置弹窗的分组：通用设置 / 数据管理 / 第三方接口 */
export type SettingsSection = 'general' | 'data' | 'custom'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/**
 * 发送、上传、语音等操作前的检查：DeepSeek 密钥或第三方接口任意一个可用即可。
 * 都没有时打开「数据管理」并提示填写，返回是否已有可用接口。
 */
export const ensureApiKey = () => {
  if (hasProvider()) {
    return true
  }
  openSettings('data')
  showToast(translate('apiKeyRequired'))
  return false
}
