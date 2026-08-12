// sw-local.js — App 本地模式的 Service Worker：图片资源离线化
//   - 公式图（URL 含 formulas?latex=...）→ 从 IndexedDB kaogong_images_db 取 blob 返回
//   - 真图形（URL 含 /tarzan/images/）→ IndexedDB kaogong_imgcache_db 命中直接返回；
//     未命中则联网拉取并缓存，联网失败返回“需联网”占位图
// 优点：img 标签的 src 无需任何改动（UI 零侵入），断网时自动降级。

const IMAGES_DB = 'kaogong_images_db';
const IMAGES_STORE = 'images';
const CACHE_DB = 'kaogong_imgcache_db';
const CACHE_STORE = 'imgs';

const PLACEHOLDER_SVG = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="100%" height="100%" fill="#f2f2f7"/><text x="50%" y="50%" font-size="14" fill="#999" text-anchor="middle" dominant-baseline="middle">图片需联网查看</text></svg>`,
)}`;

function idbGet(dbName, storeName, key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(storeName)) d.createObjectStore(storeName);
    };
    req.onsuccess = () => {
      const d = req.result;
      const tx = d.transaction(storeName, 'readonly');
      const r = tx.objectStore(storeName).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    };
    req.onerror = () => reject(req.error);
  });
}

function idbPut(dbName, storeName, key, value) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(storeName)) d.createObjectStore(storeName);
    };
    req.onsuccess = () => {
      const d = req.result;
      const tx = d.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

function placeholderResponse() {
  return new Response(new Uint8Array([]), {
    status: 200,
    headers: { 'Content-Type': 'image/svg+xml', 'X-Offline-Placeholder': '1' },
  });
}

// SVG data URL 没法直接作为 Response body，这里用 fetch(dataURL) 转
async function placeholderWithImage() {
  try {
    const r = await fetch(PLACEHOLDER_SVG);
    const buf = await r.arrayBuffer();
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml', 'X-Offline-Placeholder': '1' },
    });
  } catch {
    return placeholderResponse();
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 公式图（本地重写路径）：/formula/<key> → IndexedDB 本地 blob（Capacitor/浏览器同源路径，SW 可拦截）
  const fm = url.pathname.match(/^\/formula\/(.+)$/);
  if (fm) {
    e.respondWith(
      (async () => {
        try {
          const key = decodeURIComponent(fm[1]);
          const hit = await idbGet(IMAGES_DB, IMAGES_STORE, key);
          if (hit && hit.blob) {
            return new Response(hit.blob, { status: 200, headers: { 'Content-Type': hit.mime || 'image/png' } });
          }
        } catch {
          /* 忽略 */
        }
        return placeholderWithImage();
      })(),
    );
    return;
  }

  // 公式图（旧路径兼容）：URL 含 formulas?latex=
  if (url.searchParams.has('latex') && /formulas/i.test(url.href)) {
    e.respondWith(
      (async () => {
        try {
          const hit = await idbGet(IMAGES_DB, IMAGES_STORE, url.searchParams.get('latex'));
          if (hit && hit.blob) {
            return new Response(hit.blob, { status: 200, headers: { 'Content-Type': hit.mime || 'image/png' } });
          }
        } catch {
          /* 继续走网络 */
        }
        try {
          const net = await fetch(e.request);
          if (net.ok) return net;
        } catch {
          /* 离线 */
        }
        return placeholderWithImage();
      })(),
    );
    return;
  }

  // 真图形：先缓存，后网络
  if (/\/tarzan\/images\//i.test(url.href)) {
    e.respondWith(
      (async () => {
        try {
          const hit = await idbGet(CACHE_DB, CACHE_STORE, url.href);
          if (hit && hit.blob) {
            return new Response(hit.blob, { status: 200, headers: { 'Content-Type': hit.mime || 'image/png' } });
          }
        } catch {
          /* 忽略 */
        }
        try {
          const net = await fetch(e.request, { cache: 'no-store' });
          if (net.ok) {
            const blob = await net.clone().blob();
            idbPut(CACHE_DB, CACHE_STORE, url.href, { blob, mime: blob.type || 'image/png' }).catch(() => {});
            return net;
          }
        } catch {
          /* 离线 → 占位 */
        }
        return placeholderWithImage();
      })(),
    );
  }
});
