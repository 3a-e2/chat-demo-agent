package com.deepseek.web.terminal;

import android.content.Context;
import android.os.Build;
import android.system.Os;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Alpine 的 minirootfs 管理：下载、解包、写入最小可用配置。
 *
 * 为什么是 Alpine 而不是 Termux 的 bootstrap：Termux 那套 deb 里所有二进制的
 * rpath 和解释器都写死了 /data/data/com.termux/files/usr，我们的包名不是这个，
 * 前缀对不上根本跑不起来。Alpine 的 minirootfs 是自包含的（busybox + apk + musl），
 * 交给 proot 做路径重映射，`apk add` 就是真的包管理器。
 */
final class RootfsManager {

    private static final String VERSION = "3.20.10";

    private RootfsManager() {
    }

    interface Progress {
        void onStatus(String text);

        void onPercent(int percent);
    }

    static File rootfsDir(Context ctx) {
        return new File(ctx.getFilesDir(), "alpine");
    }

    static boolean isInstalled(Context ctx) {
        File rootfs = rootfsDir(ctx);
        return new File(rootfs, "bin/busybox").exists() && new File(rootfs, "sbin/apk").exists();
    }

    /** 主 ABI 决定下哪个 rootfs。 */
    private static String alpineArch() {
        String abi = Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "arm64-v8a";
        switch (abi) {
            case "armeabi-v7a":
            case "armeabi":
                return "armv7";
            case "x86_64":
                return "x86_64";
            case "x86":
                return "x86";
            case "arm64-v8a":
            default:
                return "aarch64";
        }
    }

    private static String downloadUrl() {
        String arch = alpineArch();
        return "https://dl-cdn.alpinelinux.org/alpine/v" + VERSION.substring(0, 4)
                + "/releases/" + arch + "/alpine-minirootfs-" + VERSION + "-" + arch + ".tar.gz";
    }

    static void install(Context ctx, Progress cb) throws Exception {
        File rootfs = rootfsDir(ctx);
        File cache = new File(ctx.getCacheDir(), "alpine-rootfs.tar.gz");

        // 1. 下载
        cb.onStatus("正在下载 Alpine " + VERSION + "…");
        download(downloadUrl(), cache, cb);

        // 2. 清掉旧 rootfs 再解包
        cb.onStatus("正在解包…");
        cb.onPercent(0);
        // 上次中断可能留下只读目录或断链软链，普通 delete 删不掉，先放开权限再删一遍
        deleteRecursive(rootfs);
        if (rootfs.exists()) {
            forceWritable(rootfs);
            deleteRecursive(rootfs);
        }
        if (!rootfs.isDirectory() && !rootfs.mkdirs()) {
            throw new IOException("无法创建 rootfs 目录：" + rootfs.getAbsolutePath()
                    + "（已存在=" + rootfs.exists() + "，是目录=" + rootfs.isDirectory()
                    + "，可写=" + rootfs.canWrite() + "）");
        }

        final int[] last = {-1};
        TarGz.extract(cache, rootfs, name -> {
            if (name.startsWith("bin/") || name.startsWith("sbin/") || name.startsWith("usr/")) {
                int p = Math.min(99, 10 + Math.abs(name.hashCode() % 90));
                if (p != last[0]) {
                    last[0] = p;
                    cb.onPercent(p);
                }
            }
        });

        // 2.5 解包完整性校验：缺 busybox 说明包残缺或解包失败，删掉半成品免得下次误判
        if (!new File(rootfs, "bin/busybox").exists()) {
            deleteRecursive(rootfs);
            throw new IOException("解包后缺少 bin/busybox，rootfs 不完整，请重试");
        }

        // 3. 最小配置：DNS（Android 没有 /etc/resolv.conf 可用）、apk 源走 http 以免缺 CA
        cb.onStatus("正在写入基础配置…");
        write(new File(rootfs, "etc/resolv.conf"),
                "nameserver 223.5.5.5\nnameserver 8.8.8.8\nnameserver 1.1.1.1\n");
        write(new File(rootfs, "etc/apk/repositories"),
                "http://dl-cdn.alpinelinux.org/alpine/v" + VERSION.substring(0, 4) + "/main\n"
                        + "http://dl-cdn.alpinelinux.org/alpine/v" + VERSION.substring(0, 4) + "/community\n");
        write(new File(rootfs, "etc/hostname"), "alpine\n");
        new File(rootfs, "root").mkdirs();
        new File(rootfs, "tmp").mkdirs();

        //noinspection ResultOfMethodCallIgnored
        cache.delete();
        cb.onPercent(100);
        cb.onStatus("完成");
    }

    /**
     * 带断点续传的下载。实测这个 CDN 经常在传了一半时直接掐连接
     * （我这边 4MB 的包被截断过三次），所以必须支持 Range 续传并校验总长，
     * 否则解包会拿到残缺的 tar.gz。
     */
    private static void download(String urlStr, File dest, Progress cb) throws Exception {
        //noinspection ResultOfMethodCallIgnored
        dest.delete();
        long total = -1;
        int lastPct = -1;

        for (int attempt = 0; attempt < 12; attempt++) {
            long have = dest.exists() ? dest.length() : 0;
            if (total > 0 && have >= total) break;

            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(urlStr).openConnection();
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(30000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "DeepSeekTerminal/1.0");
                if (have > 0) conn.setRequestProperty("Range", "bytes=" + have + "-");

                int code = conn.getResponseCode();
                if (code != 200 && code != 206) throw new IOException("HTTP " + code);
                if (code == 200) {
                    // 服务器不认 Range，只能从头来
                    have = 0;
                    //noinspection ResultOfMethodCallIgnored
                    dest.delete();
                }
                long len = conn.getContentLength();
                if (len > 0) total = have + len;

                try (InputStream in = conn.getInputStream();
                     OutputStream out = new FileOutputStream(dest, have > 0)) {
                    byte[] buf = new byte[64 * 1024];
                    long done = have;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        done += n;
                        if (total > 0) {
                            int pct = (int) (done * 100 / total);
                            if (pct != lastPct) {
                                lastPct = pct;
                                cb.onPercent(pct);
                            }
                        }
                    }
                }
                // 读干净了但长度不够，说明是被掐断的，继续下一轮续传
                if (total <= 0 || dest.length() >= total) break;
                cb.onStatus("下载中断，正在续传…");
            } catch (IOException e) {
                if (attempt == 11) throw e;
                if (dest.exists() && dest.length() == 0) {
                    //noinspection ResultOfMethodCallIgnored
                    dest.delete();
                }
                cb.onStatus("网络抖动，正在重试…");
                try {
                    Thread.sleep(500);
                } catch (InterruptedException ignored) {
                }
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        if (total > 0 && dest.length() < total) {
            throw new IOException("下载不完整 " + dest.length() + "/" + total);
        }
        if (!dest.exists() || dest.length() < 1024) {
            throw new IOException("下载失败：文件为空");
        }
    }

    private static void write(File f, String content) throws IOException {
        File parent = f.getParentFile();
        if (parent != null) parent.mkdirs();
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(content.getBytes("UTF-8"));
        }
    }

    /** 递归放开权限：只读目录会让 delete() 静默失败 */
    private static void forceWritable(File f) {
        if (f == null) return;
        try {
            Os.chmod(f.getAbsolutePath(), f.isDirectory() ? 0700 : 0600);
        } catch (Exception ignored) {
        }
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) forceWritable(c);
        }
    }

    static void deleteRecursive(File f) {
        if (f == null) return;
        if (!f.exists()) {
            // 断链的符号链接 exists() 为 false，但目录项还在，照样要删
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            return;
        }
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) deleteRecursive(c);

        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
