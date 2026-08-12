// sqljs-engine.mjs — 浏览器端用 sql.js 打开离线题库（tiku_app.db.gz）
// 提供与 Node 版 sqlite 一致的 { get, all, run } 接口，供 local-api / local-handler 使用。
// Capacitor App 中阶段 5 可换成 capacitor-sqlite（接口不变）。

const WASM_DIR = './vendor/sqljs/';
const IMAGES_DB = 'kaogong_images_db';
const IMAGES_STORE = 'images';

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

  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(IMAGES_DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(IMAGES_STORE)) d.createObjectStore(IMAGES_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

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
