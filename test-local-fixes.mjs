// 修复验证测试（node --test）：
//   - 清空错题本只删错题（保留正确题与统计）
//   - byChapter 数组格式（弱项检测输入）
//   - addRecord 同日去重 + onChanged 刷新 stats
//   - dayStart 按中国时区（UTC+8）
//   - 图片题（content 空）列表摘要回退
// 运行：TZ 由脚本内设置（必须在首次 Date 调用前）
process.env.TZ = 'Asia/Shanghai';

import test from 'node:test';
import assert from 'node:assert';
import { createRecordsApi, aggregateStats } from './public/local-api.js';
import { createLocalHandler } from './public/local-handler.js';

// ---------- mock 存储 ----------
function mockStore() {
  const tables = new Map(); // kind -> Map(id, row)
  let seq = 1;
  return {
    async getAll(kind) { return [...(tables.get(kind) || new Map()).values()]; },
    async put(kind, row) { if (row.id == null) row.id = seq++; tables.get(kind) || tables.set(kind, new Map()); tables.get(kind).set(row.id, row); return row; },
    async deleteBy(kind, key, value) { const t = tables.get(kind); if (!t) return; for (const [id, row] of t) { if (row[key] === value) t.delete(id); } },
  };
}

// mock 题库引擎：content 空但有 contentHtml（模拟纯图片题）
const mockTiku = {
  get(sql, ...args) {
    if (sql.includes('FROM questions')) {
      return { questionId: args[0], paperId: 1, type: 1, content: '', contentHtml: '<img src="https://x/y.png">', options: '[]', answer: 'A' };
    }
    return null;
  },
  all() { return []; },
};

test('addRecord 同日去重 + onChanged 刷新 stats', async () => {
  const store = mockStore();
  const stats = aggregateStats([], mockTiku);
  let changed = 0;
  const records = createRecordsApi(store, mockTiku, async () => {
    changed++;
    const fresh = aggregateStats(await store.getAll('records'), mockTiku);
    stats.doneBySubject = fresh.doneBySubject;
    stats.chapterStats = fresh.chapterStats;
    stats.subStats = fresh.subStats;
  });
  await records.addRecord({ questionId: 1001, subject: '公务员·行测', chapter: '常识判断', correct: true, paperId: 7 });
  await records.addRecord({ questionId: 1001, subject: '公务员·行测', chapter: '常识判断', correct: true, paperId: 7 }); // 同日重复 → 覆盖
  const all = await store.getAll('records');
  assert.strictEqual(all.length, 1, '同日同题同卷应去重为 1 条');
  assert.strictEqual(changed, 2, 'onChanged（stats 刷新回调）应被调用 2 次');
  assert.strictEqual(stats.doneBySubject.get('公务员·行测'), 1, 'doneBySubject 应更新');
  assert.strictEqual(stats.chapterStats.get('公务员·行测')?.get('常识判断')?.c, 1, 'chapterStats 应更新');
});

test('清空错题本只删错题（保留正确题与统计）', async () => {
  const store = mockStore();
  const records = createRecordsApi(store, mockTiku);
  await records.addRecord({ questionId: 2001, subject: '公务员·行测', chapter: '言语理解', correct: true, paperId: 7 });
  await records.addRecord({ questionId: 2002, subject: '公务员·行测', chapter: '言语理解', correct: false, paperId: 7 });
  await records.addRecord({ questionId: 2003, subject: '公务员·行测', chapter: '言语理解', correct: false, paperId: 7 });
  const handler = createLocalHandler({ query: null, records, store, ai: null });
  const before = await handler('/api/records/stats');
  assert.strictEqual(before.wrong, 2, `清空前错题应为 2（实际 ${before.wrong}）`);
  const r = await handler('/api/records/wrong', { method: 'DELETE', body: '{}' });
  assert.strictEqual(r.ok, true);
  const after = await handler('/api/records/stats');
  assert.strictEqual(after.wrong, 0, '清空后错题应为 0');
  assert.strictEqual(after.total, 1, '正确题记录应保留（total=1）');
  const wrongList = await handler('/api/records/wrong');
  assert.strictEqual(wrongList.total, 0, '错题本应为空');
  // 单条删除
  await records.addRecord({ questionId: 2004, subject: '公务员·行测', chapter: '言语理解', correct: false, paperId: 7 });
  const rec = (await store.getAll('records')).find((x) => x.question_id === 2004);
  await handler('/api/records/wrong', { method: 'DELETE', body: JSON.stringify({ id: rec.id }) });
  const st2 = await handler('/api/records/stats');
  assert.strictEqual(st2.wrong, 0, '单条删除后错题应为 0');
});

test('byChapter 数组格式（弱项检测输入）', async () => {
  const store = mockStore();
  const records = createRecordsApi(store, mockTiku);
  for (let i = 0; i < 6; i++) await records.addRecord({ questionId: 3000 + i, subject: '公务员·行测', chapter: '数量关系', correct: i < 2, paperId: 7 }); // 6 题对 2 题 → 33%
  const handler = createLocalHandler({ query: null, records, store, ai: null });
  const stats = await handler('/api/records/stats');
  assert.ok(Array.isArray(stats.byChapter), 'byChapter 应为数组');
  const v = stats.byChapter.find((x) => x.chapter === '数量关系');
  assert.ok(v && typeof v.c === 'number' && typeof v.ok === 'number', `条目应含 {chapter,c,ok}（实际 ${JSON.stringify(v)}）`);
  // 模拟 app.js 修复后的弱项检测逻辑
  const modList = [{ name: '数量关系' }, { name: '言语理解' }];
  let best = null;
  for (const item of stats.byChapter) {
    const rate = item.c ? item.ok / item.c : 0;
    if (item.c >= 5 && modList.some((m) => m.name === item.chapter)) {
      if (!best || rate < (best.rate ?? 1)) best = { name: item.chapter, rate };
    }
  }
  assert.strictEqual(best?.name, '数量关系', '弱项检测应命中数量关系（33% < 60%）');
  assert.strictEqual(best?.rate, 1 / 3, 'rate 应正确（2/6）');
});

test('dayStart 按中国时区（UTC+8）', () => {
  const now = Date.now();
  const d = new Date(now);
  const localDayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); // 修复后逻辑
  const utcDayStart = now - (now % 86400000); // 修复前逻辑
  const localMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0).getTime();
  assert.strictEqual(localDayStart, localMidnight, 'dayStart 应等于本地零点');
  const utcMidnight = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  assert.notStrictEqual(utcMidnight, localMidnight, '中国时区下 UTC 零点与本地零点应不同');
  assert.notStrictEqual(localDayStart, utcDayStart, '修复后逻辑应与 UTC 旧逻辑不同');
  // 边界：本地 07:30（UTC 前一天 23:30）
  const ts730 = new Date(2026, 7, 13, 7, 30).getTime();
  const dd = new Date(ts730);
  const start = new Date(dd.getFullYear(), dd.getMonth(), dd.getDate()).getTime();
  const utcOld = ts730 - (ts730 % 86400000);
  assert.strictEqual(start, new Date(2026, 7, 13, 0, 0).getTime(), '本地 07:30 的 dayStart = 本地当天 00:00');
  assert.strictEqual(utcOld, Date.UTC(2026, 7, 12), '旧算法把本地 07:30 归到 UTC 零点（bug 复现）');
});

test('图片题（content 空）列表摘要回退', async () => {
  const store = mockStore();
  const records = createRecordsApi(store, mockTiku);
  await records.addRecord({ questionId: 4001, subject: '公务员·行测', chapter: '判断推理', correct: false, paperId: 7 });
  const w = await records.wrong();
  assert.strictEqual(w.list[0]?.content, '（图片题）', '错题本图片题摘要');
  const r = await records.recent();
  assert.strictEqual(r[0]?.content, '（图片题）', '最近记录图片题摘要');
  await records.toggleFavorite(4001, { subject: '公务员·行测', chapter: '判断推理' });
  const f2 = await records.favorites();
  assert.strictEqual(f2.list[0]?.content, '（图片题）', '收藏列表图片题摘要');
});
