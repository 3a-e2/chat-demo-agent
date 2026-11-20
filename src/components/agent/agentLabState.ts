import { create } from 'zustand'

/** 工具调用演示面板；侧边栏与设置里都能打开 */
export const useAgentLab = create(() => ({ open: false }))

export const openAgentLab = () => useAgentLab.setState({ open: true })

export const closeAgentLab = () => useAgentLab.setState({ open: false })
