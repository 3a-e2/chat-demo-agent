import { create } from 'zustand'

/**
 * 移动端侧边栏抽屉：顶栏菜单按钮打开，点遮罩、切换会话或开启新对话后关闭。
 * visible 是跟手拖动时的「当前可见宽度」，null 表示没有在拖（交给 CSS 过渡收尾）。
 */
type MobileSiderState = {
  open: boolean
  visible: number | null
}

export const useMobileSider = create<MobileSiderState>(() => ({ open: false, visible: null }))

export const openMobileSider = () => useMobileSider.setState({ open: true, visible: null })

export const closeMobileSider = () => useMobileSider.setState({ open: false, visible: null })

/** 手指拖动过程中直接写真值，跳过过渡，保证跟手不卡 */
export const dragMobileSider = (visible: number | null) => useMobileSider.setState({ visible })
