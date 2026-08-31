// test-organize.mjs — 错题本/收藏/笔记 来源归档与一键整理（2026-08-22）
// 覆盖（Web server.mjs 与 App local-handler.js 双端同构）：
//   1. 写入即归档：内置题按科目归大模块（行测/职测/申论/综应）+ 章节树大模块作为子模块；custom 题归「自定义题库」
//   2. 列表按 group/sub 过滤；分组总览 groups 固定 5 大模块
//   3. 一键整理 organize：历史未分类（group_key 为空）自动归类，幂等可重复
// 运行：node --test test-organize.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const PORT = 4900 + Math.floor(Math.random() * 200);
let server, base;
const createdBatches = [];
const cleanedRecords = [];

before(async () => {
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(PORT, () => { srv.close(resolve); });
    srv.on('error', reject);
  });
  server = spawn(process.execPath, ['server.mjs', String(PORT)], { stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  base = `http://localhost:${PORT}`;
});

after(async () => {
  // 清理测试产生的数据：错题记录软删（archived）+ 自定义批次级联删题，避免污染真用户库
  for (const qid of cleanedRecords) {
    try { await fetch(`${base}/api/records/wrong`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: qid }) }); } catch {}
  }
  for (const id of createdBatches) {
    try { await fetch(`${base}/api/custom/batch?id=${id}`, { method: 'DELETE' }); } catch {}
  }
  server?.kill();
});

const post = (path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

test('server：写入即归档 + group/sub 过滤 + 总览 + 一键整理', async () => {
  // 取一道真实行测题，提交一条错题记录（写入即归档）
  const p = await fetch(`${base}/api/practice?subject=公务员·行测&n=5&mock=0&year=all`).then((r) => r.json());
  const qs = Array.isArray(p) ? p : (p.questions || p.list || []);
  assert.ok(qs.length > 0, '出题失败');
  const q = qs[0];
  const rec = await post('/api/records', { questionId: q.id, subject: '公务员·行测', chapter: q.chapter || '', type: q.type, selected: [], correct: false, costMs: 1000, paperId: q.paperId });
  assert.equal(rec.ok, true);
  cleanedRecords.push(q.id);
  // 列表按 group 过滤命中（该题来自行测并映射到章节树大模块）
  const w = await fetch(`${base}/api/records/wrong?group=${encodeURIComponent('公务员·行测')}&limit=50`).then((r) => r.json());
  const hit = (w.list || []).find((x) => String(x.questionId) === String(q.id));
  assert.ok(hit, `行测组应含新错题: ${JSON.stringify(w.list && w.list.slice(0, 2))}`);
  // 总览：固定 5 大模块在前 + 子模块非空（真实库可能有历史未分类记录 → 第 6 组 key=''）
  const g = await fetch(`${base}/api/records/wrong/groups`).then((r) => r.json());
  assert.deepEqual(g.slice(0, 5).map((x) => x.key), ['公务员·行测', '事业编·职测', '公务员·申论', '事业编·综应', 'custom'], 'groups 固定 5 组顺序');
  if (g.length > 5) assert.equal(g[5].key, '', '第 6 组应为未分类');
  const xc = g.find((x) => x.key === '公务员·行测');
  assert.ok(xc && xc.count >= 1 && xc.subs.length > 0 && xc.subs[0].key !== '', `行测组应有子模块: ${JSON.stringify(xc)}`);
  // 一键整理：幂等可重复，返回分组明细
  const org = await post('/api/organize', { target: 'wrong' });
  assert.equal(org.ok, true);
  assert.ok(org.total >= 1 && Number.isInteger(org.fixed), JSON.stringify(org));
  assert.ok(Array.isArray(org.groups) && org.groups.every((x) => 'key' in x && 'name' in x && 'count' in x), JSON.stringify(org.groups));
  const org2 = await post('/api/organize', { target: 'wrong' });
  assert.equal(org2.ok, true, '重复整理应可执行');
});

test('server：自定义题归「自定义题库」（不分子模块）', async () => {
  const b = await post('/api/custom/import', { name: '归档测试批次-' + Date.now(), subject: '自定义', questions: [{ prompt: '归档测试题', material: '', options: ['A. x', 'B. y'], answer: 'A', answer_index: 0, analysis: '' }] });
  assert.ok(b.id, `导入失败: ${JSON.stringify(b)}`);
  createdBatches.push(Number(b.id));
  // 题目 id 才是 custom-N 的 N（批次 id 与题 id 不一定相同）
  const qs = await fetch(`${base}/api/custom/questions?batch_id=${b.id}`).then((r) => r.json());
  const qid = qs.questions[0].id;
  // 判错提交记录 → 自动归档 custom 组
  const ck = await post('/api/custom/check', { questionId: `custom-${qid}`, batchId: b.id, selected: [1], chapter: b.name });
  assert.equal(ck.ok, false);
  cleanedRecords.push(`custom-${qid}`);
  const w = await fetch(`${base}/api/records/wrong?group=custom`).then((r) => r.json());
  const hit = (w.list || []).find((x) => String(x.questionId) === `custom-${qid}`);
  assert.ok(hit, `自定义组应含该题: ${JSON.stringify(w.list && w.list.slice(0, 2))}`);
  const g = await fetch(`${base}/api/records/wrong/groups`).then((r) => r.json());
  const cu = g.find((x) => x.key === 'custom');
  assert.ok(cu && cu.count >= 1, `自定义组应含该题: ${JSON.stringify(cu)}`);
  // 自定义题固定不分子模块：组内任意子模块（仅历史数据可能残留 sub_key）不影响归组
  assert.ok(cu.subs.every((s) => !s.key), `自定义组不应有子模块: ${JSON.stringify(cu.subs)}`);
});

test('本地 handler：归档 / 过滤 / 总览 / 一键整理同构', async () => {
  const { createLocalHandler } = await import('./public/local-handler.js');
  const { createRecordsApi } = await import('./public/local-api.js');
  const tiku = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
  const engine = { get: (s, ...p) => tiku.prepare(s).get(...p), all: (s, ...p) => tiku.prepare(s).all(...p) };
  // 本地记录存储（records 主键 id 覆盖；notes/favorites 主键 question_id 覆盖，与 IndexedDB 一致）
  const mem = { records: [], favorites: [], custom_questions: [], custom_batches: [], notes: [] };
  const store = {
    async getAll(k) { return mem[k].map((r) => ({ ...r })); },
    async put(k, row) {
      if (k === 'records') {
        if (row.id == null) row.id = Date.now() + Math.random();
        const i = mem.records.findIndex((r) => r.id === row.id);
        if (i >= 0) mem.records[i] = { ...row }; else mem.records.push({ ...row });
      } else if (k === 'notes') {
        const i = mem.notes.findIndex((r) => String(r.question_id) === String(row.question_id));
        if (i >= 0) mem.notes[i] = { ...row }; else mem.notes.push({ ...row });
      } else if (k === 'custom_questions') {
        mem.custom_questions.push({ ...row });
      } else if (k === 'custom_batches') {
        mem.custom_batches.push({ ...row });
      } else {
        const i = mem.favorites.findIndex((r) => String(r.question_id) === String(row.question_id));
        if (i >= 0) mem.favorites[i] = { ...row }; else mem.favorites.push({ ...row });
      }
    },
    async nextId(k) { const n = mem[k].reduce((m, x) => Math.max(m, Number(x.id) || 0), 0); return n + 1; },
    async deleteBy(k, key, v) { mem[k] = mem[k].filter((r) => r[key] !== v); },
  };
  const noopQuery = { practice: () => [], generatePaper: () => ({ ok: false }), questionById: () => ({ id: null }) };
  const noopAi = {};
  const records = createRecordsApi(store, engine);
  const handler = createLocalHandler({ query: noopQuery, records, store, ai: noopAi });

  // 真实行测题错题 → 写入即归档
  const real = engine.get('SELECT questionId, paperId, chapter FROM questions WHERE questionId IN (SELECT questionId FROM questions LIMIT 1) LIMIT 1');
  const rq = engine.get(`SELECT q.questionId, q.paperId, q.chapter FROM questions q JOIN papers p ON p.id = q.paperId WHERE p.subjectName = '公务员·行测' LIMIT 1`);
  await handler('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: rq.questionId, subject: '公务员·行测', chapter: rq.chapter || '', correct: false }) });
  const w = await handler(`/api/records/wrong?group=${encodeURIComponent('公务员·行测')}`, { method: 'GET' });
  assert.ok(w.list.some((x) => String(x.questionId) === String(rq.questionId)), '本地行测组应含新错题');
  // 总览结构
  const g = await handler('/api/records/wrong/groups', { method: 'GET' });
  assert.deepEqual(g.map((x) => x.key), ['公务员·行测', '事业编·职测', '公务员·申论', '事业编·综应', 'custom']);
  // 历史未分类 → 一键整理自动归类
  for (const r of mem.records) { r.group_key = ''; r.sub_key = ''; }
  const org = await handler('/api/organize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'wrong' }) });
  assert.equal(org.fixed, 1, JSON.stringify(org));
  assert.equal((await handler('/api/organize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'wrong' }) })).fixed, 0, 'organize 应幂等');
  // 自定义题 → custom 组
  const imp = await handler('/api/custom/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '本地归档批次', questions: [{ prompt: '本地归档题', options: ['A. x', 'B. y'], answer: 'A', answer_index: 0 }] }) });
  const bid = imp.id;
  const lq = await handler(`/api/custom/questions?batch_id=${bid}`, { method: 'GET' });
  const lqid = lq.questions[0].id;
  await handler('/api/custom/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: `custom-${lqid}`, batchId: bid, selected: [1] }) });
  const wc = await handler('/api/records/wrong?group=custom', { method: 'GET' });
  assert.ok(wc.list.some((x) => String(x.questionId) === `custom-${lqid}`), '本地自定义组应含该题');
  tiku.close();
});