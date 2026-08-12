// local-handler.mjs — App 本地模式（无服务器）的 API 路由
// 把 app.js 里 api('/api/...', opts) 的调用全部路由到本地能力：
//   query（题库查询） / records（做题记录·IndexedDB） / ai（AI 直调） / stats（聚合统计）
// 返回结构与 server.mjs 完全对齐，app.js 零改动。

import { checkAnswer } from './lib/local-queries.js';

export function createLocalHandler({ query, records, store, ai }) {
  /** 聚合统计（与 server /api/records/stats 同构：total/correct/wrong/rate/byChapter/last7/daily） */
  async function statsWithParams({ subject, days, from, to } = {}) {
    let rows = await store.getAll('records');
    if (subject) rows = rows.filter((r) => r.subject === subject);
    if (days) {
      const cutoff = Date.now() - Number(days) * 86400000;
      rows = rows.filter((r) => r.created_at >= cutoff);
    }
    if (from || to) {
      const f = from ? new Date(from).getTime() : 0;
      const t = to ? new Date(to).getTime() + 86400000 : Infinity;
      rows = rows.filter((r) => r.created_at >= f && r.created_at < t);
    }
    const total = rows.length;
    const correct = rows.filter((r) => r.is_correct).length;
    const wrong = total - correct;

    // byChapter：按章节聚合（与 server 同构：{chapter, c, ok}）
    const byChapterMap = new Map();
    for (const r of rows) {
      const key = r.chapter || '未分类';
      const e = byChapterMap.get(key) || { chapter: key, c: 0, ok: 0 };
      e.c += 1;
      if (r.is_correct) e.ok += 1;
      byChapterMap.set(key, e);
    }
    const byChapter = [...byChapterMap.values()];

    // last7：最近 7 天做题数（与 server 同构：{d:'MM-DD', c:n}，含今天）
    const fmt = (ts) => {
      const d = new Date(ts);
      return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const key = fmt(Date.now() - i * 86400000);
      const c = rows.filter((r) => fmt(r.created_at) === key).length;
      last7.push({ d: key, c });
    }

    // daily：按天聚合（按做题日期倒序）
    const dailyMap = new Map();
    for (const r of rows) {
      const key = fmt(r.created_at);
      const e = dailyMap.get(key) || { d: key, c: 0, ok: 0 };
      e.c += 1;
      if (r.is_correct) e.ok += 1;
      dailyMap.set(key, e);
    }
    const daily = [...dailyMap.values()].sort((a, b) => (a.d < b.d ? 1 : -1));

    return { total, correct, wrong, rate: total ? Math.round((correct / total) * 100) : 0, byChapter, last7, daily };
  }

  /**
   * 本地 API 入口：与 app.js 的 api(path, opts) 同签名。
   */
  return async function localApi(path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const seg = String(path).split('?')[0].split('/').filter(Boolean); // ['api','subjects']
    const qs = String(path).includes('?') ? new URLSearchParams(String(path).split('?')[1]) : new URLSearchParams();
    let body = null;
    if (opts.body) {
      try {
        body = JSON.parse(opts.body);
      } catch {
        body = opts.body;
      }
    }
    if (seg[0] !== 'api') throw new Error(`本地模式不支持的路径：${path}`);

    const rest = seg.slice(1).join('/'); // 'subjects' | 'ai/agents/3/test'
    const route = `${method} /${rest}`;

    // ---------- 题库查询 ----------
    if (route === 'GET /subjects') return query.subjects();
    if (route === 'GET /categories') return query.categories(qs.get('subject') || '');
    if (route === 'GET /chapters') return query.chapters(qs.get('subject') || '', qs.get('mock') || '');
    if (route === 'GET /papers') return query.papers(qs.get('subject') || '', qs.get('category') || '', Number(qs.get('limit') || 50));
    const paperM = route.match(/^GET \/papers\/(\d+)$/);
    if (paperM) return query.paperById(Number(paperM[1]));
    if (route === 'GET /practice') {
      return query.practice(qs.get('subject') || '', {
        chapter: qs.get('chapter') || undefined,
        chapters: qs.get('chapters') ? qs.get('chapters').split(',') : undefined,
        group: qs.get('group') || undefined,
        sub: qs.get('sub') || undefined,
        mock: qs.get('mock') || '',
        n: Number(qs.get('n') || 10),
      });
    }
    if (route === 'GET /question') return query.questionById(qs.get('id'));
    if (route === 'GET /materials') return query.paperMaterials(qs.get('paperId'));

    // ---------- 智能组卷 ----------
    if (route === 'POST /paper/generate') return query.generatePaper(body || {});

    // ---------- 判分 ----------
    if (route === 'POST /check') {
      const q = query.questionById(body.questionId);
      if (!q) throw new Error('未找到该题');
      return checkAnswer(q, body.selected);
    }

    // ---------- 记录 / 收藏 ----------
    if (route === 'POST /records') return records.addRecord(body);
    if (route === 'GET /records/stats') {
      return statsWithParams({
        subject: qs.get('subject') || undefined,
        days: qs.get('days') ? Number(qs.get('days')) : undefined,
        from: qs.get('from') || undefined,
        to: qs.get('to') || undefined,
      });
    }
    if (route === 'GET /records/recent') return records.recent({ limit: Number(qs.get('limit') || 20) });
    if (route === 'GET /records/wrong') return records.wrong({ limit: Number(qs.get('limit') || 50), offset: Number(qs.get('offset') || 0) });
    if (route === 'DELETE /records/wrong') {
      // 清空错题本（与 server 同构：全清）
      const all = await store.getAll('records');
      for (const r of all) await store.deleteBy('records', 'id', r.id);
      return { ok: true };
    }
    if (route === 'GET /favorites') return records.favorites({ limit: Number(qs.get('limit') || 50), offset: Number(qs.get('offset') || 0) });
    if (route === 'POST /favorites') return records.toggleFavorite(body.questionId, { subject: body.subject, chapter: body.chapter });
    if (route === 'DELETE /favorites') return records.toggleFavorite(body.questionId);

    // ---------- AI ----------
    if (route === 'GET /ai/material') return ai.material(qs.get('paperId'));
    // 与 server.mjs 同构：ocr/grade 响应字段转换为 {notice, text} / {notice, result}（前端 app.js 按此读取）
    if (route === 'POST /ai/ocr') {
      const r = await ai.ocr(body);
      if (r.error) return { notice: r.error, text: null };
      return { notice: '识别完成', text: r.content };
    }
    if (route === 'POST /ai/grade') {
      // 前端传 {questionId, content}，ai.grade 读 answer → 转换参数
      const r = await ai.grade({ ...body, answer: body.content });
      if (r.error) return { notice: r.error, score: null };
      return { notice: '批改完成', score: null, result: r.content, fullScore: null };
    }
    if (route === 'POST /ai/explain') {
      const r = await ai.explain(body);
      if (r.error) return { notice: r.error, content: null };
      return r;
    }
    if (route === 'POST /ai/progress') {
      const r = await ai.progress(body);
      if (r.error) return { notice: r.error, content: null };
      return r;
    }
    if (route === 'GET /ai/agents') return ai.agents();
    if (route === 'DELETE /ai/explain-cache') return ai.clearExplainCache();

    // 动态 id：/ai/agents/:id[/test|/history]
    const m = route.match(/^(GET|POST|PUT) \/ai\/agents\/(\d+)(?:\/(test|history))?$/);
    if (m) {
      const [, verb, id, sub] = m;
      if (verb === 'GET' && !sub) return ai.getAgent(id);
      if (verb === 'GET' && sub === 'history') return { list: [] };
      if (verb === 'PUT' && !sub) return ai.updateAgent(id, body);
      if (verb === 'POST' && sub === 'test') return ai.test(id, body.content);
    }

    throw new Error(`本地模式未实现：${method} /${rest}`);
  };
}
