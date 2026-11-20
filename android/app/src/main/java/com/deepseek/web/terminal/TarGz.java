package com.deepseek.web.terminal;

import android.system.Os;
import android.system.OsConstants;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.zip.GZIPInputStream;

/**
 * 极简 tar.gz 解包：只依赖 JDK，不引 commons-compress。
 * 支持 ustar、GNU 长文件名（typeflag 'L'）、PAX（'x'，只取 path）、目录、硬链接、软链接。
 * Alpine minirootfs 就这几种，够用。
 */
final class TarGz {

    private TarGz() {
    }

    interface Progress {
        void onExtract(String name);
    }

    static void extract(File tarGz, File destDir, Progress progress) throws Exception {
        if (!destDir.exists() && !destDir.mkdirs()) {
            throw new IllegalStateException("无法创建目录 " + destDir);
        }
        String destPath = destDir.getAbsolutePath();
        try (InputStream raw = new FileInputStream(tarGz);
             GZIPInputStream gz = new GZIPInputStream(raw, 1 << 16)) {
            byte[] header = new byte[512];
            String longName = null;
            String paxPath = null;
            long count = 0;
            while (true) {
                if (!readFully(gz, header)) break;
                if (isZeroBlock(header)) break;

                String name = string(header, 0, 100);
                String prefix = string(header, 345, 155);
                char type = (char) (header[156] == 0 ? '0' : header[156]);
                long size = octal(header, 124, 12);
                int mode = (int) octal(header, 100, 8);

                byte[] body = new byte[(int) Math.min(size, 64L << 20)];
                if (body.length > 0) readFully(gz, body);
                long padding = (512 - (size % 512)) % 512;
                skipFully(gz, padding);

                if (type == 'L') {                       // GNU long name
                    longName = string(body, 0, body.length).replace("\0", "");
                    continue;
                }
                if (type == 'x' || type == 'X') {        // PAX header
                    String pax = string(body, 0, body.length);
                    int idx = pax.indexOf("path=");
                    if (idx >= 0) {
                        int nl = pax.indexOf('\n', idx);
                        paxPath = pax.substring(idx + 5, nl < 0 ? pax.length() : nl).trim();
                    }
                    continue;
                }

                String path = paxPath != null ? paxPath : (longName != null ? longName
                        : (prefix.isEmpty() ? name : prefix + "/" + name));
                longName = null;
                paxPath = null;

                // 防目录穿越
                String clean = path.replaceFirst("^\\./", "");
                if (clean.isEmpty() || clean.contains("..")) continue;

                File target = new File(destDir, clean);
                if (!target.getAbsolutePath().startsWith(destPath)) continue;

                switch (type) {
                    case '5':
                        //noinspection ResultOfMethodCallIgnored
                        target.mkdirs();
                        setMode(target, mode);
                        break;
                    case '2': { // symlink
                        String linkName = string(header, 157, 100);
                        File parent = target.getParentFile();
                        if (parent != null) parent.mkdirs();
                        //noinspection ResultOfMethodCallIgnored
                        target.delete();
                        try {
                            Os.symlink(linkName, target.getAbsolutePath());
                        } catch (Exception ignored) {
                        }
                        break;
                    }
                    case '1': { // hardlink
                        String linkName = string(header, 157, 100).replaceFirst("^\\./", "");
                        File src = new File(destDir, linkName);
                        File parent = target.getParentFile();
                        if (parent != null) parent.mkdirs();
                        //noinspection ResultOfMethodCallIgnored
                        target.delete();
                        if (src.exists()) {
                            try {
                                Os.link(src.getAbsolutePath(), target.getAbsolutePath());
                            } catch (Exception e) {
                                copy(src, target);
                            }
                        }
                        break;
                    }
                    default: { // 普通文件 '0' 和 '7' 等
                        File parent = target.getParentFile();
                        if (parent != null) parent.mkdirs();
                        try (FileOutputStream out = new FileOutputStream(target)) {
                            out.write(body);
                        }
                        setMode(target, mode);
                        break;
                    }
                }
                if (progress != null && (++count % 200 == 0)) progress.onExtract(clean);
            }
        }
    }

    private static void copy(File src, File dst) {
        try (FileInputStream in = new FileInputStream(src);
             FileOutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } catch (Exception ignored) {
        }
    }

    /** 保留可执行位，Alpine 的 busybox 全靠这个；同时保证自己和 app 至少能读写，免得残留变成删不掉的只读文件。 */
    private static void setMode(File f, int mode) {
        int perm = mode & 0777;
        perm |= f.isDirectory() ? 0700 : 0600;
        try {
            Os.chmod(f.getAbsolutePath(), perm);
        } catch (Exception ignored) {
        }
        if ((mode & OsConstants.S_IXUSR) == 0 && f.isFile()) {
            try {
                Os.chmod(f.getAbsolutePath(), perm & ~0111);
            } catch (Exception ignored) {
            }
        }
    }

    private static boolean isZeroBlock(byte[] b) {
        for (byte v : b) if (v != 0) return false;
        return true;
    }

    private static String string(byte[] b, int off, int len) {
        int end = off;
        int max = Math.min(b.length, off + len);
        while (end < max && b[end] != 0) end++;
        return new String(b, off, end - off);
    }

    private static long octal(byte[] b, int off, int len) {
        long v = 0;
        for (int i = off; i < off + len; i++) {
            byte c = b[i];
            if (c == 0 || c == ' ') continue;
            if (c < '0' || c > '7') break;
            v = v * 8 + (c - '0');
        }
        return v;
    }

    private static boolean readFully(InputStream in, byte[] buf) throws Exception {
        int read = 0;
        while (read < buf.length) {
            int n = in.read(buf, read, buf.length - read);
            if (n < 0) return false;
            read += n;
        }
        return true;
    }

    private static void skipFully(InputStream in, long n) throws Exception {
        while (n > 0) {
            long skipped = in.skip(n);
            if (skipped <= 0) {
                if (in.read() < 0) return;
                skipped = 1;
            }
            n -= skipped;
        }
    }
}
