import { useEffect } from 'react'
import {
  closeMobileSider,
  dragMobileSider,
  openMobileSider,
  useMobileSider,
} from '../components/sider/mobileSiderState.js'

/** 从屏幕左缘这么宽以内起手，才算「右滑打开历史」 */
const EDGE_WIDTH = 24
/** 滑过抽屉宽度的这个比例就提交，否则回弹 */
const COMMIT_RATIO = 0.3
/** 快速轻扫（px/ms）：距离不够也能直接开/关 */
const FLING_VELOCITY = 0.45

const drawerWidth = () => {
  const element = document.querySelector<HTMLElement>('[data-mobile-sider]')
  const measured = element?.getBoundingClientRect().width ?? 0
  return measured > 0 ? measured : Math.min(300, window.innerWidth - 48)
}

/** 输入框与代码块里可能是横向选择/滚动，不抢手势 */
const ignorable = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(target.closest('input, textarea, pre, code, [contenteditable="true"]'))

/**
 * 移动端手势：左缘右滑打开历史（会话列表），抽屉打开时左滑关闭。
 * 拖动过程只更新 CSS 状态，不触发 React 重渲染之外的计算，保证 60fps 跟手。
 */
export const useEdgeSwipe = (enabled: boolean) => {
  const open = useMobileSider((state) => state.open)

  useEffect(() => {
    if (!enabled) {
      return
    }

    let tracking = false
    let horizontal = false
    let startX = 0
    let startY = 0
    let startAt = 0
    let width = 0
    let visible = 0

    const reset = () => {
      tracking = false
      horizontal = false
    }

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || ignorable(event.target)) {
        reset()
        return
      }
      const touch = event.touches[0]
      width = drawerWidth()
      if (open) {
        // 打开时只认抽屉内的左滑，遮罩区域的点击交给遮罩自己关
        if (touch.clientX > width) {
          reset()
          return
        }
      } else if (touch.clientX > EDGE_WIDTH) {
        reset()
        return
      }
      tracking = true
      horizontal = false
      startX = touch.clientX
      startY = touch.clientY
      startAt = event.timeStamp
      visible = open ? width : 0
    }

    const onMove = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) {
        return
      }
      const touch = event.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (!horizontal) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
          return
        }
        if (Math.abs(dx) < Math.abs(dy) * 1.2) {
          reset()
          return
        }
        // 关着只认右滑，开着只认左滑，避免和列表纵向滚动抢
        if (!open && dx <= 0) {
          reset()
          return
        }
        if (open && dx >= 0) {
          reset()
          return
        }
        horizontal = true
      }
      visible = Math.max(0, Math.min(width, (open ? width : 0) + dx))
      dragMobileSider(visible)
      if (event.cancelable) {
        event.preventDefault()
      }
    }

    const onEnd = (event: TouchEvent) => {
      if (!tracking) {
        return
      }
      const touch = event.changedTouches[0]
      const dx = touch ? touch.clientX - startX : 0
      const elapsed = Math.max(1, event.timeStamp - startAt)
      const velocity = dx / elapsed
      const ratio = width > 0 ? visible / width : 0
      const fast = Math.abs(velocity) > FLING_VELOCITY
      const moved = horizontal
      reset()
      if (!moved) {
        return
      }
      if (open) {
        if (ratio < 1 - COMMIT_RATIO || (fast && velocity < 0)) {
          closeMobileSider()
        } else {
          dragMobileSider(null)
        }
      } else if (ratio > COMMIT_RATIO || (fast && velocity > 0)) {
        openMobileSider()
      } else {
        closeMobileSider()
      }
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
    }
  }, [enabled, open])
}
