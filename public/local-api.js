/**
 * public/local-api.js — App 版离线数据层（阶段 2 交付）
 *
 * 在浏览器/WebView 中提供与 server.mjs 等价的查询/记录接口：
 *   查询面  —— 复用 lib/local-queries.mjs（SQL 与 server 逐字段对齐，本文件仅注入引擎适配器）
 *   记录面  —— 收藏/做题记录/错题本/统计（存储适配器；IndexedDB 实现在阶段 3，本文件定义接口 + 纯函数聚合）
 *   图片    —— images.db 公式图查询 + 真图形缓存接口
 *
 * 引擎适配器（调用方按运行环境注入其一）：
 *   - node：node:sqlite（开发/测试，见 test-local-api.mjs）
 *   - App：CapacitorSQLite 插件（阶段 5）
 *   - 浏览器调试：sql.js + gz 资源
 * 记录存储适配器（阶段 3 提供 IndexedDB 实现）：
 *   store.getAll(kind) / store.put(kind, row) / store.deleteBy(kind, key, value)
 *   kind ∈ 'records' | 'favorites'
 */

import { createLocalApi } from './lib/local-queries.js';
import { createIdbStore } from './idb-store.js';

// ---------- 统计聚合（纯函数，可单测） ----------
/**
 * 由本地做题记录聚合统计。
 * @param {Array} records [{ question_id, subject, chapter, is_correct }]
 * @param {object} tiku 题库引擎（聚合申论/综应索引子项 done 时需查 question_categories）
 * @returns {{ doneBySubject: Map, chapterStats: Map, subStats: Map }}
 */
export function aggregateStats(records, tiku) {
  const doneBySubject = new Map();
  const chapterStats = new Map();
  const subStats = new Map();
  const seenCorrect = new Set();
  for (const r of records) {
    if (!r.subject) continue;
    if (r.is_correct) {
      const k = `${r.subject}|${r.question_id}`;
      if (!seenCorrect.has(k)) { seenCorrect.add(k); doneBySubject.set(r.subject, (doneBySubject.get(r.subject) || 0) + 1); }
    }
    if (r.chapter) {
      if (!chapterStats.has(r.subject)) chapterStats.set(r.subject, new Map());
      const cs = chapterStats.get(r.subject);
      const cur = cs.get(r.chapter) || { c: 0, ok: 0 };
      cur.c += 1;
      if (r.is_correct) cur.ok += 1;
      cs.set(r.chapter, cur);
    }
  }
  // 索引子项 done（申论/综应）：正确记录经 question_categories 映射到 category|sub
  if (tiku && records.some((r) => r.is_correct)) {
    const correctIds = records.filter((r) => r.is_correct && r.question_id != null).map((r) => r.question_id);
    const subjOf = new Map(records.filter((r) => r.is_correct).map((r) => [r.question_id, r.subject]));
    for (let i = 0; i < correctIds.length; i += 500) {
      const chunk = correctIds.slice(i, i + 500);
      const rows = tiku.all(
        `SELECT question_id, subject, category, sub FROM question_categories WHERE question_id IN (${chunk.map(() => '?').join(',')})`,
        ...chunk
      );
      for (const qc of rows) {
        const subject = subjOf.get(qc.question_id);
        if (!subject) continue;
        if (!subStats.has(subject)) subStats.set(subject, new Map());
        const m = subStats.get(subject);
        m.set(`${qc.category}|${qc.sub}`, (m.get(`${qc.category}|${qc.sub}`) || 0) + 1);
      }
    }
  }
  return { doneBySubject, chapterStats, subStats };
}

// ---------- 记录层（存储适配器接口） ----------
export function createRecordsApi(store, tiku, onChanged) {
  return {
    /** 收藏列表（与 /api/favorites GET 同构：{list,total,offset,limit,hasMore}） */
    async favorites({ limit = 50, offset = 0 } = {}) {
      const rows = await store.getAll('favorites');
      rows.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      const total = rows.length;
      const page = rows.slice(offset, offset + limit);
      const list = [];
      for (const r of page) {
        const q = tiku.get('SELECT content, contentHtml, type FROM questions WHERE questionId = ? LIMIT 1', r.question_id);
        list.push({
          questionId: r.question_id,
          subject: r.subject || '',
          chapter: r.chapter || '',
          time: r.created_at,
          content: q?.content ? q.content.slice(0, 80) : (q?.contentHtml ? '（图片题）' : null),
          type: q?.type ?? null,
        });
      }
      return { list, total, offset, limit, hasMore: offset + list.length < total };
    },
    /** 收藏添加/取消（与 /api/favorites POST/DELETE 同构） */
    async toggleFavorite(questionId, { subject = '', chapter = '' } = {}) {
      if (questionId == null) throw new Error('缺少 questionId');
      const existing = await store.getAll('favorites');
      const found = existing.some((f) => f.question_id === questionId);
      if (found) await store.deleteBy('favorites', 'question_id', questionId);
      else await store.put('favorites', { question_id: questionId, subject, chapter, created_at: Date.now() });
      return { ok: true };
    },
    /** 收藏状态（App 启动时批量预载） */
    async favoriteIds() {
      const rows = await store.getAll('favorites');
      return new Set(rows.map((r) => r.question_id));
    },
    /** 提交做题记录（与 /api/records POST 同构；同卷同题同日去重，重复则更新） */
    async addRecord({ questionId, subject, chapter, type, selected, correct, costMs, paperId }) {
      if (questionId == null) throw new Error('缺少 questionId');
      const now = Date.now();
      // 按本地时区（中国 UTC+8）取当天零点：UTC 零点会在上午 8 点前把记录归到前一天，
      // 导致“每天去重”失效与每日统计错位。
      const d = new Date(now);
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      // 同日去重只针对非错题记录（正确/主观题记录）；错题记录不参与去重——错题保护：
      // 当天做对不覆盖错题记录（需累计 3 个日期做对才自动移除），做错记录始终保留
      const existing = (await store.getAll('records')).filter(
        (r) => r.question_id === questionId && r.paper_id === (paperId ?? null) && r.created_at >= dayStart && r.is_correct !== 0
      );
      const row = { question_id: questionId, paper_id: paperId ?? null, subject: subject || '', chapter: chapter || '', question_type: type ?? null, selected: selected ?? null, is_correct: correct ? 1 : 0, cost_ms: costMs ?? null, created_at: now };
      if (existing.length) await store.deleteBy('records', 'id', existing[0].id);
      await store.put('records', row);
      // 错题自动移除：客观题累计做对 3 次（按不同日期计，与 server 口径一致）→ 删除该题错题记录，正确记录与统计保留
      // 只针对行测/职测客观题（错题本收录范围）；主观题（correct=null）不参与
      if (correct === true) {
        const all = await store.getAll('records');
        const okDays = new Set(
          all.filter((r) => r.question_id === questionId && r.is_correct === 1)
            .map((r) => new Date(r.created_at).toDateString())
        );
        if (okDays.size >= 3) {
          for (const r of all) {
            if (r.question_id === questionId && r.is_correct === 0) await store.deleteBy('records', 'id', r.id);
          }
        }
      }
      // 提交后刷新统计快照，使首页/章节完成度立即反映本次作答（无需重启 App）
      if (onChanged) await onChanged();
      return { ok: true };
    },
    /** 统计（与 /api/records/stats 同构，聚合本地记录） */
    async stats() {
      const records = await store.getAll('records');
      const agg = aggregateStats(records, tiku);
      const total = records.length;
      const done = new Set(records.filter((r) => r.is_correct).map((r) => `${r.subject}|${r.question_id}`)).size;
      // 错题 = 严格答错（is_correct=0）；主观题（申论/综应 is_correct=null）不计入错题
      const wrong = records.filter((r) => r.is_correct === 0).length;
      return { total, done, wrong };
    },
    /** 错题本（与 /api/records/wrong 同构：答错题去重 + 分页；只收客观题） */
    async wrong({ limit = 50, offset = 0, subject } = {}) {
      let rows = (await store.getAll('records')).filter((r) => r.is_correct === 0);
      // 错题本只收录客观题（公考行测 / 事业编职测 / 自定义题库）；申论·综应等主观题不进错题本
      const WRONG_SUBJECTS = new Set(['公务员·行测', '事业编·职测', '自定义']);
      rows = rows.filter((r) => WRONG_SUBJECTS.has(r.subject));
      if (subject) rows = rows.filter((r) => r.subject === subject);
      rows.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      const seen = new Set();
      const uniq = rows.filter((r) => (seen.has(r.question_id) ? false : (seen.add(r.question_id), true)));
      const total = uniq.length;
      const page = uniq.slice(offset, offset + limit);
      // 自定义题内容从 IndexedDB 取（custom- 前缀）
      const customRows = (await store.getAll('custom_questions')).filter((x) => x.prompt);
      const customOf = new Map(customRows.map((x) => [Number(x.id), x]));
      const list = [];
      for (const r of page) {
        let q = null;
        if (String(r.question_id).startsWith('custom-')) {
          const cr = customOf.get(Number(String(r.question_id).replace(/^custom-/, '')));
          if (cr) q = { content: cr.prompt, type: 'custom' };
        } else {
          q = tiku.get('SELECT content, contentHtml, type FROM questions WHERE questionId = ? LIMIT 1', r.question_id);
        }
        list.push({
          id: r.question_id,
          questionId: r.question_id,   // 与 server /api/records/wrong 同构（app.js 点开用此字段）
          content: q?.content ? q.content.slice(0, 60) : (q?.contentHtml ? '（图片题）' : ''),
          available: !!q,              // 题库中已不存在的题（历史遗留）标记为不可重做
          answer: Array.isArray(r.selected) ? r.selected.slice().sort((a, b) => a - b).join(',') : (r.selected ?? ''),
          myAnswer: Array.isArray(r.selected) ? r.selected.slice().sort((a, b) => a - b).join(',') : '',
          subject: r.subject || '',
          chapter: r.chapter || '',
          time: r.created_at,
          type: q?.type ?? null,
        });
      }
      return { list, total, offset, limit, hasMore: offset + list.length < total };
    },
    /** 最近记录（与 /api/records/recent 同构） */
    async recent({ limit = 20 } = {}) {
      const rows = (await store.getAll('records')).sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, limit);
      const list = [];
      for (const r of rows) {
        const q = tiku.get('SELECT content, contentHtml, type FROM questions WHERE questionId = ? LIMIT 1', r.question_id);
        list.push({
          questionId: r.question_id,
          subject: r.subject || '',
          chapter: r.chapter || '',
          content: q?.content ? q.content.slice(0, 60) : (q?.contentHtml ? '（图片题）' : null),
          type: q?.type ?? null,
          correct: !!r.is_correct,
          time: r.created_at,
          costMs: r.cost_ms,
        });
      }
      return list;
    },
  };
}

// ---------- 图片层 ----------
/** 公式图查询 + 真图形缓存（images 引擎适配器） */
export function createImagesApi(images) {
  return {
    /** 公式图：按 latex key 取 blob（未命中返回 null） */
    formula(key) {
      if (!key) return null;
      const r = images.get('SELECT mime, blob FROM images WHERE key = ?', key);
      return r ? { mime: r.mime, blob: r.blob } : null;
    },
    /** 题目内图片 URL 改写：contentHtml 中的 formulas URL → /formula/<key>（同源相对路径，SW 可拦截；Capacitor/浏览器通用） */
    rewriteHtml(html) {
      if (!html || !html.includes('<img')) return html;
      return html.replace(/src="https?:\/\/[^"]*formulas\?latex=([^&"]+)(?:&[^"]*)?"/g, (m, key) => `src="/formula/${encodeURIComponent(decodeURIComponent(key))}"`);
    },
  };
}

// ---------- 总入口 ----------
/**
 * @param {object} opts
 *   opts.tiku     — 题库引擎适配器 {get, all}
 *   opts.practice — q_material_map/q_materials 引擎适配器（可同 tiku）
 *   opts.images   — 图片库引擎适配器（可省略）
 *   opts.store    — 记录存储适配器（阶段 3 提供 IndexedDB 实现）
 * @returns {{ query, records, images, stats }}
 */
export async function initLocalApi(opts) {
  const { tiku, practice = tiku, images = null, store } = opts;
  if (!tiku || !store) throw new Error('initLocalApi 需要 tiku 与 store 适配器');
  const records = await store.getAll('records');
  const stats = aggregateStats(records, tiku);
  // 统计快照刷新：答题记录提交后调用（见 records.addRecord 的 onChanged 回调），
  // 原地替换 stats 的三个 Map 属性——local-queries 每次查询都动态读取，无需重启 App 即可刷新完成度。
  async function refreshStats() {
    const fresh = aggregateStats(await store.getAll('records'), tiku);
    stats.doneBySubject = fresh.doneBySubject;
    stats.chapterStats = fresh.chapterStats;
    stats.subStats = fresh.subStats;
    return stats;
  }
  const query = createLocalApi(tiku, practice, stats);
  const recordsApi = createRecordsApi(store, tiku, refreshStats);
  const imagesApi = images ? createImagesApi(images) : null;
  return { query, records: recordsApi, images: imagesApi, stats, store };
}

/**
 * 浏览器端入口（阶段 3）：自动使用 IndexedDB 记录存储。
 * 题库引擎需调用方注入（阶段 4 双模式切换时由 app.js 传入 sql.js/CapacitorSQLite 引擎）。
 * @param {object} [opts] 同 initLocalApi，store 可省略（默认 createIdbStore()）
 */
export async function initLocalApiBrowser(opts = {}) {
  const store = opts.store || createIdbStore(opts.storeOpts || {});
  return initLocalApi({ ...opts, store });
}
