package com.deepseek.web.terminal;

import android.content.Intent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 极薄的桥：只负责把 Web 层的「打开终端」变成一次 startActivity。 */
@CapacitorPlugin(name = "TermuxTerminal")
public class TermuxTerminalPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        Intent intent = new Intent(getContext(), TerminalActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
