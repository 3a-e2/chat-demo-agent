type TerminalPlugin = { open?: () => Promise<void> }

const plugin = (): TerminalPlugin | undefined =>
  (globalThis as { Capacitor?: { Plugins?: Record<string, TerminalPlugin> } }).Capacitor?.Plugins
    ?.TermuxTerminal

/** 终端是原生页面，只有装进 APK 里跑的时候才存在；浏览器里恒为 false。 */
export const hasNativeTerminal = () => typeof plugin()?.open === 'function'

/** 拉起原生终端页（Termux 的 terminal-emulator + terminal-view，跑 /system/bin/sh）。 */
export const openNativeTerminal = async () => {
  const open = plugin()?.open
  if (!open) {
    return false
  }
  await open()
  return true
}
