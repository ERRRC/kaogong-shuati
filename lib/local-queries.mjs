/**
 * lib/local-queries.mjs — App 版离线查询引擎 · 纯查询逻辑层
 *
 * 从 server.mjs 抽取的只读题库查询逻辑（SQL + 组装函数），逐字段对齐：
 *   /api/subjects /api/categories /api/papers /api/papers/:id
 *   /api/papers/:id/materials /api/materials /api/practice /api/question /api/chapters
 *
 * 引擎无关设计：本模块不 import 任何 SQLite 实现，由调用方注入适配器：
 *   tiku      — 只读题库库（App: tiku_app.db 中的 tiku 库；含 question_categories/q_materials/q_material_map/materials）
 *   practice  — 用户记录库（App: IndexedDB 记录；本模块仅接受注入的统计结果，不直接查询）
 *   适配器接口：{ get(sql, ...params) -> row|undefined, all(sql, ...params) -> rows }
 *
 * 用法（浏览器/WebView ESM）：
 *   import { createLocalApi } from '../lib/local-queries.mjs';
 *   const api = createLocalApi(tikuEngine, { doneBySubject, chapterStats });
 */

import { FENBI_TREE, ESSAY_TREE, SHENLUN_TREE, ZONGYING_TREE } from './fenbi-tree.mjs';
import { mapChapterToNode } from './xingce-chapter-map.mjs';

// ============ SQL（与 server.mjs 预编译语句 1:1） ============
const Q_PAPERS_BY_SUBJECT =
  'SELECT id, category, name, questionCount, difficulty FROM papers WHERE subjectName = ? ORDER BY category, id DESC';
const Q_PAPERS_BY_CATEGORY =
  'SELECT id, name, questionCount, difficulty FROM papers WHERE subjectName = ? AND category = ? ORDER BY id DESC';
const Q_PAPER_BY_ID =
  'SELECT id, subjectName, category, name, questionCount, difficulty, chapters FROM papers WHERE id = ?';
const Q_QUESTIONS_BY_PAPER =
  'SELECT q.questionId, q.paperId, q.chapter, q.type, q.content, q.contentHtml, q.options, q.answer, q.answerIndex, q.difficulty FROM questions q WHERE q.paperId = ? ORDER BY q.id';
const Q_QUESTION_BY_ID =
  'SELECT questionId, paperId, chapter, type, content, contentHtml, options, answer, answerIndex, difficulty FROM questions WHERE questionId = ? ORDER BY id LIMIT 1';
const Q_MATERIALS_BY_PAPER =
  'SELECT title, idx, text FROM materials WHERE paperId = ? ORDER BY idx';
const Q_CAT_INDEX = (withSub) => withSub
  ? 'SELECT qc.question_id FROM question_categories qc WHERE qc.category = ? AND qc.sub = ? AND qc.subject = ? AND EXISTS (SELECT 1 FROM questions q WHERE q.questionId = qc.question_id) ORDER BY RANDOM() LIMIT ?'
  : 'SELECT qc.question_id FROM question_categories qc WHERE qc.category = ? AND qc.subject = ? AND EXISTS (SELECT 1 FROM questions q WHERE q.questionId = qc.question_id) ORDER BY RANDOM() LIMIT ?';

// ============ 智能组卷（行测）本地版常量（与 server.mjs 同构） ============
// 行测考情基准：市地/执法 130 题 / 120 分钟；官方模块序与题量；score 为机构通行单题分值估算
const XINGCE_TEMPLATE = [
  { name: '政治理论', count: 20, score: 0.5, tint: 'tint-red', subs: [['新思想', 10], ['时事政治', 6], ['马克思主义', 2], ['毛中特', 2]] },
  { name: '常识判断', count: 15, score: 0.5, tint: 'tint-amber', subs: [['人文常识', 6], ['法律常识', 3], ['科技常识', 3], ['地理国情', 2], ['经济常识', 1]] },
  { name: '言语理解与表达', count: 30, score: 0.8, tint: 'tint-blue', subs: [['片段阅读', 12], ['逻辑填空', 10], ['语句表达', 8]] },
  { name: '数量关系', count: 10, score: 0.8, tint: 'tint-orange', subs: [['数学运算', 10]] },
  { name: '判断推理', count: 35, score: 0.8, tint: 'tint-violet', subs: [['图形推理', 9], ['定义判断', 9], ['类比推理', 9], ['逻辑判断', 8]] },
  { name: '资料分析', count: 20, score: 1.0, tint: 'tint-green', subs: [['综合', 7], ['增长', 6], ['比重', 3], ['平均数', 3], ['倍数', 1]] },
];
// ============ 职测（事业编·职测）本地版常量（与 server.mjs 同构） ============
// 职测考情（2025 版大纲，联考 A/B/C 类与山东通用）：90 分钟 / 满分 150；A/B/C 各 100 题、山东 90 题
const ZHI_CE_COMMON_SUBS = {
  常识判断: [['常识判断', '人文常识', 8], ['常识判断', '科技常识', 4], ['常识判断', '法律常识', 3], ['常识判断', '地理国情', 3], ['常识判断', '经济常识', 2]],
  言语理解与表达: [['言语理解与表达', '逻辑填空', 8], ['言语理解与表达', '片段阅读', 8], ['言语理解与表达', '语句表达', 4]],
  判断推理: [['判断推理', '图形推理', 7], ['判断推理', '定义判断', 9], ['判断推理', '类比推理', 9], ['判断推理', '逻辑判断', 10]],
  资料分析: [['资料分析', '综合', 6], ['资料分析', '增长', 4], ['资料分析', '比重', 2], ['资料分析', '平均数', 2], ['资料分析', '倍数', 1]],
};
const ZHI_CE_TEMPLATES = {
  '联考A类': {
    total: 100, minutes: 90, score: 150,
    modules: [
      { name: '常识判断', count: 20, tint: 'tint-amber', subs: ZHI_CE_COMMON_SUBS.常识判断 },
      { name: '言语理解与表达', count: 20, tint: 'tint-blue', subs: ZHI_CE_COMMON_SUBS.言语理解与表达 },
      { name: '数量关系', count: 10, tint: 'tint-orange', subs: [['数量关系', '数学运算', 10]] },
      { name: '判断推理', count: 35, tint: 'tint-violet', subs: ZHI_CE_COMMON_SUBS.判断推理 },
      { name: '资料分析', count: 15, tint: 'tint-green', subs: ZHI_CE_COMMON_SUBS.资料分析 },
    ],
  },
  '联考B类': {
    total: 100, minutes: 90, score: 150,
    modules: [
      { name: '常识判断', count: 20, tint: 'tint-amber', subs: ZHI_CE_COMMON_SUBS.常识判断 },
      { name: '言语理解与表达', count: 25, tint: 'tint-blue', subs: ZHI_CE_COMMON_SUBS.言语理解与表达 },
      { name: '数量分析', count: 15, tint: 'tint-orange', subs: [['数量关系', '数学运算', 5], ...ZHI_CE_COMMON_SUBS.资料分析] },
      { name: '判断推理', count: 30, tint: 'tint-violet', subs: ZHI_CE_COMMON_SUBS.判断推理 },
      { name: '综合分析', count: 10, tint: 'tint-red', subs: [['言语理解与表达', '片段阅读', 10]] },
    ],
  },
  '联考C类': {
    total: 100, minutes: 90, score: 150,
    modules: [
      { name: '常识判断', count: 20, tint: 'tint-amber', subs: ZHI_CE_COMMON_SUBS.常识判断 },
      { name: '言语理解与表达', count: 25, tint: 'tint-blue', subs: ZHI_CE_COMMON_SUBS.言语理解与表达 },
      { name: '数量分析', count: 10, tint: 'tint-orange', subs: [['数量关系', '数学运算', 5], ['资料分析', '综合', 2], ['资料分析', '增长', 2], ['资料分析', '比重', 1]] },
      { name: '判断推理', count: 30, tint: 'tint-violet', subs: ZHI_CE_COMMON_SUBS.判断推理 },
      { name: '综合分析', count: 15, tint: 'tint-red', subs: [['数量关系', '数学运算', 5], ...ZHI_CE_COMMON_SUBS.资料分析] },
    ],
  },
  '山东': {
    total: 90, minutes: 90, score: 150,
    modules: [
      { name: '常识判断', count: 15, tint: 'tint-amber', subs: [...ZHI_CE_COMMON_SUBS.常识判断.slice(0, 5), ['政治理论', '新思想', 1]] },
      { name: '言语理解与表达', count: 20, tint: 'tint-blue', subs: ZHI_CE_COMMON_SUBS.言语理解与表达 },
      { name: '数量关系', count: 5, tint: 'tint-orange', subs: [['数量关系', '数学运算', 5]] },
      { name: '判断推理', count: 35, tint: 'tint-violet', subs: ZHI_CE_COMMON_SUBS.判断推理 },
      { name: '资料分析', count: 15, tint: 'tint-green', subs: ZHI_CE_COMMON_SUBS.资料分析 },
    ],
  },
};
const ZHI_CE_SOURCES = [
  { id: 'zcA', label: '联考A类', test: (c) => c === '联考A类' },
  { id: 'zcB', label: '联考B类', test: (c) => c === '联考B类' },
  { id: 'zcC', label: '联考C类', test: (c) => c === '联考C类' },
  { id: 'sd', label: '山东', test: (c) => c === '山东' },
];
/** 弱项加权：模块配额 +30%，差额从其余模块按比例扣回（保证总和 = total） */
function applyWeakQuota(modules, weakSet, total) {
  const boosted = modules.map((m) => (weakSet.has(m.name) ? Math.round(m.quota * 1.3) : m.quota));
  let sum = boosted.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (sum !== total && guard++ < 1000) {
    if (sum > total) {
      let best = -1, bestV = 0;
      boosted.forEach((v, i) => { if (!weakSet.has(modules[i].name) && v > bestV) { bestV = v; best = i; } });
      if (best < 0) best = boosted.indexOf(Math.max(...boosted));
      boosted[best] = Math.max(0, boosted[best] - 1);
      sum -= 1;
    } else {
      let best = -1, bestV = 0;
      boosted.forEach((v, i) => { if (weakSet.has(modules[i].name) && v > bestV) { bestV = v; best = i; } });
      if (best < 0) best = boosted.indexOf(Math.max(...boosted));
      boosted[best] += 1;
      sum += 1;
    }
  }
  return boosted;
}
const XINGCE_TOTAL = 130;
const XINGCE_MINUTES = 120;
const XINGCE_GROUP_SIZE = 5;
const XINGCE_DIFFICULTY = { easy: { min: 1, max: 3 }, balanced: { min: 3, max: 6 }, hard: { min: 6, max: 9 } };
// 四个题库源（按卷型来源划分；本地为 JS 判定，无 SQL 片段）
const LIAOKAO = new Set(['黑龙江', '吉林', '湖北', '新疆', '江西', '河南', '天津', '重庆', '福建', '安徽', '云南', '河北', '山西', '广西', '青海', '陕西', '贵州', '湖南', '辽宁', '甘肃', '海南', '内蒙古', '宁夏', '西藏', '四川']);
const DULI = new Set(['江苏', '浙江', '广东', '山东', '北京', '上海', '深圳市考', '广州市考']);
const PAPER_SOURCES = [
  { id: 'tikuA', label: '国考', test: (c) => String(c || '').includes('国考') },
  { id: 'tikuB', label: '联考省考', test: (c) => LIAOKAO.has(c) },
  { id: 'tikuC', label: '独立命题', test: (c) => DULI.has(c) },
  { id: 'tikuD', label: '选调/其他', test: (c) => c === '选调' || String(c || '').includes('政法') },
];

/** 按权重比例分配整数配额（largest remainder；与 server allocateQuota 相同） */
function allocateQuota(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const floors = weights.map((w) => Math.floor((w * total) / sum));
  const rest = weights.map((w, i) => [i, (w * total) / sum - floors[i]]);
  rest.sort((a, b) => b[1] - a[1]);
  let remain = total - floors.reduce((a, b) => a + b, 0);
  for (const [i] of rest) {
    if (remain <= 0) break;
    floors[i] += 1;
    remain -= 1;
  }
  return floors;
}

/** Fisher-Yates 洗牌（原地） */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ============ 工具函数（与 server.mjs 1:1） ============
/** 真题/模拟题过滤（mock: '0'=真题  '1'=模拟题  undefined=不限） */
export function mockCond(mock) {
  if (mock === '0') return " AND (p.category NOT LIKE '%模拟%' AND p.category NOT LIKE '%模考%')";
  if (mock === '1') return " AND (p.category LIKE '%模拟%' OR p.category LIKE '%模考%')";
  return '';
}

/** 组装题目响应（与 server toQuestion 相同：字段名为 id） */
export function toQuestion(q) {
  return {
    id: q.questionId,
    paperId: q.paperId ?? null,
    chapter: q.chapter,
    type: q.type,
    content: q.content,
    contentHtml: q.contentHtml,
    options: JSON.parse(q.options || '[]'),
    answer: q.answer,
    answerIndex: q.answerIndex,
    difficulty: q.difficulty,
  };
}

/** 判分：选项索引 → 是否正确（与 server checkAnswer 相同；兼容已解析的 options 数组） */
export function checkAnswer(q, selected) {
  const opts = Array.isArray(q.options) ? q.options : JSON.parse(q.options || '[]');
  const sel = (Array.isArray(selected) ? selected : [selected]).map(Number);
  const ans = String(q.answer ?? '').trim();
  if (ans.startsWith('[')) {
    const correct = JSON.parse(ans).map(Number);
    const ok = correct.length === sel.length && correct.every((v) => sel.includes(v));
    return { ok, correct, selected: sel, correctText: correct.map((i) => opts[i]).filter(Boolean) };
  }
  if (ans && /^[\d,\s]+$/.test(ans) && ans.includes(',')) {
    const correct = ans.split(',').map(Number);
    const ok = correct.length === sel.length && correct.every((v) => sel.includes(v));
    return { ok, correct, selected: sel, correctText: correct.map((i) => opts[i]).filter(Boolean) };
  }
  if (!opts.length) {
    if (!ans) return { ok: null, correct: [], selected: sel, correctText: [] }; // 无答案：不判分
    const a = Number(ans);
    return { ok: sel[0] === a, correct: [a], selected: sel, correctText: [sel[0] === a ? '正确' : '错误'] };
  }
  if (q.answerIndex != null && q.answerIndex >= 0) {
    return { ok: sel[0] === q.answerIndex, correct: [q.answerIndex], selected: sel, correctText: opts[q.answerIndex] ? [opts[q.answerIndex]] : [] };
  }
  if (ans && /^\d+$/.test(ans)) {
    const a = Number(ans);
    return { ok: sel[0] === a, correct: [a], selected: sel, correctText: opts[a] ? [opts[a]] : [] };
  }
  return { ok: null, correct: [], selected: sel, correctText: [] }; // 真正无答案：不判分
}

/** 随机出题（与 server randomQuestions 相同；tiku 为适配器） */
function randomQuestions(tiku, subject, chapters, n, mock) {
  const cond = mockCond(mock);
  const chList = Array.isArray(chapters) ? chapters.filter(Boolean) : (chapters ? [chapters] : []);
  const chCond = chList.length ? `AND q.chapter IN (${chList.map(() => '?').join(',')}) ` : '';
  const where = `p.subjectName = ? ${chCond}${cond}`;
  const params = [...(chList.length ? [subject, ...chList] : [subject])];
  const maxId = tiku.get('SELECT COALESCE(MAX(id), 0) m FROM questions').m;
  const seenQid = new Set();
  const picks = [];
  const tryAdd = (rows) => {
    for (const r of rows) {
      if (!seenQid.has(r.questionId)) { seenQid.add(r.questionId); picks.push(r.id); }
    }
  };
  for (let attempt = 0; attempt < 20 && picks.length < n; attempt++) {
    const start = Math.floor(Math.random() * Math.max(maxId, 1));
    const need = Math.max(n - picks.length, 1) * 8;
    const cand = tiku.all(
      `SELECT q.id, q.questionId FROM questions q JOIN papers p ON p.id = q.paperId WHERE ${where} AND q.id >= ? ORDER BY q.id LIMIT ?`,
      ...params, start, need
    );
    if (!cand.length && attempt === 0) {
      const all = tiku.all(
        `SELECT q.id, q.questionId FROM questions q JOIN papers p ON p.id = q.paperId WHERE ${where} LIMIT ?`,
        ...params, n * 4
      );
      tryAdd(all);
      break;
    }
    tryAdd(cand);
  }
  if (picks.length < n) {
    // 兜底 2：窗口抽样仍不足（职测等 id 聚集/低密度科目）→ 全量随机一次
    const all = tiku.all(
      `SELECT q.id, q.questionId FROM questions q JOIN papers p ON p.id = q.paperId WHERE ${where} ORDER BY RANDOM() LIMIT ?`,
      ...params, n * 4
    );
    tryAdd(all);
  }
  if (!picks.length) return [];
  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }
  const sel = picks.slice(0, n);
  const qs = tiku.all(
    `SELECT q.questionId, q.paperId, q.chapter, q.type, q.content, q.contentHtml, q.options, q.answer, q.answerIndex, q.difficulty
     FROM questions q WHERE q.id IN (${sel.map(() => '?').join(',')})`,
    ...sel
  );
  return qs.sort(() => Math.random() - 0.5);
}

/** 主观题树（ESSAY_TREE）章节映射：事业编章节 → 树节点（与 server 相同） */
export function mapEssayChapterToNode(ch) {
  if (/(案例分析|材料分析|综合题|综合分析|材料题|简答|论述)/.test(ch)) return { group: '案例分析题', sub: '全部' };
  if (/(情景模拟|实务处理|应急|沟通)/.test(ch)) return { group: '实务处理题', sub: '全部' };
  if (/(公文|应用文|写作|改错|评改|文稿)/.test(ch)) return { group: '公文写作题', sub: '全部' };
  return null;
}
/** 客观题题型归类（事业编）：章节名 → 题型组（与 server 相同） */
export function essayObjectiveGroup(ch) {
  if (/(单项选择|单选题|单选)/.test(ch)) return '单选';
  if (/(多项选择|多选题|多选)/.test(ch)) return '多选';
  if (/(判断)/.test(ch)) return '判断';
  if (/(不定项)/.test(ch)) return '不定项';
  if (/(填空)/.test(ch)) return '填空';
  return '其他';
}

/** 题组增强：把题目按材料归组（与 server enrichGroups 相同；tiku/practice 为适配器） */
function enrichGroups(tiku, practice, rows, subject) {
  const qids = rows.map((r) => r.id ?? r.questionId);
  let maps = [];
  if (qids.length) {
    maps = practice.all(`SELECT question_id, material_id FROM q_material_map WHERE subject = ? AND question_id IN (${qids.map(() => '?').join(',')})`, subject, ...qids);
  }
  const gidOf = new Map(maps.filter((m) => m.material_id != null).map((m) => [m.question_id, m.material_id]));
  const gids = [...new Set(gidOf.values())];
  const groupMembers = new Map();
  if (gids.length) {
    const mem = practice.all(`SELECT question_id, material_id FROM q_material_map WHERE subject = ? AND material_id IN (${gids.map(() => '?').join(',')})`, subject, ...gids);
    for (const m of mem) {
      if (!groupMembers.has(m.material_id)) groupMembers.set(m.material_id, []);
      groupMembers.get(m.material_id).push(m.question_id);
    }
  }
  for (const [gid, members] of groupMembers) {
    for (const mid of members) gidOf.set(mid, gid);
  }
  const materials = new Map();
  if (gids.length) {
    const ms = practice.all(`SELECT material_id, content FROM q_materials WHERE subject = ? AND material_id IN (${gids.map(() => '?').join(',')})`, subject, ...gids);
    for (const m of ms) materials.set(m.material_id, m.content);
  }
  const allIds = [...new Set([...qids, ...[...groupMembers.values()].flat()])];
  let qs = [];
  if (allIds.length) {
    qs = tiku.all(`SELECT q.questionId, q.paperId, q.chapter, q.type, q.content, q.contentHtml, q.options, q.answer, q.answerIndex, q.difficulty FROM questions q WHERE q.questionId IN (${allIds.map(() => '?').join(',')}) GROUP BY q.questionId`, ...allIds);
  }
  const orderOf = new Map(qs.map((q) => [q.questionId, q.id]));
  const byId = new Map(qs.map((q) => [q.questionId, q]));
  const out = [];
  for (const q of qs) {
    const gid = gidOf.get(q.questionId);
    const o = byId.get(q.questionId);
    let gi = 0, gt = 1, mat = null;
    if (gid != null) {
      const members = (groupMembers.get(gid) || []).sort((a, b) => (orderOf.get(a) || 0) - (orderOf.get(b) || 0));
      gi = members.indexOf(q.questionId);
      gt = members.length;
      mat = materials.get(gid) || null;
    }
    out.push({ ...toQuestion(q), groupId: gid ?? null, groupIndex: gi, groupTotal: gt, material: mat });
  }
  const pos = new Map(qids.map((id, i) => [id, i]));
  // 排序规则：同一组内按卷序；组与组/组与单题之间按各自首题（或自身）在原列表位置——
  // 保证材料组连续，但不再把组题无条件前置（组卷时模块内子题型顺序由 subIdx 控制）
  const firstPosOf = (gid) => Math.min(...qs.filter((q) => gidOf.get(q.questionId) === gid).map((q) => pos.get(q.questionId) ?? 99));
  out.sort((a, b) => {
    const ga = a.groupId, gb = b.groupId;
    if (ga != null && gb != null && ga === gb) return a.groupIndex - b.groupIndex;
    if (ga != null && gb != null) return firstPosOf(ga) - firstPosOf(gb);
    if (ga != null) return firstPosOf(ga) - (pos.get(b.id) ?? 99);
    if (gb != null) return (pos.get(a.id) ?? 99) - firstPosOf(gb);
    return (pos.get(a.id) ?? 99) - (pos.get(b.id) ?? 99);
  });
  return out;
}

// ============ 随机练习题量规则（2026-08 用户要求）============
// 行测/职测随机练习固定 15 题；言语理解与表达/判断推理/资料分析（材料组题）放宽到 15-20 封顶；
// 申论/综应（主观题难）固定 2 题。max 用于材料组扩充后的封顶裁剪。
const MATERIAL_GROUPS = ['言语理解与表达', '判断推理', '资料分析'];
function practiceMax(subject, group, chList) {
  if (subject === '公务员·申论' || subject === '事业编·综应') return 2;
  const names = [group, ...(chList || [])].filter(Boolean);
  for (const name of names) {
    const node = mapChapterToNode(name); // 章节/节点名 → 模块（group）
    const label = node ? node.group : name;
    if (MATERIAL_GROUPS.includes(label)) return 20;
  }
  return 15;
}
/** 材料组扩充后的封顶裁剪：优先移除尾部非组题（保持材料组完整），仍超则整组移除；
 *  裁剪后不足 max（如申论/综应 n=2 抽中同一大材料组、全科目抽中多组）→ 按原顺序补足到 max，
 *  保证"固定 N 题"规则兑现（组完整性让步于题量） */
function trimToMax(rows, max) {
  if (!rows || rows.length <= max) return rows;
  const out = rows.slice();
  for (let i = out.length - 1; i >= 0 && out.length > max; i--) {
    if (out[i].groupId == null) out.splice(i, 1);
  }
  if (out.length > max) {
    const gids = [...new Set(out.map((r) => r.groupId).filter((g) => g != null))].reverse();
    for (const gid of gids) {
      if (out.length <= max) break;
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].groupId === gid) out.splice(i, 1);
      }
    }
  }
  if (out.length < max) {
    for (const r of rows) {
      if (out.length >= Math.min(max, rows.length)) break;
      if (!out.includes(r)) out.push(r);
    }
  }
  return out.slice(0, max);
}

/**
 * 内存抽题池（本地版）：一次加载当前科目的分类索引与材料组映射，
 * 抽题改为内存 JS 随机，避免 `ORDER BY RANDOM()` 在 9.6 万行上全表物化（单次 1.6~6.4s → 毫秒级）。
 * 与 server.mjs getPaperPool 同构：byKey = 分类(sub 键) → qid[]；materialSet = 材料组成员 qid；groupMap = 材料组 → qid[]
 */
function buildPaperPool(tiku, practice, subject) {
  const byKey = new Map();
  for (const r of practice.all('SELECT question_id, category, sub FROM question_categories WHERE subject = ?', subject)) {
    const k = `${r.category}|${r.sub}`;
    let arr = byKey.get(k);
    if (!arr) byKey.set(k, (arr = []));
    arr.push(r.question_id);
  }
  const materialSet = new Set();
  const groupMap = new Map();
  for (const r of practice.all('SELECT question_id, material_id FROM q_material_map WHERE subject = ? AND material_id IS NOT NULL', subject)) {
    materialSet.add(r.question_id);
    let arr = groupMap.get(r.material_id);
    if (!arr) groupMap.set(r.material_id, (arr = []));
    arr.push(r.question_id);
  }
  return { byKey, materialSet, groupMap };
}

/**
 * 超量裁剪（本地版）：资料组整组抽取导致实际题数超过目标 1~4 题时，优先裁非材料组单题（保组完整），
 * 单题不足再裁各组组尾题。本地版不回写 sourceCounts（仅展示用途，差 1~4 题无影响）。
 */
function trimToCount(list, count) {
  if (list.length <= count) return list;
  let over = list.length - count;
  for (let i = list.length - 1; i >= 0 && over > 0; i--) {
    if (list[i].groupId != null) continue;
    list.splice(i, 1);
    over--;
  }
  for (let i = list.length - 1; i >= 0 && over > 0; i--) {
    if (list[i].groupId == null) continue;
    if (i > 0 && list[i - 1].groupId === list[i].groupId) continue; // 非组尾
    list.splice(i, 1);
    over--;
  }
  return list;
}

/** 职测组卷（本地版）：按卷型类别模板 → 主源 + 其他类别兜底 → 资料组（多章节）→ 官方模块序 */
function buildZhiCeLocal(tiku, practice, params) {
  const subject = '事业编·职测';
  const category = ZHI_CE_TEMPLATES[params.category] ? params.category : '联考A类';
  const template = ZHI_CE_TEMPLATES[category];
  const difficulty = (typeof params.difficulty === 'string' && XINGCE_DIFFICULTY[params.difficulty])
    ? XINGCE_DIFFICULTY[params.difficulty]
    : { min: Number(params.difficulty?.min) || 3, max: Number(params.difficulty?.max) || 6 };
  const types = Array.isArray(params.types) && params.types.length ? params.types.map(Number) : [1];
  const weakSet = new Set(Array.isArray(params.weak) ? params.weak : []);
  let modules = template.modules.map((m) => ({ ...m, quota: m.count }));
  if (weakSet.size) {
    const boosted = applyWeakQuota(modules, weakSet, template.total);
    modules = modules.map((m, i) => ({ ...m, quota: boosted[i] })).filter((m) => m.quota > 0);
  }
  const mainSrc = ZHI_CE_SOURCES.find((s) => s.label === category) || ZHI_CE_SOURCES[0];
  const fallbackSrcs = ZHI_CE_SOURCES.filter((s) => s.id !== mainSrc.id);
  const catOf = new Map(tiku.all('SELECT id, category FROM papers').map((r) => [r.id, r.category]));
  const pool = buildPaperPool(tiku, practice, subject);
  const qById = (ids) => tiku.all(
    `SELECT q.questionId, q.paperId, q.chapter, q.type, q.difficulty FROM questions q WHERE q.questionId IN (${ids.map(() => '?').join(',')})`,
    ...ids
  );
  const srcOk = (q, src) => src.test(catOf.get(q.paperId));
  const diffOk = (q) => q.difficulty >= difficulty.min && q.difficulty <= difficulty.max;
  const typeOk = (q) => types.includes(q.type);
  const skipQ = new Set();
  const skipG = new Set();
  const sourcePicks = new Map(ZHI_CE_SOURCES.map((s) => [s.id, []]));
  const notices = [];
  const pickSingle = (cat, sub, src, quota) => {
    const cand = shuffle((pool.byKey.get(`${cat}|${sub}`) || []).filter((qid) => !pool.materialSet.has(qid))).slice(0, quota * 12);
    if (!cand.length) return [];
    const qs = qById(cand).filter((q) => srcOk(q, src) && diffOk(q) && typeOk(q));
    shuffle(qs);
    const out = [];
    for (const q of qs) {
      if (out.length >= quota) break;
      if (!skipQ.has(q.questionId)) { skipQ.add(q.questionId); out.push(q.questionId); }
    }
    return out;
  };
  const pickGroups = (src, needGroups, chapterLikes, minSize, maxSize) => {
    const likes = Array.isArray(chapterLikes) ? chapterLikes : [chapterLikes];
    const gids = shuffle([...pool.groupMap.keys()].filter((gid) => (pool.groupMap.get(gid) || []).length >= minSize && (pool.groupMap.get(gid) || []).length <= maxSize)).slice(0, needGroups * 12);
    const out = [];
    for (const gid of gids) {
      if (out.length >= needGroups) break;
      if (skipG.has(gid)) continue;
      const members = pool.groupMap.get(gid);
      const qs = qById(members).filter((q) => srcOk(q, src));
      const okN = qs.filter((q) => diffOk(q)).length;
      if (qs.some((q) => q.chapter && likes.some((l) => q.chapter.includes(l))) && okN >= Math.min(3, qs.length)) {
        skipG.add(gid);
        out.push({ gid, members, pidOf: new Map(qs.map((q) => [q.questionId, q.paperId])) });
      }
    }
    return out;
  };
  const pickSubWithFallback = (cat, sub, quota) => {
    const out = [];
    const trySrc = (src, q) => {
      for (const qid of pickSingle(cat, sub, src, q)) out.push({ questionId: qid, srcId: src.id });
    };
    trySrc(mainSrc, quota);
    let need = quota - out.length;
    for (const src of fallbackSrcs) {
      if (need <= 0) break;
      trySrc(src, need);
      need = quota - out.length;
    }
    return out;
  };
  for (const m of modules) {
    const subWeights = m.subs.map(([, , w]) => w);
    const subQuota = allocateQuota(subWeights, m.quota);
    let dataQuota = 0;
    m.subs.forEach(([cat, sub], si) => {
      if (cat === '资料分析') dataQuota += subQuota[si];
      else if (subQuota[si] > 0) {
        for (const p of pickSubWithFallback(cat, sub, subQuota[si])) {
          sourcePicks.get(p.srcId).push({ questionId: p.questionId, groupId: null, module: m.name, subIdx: si });
        }
      }
    });
    if (dataQuota > 0) {
      // 资料组：A 类/山东在"资料分析"章节，B/C 类归入"数量分析"章节 → 多章节匹配
      const G = Math.max(1, Math.ceil(dataQuota / XINGCE_GROUP_SIZE));
      const groups = pickGroups(mainSrc, G, ['资料', '数量分析'], 3, 6);
      if (!groups.length) notices.push('「资料分析」暂无可用整组材料');
      for (const { gid, members, pidOf } of groups) {
        for (const qid of members) {
          if (skipQ.has(qid)) continue;
          skipQ.add(qid);
          const cat = catOf.get(pidOf.get(qid));
          const src = ZHI_CE_SOURCES.find((s) => s.test(cat)) || mainSrc;
          sourcePicks.get(src.id).push({ questionId: qid, groupId: gid, module: m.name, subIdx: 0 });
        }
      }
    }
  }
  const sourceCounts = {};
  for (const s of ZHI_CE_SOURCES) sourceCounts[s.id] = sourcePicks.get(s.id).length;
  const failedSources = sourceCounts[mainSrc.id] === 0 ? [mainSrc.id] : [];
  if (sourceCounts[mainSrc.id] === 0) notices.push(`「${mainSrc.label}」无可用题目`);
  // 官方模块序连排；模块内按子题型（模板 subs 顺序）稳定排序，同题型内随机；逐模块 enrichGroups 保持材料组相邻
  const ordered = [];
  for (const m of modules) {
    const mPicks = [...sourcePicks.values()].flat().filter((p) => p.module === m.name);
    mPicks.sort((a, b) => (a.subIdx ?? 0) - (b.subIdx ?? 0));
    const enriched = enrichGroups(tiku, practice, mPicks.map((p) => ({ id: p.questionId, groupId: p.groupId })), subject);
    for (const q of enriched) q.module = m.name;
    ordered.push(...enriched);
  }
  const total = ordered.length;
  if (total !== template.total && Math.abs(total - template.total) <= 6) trimToCount(ordered, template.total);
  const total2 = ordered.length;
  if (Math.abs(total2 - template.total) > 6) notices.push(`题库资源有限，实际组卷 ${total2} 题（资料分析为整组材料）`);
  return {
    ok: true,
    paperId: `paper_gen_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: `智能组卷 · ${subject}·${category} ${total2}题`,
    subject,
    category,
    total: total2,
    durationMinutes: template.minutes,
    difficulty,
    sourceCounts,
    failedSources,
    questions: ordered,
    notice: notices.length ? notices.join('；') : undefined,
  };
}

// ============ 对外 API（引擎注入） ============
/**
 * @param {object} tiku    只读题库适配器（含 materials 表）
 * @param {object} practice 用户记录适配器（q_material_map/q_materials 只读 + 本地记录统计注入）
 * @param {object} [stats] 本地做题统计（App 从 IndexedDB 计算后注入）
 *   stats.doneBySubject: Map<subjectName, number>（答对去重题数）
 *   stats.chapterStats:  Map<subjectName, Map<chapter, {c, ok}>>（每章节 已做/答对）
 *   stats.subStats:      Map<subjectName, Map<`category|sub`, okCount>>（申论/综应索引子项答对数；无记录返回 null）
 */
export function createLocalApi(tiku, practice, stats = {}) {
  // 注意：stats 是可变引用（local-api 提交答题记录后会替换其 doneBySubject/chapterStats/subStats 属性），
  // 因此这里不能把三个 Map 捕获为闭包常量，否则首页/章节完成度不会随做题实时刷新。
  const statOf = (k) => stats[k] || new Map();

  const api = {
    /** 科目列表（与 /api/subjects 同构；done 来自本地记录） */
    subjects() {
      const rows = tiku.all(`
        SELECT tp.subjectName,
               COUNT(DISTINCT tp.id) AS papers,
               COUNT(DISTINCT tq.questionId) AS questions
        FROM papers tp
        LEFT JOIN questions tq ON tq.paperId = tp.id
        GROUP BY tp.subjectName
      `);
      // 综应只保留 A 类：主界面题目数按分类树口径（question_categories），与专项练习一致
      const zongyingN = Number(tiku.get(`SELECT COUNT(DISTINCT question_id) AS n FROM question_categories WHERE subject = '事业编·综应'`)?.n || 0);
      return rows.map((r) => ({
        subjectName: r.subjectName,
        papers: Number(r.papers),
        questions: r.subjectName === '事业编·综应' ? zongyingN : Number(r.questions),
        done: Number(statOf('doneBySubject').get(r.subjectName) || 0),
      }));
    },

    /** 科目下分类（与 /api/categories 同构） */
    categories(subject) {
      if (!subject) throw new Error('缺少 subject');
      return tiku.all(
        'SELECT p.category, COUNT(DISTINCT p.id) AS papers, COUNT(DISTINCT q.questionId) AS questions FROM papers p LEFT JOIN questions q ON q.paperId = p.id WHERE p.subjectName = ? GROUP BY p.category ORDER BY papers DESC',
        subject
      );
    },

    /** 试卷列表（与 /api/papers 同构） */
    papers(subject, category, limit = 50) {
      if (!subject) throw new Error('缺少 subject');
      const rows = category
        ? tiku.all(Q_PAPERS_BY_CATEGORY, subject, category)
        : tiku.all(Q_PAPERS_BY_SUBJECT, subject);
      return rows.slice(0, Math.min(limit, 500));
    },

    /** 试卷详情（与 /api/papers/:id 同构；含 questions） */
    paperById(id) {
      const paper = tiku.get(Q_PAPER_BY_ID, id);
      if (!paper) throw Object.assign(new Error('试卷不存在'), { status: 404 });
      paper.chapters = JSON.parse(paper.chapters || '[]');
      paper.questions = tiku.all(Q_QUESTIONS_BY_PAPER, id).map(toQuestion);
      return paper;
    },

    /** 试卷材料（与 /api/papers/:id/materials 同构） */
    paperMaterials(paperId) {
      return tiku.all(Q_MATERIALS_BY_PAPER, paperId);
    },

    /** 单题（与 /api/question 同构；含 subject） */
    questionById(id) {
      const q = tiku.get(Q_QUESTION_BY_ID, id);
      if (!q) throw Object.assign(new Error('题目不存在'), { status: 404 });
      const subject = tiku.get('SELECT subjectName FROM papers WHERE id = ?', q.paperId)?.subjectName ?? '';
      return { ...toQuestion(q), subject };
    },

    /** 随机出题（与 /api/practice 同构；支持章节/树节点/题组） */
    practice(subject, { chapter, chapters, group, sub, mock, n = 10 } = {}) {
      if (!subject) throw new Error('缺少 subject');
      const chList = chapters ? chapters.split(',').map((s) => s.trim()).filter(Boolean) : (chapter ? [chapter] : null);
      const max = practiceMax(subject, group, chList);
      if (group) {
        if (subject === '公务员·申论' || subject === '事业编·综应' || subject === '公务员·行测' || subject === '事业编·职测') {
          const ids = (sub === '全部'
            ? practice.all(Q_CAT_INDEX(false), group, subject, n)
            : practice.all(Q_CAT_INDEX(true), group, sub, subject, n)
          ).map((r) => r.question_id);
          if (!ids.length) return [];
          const qs = tiku.all(
            `SELECT q.questionId, q.paperId, q.chapter, q.type, q.content, q.contentHtml, q.options, q.answer, q.answerIndex, q.difficulty
             FROM questions q WHERE q.questionId IN (${ids.map(() => '?').join(',')}) GROUP BY q.questionId`,
            ...ids
          );
          return trimToMax(enrichGroups(tiku, practice, qs, subject), max);
        }
        const chs = tiku.all(`
          SELECT DISTINCT q.chapter FROM questions q JOIN papers p ON p.id = q.paperId
          WHERE p.subjectName = ? AND q.chapter != ''
        `, subject).map((r) => r.chapter).filter((ch) => {
          const node = mapEssayChapterToNode(ch);
          return node && node.group === group && (sub === '全部' || node.sub === sub);
        });
        const rows = randomQuestions(tiku, subject, chs.length ? chs : null, n, mock);
        return trimToMax(enrichGroups(tiku, practice, rows, subject), max);
      }
      return trimToMax(enrichGroups(tiku, practice, randomQuestions(tiku, subject, chList, n, mock), subject), max);
    },

    /** 智能组卷：与 server buildXingcePaper/buildZhiCePaper 同构（本地版：索引抽候选 → 查题 → JS 过滤源/难度/题型） */
    generatePaper(params = {}) {
      if (params.subject === '事业编·职测') return buildZhiCeLocal(tiku, practice, params);
      const subject = '公务员·行测';
      const count = Math.max(1, Math.min(130, Number(params.count) || 20));
      const difficulty = (typeof params.difficulty === 'string' && XINGCE_DIFFICULTY[params.difficulty])
        ? XINGCE_DIFFICULTY[params.difficulty]
        : { min: Number(params.difficulty?.min) || 3, max: Number(params.difficulty?.max) || 6 };
      const types = Array.isArray(params.types) && params.types.length ? params.types.map(Number) : [1];
      const weakSet = new Set(Array.isArray(params.weak) ? params.weak : []);
      // 模块白名单 + 配额（weak 模块 +30%，差额从其余模块扣回）
      let modules = XINGCE_TEMPLATE.map((m) => ({ ...m }));
      if (Array.isArray(params.chapters) && params.chapters.length) {
        const want = new Set(params.chapters);
        modules = modules.filter((m) => want.has(m.name));
      }
      let quota = allocateQuota(modules.map((m) => m.count), count);
      if (weakSet.size) {
        const boosted = modules.map((m, i) => (weakSet.has(m.name) ? Math.round(quota[i] * 1.3) : quota[i]));
        let total = boosted.reduce((a, b) => a + b, 0);
        let guard = 0;
        while (total !== count && guard++ < 1000) {
          if (total > count) {
            let best = -1, bestV = 0;
            boosted.forEach((v, i) => { if (!weakSet.has(modules[i].name) && v > bestV) { bestV = v; best = i; } });
            if (best < 0) best = boosted.indexOf(Math.max(...boosted));
            boosted[best] = Math.max(0, boosted[best] - 1);
            total -= 1;
          } else {
            let best = -1, bestV = 0;
            boosted.forEach((v, i) => { if (weakSet.has(modules[i].name) && v > bestV) { bestV = v; best = i; } });
            if (best < 0) best = boosted.indexOf(Math.max(...boosted));
            boosted[best] += 1;
            total += 1;
          }
        }
        quota = boosted;
      }
      modules = modules.map((m, i) => ({ ...m, quota: quota[i] })).filter((m) => m.quota > 0);
      if (!modules.length) return { ok: false, error: '请至少选择一个模块' };
      // 源过滤（perSource: {id:false} 禁用）
      const activeSources = PAPER_SOURCES.filter((s) => params.perSource?.[s.id] !== false);
      // 分类/卷型缓存（一次取全量，JS 过滤）
      const pool = buildPaperPool(tiku, practice, subject);
      const catOf = new Map(tiku.all('SELECT id, category FROM papers').map((r) => [r.id, r.category]));
      const qById = (ids) => tiku.all(
        `SELECT q.questionId, q.paperId, q.chapter, q.type, q.difficulty FROM questions q WHERE q.questionId IN (${ids.map(() => '?').join(',')})`,
        ...ids
      );
      const srcOk = (q, src) => src.test(catOf.get(q.paperId));
      const diffOk = (q) => q.difficulty >= difficulty.min && q.difficulty <= difficulty.max;
      const typeOk = (q) => types.includes(q.type);
      const skipQ = new Set();
      const skipG = new Set();
      const sourcePicks = new Map(activeSources.map((s) => [s.id, []]));
      const notices = [];
      // 单题抽取（避开材料组题；内存池 JS 随机，等价于 SQL ORDER BY RANDOM() LIMIT quota*12）
      const pickSingle = (category, sub, src, quota) => {
        const cand = shuffle((pool.byKey.get(`${category}|${sub}`) || []).filter((qid) => !pool.materialSet.has(qid))).slice(0, quota * 12);
        if (!cand.length) return [];
        const qs = qById(cand).filter((q) => srcOk(q, src) && diffOk(q) && typeOk(q));
        shuffle(qs);
        const out = [];
        for (const q of qs) {
          if (out.length >= quota) break;
          if (!skipQ.has(q.questionId)) { skipQ.add(q.questionId); out.push(q.questionId); }
        }
        return out;
      };
      // 材料组抽取（资料分析整组；逻辑判断一拖五）；chapterLikes 可为字符串或数组
      const pickGroups = (src, needGroups, chapterLikes, minSize, maxSize) => {
        const likes = Array.isArray(chapterLikes) ? chapterLikes : [chapterLikes];
        const gids = shuffle([...pool.groupMap.keys()].filter((gid) => (pool.groupMap.get(gid) || []).length >= minSize && (pool.groupMap.get(gid) || []).length <= maxSize)).slice(0, needGroups * 12);
        const out = [];
        for (const gid of gids) {
          if (out.length >= needGroups) break;
          if (skipG.has(gid)) continue;
          const members = pool.groupMap.get(gid);
          const qs = qById(members).filter((q) => srcOk(q, src));
          const okN = qs.filter((q) => diffOk(q)).length;
          if (qs.some((q) => q.chapter && likes.some((l) => q.chapter.includes(l))) && okN >= Math.min(3, qs.length)) {
            skipG.add(gid);
            out.push({ gid, members, pidOf: new Map(qs.map((q) => [q.questionId, q.paperId])) });
          }
        }
        return out;
      };
      for (const m of modules) {
        const srcQuotas = allocateQuota(activeSources.map(() => 1), m.quota);
        if (m.name === '资料分析') {
          // 资料分析：整组抽取（标准 5 题一组，容错 3-6）；组数 = ceil(配额/5)，不限源整体抽组
          //（按源拆分会让小源候选不足而整模块落空），组内题按其所属卷型归属源
          const G = Math.ceil(m.quota / XINGCE_GROUP_SIZE);
          for (const { gid, members, pidOf } of pickGroups({ id: 'any', test: () => true }, G, '资料', 3, 6)) {
            for (const qid of members) {
              if (skipQ.has(qid)) continue;
              skipQ.add(qid);
              const cat = catOf.get(pidOf.get(qid));
              const src = activeSources.find((s) => s.test(cat)) || activeSources[0];
              sourcePicks.get(src.id).push({ questionId: qid, groupId: gid, module: m.name, subIdx: 0 });
            }
          }
          continue;
        }
        activeSources.forEach((src, si) => {
          const srcQuota = srcQuotas[si];
          if (srcQuota <= 0) return;
          const subQuota = allocateQuota(m.subs.map(([, w]) => w), srcQuota);
          m.subs.forEach(([subName], si2) => {
            const q = subQuota[si2];
            if (q <= 0) return;
            if (m.name === '判断推理' && subName === '逻辑判断' && q >= XINGCE_GROUP_SIZE) {
              const groups = pickGroups(src, 1, '逻辑', 4, 6);
              if (groups.length) {
                const { members } = groups[0];
                for (const qid of members) {
                  if (!skipQ.has(qid)) { skipQ.add(qid); sourcePicks.get(src.id).push({ questionId: qid, groupId: groups[0].gid, module: m.name, subIdx: si2 }); }
                }
                const rest = q - members.length;
                if (rest > 0) {
                  for (const qid of pickSingle(m.name, subName, src, rest)) sourcePicks.get(src.id).push({ questionId: qid, groupId: null, module: m.name, subIdx: si2 });
                }
                return;
              }
            }
            for (const qid of pickSingle(m.name, subName, src, q)) sourcePicks.get(src.id).push({ questionId: qid, groupId: null, module: m.name, subIdx: si2 });
          });
        });
        // 模块级补齐：跨源补抽（不限源）
        const have = [...sourcePicks.values()].flat().filter((p) => p.module === m.name).length;
        if (have < m.quota && m.name !== '资料分析') {
          const need = m.quota - have;
          const subQuota = allocateQuota(m.subs.map(([, w]) => w), need);
          m.subs.forEach(([subName], si2) => {
            if (subQuota[si2] <= 0) return;
            for (const qid of pickSingle(m.name, subName, { id: 'any', test: () => true }, subQuota[si2])) {
              sourcePicks.get(activeSources[0].id).push({ questionId: qid, groupId: null, module: m.name, subIdx: si2, fallback: true });
            }
          });
        }
      }
      const sourceCounts = {};
      for (const s of activeSources) sourceCounts[s.id] = sourcePicks.get(s.id).length;
      const failedSources = activeSources.filter((s) => sourceCounts[s.id] === 0).map((s) => s.id);
      for (const s of activeSources) if (sourceCounts[s.id] === 0) notices.push(`「${s.label}」无可用题目`);
      // 官方模块序连排；模块内按子题型（模板 subs 顺序）稳定排序，同题型内随机；逐模块 enrichGroups 保持材料组相邻
      const ordered = [];
      for (const m of modules) {
        const picks = [...sourcePicks.values()].flat().filter((p) => p.module === m.name);
        picks.sort((a, b) => (a.subIdx ?? 0) - (b.subIdx ?? 0));
        const rows = picks.map((p) => ({ id: p.questionId, groupId: p.groupId }));
        const enriched = enrichGroups(tiku, practice, rows, subject);
        for (const q of enriched) q.module = m.name;
        ordered.push(...enriched);
      }
      const total = ordered.length;
      if (total !== count && Math.abs(total - count) <= 6) trimToCount(ordered, count);
      const total2 = ordered.length;
      if (Math.abs(total2 - count) > 6) notices.push(`题库资源有限，实际组卷 ${total2} 题（资料分析为整组材料）`);
      return {
        ok: true,
        paperId: `paper_gen_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        title: `智能组卷 · ${subject} ${total2}题`,
        subject,
        total: total2,
        durationMinutes: Math.max(5, Math.round((total2 * XINGCE_MINUTES) / XINGCE_TOTAL)),
        difficulty,
        sourceCounts,
        failedSources,
        questions: ordered,
        notice: notices.length ? notices.join('；') : undefined,
      };
    },

    /** 章节树（与 /api/chapters 同构；done/rate 来自本地记录） */
    chapters(subject, mock) {
      if (!subject) throw new Error('缺少 subject');
      const cond = mockCond(mock);
      const totals = tiku.all(`
        SELECT q.chapter, COUNT(*) c FROM questions q JOIN papers p ON p.id = q.paperId
        WHERE p.subjectName = ? ${cond} GROUP BY q.chapter ORDER BY c DESC
      `, subject);
      const doneMap = statOf('chapterStats').get(subject) || new Map();
      const list = totals.map((t) => {
        const d = doneMap.get(t.chapter);
        return {
          name: t.chapter,
          total: t.c,
          done: d?.c || 0,
          correct: d?.ok || 0,
          rate: d?.c ? Math.round((d.ok / d.c) * 100) : null,
        };
      });
      // 组装树（与 server 1:1）
      const isXingce = subject === '公务员·行测' || subject === '事业编·职测';
      const essaySubjects = ['公务员·申论', '事业编·综应'];
      const nodeChapters = new Map();
      const otherChapters = [];
      const objectiveChapters = [];
      const objByType = new Map();
      for (const c of list) {
        if (isXingce) {
          const node = mapChapterToNode(c.name);
          if (!node) { otherChapters.push(c); continue; }
          const key = node.leaf ? `${node.group}|${node.sub}|${node.leaf}` : `${node.group}|${node.sub}`;
          if (!nodeChapters.has(key)) nodeChapters.set(key, []);
          nodeChapters.get(key).push(c);
        } else if (essaySubjects.includes(subject)) {
          otherChapters.push(c);
        } else {
          const node = mapEssayChapterToNode(c.name);
          if (node) {
            const key = `${node.group}|${node.sub}`;
            if (!nodeChapters.has(key)) nodeChapters.set(key, []);
            nodeChapters.get(key).push(c);
          } else {
            objectiveChapters.push(c);
            const t = essayObjectiveGroup(c.name);
            if (!objByType.has(t)) objByType.set(t, []);
            objByType.get(t).push(c);
          }
        }
      }
      const sum = (arr) => ({
        total: arr.reduce((s, c) => s + c.total, 0),
        done: arr.reduce((s, c) => s + c.done, 0),
        rate: (() => { const w = arr.filter((c) => c.rate != null); return w.length ? Math.round(w.reduce((s, c) => s + c.rate, 0) / w.length) : null; })(),
      });
      let groups;
      if (isXingce) {
        const idxMap = new Map();
        for (const r of practice.all(`
          SELECT qc.category, qc.sub, COUNT(*) c FROM question_categories qc
          WHERE qc.subject = ? AND EXISTS (SELECT 1 FROM questions q WHERE q.questionId = qc.question_id)
          GROUP BY qc.category, qc.sub
        `, subject)) {
          idxMap.set(`${r.category}|${r.sub}`, r.c);
        }
        groups = FENBI_TREE.map((g) => {
          const subs = g.subs.map((sub2) => {
            const idxTotal = idxMap.get(`${g.group}|${sub2.name}`) || 0;
            return { name: sub2.name, total: idxTotal, done: 0, rate: null, chapters: [], leaves: [] };
          });
          const total = subs.reduce((s, x) => s + x.total, 0);
          return { group: g.group, total, done: 0, rate: null, chapters: [], subs };
        });
      } else {
        const essayFromIndex = essaySubjects.includes(subject);
        const nodeStats = (group, sub2) => {
          if (essayFromIndex) {
            const okCount = statOf('subStats').get(subject)?.get(`${group}|${sub2}`) ?? null;
            const r = practice.get(`
              SELECT COUNT(*) c FROM question_categories qc
              WHERE qc.category = ? AND qc.sub = ? AND qc.subject = ?
                AND EXISTS (SELECT 1 FROM questions q WHERE q.questionId = qc.question_id)
            `, group, sub2, subject);
            return { total: r?.c || 0, done: okCount ?? null, rate: null };
          }
          const cs = nodeChapters.get(`${group}|${sub2}`) || [];
          return { ...sum(cs), chapters: cs.map((c) => c.name) };
        };
        // 申论用 SHENLUN_TREE（标准五题型），综应用 ZONGYING_TREE（A/B/C/D 类），其他用 ESSAY_TREE
        const tree = subject === '公务员·申论' ? SHENLUN_TREE : subject === '事业编·综应' ? ZONGYING_TREE : ESSAY_TREE;
        groups = tree.map((g) => {
          const subs = g.subs.map((sub2) => {
            const st = nodeStats(g.group, sub2.name);
            return { name: sub2.name, ...st, chapters: st.chapters || [], leaves: [] };
          });
          const total = subs.reduce((s, x) => s + x.total, 0);
          return { group: g.group, total, done: subs.reduce((s, x) => s + (x.done || 0), 0), rate: null, chapters: [], subs };
        });
        if (objectiveChapters.length) {
          const typeSubs = [...objByType.entries()].map(([t, cs]) => ({
            name: t === '其他' ? '其他题型' : `${t}选择题`,
            ...sum(cs),
            chapters: cs.map((c) => c.name),
            leaves: [],
          }));
          groups.push({ group: '客观题', ...sum(objectiveChapters), chapters: objectiveChapters.map((c) => c.name), subs: typeSubs });
        }
      }
      return groups;
    },
  };

  return api;
}

export { FENBI_TREE, ESSAY_TREE, SHENLUN_TREE, ZONGYING_TREE, mapChapterToNode };
