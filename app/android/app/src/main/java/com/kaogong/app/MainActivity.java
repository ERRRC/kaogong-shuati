package com.kaogong.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 始终开启 WebView 远程调试（本地联调/真机验证用；仅本机 adb forward 可连，无安全影响）
        android.webkit.WebView.setWebContentsDebuggingEnabled(true);
        try {
            // 原生 SQLite 同步桥：注入 window.NativeDB（替代 sql.js 整体加载题库，
            // 首启内存从 ~270MB 降到几十 MB；不可用时前端自动回退 sql.js）
            getBridge().getWebView().addJavascriptInterface(new NativeDbBridge(this), "NativeDB");
        } catch (Throwable t) {
            android.util.Log.w("NativeDB", "bridge 注册失败（将回退 sql.js）：" + t.getMessage());
        }
    }
}
