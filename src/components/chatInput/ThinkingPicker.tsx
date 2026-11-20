import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  setThinkingLevel,
  THINKING_BUDGETS,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../../services/settings.js'
import styles from './ThinkingPicker.module.css'

/** 档位对应的文案 key，顺序与 THINKING_LEVELS 一致 */
const LABELS: Record<ThinkingLevel, TranslationKey> = {
  off: 'thinkingOff',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  max: 'thinkingMax',
}

/** 点击打开滑杆面板；拖动即时改档，点外部或 Esc 关闭 */
export const ThinkingPicker = ({
  level,
  children,
}: {
  level: ThinkingLevel
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { side: 'bottom', align: 'start', offset: 8, measureKey: level }
  )
  useDismiss(open, [anchorRef, floatingRef], close)

  const index = Math.max(0, THINKING_LEVELS.indexOf(level))
  const percent = (index / (THINKING_LEVELS.length - 1)) * 100
  const budget = THINKING_BUDGETS[level]

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {children({ open, toggle: () => setOpen((value) => !value) })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.panel}
              style={position ?? { top: 0, left: 0, visibility: 'hidden' }}
              role="group"
              aria-label={t('thinkingPickerTitle')}
            >
              <div className={styles.header}>
                <span className={styles.title}>{t('thinkingPickerTitle')}</span>
                <span className={styles.value}>{t(LABELS[level])}</span>
              </div>
              <div className={styles.track}>
                <div className={styles.rail} aria-hidden>
                  <div className={styles.fill} style={{ width: `${percent}%` }} />
                </div>
                <input
                  type="range"
                  className={styles.slider}
                  min={0}
                  max={THINKING_LEVELS.length - 1}
                  step={1}
                  value={index}
                  aria-label={t('thinkingPickerTitle')}
                  aria-valuetext={t(LABELS[level])}
                  onChange={(event) => {
                    const next = THINKING_LEVELS[Number(event.currentTarget.value)]
                    if (next) {
                      setThinkingLevel(next)
                    }
                  }}
                />
              </div>
              <div className={styles.ticks} aria-hidden>
                {THINKING_LEVELS.map((item) => (
                  <span
                    key={item}
                    className={item === level ? styles.tickActive : styles.tick}
                  >
                    {t(LABELS[item])}
                  </span>
                ))}
              </div>
              <div className={styles.footer}>
                {budget === null ? t('thinkingPickerHint') : `${t('thinkingBudgetLabel')} · ${budget} tokens`}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
