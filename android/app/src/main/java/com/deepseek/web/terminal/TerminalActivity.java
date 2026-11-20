package com.deepseek.web.terminal;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.inputmethod.InputMethodManager;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;

import com.termux.terminal.TerminalSession;
import com.termux.terminal.TerminalSessionClient;
import com.termux.view.TerminalView;
import com.termux.view.TerminalViewClient;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * 真终端页面：Termux 的 terminal-emulator（PTY）+ terminal-view（渲染）跑在本进程里。
 *
 * 这里刻意不引 termux-shared，所以没有 Termux 的 bootstrap（apt、bash、/data/data/com.termux 那一套），
 * 而是直接 exec 系统自带的 /system/bin/sh，工作目录放在应用私有的 files/home。
 * 也就是说：拿到的是真 pty、真进程、真输出，只是里面的用户态工具是 Android 自带的 toybox。
 */
public class TerminalActivity extends AppCompatActivity
        implements TerminalViewClient, TerminalSessionClient {

    private static final String TAG = "DeepSeekTerminal";

    private TerminalView terminalView;
    private TerminalSession session;
    private FrameLayout root;
    private TextView statusView;
    /** 常驻右上角的退出按钮，作用和实体返回键一致。 */
    private TextView exitButton;
    /** rootfs 下载/解包进度条，只在安装时露出来。 */
    private ProgressBar progressBar;
    /** 当前字号（dp），renderer 只认 px，每次都要自己乘 density。 */
    private int textSizeDp = 13;
    /** 捏合时 TerminalView 每次都会重置内部 scale，只能在这里累加。 */
    private float scaleAccum = 1f;
    /** session 真正 attach 到视图之后才允许刷新屏幕，否则回调里会踩空。 */
    private volatile boolean attached;
    /** rootfs 安装中，防重复点。 */
    private volatile boolean installing;
    private String installStatus = "";

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0d1117"));
        setContentView(root);

        // 开机自检面板：真机崩在哪一步能直接看到
        statusView = new TextView(this);
        statusView.setTextColor(Color.parseColor("#8b949e"));
        statusView.setTextSize(11f);
        statusView.setPadding(32, 64, 32, 32);
        statusView.setTextIsSelectable(true);
        root.addView(statusView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        installCrashLogger();
        step("0. activity created");

        try {
            getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            // Android 15 起强制 edge-to-edge，会把 adjustResize 顶掉，导致软键盘盖住终端
            WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
            getWindow().setStatusBarColor(Color.parseColor("#0d1117"));
            step("1. window ok");

            terminalView = new TerminalView(this, null);
            step("2. TerminalView constructed");

            terminalView.setTerminalViewClient(this);
            terminalView.setBackgroundColor(Color.parseColor("#0d1117"));
            // 键盘输入的两个前提：能获取焦点、能进入 touch mode
            terminalView.setFocusable(true);
            terminalView.setFocusableInTouchMode(true);
            // 关键：TerminalRenderer 只有在 setTextSize/setTypeface 里才会被创建，
            // 不调用它，onSizeChanged -> updateSize() 就会踩到 null 的 mRenderer。
            applyTextSize();
            step("3. client set");

            root.addView(terminalView, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            step("4. view added");

            addProgressBar();
            addExitButton();

            if (RootfsManager.isInstalled(this)) {
                startSession();
                step("5. session started");
            } else {
                showInstallPanel();
            }
        } catch (Throwable t) {
            Log.e(TAG, "failed to start terminal", t);
            showFatal(t);
        }
    }

    private void step(String text) {
        Log.i(TAG, text);
        if (statusView != null) statusView.setText(text);
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** 右上角「退出」胶囊，点它等于按返回键。 */
    private void addExitButton() {
        exitButton = new TextView(this);
        exitButton.setText("退出");
        exitButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        exitButton.setTextColor(Color.parseColor("#c9d1d9"));
        exitButton.setGravity(Gravity.CENTER);
        exitButton.setPadding(dp(14), dp(6), dp(14), dp(6));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(16));
        bg.setColor(Color.parseColor("#21262d"));
        bg.setStroke(dp(1), Color.parseColor("#30363d"));
        exitButton.setBackground(bg);
        // 不能抢焦点，否则点完终端就丢键盘了
        exitButton.setFocusable(false);
        exitButton.setFocusableInTouchMode(false);
        exitButton.setOnClickListener(v -> finish());

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.END);
        lp.topMargin = dp(10);
        lp.rightMargin = dp(12);
        root.addView(exitButton, lp);
    }

    /** 横向进度条，安装 rootfs 时才显示。 */
    private void addProgressBar() {
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgressTintList(ColorStateList.valueOf(Color.parseColor("#58a6ff")));
        progressBar.setProgressBackgroundTintList(ColorStateList.valueOf(Color.parseColor("#21262d")));
        progressBar.setVisibility(android.view.View.GONE);

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, dp(4),
                Gravity.BOTTOM);
        lp.leftMargin = dp(28);
        lp.rightMargin = dp(28);
        lp.bottomMargin = dp(64);
        root.addView(progressBar, lp);
    }

    /** 安装面板/报错页要压在最上层，否则会被终端视图盖住看不见。 */
    private void bringOverlaysToFront() {
        if (statusView != null) root.bringChildToFront(statusView);
        if (progressBar != null) root.bringChildToFront(progressBar);
        if (exitButton != null) root.bringChildToFront(exitButton);
    }

    /** 把未捕获异常也写到外部存储，方便真机取证。 */
    private void installCrashLogger() {
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, e) -> {
            writeCrashFile(e);
            if (prev != null) prev.uncaughtException(thread, e);
        });
    }

    private void writeCrashFile(Throwable e) {
        try {
            File dir = getExternalFilesDir(null);
            if (dir == null) dir = getFilesDir();
            File out = new File(dir, "terminal-crash.txt");
            java.io.PrintWriter pw = new java.io.PrintWriter(out);
            java.io.StringWriter sw = new java.io.StringWriter();
            e.printStackTrace(new java.io.PrintWriter(sw));
            pw.println(sw.toString());
            pw.close();
            Log.e(TAG, "crash written to " + out.getAbsolutePath());
        } catch (Throwable ignored) {
        }
    }

    private void showFatal(Throwable t) {
        StringBuilder sb = new StringBuilder("终端启动失败\n\n");
        sb.append(t).append("\n\n");
        for (StackTraceElement e : t.getStackTrace()) {
            sb.append("    at ").append(e).append('\n');
            if (sb.length() > 4000) break;
        }
        Throwable cause = t.getCause();
        if (cause != null) {
            sb.append("\nCaused by: ").append(cause).append('\n');
        }
        if (statusView != null) {
            statusView.setTextColor(Color.parseColor("#ff7b72"));
            statusView.setText(sb.toString());
            writeCrashFile(t);
            return;
        }
        TextView tv = new TextView(this);
    }

    /**
     * proot 启动参数：把 Alpine 的 / 换成 rootfs，其它设备目录用 -b 借进去。
     * -0 让 root 身份可用（apk 需要），--kill-on-exit 防 proot 变僵尸。
     */
    private void startSession() {
        // 安装面板可能压在上面，会话起来后让终端回到最底层、按钮仍在最上层
        if (root != null && terminalView != null) {
            root.bringChildToFront(terminalView);
            bringOverlaysToFront();
        }
        File nativeDir = new File(getApplicationInfo().nativeLibraryDir);
        File proot = new File(nativeDir, "libproot.so");
        File loader = new File(nativeDir, "libproot_loader.so");
        File rootfs = RootfsManager.rootfsDir(this);
        File prootTmp = new File(getFilesDir(), "proot-tmp");
        //noinspection ResultOfMethodCallIgnored
        prootTmp.mkdirs();

        if (!proot.exists()) {
            showFatal(new IllegalStateException("当前 ABI 没有 proot 二进制：" + Build.SUPPORTED_ABIS[0]));
            return;
        }

        List<String> args = new ArrayList<>();
        args.add("--kill-on-exit");
        // 部分设备/data 分区不支持硬链接，apk 安装会失败，靠这个把链接模拟成符号链接
        args.add("--link2symlink");
        args.add("-0");
        args.add("-r");
        args.add(rootfs.getAbsolutePath());
        args.add("-b");
        args.add("/dev");
        args.add("-b");
        args.add("/proc");
        args.add("-b");
        args.add("/sys");
        // 有些程序读 /dev/random 会一直阻塞，指向 urandom 更快
        args.add("-b");
        args.add("/dev/urandom:/dev/random");
        if (hasStoragePermission()) {
            // 借出共享存储，终端里就能直接看手机文件
            args.add("-b");
            args.add("/storage/emulated/0:/sdcard");
            args.add("-b");
            args.add("/storage/emulated/0:/storage/emulated/0");
        }
        args.add("-w");
        args.add("/root");
        args.add("/usr/bin/env");
        args.add("-i");
        args.add("HOME=/root");
        args.add("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        args.add("TERM=xterm-256color");
        args.add("LANG=C.UTF-8");
        args.add("/bin/sh");
        args.add("-l");

        List<String> env = new ArrayList<>();
        env.add("PROOT_LOADER=" + loader.getAbsolutePath());
        env.add("PROOT_TMP_DIR=" + prootTmp.getAbsolutePath());
        // 少部分设备上 seccomp 加速会导致 proot 直接挂，禁掉更稳
        env.add("PROOT_NO_SECCOMP=1");
        env.add("TERM=xterm-256color");
        env.add("HOME=/root");

        session = new TerminalSession(
                proot.getAbsolutePath(),
                rootfs.getAbsolutePath(),
                args.toArray(new String[0]),
                env.toArray(new String[0]),
                2000,
                this);

        terminalView.attachSession(session);
        attached = true;
        terminalView.post(() -> {
            if (statusView != null) {
                root.removeView(statusView);
                statusView = null;
            }
            terminalView.requestFocus();
            terminalView.onScreenUpdated();
            // 布局和 IME insets 稳定后再算一次行列，避免刚进来是 4x4
            terminalView.postDelayed(() -> {
                if (terminalView != null) terminalView.updateSize();
            }, 120);
        });
    }

    private boolean hasStoragePermission() {
        String perm = Build.VERSION.SDK_INT >= 33
                ? Manifest.permission.READ_MEDIA_IMAGES
                : Manifest.permission.READ_EXTERNAL_STORAGE;
        return ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED;
    }

    /** 首次进入：把状态面板当成「安装页」，点一下就开始下载 rootfs。 */
    private void showInstallPanel() {
        if (statusView == null) return;
        statusView.setTextColor(Color.parseColor("#c9d1d9"));
        statusView.setText("还没有 Linux 环境\n\n"
                + "点这里下载 Alpine " + "（约 4MB，装一次就够了）\n\n"
                + "装好之后这个终端里就是真的 Alpine + apk 包管理器，\n"
                + "可以 apk add bash git nano python3 …\n\n"
                + "rootfs 放在应用私有目录，不占系统分区，卸载即清。");
        statusView.setOnClickListener(v -> startInstall());
        bringOverlaysToFront();
    }

    private void startInstall() {
        if (installing || statusView == null) return;
        installing = true;
        statusView.setTextColor(Color.parseColor("#c9d1d9"));
        statusView.setOnClickListener(null);
        installStatus = "准备下载…";
        statusView.setText(installStatus + "\n\n0%");
        if (progressBar != null) {
            progressBar.setProgress(0);
            progressBar.setVisibility(android.view.View.VISIBLE);
        }
        bringOverlaysToFront();

        new Thread(() -> {
            try {
                RootfsManager.install(this, new RootfsManager.Progress() {
                    @Override
                    public void onStatus(String text) {
                        installStatus = text;
                        runOnUiThread(() -> {
                            if (statusView != null) statusView.setText(installStatus);
                        });
                    }

                    @Override
                    public void onPercent(int percent) {
                        runOnUiThread(() -> {
                            if (progressBar != null) {
                                progressBar.setVisibility(android.view.View.VISIBLE);
                                progressBar.setProgress(percent);
                            }
                            if (statusView != null) {
                                statusView.setText(installStatus + "\n\n" + percent + "%");
                            }
                        });
                    }
                });
                runOnUiThread(() -> {
                    installing = false;
                    if (progressBar != null) progressBar.setVisibility(android.view.View.GONE);
                    if (statusView != null) {
                        root.removeView(statusView);
                        statusView = null;
                    }
                    startSession();
                });
            } catch (Throwable e) {
                Log.e(TAG, "rootfs install failed", e);
                writeCrashFile(e);
                runOnUiThread(() -> {
                    installing = false;
                    if (progressBar != null) progressBar.setVisibility(android.view.View.GONE);
                    if (statusView != null) {
                        statusView.setTextColor(Color.parseColor("#ff7b72"));
                        statusView.setText("安装失败：" + e + "\n\n点这里重试");
                        statusView.setOnClickListener(v -> startInstall());
                        bringOverlaysToFront();
                    }
                });
            }
        }, "rootfs-install").start();
    }

    /** 实体返回键：和右上角「退出」按钮一样，直接退出终端。 */
    @Override
    public void onBackPressed() {
        finish();
    }

    @Override
    protected void onDestroy() {
        attached = false;
        if (session != null) {
            session.finishIfRunning();
        }
        terminalView = null;
        super.onDestroy();
    }

    /** renderer 接受的是 px，这里统一把 dp 换算过去。 */
    private void applyTextSize() {
        int px = Math.max(6, Math.round(textSizeDp * getResources().getDisplayMetrics().density));
        terminalView.setTextSize(px);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && terminalView != null && !terminalView.hasFocus()) {
            terminalView.requestFocus();
        }
    }

    private void showIme() {
        if (terminalView == null) return;
        terminalView.requestFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm == null) return;
        // 刚拿到焦点那一刻 showSoftInput 经常无效，post 一次更稳
        terminalView.post(() -> imm.showSoftInput(terminalView, InputMethodManager.SHOW_IMPLICIT));
    }

    // ---------------------------------------------------------------- TerminalViewClient

    @Override
    public float onScale(float scale) {
        // TerminalView 每次都会把 mScaleFactor 重置成我们返回的值，
        // 所以这里拿到的是「增量」，得自己累加，够一档再改字号。
        scaleAccum *= scale;
        if (scaleAccum > 1.18f || scaleAccum < 0.85f) {
            int next = Math.round(textSizeDp * scaleAccum);
            next = Math.max(7, Math.min(30, next));
            if (next != textSizeDp) {
                textSizeDp = next;
                applyTextSize();
            }
            scaleAccum = 1f;
        }
        return 1.0f;
    }

    @Override
    public void onSingleTapUp(MotionEvent e) {
        showIme();
    }

    @Override
    public boolean shouldBackButtonBeMappedToEscape() {
        return false;
    }

    @Override
    public boolean shouldEnforceCharBasedInput() {
        return false;
    }

    @Override
    public boolean shouldUseCtrlSpaceWorkaround() {
        return false;
    }

    @Override
    public boolean isTerminalViewSelected() {
        return true;
    }

    @Override
    public void copyModeChanged(boolean copyMode) {
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent e, TerminalSession target) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            finish();
            return true;
        }
        return false;
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent e) {
        return false;
    }

    @Override
    public boolean onLongPress(MotionEvent event) {
        return false;
    }

    @Override
    public boolean readControlKey() {
        return false;
    }

    @Override
    public boolean readAltKey() {
        return false;
    }

    @Override
    public boolean readShiftKey() {
        return false;
    }

    @Override
    public boolean readFnKey() {
        return false;
    }

    @Override
    public boolean onCodePoint(int codePoint, boolean ctrlDown, TerminalSession target) {
        return false;
    }

    @Override
    public void onEmulatorSet() {
        if (terminalView == null) return;
        terminalView.post(() -> {
            if (terminalView != null) {
                terminalView.requestFocus();
                terminalView.onScreenUpdated();
            }
        });
    }

    // ---------------------------------------------------------------- TerminalSessionClient

    @Override
    public void onTextChanged(@NonNull TerminalSession changedSession) {
        // 这个回调可能是 session 后台读线程发来的，必须回 UI 线程，且要等 attach 完成
        if (!attached || terminalView == null) return;
        terminalView.post(terminalView::onScreenUpdated);
    }

    @Override
    public void onTitleChanged(@NonNull TerminalSession changedSession) {
    }

    @Override
    public void onSessionFinished(@NonNull TerminalSession finishedSession) {
        if (terminalView == null) return;
        terminalView.post(terminalView::onScreenUpdated);
    }

    @Override
    public void onCopyTextToClipboard(@NonNull TerminalSession target, String text) {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null) {
            cm.setPrimaryClip(ClipData.newPlainText("terminal", text));
        }
    }

    @Override
    public void onPasteTextFromClipboard(@Nullable TerminalSession target) {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null && cm.getPrimaryClip() != null && target != null) {
            CharSequence text = cm.getPrimaryClip().getItemAt(0).coerceToText(this);
            if (text != null) {
                target.write(text.toString());
            }
        }
    }

    @Override
    public void onBell(@NonNull TerminalSession s) {
    }

    @Override
    public void onColorsChanged(@NonNull TerminalSession s) {
        if (terminalView == null) return;
        terminalView.post(terminalView::onScreenUpdated);
    }

    @Override
    public void onTerminalCursorStateChange(boolean state) {
    }

    @Override
    public void setTerminalShellPid(@NonNull TerminalSession s, int pid) {
    }

    @Override
    public Integer getTerminalCursorStyle() {
        return 0;
    }

    @Override
    public void logError(String tag, String message) {
        Log.e(TAG, message);
    }

    @Override
    public void logWarn(String tag, String message) {
        Log.w(TAG, message);
    }

    @Override
    public void logInfo(String tag, String message) {
        Log.i(TAG, message);
    }

    @Override
    public void logDebug(String tag, String message) {
        Log.d(TAG, message);
    }

    @Override
    public void logVerbose(String tag, String message) {
        Log.v(TAG, message);
    }

    @Override
    public void logStackTraceWithMessage(String tag, String message, Exception e) {
        Log.e(TAG, message, e);
    }

    @Override
    public void logStackTrace(String tag, Exception e) {
        Log.e(TAG, "stack trace", e);
    }
}
