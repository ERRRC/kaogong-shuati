// sqljs-engine.mjs — 浏览器端用 sql.js 打开离线题库（tiku_app.db.gz）
// 提供与 Node 版 sqlite 一致的 { get, all, run } 接口，供 local-api / local-handler 使用。
// Capacitor App 中阶段 5 可换成 capacitor-sqlite（接口不变）。

const WASM_DIR = './vendor/sqljs/';
const IMAGES_DB = 'kaogong_images_db';
const IMAGES_STORE = 'images';

// ================= 原生 SQLite 同步桥（Capacitor App 主路径，替代 sql.js） =================
// MainActivity 通过 addJavascriptInterface 注入 window.NativeDB：
//   open() -> 'ok' | 'error: ...'
//   get(sql, paramsJson) / all(sql, paramsJson) -> JSON 字符串；blob 列包装为 {"__b64":"..."}
// 题库 136MB 在原生侧只读打开（按页读取），不再进入 WebView JS 堆，首启内存峰值大幅下降。

function normParams(params) {
  return params.map((p) => (p == null ? null : p));
}

/** 还原原生桥 JSON 中的 blob 包装（{"__b64":...} → Uint8Array），与 sql.js getAsObject 结构一致 */
function reviveNativeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v && typeof v === 'object' && typeof v.__b64 === 'string') {
      const bin = atob(v.__b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      out[k] = bytes;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function parseNativeResult(s) {
  if (typeof s === 'string' && s.startsWith('{"__error"')) {
    throw new Error(s.slice(9, s.length - 1));
  }
  return s;
}

/**
 * 打开原生 SQLite 引擎（window.NativeDB）。接口与 loadSqljsEngine 一致 { get, all, run, close }。
 */
export function loadNativeEngine() {
  if (!window.NativeDB) throw new Error('NativeDB 桥不可用');
  const NativeDB = window.NativeDB;
  const res = NativeDB.open();
  if (res !== 'ok') throw new Error('原生题库打开失败：' + res);
  return {
    get(sql, ...params) {
      const r = parseNativeResult(NativeDB.get(sql, JSON.stringify(normParams(params))));
      if (r === 'null') return undefined;
      return reviveNativeRow(JSON.parse(r));
    },
    all(sql, ...params) {
      const r = parseNativeResult(NativeDB.all(sql, JSON.stringify(normParams(params))));
      return JSON.parse(r).map(reviveNativeRow);
    },
    run() {
      throw new Error('只读引擎不支持 run');
    },
    close() {},
  };
}

/** 原生桥版本：images.db 公式图 → IndexedDB（b64 解码后与 sql.js 导入结果一致） */
export async function importImagesFromNative(images) {
  const rows = images.all('SELECT key, mime, blob FROM images');
  if (!rows.length) return;
  const db = await openImagesIdb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGES_STORE, 'readwrite');
    const store = tx.objectStore(IMAGES_STORE);
    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result > 0) return resolve(); // 已导入过
      for (const row of rows) {
        store.put({ mime: row.mime || 'image/png', blob: new Blob([row.blob], { type: row.mime || 'image/png' }) }, row.key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    countReq.onerror = () => reject(countReq.error);
  });
  console.log(`公式图已就绪：${rows.length} 张（IndexedDB，原生桥）`);
}

// ================= sql.js 引擎（浏览器联调 / 原生桥不可用时的兜底） =================

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('加载 ' + src + ' 失败'));
    document.head.appendChild(s);
  });
}

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载题库失败：HTTP ${r.status} (${url})`);
  const ct = r.headers.get('Content-Type') || '';
  const raw = new Uint8Array(await r.arrayBuffer());
  if (url.endsWith('.gz') || ct.includes('gzip')) {
    const ds = new DecompressionStream('gzip');
    const stream = new Response(raw).body.pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return raw;
}

let sqljsInitPromise = null;
async function ensureInitSqlJs() {
  if (!sqljsInitPromise) {
    sqljsInitPromise = (async () => {
      await loadScript(WASM_DIR + 'sql-wasm.js');
      return window.initSqlJs({
        locateFile: () => new URL(WASM_DIR + 'sql-wasm.wasm', location.href).href,
      });
    })();
  }
  return sqljsInitPromise;
}

/**
 * 打开 sql.js 题库引擎。
 * @param {object} opts { gzUrl: 题库 gz 地址, imagesUrl?: images.db 地址（用于公式图导入） }
 */
export async function loadSqljsEngine({ gzUrl, imagesUrl }) {
  const SQL = await ensureInitSqlJs();
  const buf = await fetchBuf(gzUrl);
  const db = new SQL.Database(buf);

  const engine = {
    get(sql, ...params) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        return stmt.step() ? stmt.getAsObject() : undefined;
      } finally {
        stmt.free();
      }
    },
    all(sql, ...params) {
      const stmt = db.prepare(sql);
      const out = [];
      try {
        stmt.bind(params);
        while (stmt.step()) out.push(stmt.getAsObject());
      } finally {
        stmt.free();
      }
      return out;
    },
    run(sql, ...params) {
      db.run(sql, params);
    },
    close() {
      db.close();
    },
  };

  // 公式图 images.db → IndexedDB（供 Service Worker 离线返回 /api/formulas 图片）
  if (imagesUrl) {
    try {
      await importImagesToIdb(imagesUrl, SQL);
    } catch (e) {
      console.warn('公式图导入失败（不影响题库使用）：', e.message);
    }
  }

  return engine;
}

async function importImagesToIdb(imagesUrl, SQL) {
  const raw = await fetchBuf(imagesUrl);
  const imgDb = new SQL.Database(raw);
  const rows = [];
  try {
    const stmt = imgDb.prepare('SELECT key, mime, blob FROM images');
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
  } finally {
    imgDb.close();
  }
  if (!rows.length) return;

  const db = await openImagesIdb();

  await new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGES_STORE, 'readwrite');
    const store = tx.objectStore(IMAGES_STORE);
    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result > 0) return resolve(); // 已导入过
      for (const row of rows) {
        store.put({ mime: row.mime || 'image/png', blob: new Blob([row.blob], { type: row.mime || 'image/png' }) }, row.key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
  console.log(`公式图已就绪：${rows.length} 张（IndexedDB）`);
}

function openImagesIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IMAGES_DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(IMAGES_STORE)) d.createObjectStore(IMAGES_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
