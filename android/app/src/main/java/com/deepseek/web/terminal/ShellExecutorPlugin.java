package com.deepseek.web.terminal;

import android.content.Context;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * 给 Agent 用的真机执行桥：把一条命令丢进 Alpine（proot）里跑，拿回 stdout/stderr/退出码。
 *
 * 和终端页复用同一套 rootfs 与 proot 参数，区别只是这里不接 PTY——
 * 一次性命令不需要终端，拿到完整输出更重要，免得 Agent 还要去解析 ANSI 控制字符。
 */
@CapacitorPlugin(name = "ShellExecutor")
public class ShellExecutorPlugin extends Plugin {

    private static final int MAX_OUTPUT = 48 * 1024;
    private static final int DEFAULT_TIMEOUT = 30_000;
    private static final int MAX_TIMEOUT = 120_000;

    /** 破坏性命令直接拦掉，真机上不给后悔的机会 */
    private static final Pattern DANGEROUS = Pattern.compile(
            "(^|\\s)(rm\\s+-rf?\\s+/(\\s|$)|mkfs|dd\\s+if=|/dev/(sd|mmcblk|block))");

    @PluginMethod
    public void execute(PluginCall call) {
        final String command = call.getString("command", "").trim();
        final String cwd = call.getString("cwd");
        final Integer timeoutMs = call.getInt("timeout_ms", DEFAULT_TIMEOUT);
        if (command.isEmpty()) {
            JSObject ret = error("缺少 command", 2);
            call.resolve(ret);
            return;
        }
        // Capacitor 的回调线程不一定适合长时间阻塞，自己开一个
        new Thread(() -> call.resolve(run(command, cwd, clampTimeout(timeoutMs))), "shell-executor")
                .start();
    }

    private static int clampTimeout(Integer timeoutMs) {
        if (timeoutMs == null || timeoutMs <= 0) return DEFAULT_TIMEOUT;
        return Math.min(timeoutMs, MAX_TIMEOUT);
    }

    private JSObject run(String command, String cwd, int timeoutMs) {
        long startedAt = System.currentTimeMillis();
        Context ctx = getContext();
        if (!RootfsManager.isInstalled(ctx)) {
            JSObject ret = error("还没有 Linux 环境，先打开终端装一次 Alpine", 127);
            ret.put("durationMs", 0);
            return ret;
        }
        if (DANGEROUS.matcher(command).find()) {
            JSObject ret = error("该命令被判为危险操作，已拒绝执行", 126);
            ret.put("durationMs", 0);
            return ret;
        }

        File nativeDir = new File(ctx.getApplicationInfo().nativeLibraryDir);
        File proot = new File(nativeDir, "libproot.so");
        File loader = new File(nativeDir, "libproot_loader.so");
        File rootfs = RootfsManager.rootfsDir(ctx);
        File prootTmp = new File(ctx.getFilesDir(), "proot-tmp");
        //noinspection ResultOfMethodCallIgnored
        prootTmp.mkdirs();

        if (!proot.exists()) {
            JSObject ret = error("当前 ABI 没有 proot 二进制：" + Build.SUPPORTED_ABIS[0], 127);
            ret.put("durationMs", 0);
            return ret;
        }

        String workDir = cwd == null || cwd.trim().isEmpty() ? "/root" : cwd.trim();
        List<String> args = new ArrayList<>();
        args.add("--kill-on-exit");
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
        args.add("-b");
        args.add("/dev/urandom:/dev/random");
        // 共享存储总是借进去：Agent 读手机文件不需要额外授权，写仍然受系统权限限制
        args.add("-b");
        args.add("/storage/emulated/0:/sdcard");
        args.add("-b");
        args.add("/storage/emulated/0:/storage/emulated/0");
        args.add("-w");
        args.add(workDir);
        args.add("/usr/bin/env");
        args.add("-i");
        args.add("HOME=/root");
        args.add("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        args.add("TERM=dumb");
        args.add("LANG=C.UTF-8");
        args.add("/bin/sh");
        args.add("-c");
        args.add(command);

        ProcessBuilder builder = new ProcessBuilder();
        List<String> cmdline = new ArrayList<>();
        cmdline.add(proot.getAbsolutePath());
        cmdline.addAll(args);
        builder.command(cmdline);
        builder.environment().put("PROOT_LOADER", loader.getAbsolutePath());
        builder.environment().put("PROOT_TMP_DIR", prootTmp.getAbsolutePath());
        builder.environment().put("PROOT_NO_SECCOMP", "1");
        builder.environment().put("HOME", "/root");
        builder.redirectErrorStream(false);

        Process process = null;
        try {
            process = builder.start();
            Drain out = new Drain(process.getInputStream());
            Drain err = new Drain(process.getErrorStream());
            out.start();
            err.start();

            boolean finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
            if (!finished) {
                process.destroyForcibly();
                out.join(1_000);
                err.join(1_000);
                JSObject ret = error("命令超时（" + timeoutMs + "ms）", 124);
                ret.put("stdout", out.text());
                ret.put("stderr", err.text());
                ret.put("durationMs", System.currentTimeMillis() - startedAt);
                ret.put("cwd", workDir);
                return ret;
            }
            out.join(2_000);
            err.join(2_000);

            JSObject ret = new JSObject();
            ret.put("exitCode", process.exitValue());
            ret.put("stdout", out.text());
            ret.put("stderr", err.text());
            ret.put("durationMs", System.currentTimeMillis() - startedAt);
            ret.put("cwd", workDir);
            ret.put("mock", false);
            return ret;
        } catch (Exception e) {
            if (process != null) process.destroyForcibly();
            JSObject ret = error("执行失败：" + e.getClass().getSimpleName() + " " + e.getMessage(), 1);
            ret.put("durationMs", System.currentTimeMillis() - startedAt);
            ret.put("cwd", workDir);
            return ret;
        }
    }

    private static JSObject error(String message, int exitCode) {
        JSObject ret = new JSObject();
        ret.put("exitCode", exitCode);
        ret.put("stdout", "");
        ret.put("stderr", message);
        ret.put("mock", false);
        return ret;
    }

    /** 读干一条流；输出封顶，避免某条命令把内存刷爆 */
    private static final class Drain extends Thread {
        private final InputStream in;
        private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();

        Drain(InputStream in) {
            this.in = in;
            setDaemon(true);
        }

        @Override
        public void run() {
            byte[] chunk = new byte[8 * 1024];
            try {
                int n;
                while ((n = in.read(chunk)) > 0) {
                    if (buffer.size() < MAX_OUTPUT) {
                        buffer.write(chunk, 0, Math.min(n, MAX_OUTPUT - buffer.size()));
                    }
                    // 超出上限后继续读但不保存，防止子进程被管道写满卡死
                }
            } catch (Exception ignored) {
                // 进程被 kill 时读端会抛，属正常结束
            }
        }

        String text() {
            String text = buffer.toString();
            if (buffer.size() >= MAX_OUTPUT) {
                text += "\n…（输出已截断）";
            }
            return text;
        }
    }
}
