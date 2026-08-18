// test-local-api.mjs — 阶段 2 验证：public/local-api.js 数据层（查询面 + 记录面 + 图片层）
import { DatabaseSync } from 'node:sqlite';
import { initLocalApi, aggregateStats } from './public/local-api.js';

const db = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
const imgDb = new DatabaseSync('app-assets/images.db', { readOnly: true });
const engine = { get: (s, ...p) => db.prepare(s).get(...p), all: (s, ...p) => db.prepare(s).all(...p) };
const imgEngine = { get: (s, ...p) => imgDb.prepare(s).get(...p) };

// 内存 store（模拟 IndexedDB 适配器接口）
const mem = { records: [], favorites: [], custom_questions: [] };
const store = {
  async getAll(kind) { return mem[kind].map((r) => ({ ...r })); },
  async put(kind, row) {
    if (kind === 'records') { if (row.id == null) row.id = Date.now() + Math.random(); mem.records.push({ ...row }); }
    else mem.favorites.push({ ...row });
  },
  async deleteBy(kind, key, value) {
    mem[kind] = mem[kind].filter((r) => r[key] !== value);
  },
};

let failed = 0;
const ok = (name, cond, extra = '') => { if (!cond) { failed++; console.error(`✗ ${name} ${extra}`); } else console.log(`✓ ${name} ${extra}`); };

const api = await initLocalApi({ tiku: engine, practice: engine, images: imgEngine, store });

// ---- 查询面 smoke ----
ok('query.subjects 4 科', api.query.subjects().length === 4);
const pr = api.query.practice('公务员·行测', { n: 5 });
ok('query.practice 出题', pr.length >= 5, `(${pr.length})`);
ok('题目含 id 字段', pr.every((q) => 'id' in q && q.id != null));

// ---- 收藏 ----
const favQ = pr[0];
await api.records.toggleFavorite(favQ.id, { subject: '公务员·行测', chapter: favQ.chapter });
const favList1 = await api.records.favorites({ limit: 10 });
ok('favorites 添加', favList1.total === 1 && favList1.list[0].questionId === favQ.id && typeof favList1.list[0].content === 'string');
ok('favorites 分页结构', favList1.hasMore === false && favList1.offset === 0);
const favIds = await api.records.favoriteIds();
ok('favoriteIds', favIds.has(favQ.id) && favIds.size === 1);
await api.records.toggleFavorite(favQ.id, {});
ok('favorites 取消', (await api.records.favorites()).total === 0);
await api.records.toggleFavorite(favQ.id, {}); // 再加回，供后续对照

// ---- 做题记录 ----
const q1 = api.query.questionById(favQ.id);
// 先提交错误，再同日重复提交正确 → 错题保护：保留错题记录 + 新增正确记录（累计做对 3 次才移除）
await api.records.addRecord({ questionId: q1.id, subject: '公务员·行测', chapter: q1.chapter, type: q1.type, selected: [], correct: false, costMs: 3000, paperId: q1.paperId });
await api.records.addRecord({ questionId: q1.id, subject: '公务员·行测', chapter: q1.chapter, type: q1.type, selected: [q1.answerIndex], correct: true, costMs: 5000, paperId: q1.paperId });
let recs = await store.getAll('records');
ok('records 错题保护（错→对保留错题记录）', recs.length === 2 && recs.some((r) => r.is_correct === 0) && recs.some((r) => r.is_correct === 1), `(${recs.length} 条)`);
// 同日再答对 → 正确记录去重为 1 条，错题记录仍保留
await api.records.addRecord({ questionId: q1.id, subject: '公务员·行测', chapter: q1.chapter, type: q1.type, selected: [q1.answerIndex], correct: true, costMs: 6000, paperId: q1.paperId });
recs = await store.getAll('records');
ok('records 正确记录同日去重', recs.length === 2 && recs.filter((r) => r.is_correct === 1).length === 1, `(${recs.length} 条)`);

const q2 = api.query.questionById(pr[1].id);
await api.records.addRecord({ questionId: q2.id, subject: '公务员·行测', chapter: q2.chapter, type: q2.type, selected: [], correct: false, costMs: 8000, paperId: q2.paperId });

const st = await api.records.stats();
ok('stats 计数', st.total === 3 && st.done === 1 && st.wrong === 2, JSON.stringify(st));

const w = await api.records.wrong({ limit: 10 });
ok('wrong 去重列表', w.total === 2 && typeof w.list[0].content === 'string', JSON.stringify(w.list.map((x) => x.id)));

const rec = await api.records.recent({ limit: 5 });
ok('recent 时间倒序且含字段', rec.length === 3 && 'correct' in rec[0] && rec.every((x) => x.questionId === q1.id || x.questionId === q2.id), JSON.stringify(rec.map((x) => x.questionId)));

// ---- aggregateStats 直测（用真实题 id 保证索引映射存在） ----
const xcReal = api.query.practice('公务员·行测', { n: 1 })[0];
const slReal = api.query.practice('公务员·申论', { group: '归纳概括题', sub: '全部', n: 1 })[0];
const agg = aggregateStats([
  { question_id: xcReal.id, subject: '公务员·行测', chapter: xcReal.chapter, is_correct: 1 },
  { question_id: xcReal.id, subject: '公务员·行测', chapter: xcReal.chapter, is_correct: 1 }, // 重复答对
  { question_id: xcReal.id + 1, subject: '公务员·行测', chapter: xcReal.chapter, is_correct: 0 },
  { question_id: slReal.id, subject: '公务员·申论', chapter: slReal.chapter, is_correct: 1 },
], engine);
ok('doneBySubject 去重', agg.doneBySubject.get('公务员·行测') === 1 && agg.doneBySubject.get('公务员·申论') === 1);
ok('chapterStats', agg.chapterStats.get('公务员·行测').get(xcReal.chapter).c === 3 && agg.chapterStats.get('公务员·行测').get(xcReal.chapter).ok === 2);
ok('subStats 索引映射', agg.subStats.has('公务员·申论') && agg.subStats.get('公务员·申论').size > 0, JSON.stringify([...agg.subStats.keys()]));

// ---- 图片层 ----
const k = imgDb.prepare('SELECT key FROM images LIMIT 1').get()?.key;
ok('formula 命中', k && api.images.formula(k)?.blob?.length > 0, `(key=${k?.slice(0, 16)}…)`);
ok('formula 未命中', api.images.formula('__nope__') === null);
const html = '<img src="https://fb.fbstatic.cn/api/planet/accessories/formulas?latex=ABC" style="width:20px"> <img src="https://other.com/x.png">';
const rw = api.images.rewriteHtml(html);
ok('rewriteHtml 公式 URL 改写', rw.includes('/formula/ABC') && rw.includes('other.com/x.png'), rw);

db.close(); imgDb.close();
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;

