# 项目上下文（压缩版 · 2026-11-19）

## 定位
Android 应用：把真 Linux 终端塞进 Capacitor 壳里。包名 `com.deepseek.web`，versionName 1.0，minSdk/compileSdk 取根 gradle.ext。
工程根：`/root/111/chat-demo/android`

## 技术栈
- 壳：Capacitor（`:capacitor-android`、`:capacitor-cordova-android-plugins`），appcompat / coordinatorlayout / core-splashscreen。
- 终端：源码引入 Termux 的 `terminal-emulator` + `:terminal-view`（不引 termux-shared，无 bootstrap）。
- 跑 Linux：proot，原生库 `libproot.so` + `libproot_loader.so`（在 `nativeLibraryDir`）。
- rootfs：Alpine `3.20.10` minirootfs，`https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/<arch>/alpine-minirootfs-3.20.10-<arch>.tar.gz`，arch 取 `Build.SUPPORTED_ABIS[0]`（arm64-v8a 默认）。装在应用私有 files 目录，卸载即清。apk 源指向 v3.20 main+community。

## 文件职责
- `MainActivity.java`（60 行）：Capacitor 入口，无业务。
- `terminal/TerminalActivity.java`（~620 行）：Idle 终端页。全屏 FrameLayout：statusView（安装页/报错页，可点）→ TerminalView（PTY 渲染）→ progressBar（横向 4dp）→ exitButton（右上「退出」胶囊）。含崩溃日志落盘 `terminal-crash.txt`、字号捏合缩放、软键盘处理。
- `terminal/RootfsManager.java`（205 行）：下载（HttpURLConnection + Range 续传 + 11 次重试）→ TarGz 解包 → 写 `/etc/resolv.conf`、`/etc/apk/repositories` 等基础配置。回调 `Progress{ onStatus(String), onPercent(int) }`。
- `terminal/TarGz.java`（194 行）：纯 Java 解 tar.gz。
- `terminal/TermuxTerminalPlugin.java`（21 行）：Capacitor 插件，负责 startActivity 进终端。

## 已完成（截至第四版）
1. 真 PTY 启动 + rootfs 自动下载安装。
2. 退出：右上「退出」按钮（focusable=false 防抢键盘）+ `onBackPressed()` → `finish()`，二者等价。
3. 进度：下载/解包统一走 progressBar，文本同步显示「状态 + 百分比」；成功/失败/重试自动收起。
4. 层级修复：overlay 必须 `bringChildToFront`（顺序 statusView → progressBar → exitButton），否则被全屏 TerminalView 盖死；会话启动后终端回最底层。

## 踩过的坑（别重犯）
- TerminalRenderer 只在 `setTextSize()/setTypeface()` 里创建，不调用则 `onSizeChanged → updateSize()` 空指针。
- Android 15 强制 edge-to-edge 会顶掉 `adjustResize`，需 `WindowCompat.setDecorFitsSystemWindows(true)`。
- 刚拿焦点时 `showSoftInput` 常失效，要 `post` 一次。
- 捏合缩放：TerminalView 每次重置 scale，必须自己累加（`scaleAccum`）。
- 布局初测行列会偏（4x4），需 `postDelayed(updateSize, 120)`。
- 服务器不认 Range（返回 200）时只能删档重下。

## 构建
`cd /root/111/chat-demo/android && ./gradlew :app:assembleDebug --offline`
产物：`app/build/outputs/apk/debug/app-debug.apk`（约 9.9MB）

## 协作约定
- 省 token：不整篇读文件，用 grep 精准定位；不必反复全量校验 dex，只在关键改动后查。
- 回复简短，只报结果。
