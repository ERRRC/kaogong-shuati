// test-custom-bank-group.mjs — 自定义题库：刷题模式选择 + 材料分组（material_id）数据层测试（2026-08-21）
// 覆盖（Web server.mjs 与 App local-handler.js 双端同构）：
//   1. 批次内题目可归为一组（POST /api/custom/questions/group）→ 出题时同组题连续、共用组内第一份材料、标记第 n/m 小问
//   2. 取消分组（ungroup）→ 出题恢复逐题独立材料
//   3. 跨非相邻 id 分组 → 出题序列自动把组内题排到一起
//   4. 编辑单题（不带 material_id）不丢分组；显式传 material_id 可改
//   5. 本地 handler 同构
// 运行：node --test test-custom-bank-group.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

const PORT = 4800 + Math.floor(Math.random() * 200);
let server, base;
const createdBatches = [];

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
  // 清理本次测试创建的批次（级联删题），避免污染真用户库
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

async function importBatch(name, questions) {
  const r = await post('/api/custom/import', { name, questions });
  assert.ok(r.id, `导入失败: ${JSON.stringify(r)}`);
  createdBatches.push(Number(r.id));
  return r;
}

/** 组卷样例：5 题 —— 1,2 共用材料A（材料内容在 2 号上）；3 独立；4,5 共用材料B（材料内容在 5 号上） */
function sampleQuestions() {
  return [
    { prompt: '问题一', material: '', options: ['A. x', 'B. y'], answer: 'A', analysis: '' },
    { prompt: '问题二', material: '材料A：共享材料A内容', options: ['A. x', 'B. y'], answer: 'B', analysis: '' },
    { prompt: '问题三', material: '材料三：独立材料', options: ['A. x', 'B. y'], answer: 'A', analysis: '' },
    { prompt: '问题四', material: '', options: ['A. x', 'B. y'], answer: 'B', analysis: '' },
    { prompt: '问题五', material: '材料B：共享材料B内容', options: ['A. x', 'B. y'], answer: 'A', analysis: '' },
  ];
}

test('分组：同组题出题共用材料 + 第 n/m 小问 + 组内连续', async () => {
  const b = await importBatch('材料分组测试A-' + Date.now(), sampleQuestions());
  const qs = await fetch(`${base}/api/custom/questions?batch_id=${b.id}`).then((r) => r.json());
  assert.equal(qs.questions.length, 5);
  // 1,2 归一组（2 号带材料）
  const g = await post('/api/custom/questions/group', { ids: [qs.questions[0].id, qs.questions[1].id], action: 'group' });
  assert.equal(g.ok, true); assert.ok(g.groupId);
  const gidA = g.groupId;
  // 4,5 归一组（5 号带材料），刻意乱序传入
  const g2 = await post('/api/custom/questions/group', { ids: [qs.questions[4].id, qs.questions[3].id], action: 'group' });
  const gidB = g2.groupId;

  const p = await fetch(`${base}/api/custom/practice?batch_id=${b.id}`).then((r) => r.json());
  const list = p.questions;
  assert.equal(list.length, 5);

  // 组 A（1,2）：同组连续、共用材料内容（取自第 2 题）、小问序号 0/1
  const ga = list.filter((q) => q.groupId === gidA);
  assert.equal(ga.length, 2);
  assert.equal(ga[0].groupTotal, 2); assert.equal(ga[1].groupTotal, 2);
  assert.equal(ga[0].groupIndex, 0); assert.equal(ga[1].groupIndex, 1);
  assert.ok(ga[0].material.includes('材料A'), `组A第1题应共用材料A: ${ga[0].material}`);
  assert.equal(ga[0].material, ga[1].material, '组内材料内容应一致');
  // 组 A 必须连续出现
  const idxA = list.map((q) => q.groupId === gidA ? 1 : 0).join('');
  assert.ok(idxA.includes('11'), `组A应连续: ${idxA}`);
  // 组 B（4,5）：跨 id 乱序分组后出题仍连续，材料取自第 5 题
  const gb = list.filter((q) => q.groupId === gidB);
  assert.equal(gb.length, 2);
  assert.ok(gb[0].material.includes('材料B'), `组B应共用材料B: ${gb[0].material}`);
  assert.equal(gb[0].material, gb[1].material);
  const idxB = list.map((q) => q.groupId === gidB ? 1 : 0).join('');
  assert.ok(idxB.includes('11'), `组B应连续: ${idxB}`);
  // 独立题 3 不分组
  const solo = list.find((q) => q.content === '问题三');
  assert.ok(solo && !solo.groupId, '独立题不应有 groupId');
  assert.equal(solo.material, '材料三：独立材料');
});

test('取消分组：出题恢复逐题独立材料、无小问标记', async () => {
  const b = await importBatch('材料分组测试B-' + Date.now(), sampleQuestions());
  const qs = await fetch(`${base}/api/custom/questions?batch_id=${b.id}`).then((r) => r.json());
  const [q1, q2] = qs.questions.slice(0, 2);
  const g = await post('/api/custom/questions/group', { ids: [q1.id, q2.id], action: 'group' });
  await post('/api/custom/questions/group', { ids: [q1.id], action: 'ungroup' });
  const p = await fetch(`${base}/api/custom/practice?batch_id=${b.id}`).then((r) => r.json());
  const a = p.questions.find((q) => q.content === '问题一');
  const bq = p.questions.find((q) => q.content === '问题二');
  assert.ok(!a.groupId && !a.groupTotal, '移出组的题不应有分组标记');
  assert.ok(bq.groupId, '仍在组内的题保留分组');
});

test('编辑单题（不带 material_id）不丢分组；显式传可改', async () => {
  const b = await importBatch('材料分组测试C-' + Date.now(), sampleQuestions());
  const qs = await fetch(`${base}/api/custom/questions?batch_id=${b.id}`).then((r) => r.json());
  const q1 = qs.questions[0], q2 = qs.questions[1];
  const g = await post('/api/custom/questions/group', { ids: [q1.id, q2.id], action: 'group' });
  // 普通编辑（无 material_id 字段）→ 分组保留
  await fetch(`${base}/api/custom/question?id=${q1.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: q1.id, prompt: '问题一改', material: '', options: ['A. x', 'B. y'], answer: 'A', answer_index: 0, analysis: '' }),
  }).then((r) => r.json());
  let after = await fetch(`${base}/api/custom/questions?batch_id=${b.id}`).then((r) => r.json());
  assert.equal(after.questions[0].material_id, g.groupId, '普通编辑不应清空分组');
  // 显式传 material_id='' → 清空分组
  await fetch(`${base}/api/custom/question?id=${q1.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: q1.id, material_id: '' }),
  }).then((r) => r.json());
  after = await fetch(`${base}/api/custom/questions?batch_id=${b.id}`).then((r) => r.json());
  assert.equal(after.questions[0].material_id, '', '显式 material_id="" 应清空分组');
});

// ==================== 本地 handler（App 端）同构 ====================
function memStore() {
  const tables = { custom_batches: new Map(), custom_questions: new Map() };
  let seq = 1;
  return {
    async getAll(t) { return [...tables[t].values()]; },
    async put(t, obj) { tables[t].set(Number(obj.id), obj); },
    async nextId() { return seq++; },
    async deleteBy(t, key, v) {
      for (const [id, obj] of tables[t]) if (obj[key] === v) tables[t].delete(id);
    },
  };
}
const noopRecords = { addRecord: async () => {}, wrong: async () => [], recent: async () => [], favorites: async () => [], toggleFavorite: async () => {} };
const noopQuery = { practice: () => [], generatePaper: () => ({ ok: false }), questionById: () => null };
const noopAi = {};

test('本地 handler：分组出题同构（共用材料 + 小问标记 + 连续）', async () => {
  const { createLocalHandler } = await import('./public/local-handler.js');
  const store = memStore();
  const handler = createLocalHandler({ query: noopQuery, records: noopRecords, store, ai: noopAi });
  const bid = await handler('/api/custom/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '本地分组', questions: sampleQuestions() }),
  }).then((r) => r.id);
  const { questions } = await handler(`/api/custom/questions?batch_id=${bid}`, { method: 'GET' });
  const g = await handler('/api/custom/questions/group', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [questions[0].id, questions[1].id], action: 'group' }),
  });
  const p = await handler(`/api/custom/practice?batch_id=${bid}`, { method: 'GET' });
  const group = p.questions.filter((q) => q.groupId === g.groupId);
  assert.equal(group.length, 2);
  assert.ok(group[0].material.includes('材料A'), `本地组材料: ${group[0].material}`);
  assert.equal(group[0].groupTotal, 2);
  assert.equal(group[0].groupIndex, 0);
  assert.equal(group[1].groupIndex, 1);
  assert.equal(group[0].material, group[1].material);
  const seq = p.questions.map((q) => q.groupId === g.groupId ? 1 : 0).join('');
  assert.ok(seq.includes('11'), `本地组应连续: ${seq}`);
  // 取消分组
  await handler('/api/custom/questions/group', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [questions[0].id], action: 'ungroup' }),
  });
  const p2 = await handler(`/api/custom/practice?batch_id=${bid}`, { method: 'GET' });
  const qa = p2.questions.find((q) => q.content === '问题一');
  assert.ok(!qa.groupId, '本地取消分组生效');
});

test('本地 handler：导入带 material_id 保留', async () => {
  const { createLocalHandler } = await import('./public/local-handler.js');
  const store = memStore();
  const handler = createLocalHandler({ query: noopQuery, records: noopRecords, store, ai: noopAi });
  const bid = await handler('/api/custom/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '本地导入带组',
      questions: [{ prompt: '甲', material: '', options: ['A', 'B'], answer: 'A', material_id: 'gx' },
                   { prompt: '乙', material: '', options: ['A', 'B'], answer: 'B', material_id: 'gx' }],
    }),
  }).then((r) => r.id);
  const { questions } = await handler(`/api/custom/questions?batch_id=${bid}`, { method: 'GET' });
  assert.equal(questions[0].material_id, 'gx');
  const p = await handler(`/api/custom/practice?batch_id=${bid}`, { method: 'GET' });
  assert.equal(p.questions.length, 2);
  assert.equal(p.questions[0].groupId, 'gx');
  assert.equal(p.questions[0].groupTotal, 2);
});

// ==================== 自动按材料内容分组 ====================
/** 3 题共用同一材料 + 1 题独立 + 1 题不同材料 */
function sampleAutoGroupQuestions() {
  return [
    { prompt: 'A1', material: '材料X：表格数据', options: ['A', 'B'], answer: 'A' },
    { prompt: 'A2', material: '材料X：表格数据', options: ['A', 'B'], answer: 'B' },
    { prompt: 'A3', material: '材料X：表格数据', options: ['A', 'B'], answer: 'A' },
    { prompt: 'B1', material: '材料Y：另一段', options: ['A', 'B'], answer: 'B' },
    { prompt: 'C1', material: '独立题', options: ['A', 'B'], answer: 'A' },
  ];
}

test('按材料内容自动分组：相同材料文本自动归组（≥2 题）', async () => {
  const b = await importBatch('自动分组测试A-' + Date.now(), sampleAutoGroupQuestions());
  const r = await post('/api/custom/questions/auto-group', { batch_id: b.id });
  assert.equal(r.ok, true);
  assert.equal(r.grouped, 3, `应分组 3 题（A1/A2/A3），实际 ${r.grouped}`);
  assert.equal(r.groupCount, 1, `应只 1 组，实际 ${r.groupCount}`);
  assert.equal(r.total, 5);

  const p = await fetch(`${base}/api/custom/practice?batch_id=${b.id}`).then((r) => r.json());
  const groupedQs = p.questions.filter((q) => q.groupId);
  assert.equal(groupedQs.length, 3, '应 3 题有分组');
  assert.equal(groupedQs[0].groupTotal, 3);
  // 独立题无分组
  const solo = p.questions.find((q) => q.content === 'C1');
  assert.ok(!solo.groupId, '独立题不应被分组');
});

test('按材料内容自动分组：归一化（去 HTML/空白）也命中同一组', async () => {
  const b = await importBatch('自动分组归一化-' + Date.now(), [
    { prompt: '甲', material: '<p>材料A</p>\n表格数据', options: ['A', 'B'], answer: 'A' },
    { prompt: '乙', material: '  材料A  表格数据  ', options: ['A', 'B'], answer: 'B' },
    { prompt: '丙', material: '材料A 表格数据', options: ['A', 'B'], answer: 'A' },
  ]);
  const r = await post('/api/custom/questions/auto-group', { batch_id: b.id });
  assert.equal(r.grouped, 3);
  assert.equal(r.groupCount, 1);
});

test('按材料内容自动分组：空材料不参与；单题不分组', async () => {
  const b = await importBatch('自动分组空材料-' + Date.now(), [
    { prompt: '甲', material: '', options: ['A', 'B'], answer: 'A' },
    { prompt: '乙', material: '', options: ['A', 'B'], answer: 'B' },
    { prompt: '丙', material: '单独材料', options: ['A', 'B'], answer: 'A' },
  ]);
  const r = await post('/api/custom/questions/auto-group', { batch_id: b.id });
  assert.equal(r.grouped, 0, '没有重复材料应不分组');
  assert.equal(r.groupCount, 0);
});

test('本地 handler：自动按材料内容分组同构', async () => {
  const { createLocalHandler } = await import('./public/local-handler.js');
  const store = memStore();
  const handler = createLocalHandler({ query: noopQuery, records: noopRecords, store, ai: noopAi });
  const bid = await handler('/api/custom/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '本地自动分组', questions: sampleAutoGroupQuestions() }),
  }).then((r) => r.id);
  const r = await handler('/api/custom/questions/auto-group', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch_id: bid }),
  });
  assert.equal(r.grouped, 3);
  assert.equal(r.groupCount, 1);
});

// ==================== 出题 count 参数 ====================
test('出题 count 参数：限制题数；保护材料组完整（不切中间）', async () => {
  // 6 题：前 3 题一组（材料组）、后 3 题独立
  const b = await importBatch('count截断测试-' + Date.now(), [
    { prompt: 'A1', material: '材料', options: ['A'], answer: 'A' },
    { prompt: 'A2', material: '', options: ['A'], answer: 'A' },
    { prompt: 'A3', material: '', options: ['A'], answer: 'A' },
    { prompt: 'B1', material: '', options: ['A'], answer: 'A' },
    { prompt: 'B2', material: '', options: ['A'], answer: 'A' },
    { prompt: 'B3', material: '', options: ['A'], answer: 'A' },
  ]);
  // 先把 A1/A2/A3 归为一组
  const qs = await fetch(`${base}/api/custom/questions?batch_id=${b.id}`).then((r) => r.json());
  await post('/api/custom/questions/group', { ids: [qs.questions[0].id, qs.questions[1].id, qs.questions[2].id], action: 'group' });

  // count=2 → A1/A2 在第 2 题停下，但 A2 在材料组中间（A1/A2/A3），应自动扩到 A3
  const p = await fetch(`${base}/api/custom/practice?batch_id=${b.id}&count=2`).then((r) => r.json());
  assert.equal(p.questions.length, 3, `材料组扩展后应 3 题，实际 ${p.questions.length}`);
  assert.equal(p.questions[0].content, 'A1');
  assert.equal(p.questions[2].content, 'A3');

  // count=0 → 不传 count 时不截断（缺省行为：返回全部 6 题）
  const p0 = await fetch(`${base}/api/custom/practice?batch_id=${b.id}`).then((r) => r.json());
  assert.equal(p0.questions.length, 6);

  // count=100 → 全部 6 题
  const p100 = await fetch(`${base}/api/custom/practice?batch_id=${b.id}&count=100`).then((r) => r.json());
  assert.equal(p100.questions.length, 6);
});

test('本地 handler：出题 count 参数同构（材料组保护）', async () => {
  const { createLocalHandler } = await import('./public/local-handler.js');
  const store = memStore();
  const handler = createLocalHandler({ query: noopQuery, records: noopRecords, store, ai: noopAi });
  const bid = await handler('/api/custom/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '本地count', questions: [
      { prompt: 'A1', material: '材料', options: ['A'], answer: 'A' },
      { prompt: 'A2', material: '', options: ['A'], answer: 'A' },
      { prompt: 'A3', material: '', options: ['A'], answer: 'A' },
      { prompt: 'B1', material: '', options: ['A'], answer: 'A' },
    ] }),
  }).then((r) => r.id);
  const { questions } = await handler(`/api/custom/questions?batch_id=${bid}`, { method: 'GET' });
  await handler('/api/custom/questions/group', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [questions[0].id, questions[1].id, questions[2].id], action: 'group' }),
  });
  const p = await handler(`/api/custom/practice?batch_id=${bid}&count=2`, { method: 'GET' });
  assert.equal(p.questions.length, 3, `本地 count=2 应扩展材料组到 3 题`);
});
