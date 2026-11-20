package com.deepseek.web;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.deepseek.web.terminal.ShellExecutorPlugin;
import com.deepseek.web.terminal.TermuxTerminalPlugin;
import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    private static final int REQ_PERMISSIONS = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TermuxTerminalPlugin.class);
        registerPlugin(ShellExecutorPlugin.class);
        registerPlugin(ChatExportPlugin.class);
        super.onCreate(savedInstanceState);
        requestMissingPermissions();
    }

    /**
     * Android 6 起权限都要运行时申请，清单里写了不等于拿到。
     * 这里按版本挑合适的集合，一次全弹给用户。
     */
    private void requestMissingPermissions() {
        List<String> wanted = new ArrayList<>();
        int sdk = Build.VERSION.SDK_INT;

        if (sdk >= 33) {
            wanted.add(Manifest.permission.READ_MEDIA_IMAGES);
            wanted.add(Manifest.permission.READ_MEDIA_VIDEO);
            wanted.add(Manifest.permission.READ_MEDIA_AUDIO);
        } else {
            wanted.add(Manifest.permission.READ_EXTERNAL_STORAGE);
            if (sdk <= 28) {
                wanted.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);
            }
        }
        wanted.add(Manifest.permission.CAMERA);
        wanted.add(Manifest.permission.RECORD_AUDIO);

        List<String> missing = new ArrayList<>();
        for (String p : wanted) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                missing.add(p);
            }
        }
        if (missing.isEmpty()) return;

        ActivityCompat.requestPermissions(
                this, missing.toArray(new String[0]), REQ_PERMISSIONS);
    }
}
