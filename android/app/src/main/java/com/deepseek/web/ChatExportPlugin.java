package com.deepseek.web;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 聊天记录落盘：把前端生成的 Markdown 写进公共的 /sdcard/Download。
 *
 * Android 10 起公共目录不能直接 File 写，只能走 MediaStore（自己的分区自己说了算）；
 * 10 以下没有 MediaStore.Downloads，退回老路子，靠清单里的 WRITE_EXTERNAL_STORAGE。
 * 文件名交给系统去重（同名会自动变成 name (1).md），不在前端做，省得两边规则打架。
 */
@CapacitorPlugin(name = "ChatExport")
public class ChatExportPlugin extends Plugin {

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        final String filename = safeName(call.getString("filename", "deepseek-chat.md"));
        final String content = call.getString("content", "");

        new Thread(() -> {
            try {
                String path = Build.VERSION.SDK_INT >= 29
                        ? saveWithMediaStore(filename, content)
                        : saveWithFile(filename, content);
                JSObject ret = new JSObject();
                ret.put("path", path);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("保存到 Download 失败：" + e.getMessage(), e);
            }
        }, "chat-export").start();
    }

    private String saveWithMediaStore(String filename, String content) throws Exception {
        Context ctx = getContext();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(filename));
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        Uri uri = ctx.getContentResolver()
                .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IllegalStateException("系统没有给出可写的位置");
        }
        try (OutputStream out = ctx.getContentResolver().openOutputStream(uri)) {
            if (out == null) {
                throw new IllegalStateException("打开文件失败");
            }
            out.write(content.getBytes("UTF-8"));
            out.flush();
        }
        return Environment.DIRECTORY_DOWNLOADS + "/" + filename;
    }

    private String saveWithFile(String filename, String content) throws Exception {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("无法创建 Download 目录");
        }
        File target = new File(dir, filename);
        try (FileOutputStream out = new FileOutputStream(target)) {
            out.write(content.getBytes("UTF-8"));
        }
        return target.getAbsolutePath();
    }

    /** 只留安全字符，避免把路径分隔符带进去 */
    private static String safeName(String name) {
        String cleaned = name.replaceAll("[\\\\/:*?\"<>|\n\r\t]", "-").trim();
        return cleaned.isEmpty() ? "deepseek-chat.md" : cleaned;
    }

    private static String mimeOf(String name) {
        String lower = name.toLowerCase();
        if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }
}
