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
    const correct = rows.filter((r) => r.is_correct === 1).length;
    const graded = rows.filter((r) => r.is_correct === 1 || r.is_correct === 0).length;
    // 错题 = 严格答错（is_correct=0），与 server /api/records/stats 同构；主观题（NULL）不计入错题
    const wrong = rows.filter((r) => r.is_correct === 0).length;

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

    return { total, correct, wrong, rate: graded ? Math.round((correct / graded) * 100) : 0, byChapter, last7, daily };
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
    if (route === 'GET /question') {
      // 自定义题：custom- 前缀 → 从 IndexedDB 取（错题/收藏重做入口）
      const raw = String(qs.get('id') || '');
      if (raw.startsWith('custom-')) {
        const cid = Number(raw.replace(/^custom-/, ''));
        const all = await store.getAll('custom_questions');
        const cr = all.find((x) => Number(x.id) === cid);
        if (!cr) throw new Error('题目不存在');
        const batches = await store.getAll('custom_batches');
        const b = batches.find((x) => Number(x.id) === Number(cr.batch_id)) || {};
        return { questionId: raw, id: raw, type: 'custom', content: cr.prompt, contentHtml: cr.prompt, material: cr.material || '', options: cr.options || [], answer: cr.answer || '', answerIndex: cr.answer_index ?? -1, analysis: cr.analysis || '', subject: String(b.subject || '').trim() || '自定义', chapter: b.name || '' };
      }
      return query.questionById(qs.get('id'));
    }
    if (route === 'GET /materials') return query.paperMaterials(qs.get('paperId'));

    // ---------- 智能组卷 ----------
    if (route === 'POST /paper/generate') return query.generatePaper(body || {});

    // ---------- 判分 ----------
    if (route === 'POST /check') {
      // 自定义题（custom- 前缀）从 IndexedDB 查，粉笔题从题库查
      let q = null;
      if (String(body.questionId || '').startsWith('custom-')) {
        const cid = Number(String(body.questionId).replace(/^custom-/, ''));
        const all = await store.getAll('custom_questions');
        const r = all.find((x) => Number(x.id) === cid);
        if (r) q = { content: r.prompt, material: r.material || '', options: r.options || [], answer: r.answer || '', answerIndex: r.answer_index ?? -1, analysis: r.analysis || '', type: 'custom' };
      } else {
        q = query.questionById(body.questionId);
      }
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
    if (route === 'GET /records/wrong') return records.wrong({ limit: Number(qs.get('limit') || 50), offset: Number(qs.get('offset') || 0), subject: qs.get('subject') || undefined });
    if (route === 'DELETE /records/wrong') {
      // 与 server 同构：body.id 存在时只删单条；body.questionId 按题删；body.subject 指定时只清该模块；否则清空错题本
      // 注意：只删除错题记录（is_correct = 0），保留正确题记录与学习统计
      if (body && body.id != null) {
        await store.deleteBy('records', 'id', body.id);
        return { ok: true };
      }
      const all = await store.getAll('records');
      for (const r of all) {
        if (!r.is_correct && (!body?.questionId || r.question_id === body.questionId) && (!body?.subject || r.subject === body.subject)) await store.deleteBy('records', 'id', r.id);
      }
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
    if (route === 'GET /ai/agents') return ai.agents();
    if (route === 'DELETE /ai/explain-cache') return ai.clearExplainCache();
    if (route === 'POST /ai/structure') {
      const r = await ai.structure(body);
      if (r.error) return { notice: r.error, text: null };
      return { notice: '解析完成', text: r.content };
    }

    // 动态 id：/ai/agents/:id[/test|/history]
    const m = route.match(/^(GET|POST|PUT) \/ai\/agents\/(\d+)(?:\/(test|history))?$/);
    if (m) {
      const [, verb, id, sub] = m;
      if (verb === 'GET' && !sub) return ai.getAgent(id);
      if (verb === 'GET' && sub === 'history') return { list: [] };
      if (verb === 'PUT' && !sub) return ai.updateAgent(id, body);
      if (verb === 'POST' && sub === 'test') return ai.test(id, body.content);
    }

    // ---------- 自定义题库（2026-08-15，IndexedDB：custom_batches / custom_questions） ----------
    // 导入：建批次 + 批量插题
    if (route === 'POST /custom/import') {
      if (!body.name || !Array.isArray(body.questions) || body.questions.length === 0) throw new Error('缺少批次名或题目');
      const bid = await store.nextId('custom_batches');
      const subject = String(body.subject || '').trim() || '自定义';
      await store.put('custom_batches', { id: bid, name: String(body.name).trim(), subject, created_at: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'), updated_at: '' });
      for (const q of body.questions) {
        const qid = await store.nextId('custom_questions');
        await store.put('custom_questions', {
          id: qid, batch_id: bid,
          prompt: String(q.prompt ?? '').trim(),
          material: String(q.material ?? ''),
          options: Array.isArray(q.options) ? q.options : [],
          answer: String(q.answer ?? ''),
          answer_index: q.answer_index == null ? -1 : Number(q.answer_index),
          analysis: String(q.analysis ?? ''),
        });
      }
      return { id: bid, name: String(body.name).trim(), subject, count: body.questions.length };
    }
    // 批次列表（含题数）
    if (route === 'GET /custom/batches') {
      const batches = await store.getAll('custom_batches');
      const questions = await store.getAll('custom_questions');
      const list = batches.map((b) => ({ ...b, count: questions.filter((q) => Number(q.batch_id) === Number(b.id)).length }));
      list.sort((a, b) => Number(b.id) - Number(a.id));
      return { batches: list };
    }
    // 批次内题目列表
    if (route === 'GET /custom/questions') {
      const bid = Number(qs.get('batch_id') || 0);
      const all = await store.getAll('custom_questions');
      const list = all.filter((q) => Number(q.batch_id) === bid).sort((a, b) => Number(a.id) - Number(b.id));
      return { questions: list };
    }
    // 批改名
    if (route === 'PUT /custom/batch') {
      const bid = Number(body.id);
      if (!bid || !String(body.name || '').trim()) throw new Error('缺少 id 或批次名');
      const batches = await store.getAll('custom_batches');
      const b = batches.find((x) => Number(x.id) === bid);
      if (!b) throw new Error('批次不存在');
      await store.put('custom_batches', { ...b, name: String(body.name).trim() });
      return { ok: true };
    }
    // 合并批次：题目并入最小 id 批次，删其余
    if (route === 'POST /custom/batch/merge') {
      const idList = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean);
      if (idList.length < 2) throw new Error('至少选择两个批次');
      const target = Math.min(...idList);
      const others = idList.filter((x) => x !== target);
      const batches = await store.getAll('custom_batches');
      const questions = await store.getAll('custom_questions');
      for (const q of questions) {
        if (others.includes(Number(q.batch_id))) await store.put('custom_questions', { ...q, batch_id: target });
      }
      const tb = batches.find((x) => Number(x.id) === target);
      if (body.name && String(body.name).trim() && tb) await store.put('custom_batches', { ...tb, name: String(body.name).trim() });
      for (const o of others) {
        const ob = batches.find((x) => Number(x.id) === o);
        if (ob) await store.deleteBy('custom_batches', 'id', Number(ob.id));
      }
      const after = await store.getAll('custom_questions');
      const cnt = after.filter((q) => Number(q.batch_id) === target).length;
      return { id: target, count: cnt };
    }
    // 拆分批次：勾选题目移入新批次
    if (route === 'POST /custom/batch/split') {
      const bid = Number(body.batch_id);
      const qids = (Array.isArray(body.question_ids) ? body.question_ids : []).map(Number).filter(Boolean);
      if (!bid || qids.length === 0) throw new Error('缺少批次或题目');
      const batches = await store.getAll('custom_batches');
      const src = batches.find((x) => Number(x.id) === bid);
      if (!src) throw new Error('批次不存在');
      const splitN = batches.filter((x) => String(x.name || '').startsWith(String(src.name || '') + '-拆分')).length;
      const newName = String(body.name || '').trim() || `${src.name}-拆分${splitN + 1}`;
      const nb = await store.nextId('custom_batches');
      await store.put('custom_batches', { id: nb, name: newName, subject: String(src.subject || '').trim() || '自定义', created_at: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'), updated_at: '' });
      const questions = await store.getAll('custom_questions');
      let cnt = 0;
      for (const q of questions) {
        if (qids.includes(Number(q.id)) && Number(q.batch_id) === bid) { await store.put('custom_questions', { ...q, batch_id: nb }); cnt++; }
      }
      return { id: nb, name: newName, count: cnt };
    }
    // 删批次（级联删题）
    if (route === 'DELETE /custom/batch') {
      const bid = Number(qs.get('id') || 0);
      if (!bid) throw new Error('缺少 id');
      const questions = await store.getAll('custom_questions');
      for (const q of questions) if (Number(q.batch_id) === bid) await store.deleteBy('custom_questions', 'id', Number(q.id));
      await store.deleteBy('custom_batches', 'id', bid);
      return { ok: true };
    }
    // 改单题
    if (route === 'PUT /custom/question') {
      const qid = Number(body.id);
      if (!qid) throw new Error('缺少 id');
      const all = await store.getAll('custom_questions');
      const q = all.find((x) => Number(x.id) === qid);
      if (!q) throw new Error('题目不存在');
      await store.put('custom_questions', {
        ...q,
        prompt: String(body.prompt ?? '').trim(),
        material: String(body.material ?? ''),
        options: Array.isArray(body.options) ? body.options : [],
        answer: String(body.answer ?? ''),
        answer_index: body.answer_index == null ? -1 : Number(body.answer_index),
        analysis: String(body.analysis ?? ''),
      });
      return { ok: true };
    }
    // 删单题
    if (route === 'DELETE /custom/question') {
      const qid = Number(qs.get('id') || 0);
      if (!qid) throw new Error('缺少 id');
      await store.deleteBy('custom_questions', 'id', qid);
      return { ok: true };
    }
    // 出题（刷题）：字段映射成粉笔结构
    if (route === 'GET /custom/practice') {
      const bid = Number(qs.get('batch_id') || 0);
      if (!bid) throw new Error('缺少 batch_id');
      const batches = await store.getAll('custom_batches');
      const b = batches.find((x) => Number(x.id) === bid);
      if (!b) throw new Error('批次不存在');
      const bSubj = String(b.subject || '').trim() || '自定义';
      const all = await store.getAll('custom_questions');
      const rows = all.filter((q) => Number(q.batch_id) === bid).sort((a, b) => Number(a.id) - Number(b.id));
      const questions = rows.map((r) => ({
        id: `custom-${r.id}`,
        questionId: `custom-${r.id}`,
        content: r.prompt,
        material: r.material || '',
        options: r.options || [],
        answer: r.answer || '',
        answerIndex: r.answer_index ?? -1,
        analysis: r.analysis || '',
        type: 'custom',
        subjectName: bSubj,
        batchId: bid,
        chapter: b.name,
      }));
      return { questions, batch: { id: bid, name: b.name, subject: bSubj } };
    }
    // 判分（自定义）：复用 checkAnswer，写 records（subject=自定义，chapter=批次名）
    if (route === 'POST /custom/check') {
      const cid = Number(String(body.questionId || '').replace(/^custom-/, ''));
      if (!cid) throw new Error('缺少 questionId');
      const all = await store.getAll('custom_questions');
      const r = all.find((x) => Number(x.id) === cid);
      if (!r) throw new Error('题目不存在');
      const fq = { content: r.prompt, material: r.material || '', options: r.options || [], answer: r.answer || '', answerIndex: r.answer_index ?? -1, analysis: r.analysis || '', type: 'custom' };
      const result = checkAnswer(fq, body.selected);
      const batches = await store.getAll('custom_batches');
      const bb = batches.find((x) => Number(x.id) === Number(body.batchId || 0));
      const subject = (bb && String(bb.subject || '').trim()) || '自定义';
      await records.addRecord({ questionId: body.questionId, subject, chapter: body.chapter || '', type: 'custom', selected: Array.isArray(body.selected) ? body.selected : (body.selected == null ? [] : [body.selected]), correct: result.ok, costMs: 0 });
      return result;
    }

    throw new Error(`本地模式未实现：${method} /${rest}`);
  };
}
