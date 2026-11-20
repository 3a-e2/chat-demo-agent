import { useState } from 'react'
import { normalizeBaseUrl, resolveProvider } from '../../services/api/provider.js'
import { setCustomEndpoint, useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

/**
 * 第三方 AI 接口：只支持 OpenAI 兼容的 /chat/completions。
 * 地址与密钥都填了才生效，并且优先于 DeepSeek；这里不做网络校验，避免被跨域拦掉。
 */
export const CustomApiSection = () => {
  const t = useTranslate()
  const savedBaseUrl = useSettings((state) => state.customBaseUrl)
  const savedApiKey = useSettings((state) => state.customApiKey) ?? ''
  const savedModel = useSettings((state) => state.customModel)
  const [baseUrl, setBaseUrl] = useState(savedBaseUrl)
  const [apiKey, setApiKey] = useState(savedApiKey)
  const [model, setModel] = useState(savedModel)
  const [error, setError] = useState<string | null>(null)

  const provider = resolveProvider()
  const status =
    provider?.kind === 'custom'
      ? t('customApiActiveCustom', { model: provider.model })
      : provider
        ? t('customApiActiveDeepSeek')
        : t('customApiActiveNone')

  const save = () => {
    const nextBaseUrl = normalizeBaseUrl(baseUrl)
    if (nextBaseUrl && !/^https?:\/\//i.test(nextBaseUrl)) {
      setError(t('customApiBaseUrlInvalid'))
      return
    }
    setCustomEndpoint({ baseUrl: nextBaseUrl, apiKey: apiKey.trim() || null, model: model.trim() })
    setBaseUrl(nextBaseUrl)
    setApiKey(apiKey.trim())
    setModel(model.trim())
    setError(null)
    showToast(t('customApiSaved'))
  }

  const incomplete = Boolean(baseUrl.trim()) !== Boolean(apiKey.trim())

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('customApiTitle')}</div>
        <div className={styles.description}>{t('customApiDescription')}</div>
        <div className={styles.customFields}>
          <label className={styles.customField}>
            <span className={styles.customFieldLabel}>{t('customApiBaseUrlLabel')}</span>
            <input
              className={styles.customInput}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('customApiBaseUrlPlaceholder')}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label className={styles.customField}>
            <span className={styles.customFieldLabel}>{t('customApiKeyLabel')}</span>
            <input
              className={styles.customInput}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('customApiKeyPlaceholder')}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <label className={styles.customField}>
            <span className={styles.customFieldLabel}>{t('customApiModelLabel')}</span>
            <input
              className={styles.customInput}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('customApiModelPlaceholder')}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  save()
                }
              }}
            />
          </label>
        </div>
        {error ? <div className={styles.error}>{error}</div> : null}
        {!error && incomplete ? (
          <div className={styles.description}>{t('customApiIncomplete')}</div>
        ) : null}
        <div className={styles.customFooter}>
          <span className={styles.description}>{status}</span>
          <button type="button" className={styles.saveButton} onClick={save}>
            {t('customApiSave')}
          </button>
        </div>
        <div className={styles.description}>{t('customApiNotSupported')}</div>
      </div>
    </div>
  )
}
