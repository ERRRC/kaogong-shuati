package com.kaogong.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

/**
 * 原生 SQLite 同步桥（替代 sql.js + WASM 整体加载题库）：
 * - 首次启动把 assets 中 136MB 题库流式复制到应用私有目录（此后跳过），以只读方式打开；
 * - 通过 addJavascriptInterface 暴露同步查询（open/all/get），JS 侧同步拿到 JSON；
 * - 题库不再进入 WebView JS 堆，首启内存峰值从 ~270MB 降到几十 MB，低端机不再白屏/OOM；
 * - images.db（公式图）由同一桥按 SQL 内容路由，blob 列以 {"__b64": "..."} 包装返回，
 *   JS 适配层还原为 Uint8Array，与 sql.js 的 getAsObject 结构一致，上层代码零改动。
 *
 * 线程模型：@JavascriptInterface 方法运行在 Chromium JavaBridge 线程（非 UI 线程），
 * SQLiteDatabase 连接线程安全；JS 单线程同步调用，无并发问题。
 */
public class NativeDbBridge {

    private final Context context;
    private SQLiteDatabase tikuDb;
    private SQLiteDatabase imagesDb;

    public NativeDbBridge(Context context) {
        this.context = context;
    }

    /** 初始化：复制 assets 题库到私有目录并打开只读连接。返回 "ok" 或错误信息。 */
    @JavascriptInterface
    public String open() {
        try {
            openIfNeeded();
            return "ok";
        } catch (Throwable t) {
            return "error: " + t.getMessage();
        }
    }

    private void openIfNeeded() throws Exception {
        if (tikuDb == null || !tikuDb.isOpen()) {
            File f = copyAssetIfNeeded("public/app-assets/tiku_app.db", "tiku_app.db");
            tikuDb = SQLiteDatabase.openDatabase(f.getAbsolutePath(), null,
                    SQLiteDatabase.OPEN_READONLY | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
        }
        if (imagesDb == null || !imagesDb.isOpen()) {
            File f = copyAssetIfNeeded("public/app-assets/images.db", "images.db");
            imagesDb = SQLiteDatabase.openDatabase(f.getAbsolutePath(), null,
                    SQLiteDatabase.OPEN_READONLY | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
        }
    }

    /** 多行查询：返回 JSON 数组字符串。 */
    @JavascriptInterface
    public String all(String sql, String paramsJson) {
        try {
            openIfNeeded();
            return queryRows(pickDb(sql), sql, parseParams(paramsJson)).toString();
        } catch (Throwable t) {
            return errorJson(t);
        }
    }

    /** 单行查询：返回 JSON 对象字符串；未命中返回 "null"。 */
    @JavascriptInterface
    public String get(String sql, String paramsJson) {
        try {
            openIfNeeded();
            JSONArray rows = queryRows(pickDb(sql), sql, parseParams(paramsJson));
            return rows.length() > 0 ? rows.get(0).toString() : "null";
        } catch (Throwable t) {
            return errorJson(t);
        }
    }

    /** 按 SQL 内容路由到对应库（images 表 → images.db，其余 → tiku_app.db）。 */
    private SQLiteDatabase pickDb(String sql) {
        String s = sql == null ? "" : sql;
        boolean images = s.contains("FROM images") || s.contains("from images");
        return images ? imagesDb : tikuDb;
    }

    private JSONArray queryRows(SQLiteDatabase db, String sql, String[] args) throws org.json.JSONException {
        JSONArray rows = new JSONArray();
        try (Cursor c = db.rawQuery(sql, args)) {
            int n = c.getColumnCount();
            String[] cols = c.getColumnNames();
            while (c.moveToNext()) {
                JSONObject row = new JSONObject();
                for (int i = 0; i < n; i++) {
                    row.put(cols[i], colValue(c, i));
                }
                rows.put(row);
            }
        }
        return rows;
    }

    private Object colValue(Cursor c, int i) {
        switch (c.getType(i)) {
            case Cursor.FIELD_TYPE_INTEGER:
                return c.getLong(i);
            case Cursor.FIELD_TYPE_FLOAT:
                return c.getDouble(i);
            case Cursor.FIELD_TYPE_BLOB:
                try {
                    JSONObject o = new JSONObject();
                    o.put("__b64", Base64.encodeToString(c.getBlob(i), Base64.NO_WRAP));
                    return o;
                } catch (Exception e) {
                    return JSONObject.NULL;
                }
            case Cursor.FIELD_TYPE_NULL:
                return JSONObject.NULL;
            default:
                return c.getString(i);
        }
    }

    private String[] parseParams(String json) {
        if (json == null || json.isEmpty() || json.equals("null")) return null;
        try {
            JSONArray arr = new JSONArray(json);
            String[] out = new String[arr.length()];
            for (int i = 0; i < arr.length(); i++) {
                Object v = arr.get(i);
                out[i] = v == null || v == JSONObject.NULL ? null : String.valueOf(v);
            }
            return out;
        } catch (Throwable t) {
            return null;
        }
    }

    private String errorJson(Throwable t) {
        String m = t.getMessage() == null ? t.toString() : t.getMessage();
        return "{\"__error\":\"" + m.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}";
    }

    /** 流式复制 assets 文件到私有目录（已存在且非空则跳过；先写 .tmp 再改名，避免半截文件）。 */
    private File copyAssetIfNeeded(String assetPath, String name) throws Exception {
        File dir = new File(context.getFilesDir(), "db");
        if (!dir.exists() && !dir.mkdirs()) throw new RuntimeException("无法创建数据库目录");
        File target = new File(dir, name);
        if (target.exists() && target.length() > 0) return target;
        File tmp = new File(dir, name + ".tmp");
        AssetManager am = context.getAssets();
        try (InputStream in = am.open(assetPath); FileOutputStream out = new FileOutputStream(tmp)) {
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        if (!tmp.renameTo(target)) {
            if (tmp.exists()) tmp.delete();
            throw new RuntimeException("题库文件就位失败: " + name);
        }
        return target;
    }
}
