package com.kaogong.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // debug 构建下强制开启 WebView 远程调试（方便本地排查；release 自动跳过）
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            android.webkit.WebView.setWebContentsDebuggingEnabled(true);
        }
        try {
            // 原生 SQLite 同步桥：注入 window.NativeDB（替代 sql.js 整体加载题库，
            // 首启内存从 ~270MB 降到几十 MB；不可用时前端自动回退 sql.js）
            getBridge().getWebView().addJavascriptInterface(new NativeDbBridge(this), "NativeDB");
        } catch (Throwable t) {
            android.util.Log.w("NativeDB", "bridge 注册失败（将回退 sql.js）：" + t.getMessage());
        }
    }
}
