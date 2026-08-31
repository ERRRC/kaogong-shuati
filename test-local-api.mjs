// test-local-api.mjs — 阶段 2 验证：public/local-api.js 数据层（查询面 + 记录面 + 图片层）
import { DatabaseSync } from 'node:sqlite';
import { initLocalApi, aggregateStats } from './public/local-api.js';

const db = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
const imgDb = new DatabaseSync('app-assets/images.db', { readOnly: true });
const engine = { get: (s, ...p) => db.prepare(s).get(...p), all: (s, ...p) => db.prepare(s).all(...p) };
const imgEngine = { get: (s, ...p) => imgDb.prepare(s).get(...p) };

// 内存 store（模拟 IndexedDB 适配器接口；records/favorites 按主键覆盖，与真实 IDB 一致）
const mem = { records: [], favorites: [], custom_questions: [], notes: [] };
const store = {
  async getAll(kind) { return mem[kind].map((r) => ({ ...r })); },
  async put(kind, row) {
    if (kind === 'records') {
      if (row.id == null) row.id = Date.now() + Math.random();
      const i = mem.records.findIndex((r) => r.id === row.id);
      if (i >= 0) mem.records[i] = { ...row }; else mem.records.push({ ...row });
    } else if (kind === 'notes') { // 一题一笔记：同 question_id 覆盖（upsert 语义，与 IndexedDB 同 key 覆盖一致）
      const i = mem.notes.findIndex((r) => String(r.question_id) === String(row.question_id));
      if (i >= 0) mem.notes[i] = { ...row };
      else mem.notes.push({ ...row });
    } else { // favorites：question_id 为主键
      const i = mem.favorites.findIndex((r) => String(r.question_id) === String(row.question_id));
      if (i >= 0) mem.favorites[i] = { ...row }; else mem.favorites.push({ ...row });
    }
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

// ---- 笔记（一题一笔记，可修改，可删除） ----
const noteQ = pr[1];
await api.records.upsertNote(noteQ.id, { subject: '公务员·行测', chapter: noteQ.chapter, note: '考点：主谓一致，注意就近原则' });
let noteList = await api.records.notes({ limit: 10 });
ok('notes 添加', noteList.total === 1 && noteList.list[0].questionId === noteQ.id && noteList.list[0].note.includes('主谓一致'));
ok('notes 分页结构', noteList.hasMore === false && noteList.offset === 0 && typeof noteList.list[0].content === 'string');
// 修改：同题再保存 = 更新（一题一笔记）
await api.records.upsertNote(noteQ.id, { subject: '公务员·行测', chapter: noteQ.chapter, note: '考点：主谓一致（修改版）' });
noteList = await api.records.notes();
ok('notes 修改（upsert 不重复）', noteList.total === 1 && noteList.list[0].note.includes('修改版'));
const noteIds = await api.records.noteIds();
ok('noteIds', noteIds.has(String(noteQ.id)) && noteIds.size === 1);
// 删除
await api.records.deleteNote(noteQ.id);
ok('notes 删除', (await api.records.notes()).total === 0);
// 再加一条供后续对照（含 custom 前缀语义的 question_id 兼容）
await api.records.upsertNote('custom-999', { subject: '自定义', note: '自定义题笔记' });
noteList = await api.records.notes();
ok('notes custom- 前缀 question_id', noteList.total === 1 && String(noteList.list[0].questionId) === 'custom-999' && noteList.list[0].note === '自定义题笔记');
// 单条查询（?qid=，笔记超过预载 200 条时弹层兜底用）+ 时间格式 + 空内容/超长防护
const qidHit = await api.records.notes({ qid: 'custom-999' });
ok('notes qid 单条查询', qidHit.total === 1 && qidHit.list[0].note === '自定义题笔记');
ok('notes qid 未命中', (await api.records.notes({ qid: 'nope' })).total === 0);
ok('notes 时间格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(qidHit.list[0].time || ''));
let emptyBlocked = false;
try { await api.records.upsertNote(noteQ.id, { note: '   ' }); } catch { emptyBlocked = true; }
ok('notes 空内容拦截', emptyBlocked);
await api.records.upsertNote('custom-888', { note: 'x'.repeat(600) });
ok('notes 超长截断到 500', (await api.records.notes({ qid: 'custom-888' })).list[0].note.length === 500);
await api.records.deleteNote('custom-888');
await api.records.deleteNote('custom-999');

// ---- 做题记录 ----
const q1 = pr[0]; // 直接用出题响应（字段与 questionById 同构，避免题库行随机性导致取到同题）
// 先提交错误，再同日重复提交正确 → 错题保护：保留错题记录 + 新增正确记录（累计做对 3 次才移除）
await api.records.addRecord({ questionId: q1.id, subject: '公务员·行测', chapter: q1.chapter, type: q1.type, selected: [], correct: false, costMs: 3000, paperId: q1.paperId });
await api.records.addRecord({ questionId: q1.id, subject: '公务员·行测', chapter: q1.chapter, type: q1.type, selected: [q1.answerIndex], correct: true, costMs: 5000, paperId: q1.paperId });
let recs = await store.getAll('records');
ok('records 错题保护（错→对保留错题记录）', recs.length === 2 && recs.some((r) => r.is_correct === 0) && recs.some((r) => r.is_correct === 1), `(${recs.length} 条)`);
// 同日再答对 → 正确记录去重为 1 条，错题记录仍保留
await api.records.addRecord({ questionId: q1.id, subject: '公务员·行测', chapter: q1.chapter, type: q1.type, selected: [q1.answerIndex], correct: true, costMs: 6000, paperId: q1.paperId });
recs = await store.getAll('records');
ok('records 正确记录同日去重', recs.length === 2 && recs.filter((r) => r.is_correct === 1).length === 1, `(${recs.length} 条)`);

const q2 = pr[1];
await api.records.addRecord({ questionId: q2.id, subject: '公务员·行测', chapter: q2.chapter, type: q2.type, selected: [], correct: false, costMs: 8000, paperId: q2.paperId });

const st = await api.records.stats();
ok('stats 计数', st.total === 3 && st.done === 1 && st.wrong === 2, JSON.stringify(st));

const w = await api.records.wrong({ limit: 10 });
ok('wrong 去重列表', w.total === 2 && typeof w.list[0].content === 'string', JSON.stringify(w.list.map((x) => x.id)));

const rec = await api.records.recent({ limit: 5 });
ok('recent 时间倒序且含字段', rec.length === 3 && 'correct' in rec[0] && rec.every((x) => x.questionId === q1.id || x.questionId === q2.id), JSON.stringify(rec.map((x) => x.questionId)));

// ---- 来源归档（2026-08-22：5 大模块 tab + 子模块 + 一键整理） ----
// 写入时自动分类：q1/q2 为行测题（group=公务员·行测，sub=章节树大模块）；再补一条自定义题错题记录
await api.records.addRecord({ questionId: 'custom-1', subject: '自定义', chapter: '测试批次', correct: false });
const wrongRows = (await store.getAll('records')).filter((r) => r.is_correct === 0);
ok('records 写入即归档 group_key', wrongRows.filter((r) => !String(r.question_id).startsWith('custom-')).every((r) => r.group_key === '公务员·行测' && r.sub_key !== ''), JSON.stringify(wrongRows.map((r) => [r.question_id, r.group_key, r.sub_key])));
ok('records 自定义题归档 custom', wrongRows.some((r) => String(r.question_id) === 'custom-1' && r.group_key === 'custom' && r.sub_key === ''));
// group 过滤
const wXc = await api.records.wrong({ group: '公务员·行测' });
ok('wrong group 过滤', wXc.total === 2 && wXc.list.every((x) => !String(x.questionId).startsWith('custom-')), `(${wXc.total})`);
const wCustom = await api.records.wrong({ group: 'custom' });
ok('wrong custom 组', wCustom.total === 1 && wCustom.list[0].questionId === 'custom-1');
// 子模块过滤：行测组内某大模块应命中 q1/q2（mapChapterToNode 非空）
const xcG = await api.records.groups('wrong');
const xc = xcG.find((x) => x.key === '公务员·行测');
ok('wrong groups 总览', xc && xc.count === 2 && xc.subs.length > 0 && xc.subs[0].key !== '' && xc.subs[0].name !== '', JSON.stringify(xcG.map((x) => [x.name, x.count])));
const customG = xcG.find((x) => x.key === 'custom');
ok('wrong groups 自定义组', customG && customG.count === 1);
ok('wrong groups 固定 5 组', xcG.length === 5 && xcG.map((x) => x.key).join(',') === '公务员·行测,事业编·职测,公务员·申论,事业编·综应,custom');
// 收藏/笔记写入归档 + group 过滤（favQ 行测题；笔记用 custom 题）
const favG = await api.records.favorites({ group: '公务员·行测' });
ok('favorites 写入归档 + group 过滤', favG.total === 1 && favG.list[0].questionId === favQ.id, JSON.stringify(favG.list));
await api.records.upsertNote('custom-2', { note: '自定义归档' });
const noteG = await api.records.notes({ group: 'custom' });
ok('notes 写入归档 + group 过滤', noteG.total === 1 && String(noteG.list[0].questionId) === 'custom-2');
// 一键整理：清空归档字段模拟历史未分类数据 → organize 自动归类（幂等可重复）
for (const r of mem.records) { r.group_key = ''; r.sub_key = ''; }
for (const r of mem.favorites) { r.group_key = ''; r.sub_key = ''; }
for (const r of mem.notes) { r.group_key = ''; r.sub_key = ''; }
const org = await api.records.organize('wrong');
ok('organize 回填错题', org.ok && org.total === 3 && org.fixed === 3, JSON.stringify(org));
const orgF = await api.records.organize('favorites');
ok('organize 回填收藏', orgF.ok && orgF.fixed === 1, JSON.stringify(orgF));
const orgN = await api.records.organize('notes');
ok('organize 回填笔记', orgN.ok && orgN.fixed === 1, JSON.stringify(orgN));
ok('organize 幂等', (await api.records.organize('wrong')).fixed === 0 && (await api.records.organize('favorites')).fixed === 0 && (await api.records.organize('notes')).fixed === 0);
ok('organize 后未分类为空', (await api.records.groups('wrong')).every((x) => x.key !== ''));

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

