/**
 * public/idb-store.mjs — IndexedDB 记录存储适配器（阶段 3 交付）
 *
 * 实现 local-api.mjs 定义的存储适配器接口，供浏览器/WebView 使用：
 *   store.getAll(kind)                        → Promise<row[]>
 *   store.put(kind, row)                      → Promise<void>（无 id 自动生成；同 key 覆盖 = 更新）
 *   store.deleteBy(kind, key, value)          → Promise<void>（游标匹配删除）
 *   store.clear(kind)                         → Promise<void>（清空一个 store，测试/重置用）
 *   store.close()                             → Promise<void>（关闭连接，测试用）
 *
 * kind ∈ 'records' | 'favorites'（单用户，无 user_id 列）
 * - records  ：以自动生成 id 为 key 存储（addRecord 去重更新依赖 id 定位）
 * - favorites：以 question_id 为 key 存储（一题一收藏，天然覆盖更新）
 *
 * 与 server 版差异：stats 不落库，由 local-api.mjs aggregateStats 实时聚合。
 * 数据库版本升级：新增 objectStore 或改结构时 version+1，onupgradeneeded 增量建表。
 */
'use strict';

const DEFAULT_DB = 'kaogong-app';
const DEFAULT_VERSION = 2; // 2：新增 custom_batches / custom_questions（自定义题库，2026-08-15）
const STORES = ['records', 'favorites', 'custom_batches', 'custom_questions'];

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 数字自增 id（custom_batches / custom_questions 用，与服务端 AUTOINCREMENT 语义一致） */
async function nextNumericId(getAll, kind) {
  const rows = await getAll(kind);
  return rows.reduce((m, r) => Math.max(m, Number(r && r.id) || 0), 0) + 1;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dbName]   IndexedDB 数据库名（默认 kaogong-app）
 * @param {number} [opts.version]  数据库版本（默认 1）
 */
export function createIdbStore(opts = {}) {
  const dbName = opts.dbName || DEFAULT_DB;
  const version = opts.version || DEFAULT_VERSION;
  let dbPromise = null;
  let closed = false;

  function open() {
    if (dbPromise) return dbPromise;
    if (!(typeof indexedDB !== 'undefined' && indexedDB.open)) {
      return Promise.reject(new Error('当前环境不支持 IndexedDB'));
    }
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, version);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); // 无 keyPath，显式 key
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error(`打开 IndexedDB ${dbName} 失败`));
      req.onblocked = () => reject(new Error(`IndexedDB ${dbName} 被其他连接阻塞`));
    });
    return dbPromise;
  }

  /** 在单个事务内操作 objectStore，返回事务完成后的结果 */
  async function tx(kind, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let t;
      try {
        t = db.transaction(kind, mode);
      } catch (e) {
        reject(e);
        return;
      }
      const s = t.objectStore(kind);
      let fnResult;
      try {
        fnResult = fn(s);
      } catch (e) {
        t.abort();
        reject(e);
        return;
      }
      t.oncomplete = () => resolve(fnResult);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('事务中止'));
    });
  }

  /** 取行 key：records 用 id（缺失自动生成），favorites 用 question_id，custom_* 用数字自增 id */
  function rowKey(kind, row) {
    if (kind === 'records') {
      if (row.id == null) row.id = newId();
      return row.id;
    }
    if (kind === 'favorites') {
      if (row.question_id == null) throw new Error('favorites 行缺少 question_id');
      return String(row.question_id);
    }
    if (kind === 'custom_batches' || kind === 'custom_questions') {
      if (row.id == null) throw new Error(`${kind} 行缺少 id（应先分配数字自增 id）`);
      return Number(row.id);
    }
    throw new Error(`未知存储 kind: ${kind}`);
  }

  /** 内部：读取某 store 全部行（getAll 方法与 nextId 共用） */
  async function readAll(kind) {
    if (!STORES.includes(kind)) throw new Error(`未知存储 kind: ${kind}`);
    const rows = await tx(kind, 'readonly', (s) => {
      const out = [];
      return new Promise((resolve) => {
        const req = s.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) { out.push(cur.value); cur.continue(); }
          else resolve(out);
        };
      });
    });
    return rows;
  }

  return {
    async getAll(kind) {
      return readAll(kind);
    },

    async put(kind, row) {
      if (!STORES.includes(kind)) throw new Error(`未知存储 kind: ${kind}`);
      // 先求值 rowKey（records 会在 row 上补 id），再拷贝存储，保证值内含 id
      const key = rowKey(kind, row);
      await tx(kind, 'readwrite', (s) => {
        s.put({ ...row }, key);
      });
    },

    /** 分配数字自增 id（custom_batches / custom_questions） */
    async nextId(kind) {
      if (!STORES.includes(kind)) throw new Error(`未知存储 kind: ${kind}`);
      const rows = await readAll(kind);
      return rows.reduce((m, r) => Math.max(m, Number(r && r.id) || 0), 0) + 1;
    },

    async deleteBy(kind, key, value) {
      if (!STORES.includes(kind)) throw new Error(`未知存储 kind: ${kind}`);
      if (value == null) return; // 防御：空值不匹配任何行
      await tx(kind, 'readwrite', (s) => {
        return new Promise((resolve) => {
          // 记录以 id 为 key：直接用 key 删除（O(1)）
          if (key === 'id') {
            s.delete(value);
            resolve();
            return;
          }
          // 其余字段：游标匹配删除
          const req = s.openCursor();
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) { resolve(); return; }
            if (cur.value && cur.value[key] === value) cur.delete();
            cur.continue();
          };
        });
      });
    },

    async clear(kind) {
      if (!STORES.includes(kind)) throw new Error(`未知存储 kind: ${kind}`);
      await tx(kind, 'readwrite', (s) => { s.clear(); });
    },

    async close() {
      if (dbPromise) {
        const db = await dbPromise.catch(() => null);
        if (db) db.close();
      }
      dbPromise = null;
      closed = true;
    },
  };
}

// 非 module 环境（file:// 调试 / 内联测试）全局挂载
if (typeof globalThis !== 'undefined' && !globalThis.createIdbStore) {
  globalThis.createIdbStore = createIdbStore;
}
