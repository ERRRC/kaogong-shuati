/**
 * 考公刷题 Web 服务（零依赖）
 *  - 静态文件：public/
 *  - 题库 API：tiku.db（node:sqlite 只读）
 *  - 刷题/判分逻辑：选择题 answerIndex 判分；多选数组判分；申论返回 AI 批改占位
 *  - AI 配置 API：ai-config.db（五个 AI 智能体的 prompt/skill/key/url 热更新）
 *
 * 启动：node server.mjs [端口]   （默认 3000）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { listAgents, getAgent, updateAgent, getHistory, callAgent, initAiConfig } from './lib/ai-agents.mjs';
import { extractMaterialFromPdf } from './lib/pdf-ocr.mjs';
import { FENBI_TREE, ESSAY_TREE, SHENLUN_TREE, ZONGYING_TREE } from './lib/fenbi-tree.mjs';
import { mapChapterToNode } from './lib/xingce-chapter-map.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const DB_FILE = path.join(__dirname, 'tiku.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const outDir = path.join(__dirname, 'out');

if (!fs.existsSync(DB_FILE)) {
  console.error(`✗ 找不到题库文件: ${DB_FILE}\n  请先运行 node import-to-sqlite.mjs 生成 tiku.db`);
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE, { readOnly: true });
initAiConfig(); // 初始化 ai-config.db（首次自动写入五个 AI 默认配置）

// ---------- 做题记录库（可写 practice.db，独立于只读 tiku.db） ----------
const PRACTICE_DB = path.join(__dirname, 'practice.db');
const pdb = new DatabaseSync(PRACTICE_DB);
// 附加只读题库,供 practice.db 侧的统计 SQL 引用真实题目(排除已删题的索引残留)
pdb.exec(`ATTACH DATABASE ${JSON.stringify(DB_FILE)} AS tiku`);
pdb.exec(`
  CREATE TABLE IF NOT EXISTS practice_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    paper_id INTEGER DEFAULT NULL,
    subject TEXT NOT NULL,
    chapter TEXT NOT NULL DEFAULT '',
    question_type INTEGER DEFAULT 0,
    selected TEXT DEFAULT '',
    is_correct INTEGER,             -- 客观题 0/1；主观题（申论/综应）为 NULL 待批改
    cost_ms INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0,     -- 错题本移除标记（保留历史供统计/进度 AI）
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_records_subject ON practice_records(subject, chapter);
  CREATE INDEX IF NOT EXISTS idx_records_correct ON practice_records(is_correct);
  CREATE INDEX IF NOT EXISTS idx_records_time ON practice_records(created_at);
`);
// 兼容已存在的库：补充 archived 列
try { pdb.exec('ALTER TABLE practice_records ADD COLUMN archived INTEGER DEFAULT 0'); } catch {}
// ---- 自定义题库（2026-08-15）：批次 = 一次导入的文件；题目字段与粉笔 questions 同构 ----
pdb.exec(`
  CREATE TABLE IF NOT EXISTS custom_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS custom_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    material TEXT DEFAULT '',
    options TEXT DEFAULT '[]',
    answer TEXT DEFAULT '',
    answer_index INTEGER DEFAULT -1,
    analysis TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_cq_batch ON custom_questions(batch_id);
`);
// 申论材料缓存表（从真题 PDF OCR 提取）
pdb.exec(`
  CREATE TABLE IF NOT EXISTS materials (
    paper_id INTEGER PRIMARY KEY,
    subject TEXT NOT NULL,
    name TEXT DEFAULT '',
    text TEXT NOT NULL,
    pages INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);
// 材料库（materials.db：PDF 提取的"材料1..N"分块，独立可写库）
const MATERIALS_DB = path.join(__dirname, 'materials.db');
let mdb = null;
try { if (fs.existsSync(MATERIALS_DB)) mdb = new DatabaseSync(MATERIALS_DB, { readOnly: true }); } catch {}
// 收藏表（跨设备同步）
pdb.exec(`
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL UNIQUE,
    subject TEXT DEFAULT '',
    chapter TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);
// AI 解析缓存表（同一题同一作答只调一次 LLM，之后秒回；跨设备同步）
pdb.exec(`
  CREATE TABLE IF NOT EXISTS ai_explains (
    question_id INTEGER NOT NULL,
    selected TEXT NOT NULL DEFAULT 'none',
    correct TEXT NOT NULL DEFAULT 'none',
    content TEXT NOT NULL,
    image_note TEXT,
    model TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (question_id, selected, correct)
  );
`);

// ---------- 使用统计埋点库（stats.db） ----------
// 事件带"发生时的原始时间戳 ts"，服务端按 ts 聚合 DAU/MAU（补报不影响准确性）；
// install_id 由客户端生成（UUID，永久不变），COUNT(DISTINCT install_id) 即"人数"。
const STATS_DB = path.join(__dirname, 'stats.db');
const sdb = new DatabaseSync(STATS_DB);
sdb.exec(`
  CREATE TABLE IF NOT EXISTS telemetry_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    install_id TEXT NOT NULL,
    event TEXT NOT NULL,
    ts INTEGER NOT NULL,
    data TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_tele_install ON telemetry_events(install_id);
  CREATE INDEX IF NOT EXISTS idx_tele_ts ON telemetry_events(ts);
`);

// ---------- 工具 ----------
const json = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};
const err = (res, code, msg) => json(res, code, { error: msg });

/** 多模态识图调用（OpenAI 兼容 image_url 格式，用于 GLM-4.1V-Thinking-Flash / GLM-4V-Flash 等视觉模型）
 *  含 429 限流自动重试（免费视觉模型常见访问量过大）
 *  mode='ocr' 时提示词为作答文字转写，否则为图形/图表转写 */
async function callVision(apiKey, baseUrl, model, imgs, mode = 'describe') {
  if (!apiKey || !baseUrl) return { error: '未配置 API key/URL' };
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const text = mode === 'ocr'
    ? '这是一张考生手写或打印的答题纸图片。请逐字准确转写图片中的全部作答文字（包括标点、数字、段落换行）。要求：1) 手写潦草处根据上下文合理推断；2) 不要修改、润色或添加任何内容；3) 只输出识别出的原文，不要任何解释或标记。'
    : '这是一道考公题目的图片（可能包含题干图形序列和 A/B/C/D 选项图形）。请逐一详细转写图片中的全部内容：题干部分描述每个图形的形状/线条/数量/位置/规律；选项部分标注 A/B/C/D 对应关系。不要遗漏任何图形或文字。';
  const content = [
    { type: 'text', text },
    ...imgs.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.b64}` } })),
  ];
  const body = { model, messages: [{ role: 'user', content }], temperature: 0.1, max_tokens: 4000, stream: false };
  // 推理型模型（mimo/deepseek 等）默认思维链极长，会吃光 max_tokens 导致 content 为空；
  // 传 reasoning_effort=low 抑制过度思考（网关不支持时自动回退重试）
  body.reasoning_effort = 'low';
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 90000);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (r.status === 429 || r.status >= 500) {
        lastErr = `识图 API ${r.status}（第 ${attempt} 次，稍后重试）`;
        // 429 限流（智谱等免费视觉模型 RPM 极低，重试本身也消耗配额）：等 60 秒、最多重试 2 次；其他 5xx 短等
        if (attempt < 3) await new Promise((res) => setTimeout(res, r.status === 429 ? 60000 : attempt * 4000));
        continue;
      }
      if (!r.ok) {
        const text = (await r.text()).slice(0, 200);
        // 部分模型 max_tokens 上限较低（如 glm-4v-flash 仅 1024）→ 降级后重试
        if (/max_tokens/i.test(text) && body.max_tokens > 1024 && attempt < 3) {
          body.max_tokens = 1024;
          lastErr = `识图 API ${r.status}: max_tokens 超限，降级为 1024 重试`;
          continue;
        }
        // 网关不支持 reasoning_effort 参数 → 去掉后重试一次
        if (body.reasoning_effort && (r.status === 400 || r.status === 422 || /reasoning_effort|Unknown parameter|Unsupported parameter/i.test(text)) && attempt < 3) {
          delete body.reasoning_effort;
          lastErr = `识图 API ${r.status}: 网关不支持 reasoning_effort，去掉后重试`;
          continue;
        }
        return { error: `识图 API ${r.status}: ${text}` };
      }
      const d = await r.json().catch(() => null);
      if (!d) return { error: `识图 API 返回异常：状态 200 但响应体不是有效 JSON（网关异常）` };
      const c = d.choices?.[0]?.message?.content;
      if (c) return { content: c };
      // 推理模型思维链吃光 max_tokens 的典型表现：finish_reason=length 且只有 reasoning_content
      const reason = d.choices?.[0]?.finish_reason;
      const hasReasoning = !!d.choices?.[0]?.message?.reasoning;
      if (reason === 'length' && hasReasoning) {
        return { error: '识图模型输出超长被截断（思维链吃光 max_tokens）。请在 AI 设置页把识图转写员 max_tokens 调大到 8000 以上，或切换非推理型识图模型。' };
      }
      return { error: '识图返回为空' };
    } catch (e) {
      lastErr = `识图请求失败: ${e.message}`;
      if (attempt < 3) await new Promise((res) => setTimeout(res, attempt * 4000));
    }
  }
  return { error: lastErr };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** 判分：选项索引 → 是否正确（与前端 judge 逻辑对齐） */
// node:sqlite 无 transaction()，手工事务包装
function withTx(fn) {
  pdb.exec('BEGIN');
  try { const r = fn(); pdb.exec('COMMIT'); return r; }
  catch (e) { try { pdb.exec('ROLLBACK'); } catch {} throw e; }
}

function checkAnswer(q, selected) {
  const opts = JSON.parse(q.options || '[]');
  const sel = (Array.isArray(selected) ? selected : [selected]).map(Number);
  const ans = String(q.answer ?? '').trim();
  // 多选1：JSON 数组（如 "[0,1,3]"；兼容双层 JSON "[[2,3]]"）
  if (ans.startsWith('[')) {
    let parsed = JSON.parse(ans);
    if (Array.isArray(parsed) && parsed.length && Array.isArray(parsed[0])) parsed = parsed[0];
    const correct = parsed.map(Number);
    const ok = correct.length === sel.length && correct.every((v) => sel.includes(v));
    return { ok, correct, selected: sel, correctText: correct.map((i) => opts[i]).filter(Boolean) };
  }
  // 多选2：逗号分隔数字（如 "0,2,3"）
  if (ans && /^[\d,\s]+$/.test(ans) && ans.includes(',')) {
    const correct = ans.split(',').map(Number);
    const ok = correct.length === sel.length && correct.every((v) => sel.includes(v));
    return { ok, correct, selected: sel, correctText: correct.map((i) => opts[i]).filter(Boolean) };
  }
  // 判断/无选项题
  if (!opts.length) {
    if (!ans) return { ok: false, correct: [], selected: sel, correctText: [] };
    const a = Number(ans);
    return { ok: sel[0] === a, correct: [a], selected: sel, correctText: [sel[0] === a ? '正确' : '错误'] };
  }
  // 单选：answerIndex 优先，其次单数字 answer
  if (q.answerIndex != null && q.answerIndex >= 0) {
    return { ok: sel[0] === q.answerIndex, correct: [q.answerIndex], selected: sel, correctText: opts[q.answerIndex] ? [opts[q.answerIndex]] : [] };
  }
  if (ans && /^\d+$/.test(ans)) {
    const a = Number(ans);
    return { ok: sel[0] === a, correct: [a], selected: sel, correctText: opts[a] ? [opts[a]] : [] };
  }
  return { ok: false, correct: [], selected: sel, correctText: [] }; // 真正无答案
}

// ---------- 预编译查询 ----------
const qPapersBySubject = db.prepare(
  "SELECT id, category, name, questionCount, difficulty FROM papers WHERE subjectName = ? ORDER BY category, id DESC"
);
const qPapersByCategory = db.prepare(
  "SELECT id, name, questionCount, difficulty FROM papers WHERE subjectName = ? AND category = ? ORDER BY id DESC"
);
const qPaperById = db.prepare(
  "SELECT id, subjectName, category, name, questionCount, difficulty, chapters FROM papers WHERE id = ?"
);
const qQuestionsByPaper = db.prepare(
  "SELECT q.questionId, q.paperId, q.chapter, q.type, q.content, q.contentHtml, q.options, q.answer, q.answerIndex, q.difficulty, q.analysis FROM questions q WHERE q.paperId = ? ORDER BY q.id"
);
const qQuestionById = db.prepare(
  "SELECT questionId, paperId, chapter, type, content, contentHtml, options, answer, answerIndex, difficulty, analysis FROM questions WHERE questionId = ? LIMIT 1"
);
const qChaptersBySubject = db.prepare(
  "SELECT DISTINCT q.chapter FROM questions q JOIN papers p ON p.id = q.paperId WHERE p.subjectName = ? AND q.chapter != '' ORDER BY q.chapter"
);
const qRandomByChapter = db.prepare(
  "SELECT q.questionId, q.paperId, q.chapter, q.type, q.content, q.contentHtml, q.options, q.answer, q.answerIndex, q.difficulty, q.analysis FROM questions q JOIN papers p ON p.id = q.paperId WHERE p.subjectName = ? AND q.chapter = ? ORDER BY RANDOM() LIMIT ?"
);
const qRandomBySubject = db.prepare(
  "SELECT q.questionId, q.paperId, q.chapter, q.type, q.content, q.contentHtml, q.options, q.answer, q.answerIndex, q.difficulty, q.analysis FROM questions q JOIN papers p ON p.id = q.paperId WHERE p.subjectName = ? ORDER BY RANDOM() LIMIT ?"
);
// 真题/模拟题过滤（mock: '0'=真题  '1'=模拟题  undefined=不限）
function mockCond(mock) {
  if (mock === '0') return " AND (p.category NOT LIKE '%模拟%' AND p.category NOT LIKE '%模考%')";
  if (mock === '1') return " AND (p.category LIKE '%模拟%' OR p.category LIKE '%模考%')";
  return '';
}
// 模块两级分组（粉笔风格：大模块 → 子模块）
const MODULE_GROUPS = [
  { name: '言语理解与表达', keys: ['言语', '选词填空', '实词填空', '阅读理解', '段落阅读', '语句表达', '逻辑填空'] },
  { name: '判断推理', keys: ['判断', '图形', '定义判断', '类比', '逻辑', '演绎', '推理'] },
  { name: '数量关系', keys: ['数量关系', '数学运算', '数字推理', '数理能力', '计算'] },
  { name: '资料分析', keys: ['资料', '综合分析'] },
  { name: '常识判断', keys: ['常识', '公共基础', '法律', '科学', '政治理论', '时政'] },
];
function groupChapter(name) {
  for (const g of MODULE_GROUPS) if (g.keys.some((k) => name.includes(k))) return g.name;
  return '其他';
}
// 中模块（粉笔标准知识点大类）关键词映射：chapter → 中模块
const SUB_KEYWORDS = [
  { name: '图形推理', keys: ['图形'] },
  { name: '定义判断', keys: ['定义'] },
  { name: '类比推理', keys: ['类比'] },
  { name: '逻辑判断', keys: ['逻辑', '演绎'] },
  { name: '事件排序', keys: ['事件排序'] },
  { name: '逻辑填空', keys: ['选词', '实词', '成语', '逻辑填空', '词语'] },
  { name: '片段阅读', keys: ['片段', '阅读理解', '段落阅读', '主旨', '意图', '阅读'] },
  { name: '语句表达', keys: ['语句', '表达'] },
  { name: '数学运算', keys: ['数学运算', '运算', '数量关系（数学'] },
  { name: '数字推理', keys: ['数字推理', '数量关系（数字'] },
  { name: '资料分析', keys: ['资料', '综合'] },
  { name: '政治', keys: ['政治', '时政'] },
  { name: '经济', keys: ['经济'] },
  { name: '法律', keys: ['法律', '法规'] },
  { name: '人文历史', keys: ['人文', '历史', '文学', '文化'] },
  { name: '科技常识', keys: ['科技', '科学'] },
  { name: '常识综合', keys: ['常识', '公共基础', '基本常识', '国情', '地理', '生活'] },
  { name: '言语综合', keys: ['言语'] },
  { name: '判断综合', keys: ['判断', '推理'] },
  { name: '数量综合', keys: ['数量', '数理', '计算'] },
];
function mapChapterSub(name) {
  for (const s of SUB_KEYWORDS) if (s.keys.some((k) => name.includes(k))) return s.name;
  return '综合';
}

// ============ 主观题树（ESSAY_TREE）章节映射：事业编章节 → 树节点 ============
// 返回 { group, sub } 或 null（客观题型 → 归"客观题"大模块）
function mapEssayChapterToNode(ch) {
  // 案例分析题
  if (/(案例分析|材料分析|综合题|综合分析|材料题|简答|论述)/.test(ch)) return { group: '案例分析题', sub: '全部' };
  // 实务处理题
  if (/(情景模拟|实务处理|应急|沟通)/.test(ch)) return { group: '实务处理题', sub: '全部' };
  // 公文写作题
  if (/(公文|应用文|写作|改错|评改|文稿)/.test(ch)) return { group: '公文写作题', sub: '全部' };
  return null; // 客观题型（单选/判断/多选等）→ 归"客观题"组
}
/** 客观题题型归类（事业编）：章节名 → 题型组 */
function essayObjectiveGroup(ch) {
  if (/(单项选择|单选题|单选)/.test(ch)) return '单选';
  if (/(多项选择|多选题|多选)/.test(ch)) return '多选';
  if (/(判断)/.test(ch)) return '判断';
  if (/(不定项)/.test(ch)) return '不定项';
  if (/(填空)/.test(ch)) return '填空';
  return '其他';
}
/** 随机出题（支持真题/模拟题过滤；chapters 为数组时可多章节混出）
 *  注意：题库删除后 id 有空洞，单点取样会落空 → 多轮取样 + 顺序补取，凑够 n 道
 *  去重：同一 questionId 可能出现在多套卷（联考卷共享），按 questionId 去重保证按题刷题不重复 */
function randomQuestions(subject, chapters, n, mock) {
  const cond = mockCond(mock);
  const chList = Array.isArray(chapters) ? chapters.filter(Boolean) : (chapters ? [chapters] : []);
  const chCond = chList.length ? `AND q.chapter IN (${chList.map(() => '?').join(',')}) ` : '';
  const where = `p.subjectName = ? ${chCond}${cond}`;
  const params = [...(chList.length ? [subject, ...chList] : [subject])];
  const maxId = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM questions').get().m;
  const seenQid = new Set();
  const picks = []; // 已入选的 q.id（questionId 唯一）
  const tryAdd = (rows) => {
    for (const r of rows) {
      if (!seenQid.has(r.questionId)) { seenQid.add(r.questionId); picks.push(r.id); }
    }
  };
  for (let attempt = 0; attempt < 20 && picks.length < n; attempt++) {
    const start = Math.floor(Math.random() * Math.max(maxId, 1));
    const need = Math.max(n - picks.length, 1) * 8;
    const cand = db.prepare(
      `SELECT q.id, q.questionId FROM questions q JOIN papers p ON p.id = q.paperId WHERE ${where} AND q.id >= ? ORDER BY q.id LIMIT ?`
    ).all(...params, start, need);
    if (!cand.length && attempt === 0) {
      // 兜底：直接顺序取（表可能极小或全被过滤）
      const all = db.prepare(
        `SELECT q.id, q.questionId FROM questions q JOIN papers p ON p.id = q.paperId WHERE ${where} LIMIT ?`
      ).all(...params, n * 4);
      tryAdd(all);
      break;
    }
    tryAdd(cand);
  }
  if (picks.length < n) {
    // 兜底 2：窗口抽样仍不足（职测等 id 聚集/低密度科目）→ 全量随机一次
    const all = db.prepare(
      `SELECT q.id, q.questionId FROM questions q JOIN papers p ON p.id = q.paperId WHERE ${where} ORDER BY RANDOM() LIMIT ?`
    ).all(...params, n * 4);
    tryAdd(all);
  }
  if (!picks.length) return [];
  // 打乱顺序取 n
  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }
  const sel = picks.slice(0, n);
  const qs = db.prepare(
    `SELECT q.questionId, q.paperId, q.chapter, q.type, q.content, q.contentHtml, q.options, q.answer, q.answerIndex, q.difficulty, q.analysis
     FROM questions q WHERE q.id IN (${sel.map(() => '?').join(',')})`
  ).all(...sel);
  // 保持随机顺序
  return qs.sort(() => Math.random() - 0.5);
}

const SUBJECTS = ['公务员·行测', '公务员·申论', '事业编'];

/** 组装题目响应（去掉多余字段） */
function toQuestion(q) {
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
    analysis: q.analysis ?? null,
  };
}

// ---------- 路由 ----------
// 题组增强：把题目按材料（material_id）归组，返回组信息 + 材料内容
function enrichGroups(rows, subject) {
  const qids = rows.map((r) => r.id ?? r.questionId);
  let maps = [];
  if (qids.length) {
    maps = pdb.prepare(`SELECT question_id, material_id FROM q_material_map WHERE subject = ? AND question_id IN (${qids.map(() => '?').join(',')})`).all(subject, ...qids);
  }
  const gidOf = new Map(maps.filter((m) => m.material_id != null).map((m) => [m.question_id, m.material_id]));
  const gids = [...new Set(gidOf.values())];
  // 组内全部题（同 material_id）
  const groupMembers = new Map(); // material_id -> [question_id...]
  if (gids.length) {
    const mem = pdb.prepare(`SELECT question_id, material_id FROM q_material_map WHERE subject = ? AND material_id IN (${gids.map(() => '?').join(',')})`).all(subject, ...gids);
    for (const m of mem) {
      if (!groupMembers.has(m.material_id)) groupMembers.set(m.material_id, []);
      groupMembers.get(m.material_id).push(m.question_id);
    }
  }
  // gidOf 覆盖组内全部题（含补充题）
  for (const [gid, members] of groupMembers) {
    for (const mid of members) gidOf.set(mid, gid);
  }
  const materials = new Map(); // material_id -> content
  if (gids.length) {
    const ms = pdb.prepare(`SELECT material_id, content FROM q_materials WHERE subject = ? AND material_id IN (${gids.map(() => '?').join(',')})`).all(subject, ...gids);
    for (const m of ms) materials.set(m.material_id, m.content);
  }
  // 汇总所有需要详情的题（原 rows + 组内补充题）
  const allIds = [...new Set([...qids, ...[...groupMembers.values()].flat()])];
  let qs = [];
  if (allIds.length) {
    qs = db.prepare(`SELECT q.questionId, q.paperId, q.chapter, q.type, q.content, q.contentHtml, q.options, q.answer, q.answerIndex, q.difficulty, q.analysis FROM questions q WHERE q.questionId IN (${allIds.map(() => '?').join(',')}) GROUP BY q.questionId`).all(...allIds);
  }
  // 卷内顺序：按 paperId + id（导入顺序）
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
  // 按原顺序 + 组聚合排序：同组相邻
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

// 行测考情基准（2025/2026 国考）：市地级/执法 130 题、副省 135 题，120 分钟，满分 100；
// 官方模块序：政治理论→常识判断→言语理解与表达→数量关系→判断推理→资料分析（副省数量 15 题）。
// score 为机构通行单题分值估算（官方不公布单题分值）；subs 为子知识点配额（对应粉笔分类索引）。
const XINGCE_TEMPLATE = [
  { name: '政治理论', count: 20, score: 0.5, tint: 'tint-red', subs: [['新思想', 10], ['时事政治', 6], ['马克思主义', 2], ['毛中特', 2]] },
  { name: '常识判断', count: 15, score: 0.5, tint: 'tint-amber', subs: [['人文常识', 6], ['法律常识', 3], ['科技常识', 3], ['地理国情', 2], ['经济常识', 1]] },
  { name: '言语理解与表达', count: 30, score: 0.8, tint: 'tint-blue', subs: [['片段阅读', 12], ['逻辑填空', 10], ['语句表达', 8]] },
  { name: '数量关系', count: 10, score: 0.8, tint: 'tint-orange', subs: [['数学运算', 10]] },
  { name: '判断推理', count: 35, score: 0.8, tint: 'tint-violet', subs: [['图形推理', 9], ['定义判断', 9], ['类比推理', 9], ['逻辑判断', 8]] },
  { name: '资料分析', count: 20, score: 1.0, tint: 'tint-green', subs: [['综合', 7], ['增长', 6], ['比重', 3], ['平均数', 3], ['倍数', 1]] },
];
const XINGCE_TOTAL = 130;      // 模板基准题量（市地级）
const XINGCE_MINUTES = 120;    // 官方考试时长（分钟）

/**
 * 超量裁剪：资料分析等材料题为整组抽取（每组固定 5 题），当配额非 5 的倍数（weak 加权 / 模块白名单 / 子题配额取整后）
 * 实际题数会超过目标 count 1~4 题。策略：优先裁非材料组单题（保持材料组完整与模块序），单题不足时再裁各组组尾题。
 * 返回裁剪后的数组；同时回写 sourceCounts（按 q.paperId 归源，键不存在则跳过）。
 */
function trimToCount(list, count, sourceCounts) {
  if (list.length <= count) return list;
  let over = list.length - count;
  const srcIdOf = (q) => {
    try { return sourceIdOfCategory(paperCategoryOf(q.paperId)); } catch { return null; }
  };
  // 第一轮：非材料组单题，从尾部裁
  for (let i = list.length - 1; i >= 0 && over > 0; i--) {
    if (list[i].groupId != null) continue;
    const sid = srcIdOf(list[i]);
    if (sourceCounts && sid != null && sourceCounts[sid] != null) sourceCounts[sid] = Math.max(0, sourceCounts[sid] - 1);
    list.splice(i, 1);
    over--;
  }
  // 第二轮：材料组组尾题（每组裁最后 1 题，保持组首题与组内顺序）
  for (let i = list.length - 1; i >= 0 && over > 0; i--) {
    if (list[i].groupId == null) continue;
    if (i > 0 && list[i - 1].groupId === list[i].groupId) continue; // 非组尾
    const sid = srcIdOf(list[i]);
    if (sourceCounts && sid != null && sourceCounts[sid] != null) sourceCounts[sid] = Math.max(0, sourceCounts[sid] - 1);
    list.splice(i, 1);
    over--;
  }
  return list;
}
const XINGCE_DIFFICULTY = {    // 难度档位（粉笔 difficulty 1-9）
  easy: { min: 1, max: 3 },
  balanced: { min: 3, max: 6 },
  hard: { min: 5, max: 9 },    // 原 6-9：偏难题少（行测仅 6302 题）易"题库资源有限"→ 下调到 5-9（53383 题）
  random: { min: 1, max: 9 },  // 随机：不限难度（含未标注难度）
};
// 四个题库源（按卷型来源划分，保证题目来源多样；category 取值来自 tiku.papers）
const PAPER_SOURCES = [
  { id: 'tikuA', label: '国考', cond: "p.category LIKE '%国考%'" },
  { id: 'tikuB', label: '联考省考', cond: "p.category IN ('黑龙江','吉林','湖北','新疆','江西','河南','天津','重庆','福建','安徽','云南','河北','山西','广西','青海','陕西','贵州','湖南','辽宁','甘肃','海南','内蒙古','宁夏','西藏','四川')" },
  { id: 'tikuC', label: '独立命题', cond: "p.category IN ('江苏','浙江','广东','山东','北京','上海','深圳市考','广州市考')" },
  { id: 'tikuD', label: '选调/其他', cond: "p.category IN ('选调','政法干警')" },
];
const XINGCE_GROUP_SIZE = 5;   // 资料分析标准材料组题数
// 卷型分类 → 源 id（与 PAPER_SOURCES.cond 对应；JS 侧用于组内题归属）
const LIAOKAO_SET = new Set(['黑龙江', '吉林', '湖北', '新疆', '江西', '河南', '天津', '重庆', '福建', '安徽', '云南', '河北', '山西', '广西', '青海', '陕西', '贵州', '湖南', '辽宁', '甘肃', '海南', '内蒙古', '宁夏', '西藏', '四川']);
const DULI_SET = new Set(['江苏', '浙江', '广东', '山东', '北京', '上海', '深圳市考', '广州市考']);
function sourceIdOfCategory(cat) {
  if (!cat) return null;
  if (String(cat).includes('国考')) return 'tikuA';
  if (LIAOKAO_SET.has(cat)) return 'tikuB';
  if (DULI_SET.has(cat)) return 'tikuC';
  if (cat === '选调' || cat === '政法干警') return 'tikuD'; // 与 srcMatch tikuD 精确匹配对齐
  return null;
}
function paperCategoryOf(qid) {
  // 由 getPaperPool().paperCat（全量内存索引）取代逐题 SQL 缓存；查不到时回退单查（理论仅未入库残留）
  const c = getPaperPool().paperCat.get(qid);
  if (c !== undefined) return c;
  const row = db.prepare('SELECT p.category FROM questions q JOIN papers p ON p.id = q.paperId WHERE q.questionId = ?').get(qid);
  return row?.category ?? null;
}

/** 按权重比例分配整数配额（largest remainder，保证总和 === total；weights 全 0 时全 0） */
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

// ============ 智能组卷内存抽题池 ============
// 只读题库（question_categories / q_material_map / questions / papers）静态索引一次性载入内存。
// 抽题、组题全部改为内存过滤 + Fisher-Yates 洗牌，不再执行 ORDER BY RANDOM()：
// 该写法在 SQLite 中强制全量物化 + 全表排序（且 NOT EXISTS 相关子查询逐行扫描），实测单次 ~560ms，
// 默认行测组卷约 44 次调用 → 总耗时 4-8 秒。题库运行时不变，载入一次后长期有效（与 chapterCache 同哲学）。
let paperPool = null;
function getPaperPool() {
  if (paperPool) return paperPool;
  const t0 = performance.now();
  const byKey = new Map();       // `${subject}|${category}|${sub}` → 行（含 diff/type/pcat/psub/chapter）
  const groups = new Map();      // material_id → { subject, members[] }（members 按卷序 q.id 升序）
  const materialSetBySubject = new Map(); // subject → Set<question_id>（材料组题，抽单题时排除）
  const paperCat = new Map();    // question_id → papers.category
  for (const r of pdb.prepare(`
    SELECT qc.subject subj, qc.category cat, qc.sub sub, qc.question_id qid,
           q.difficulty diff, q.type type, p.category pcat, p.subjectName psub, q.chapter chapter
    FROM question_categories qc
    JOIN tiku.questions q ON q.questionId = qc.question_id
    JOIN tiku.papers p ON p.id = q.paperId
  `).all()) {
    const key = `${r.subj}|${r.cat}|${r.sub}`;
    let arr = byKey.get(key);
    if (!arr) { arr = []; byKey.set(key, arr); }
    arr.push(r);
  }
  for (const r of pdb.prepare(`
    SELECT mm.subject msub, mm.material_id gid, mm.question_id qid,
           q.difficulty diff, q.type type, p.category pcat, p.subjectName psub, q.chapter chapter, q.id seq
    FROM q_material_map mm
    JOIN tiku.questions q ON q.questionId = mm.question_id
    JOIN tiku.papers p ON p.id = q.paperId
    WHERE mm.material_id IS NOT NULL
    ORDER BY q.id
  `).all()) {
    let g = groups.get(r.gid);
    if (!g) { g = { subject: r.msub, members: [] }; groups.set(r.gid, g); }
    g.members.push(r);
    let s = materialSetBySubject.get(r.msub);
    if (!s) { s = new Set(); materialSetBySubject.set(r.msub, s); }
    s.add(r.qid);
  }
  for (const r of db.prepare(`
    SELECT q.questionId qid, p.category pcat FROM questions q JOIN papers p ON p.id = q.paperId
  `).all()) paperCat.set(r.qid, r.pcat);
  paperPool = { byKey, groups, materialSetBySubject, paperCat };
  console.log(`[组卷池] 内存抽题池就绪: ${byKey.size} 分类 / ${groups.size} 材料组 / ${paperCat.size} 题卷源（${(performance.now() - t0).toFixed(0)}ms）`);
  return paperPool;
}
// 启动后异步预热，避免首个组卷请求等待载入
setImmediate(() => { try { getPaperPool(); } catch (e) { console.error('[组卷池] 预热失败:', e.message); } });

/** 题库源匹配（等价于 PAPER_SOURCES / ZHI_CE_SOURCES 的 cond SQL 语义；无 id 的兜底调用恒全匹配） */
function srcMatch(pcat, srcId) {
  switch (srcId) {
    case 'tikuA': return String(pcat).includes('国考');
    case 'tikuB': return LIAOKAO_SET.has(pcat);
    case 'tikuC': return DULI_SET.has(pcat);
    case 'tikuD': return pcat === '选调' || pcat === '政法干警'; // 与原 cond IN ('选调','政法干警') 精确匹配
    case 'zcA': return pcat === '联考A类';
    case 'zcB': return pcat === '联考B类';
    case 'zcC': return pcat === '联考C类';
    case 'sd': return pcat === '山东';
    default: return true; // 'any' / 无 id（cond='1=1'）
  }
}

/** 已做题 question_id 集合（动态数据：每次组卷实时查 practice_records，绝不缓存） */
function practiceDoneQids() {
  return new Set(pdb.prepare('SELECT question_id FROM practice_records').all().map((r) => r.question_id));
}

/** 单题抽题：分类索引 × 源 × 难度 × 题型（避开材料组题；weak 时未做题优先）
 *  内存版：题库静态索引已在 getPaperPool 载入，过滤 + Fisher-Yates 洗牌，O(候选数) 无 SQL */
function pickSingle(subject, category, sub, src, difficulty, types, quota, weak, skipDup) {
  if (quota <= 0) return [];
  const pool = getPaperPool();
  const rows = pool.byKey.get(`${subject}|${category}|${sub}`);
  if (!rows || !rows.length) return [];
  const diffMin = difficulty.min, diffMax = difficulty.max;
  const typeSet = types && types.length ? new Set(types) : null;
  const srcId = src?.id;
  const materialSet = pool.materialSetBySubject.get(subject);
  const cand = [];
  const diffAll = diffMin === 1 && diffMax === 9; // 随机档：未标注难度也纳入
  for (const r of rows) {
    if (r.diff == null) { if (!diffAll) continue; }
    else if (r.diff < diffMin || r.diff > diffMax) continue;
    if (r.psub !== subject) continue;
    if (typeSet && !typeSet.has(r.type)) continue;
    if (!srcMatch(r.pcat, srcId)) continue;
    if (materialSet && materialSet.has(r.qid)) continue;
    cand.push(r.qid);
  }
  // Fisher-Yates 洗牌（等价 ORDER BY RANDOM()，无 SQL 物化开销）
  for (let i = cand.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [cand[i], cand[j]] = [cand[j], cand[i]];
  }
  const out = [];
  const take = (list) => {
    for (const qid of list) {
      if (out.length >= quota) break;
      if (!skipDup.has(qid)) { skipDup.add(qid); out.push(qid); }
    }
  };
  if (weak) {
    // 未做优先；不足回退到全量（已做题也纳入）——等价原 SQL 的 weak 回退
    const done = practiceDoneQids();
    take(cand.filter((qid) => !done.has(qid)));
    if (out.length < quota) take(cand);
  } else {
    take(cand);
  }
  return out;
}

/** 材料组抽题（资料分析：整组入卷；逻辑判断一拖五：单组 + 单题补齐）
 *  chapterLike 可为字符串或数组（职测 B/C 类资料组在"数量分析"章节下，需多章节匹配） */
function pickGroups(subject, src, difficulty, types, needGroups, skipDup, chapterLike, minSize, maxSize) {
  if (needGroups <= 0) return [];
  const likes = (Array.isArray(chapterLike) ? chapterLike : [chapterLike]).map((l) => l.slice(1, -1)); // '%资料%' → '资料'
  const pool = getPaperPool();
  const diffMin = difficulty.min, diffMax = difficulty.max;
  const typeSet = types && types.length ? new Set(types) : null;
  const srcId = src?.id;
  const cand = [];
  for (const [gid, g] of pool.groups) {
    if (g.subject !== subject) continue;
    let n = 0;
    for (const r of g.members) {
      if (r.diff == null || r.diff < diffMin || r.diff > diffMax) continue;
      if (r.psub !== subject) continue;
      if (typeSet && !typeSet.has(r.type)) continue;
      if (!srcMatch(r.pcat, srcId)) continue;
      if (!likes.some((l) => r.chapter && r.chapter.includes(l))) continue;
      n++;
    }
    if (n >= minSize && n <= maxSize) cand.push(gid);
  }
  for (let i = cand.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [cand[i], cand[j]] = [cand[j], cand[i]];
  }
  const out = [];
  for (const gid of cand) {
    if (out.length >= needGroups) break;
    if (!skipDup.has(gid)) { skipDup.add(gid); out.push(gid); }
  }
  return out;
}

/** 取一组材料题的全部 question_id（组内按卷序） */
function groupQuestionIds(subject, gid) {
  const g = getPaperPool().groups.get(gid);
  if (!g || g.subject !== subject) return [];
  return g.members.map((r) => r.qid);
}

/** 生成智能组卷（行测）：官方模块配额 × 四源并发 → 聚合去重 → 材料整组 → 官方模块序连排 */
async function buildXingcePaper(opts) {
  const subject = '公务员·行测';
  const count = Math.max(1, Math.min(130, Number(opts.count) || 20));
  const difficulty = (typeof opts.difficulty === 'string' && XINGCE_DIFFICULTY[opts.difficulty])
    ? XINGCE_DIFFICULTY[opts.difficulty]
    : { min: Number(opts.difficulty?.min) || 3, max: Number(opts.difficulty?.max) || 6 };
  const types = Array.isArray(opts.types) && opts.types.length ? opts.types.map(Number).filter((t) => t > 0) : [1];
  const weakSet = new Set(Array.isArray(opts.weak) ? opts.weak : []);
  // 模块白名单（无效名忽略；空 = 全模块）
  let modules = XINGCE_TEMPLATE.map((m) => ({ ...m }));
  if (Array.isArray(opts.chapters) && opts.chapters.length) {
    const want = new Set(opts.chapters);
    modules = modules.filter((m) => want.has(m.name));
  }
  // 模块配额（largest remainder）；weak 模块 +30%
  let quota = allocateQuota(modules.map((m) => m.count), count);
  if (weakSet.size) {
    const boosted = modules.map((m, i) => (weakSet.has(m.name) ? Math.round(quota[i] * 1.3) : quota[i]));
    let total = boosted.reduce((a, b) => a + b, 0);
    let guard = 0;
    while (total !== count && guard++ < 1000) {
      if (total > count) {
        // 从最大的非 weak 模块扣 1
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
  // 源启用与权重（perSource: {id:false} 禁用；{id:{weight:n}} 调权）
  const activeSources = PAPER_SOURCES.filter((s) => {
    const ps = opts.perSource?.[s.id];
    return ps !== false && ps !== null;
  });
  if (!activeSources.length) activeSources.push(...PAPER_SOURCES); // 源全被禁用时视为全启用（与无 perSource 默认一致）
  const sourceWeights = activeSources.map((s) => {
    const w = Number(opts.perSource?.[s.id]?.weight);
    return Number.isFinite(w) && w > 0 ? w : 1;
  });
  const sourcePicks = new Map(activeSources.map((s) => [s.id, []]));
  const skipQ = new Set(); // 全局去重（跨源）
  const skipG = new Set(); // 组去重（跨源）
  const notices = [];
  // 四路并发：每模块 × 每源独立抽题
  for (const m of modules) {
    // 源级配额：按权重精确均摊（largest remainder，总和 = 模块配额）
    const srcQuotas = allocateQuota(sourceWeights, m.quota);
    if (m.name === '资料分析') {
      // 资料分析：整组抽取（标准 5 题一组，容错 3-6）；组数 = ceil(配额/5)，不限源整体抽组
      //（按源拆分会让小源候选不足而整模块落空），组内题按其所属卷型归属源
      const G = Math.ceil(m.quota / XINGCE_GROUP_SIZE);
      const gids = pickGroups(subject, { id: 'any', label: '全部', cond: '1=1' }, difficulty, types, G, skipG, '%资料%', 3, 6);
      for (const gid of gids) {
        for (const qid of groupQuestionIds(subject, gid)) {
          if (skipQ.has(qid)) continue;
          skipQ.add(qid);
          const srcId = sourceIdOfCategory(paperCategoryOf(qid));
          const srcPicks = sourcePicks.get(srcId) ?? sourcePicks.get(activeSources[0].id); // srcId 不在 activeSources 时归入首源（跨源兜底）
          srcPicks.push({ questionId: qid, groupId: gid, module: m.name, subIdx: 0 });
        }
      }
      continue;
    }
    const srcTasks = activeSources.map(async (src, si) => {
      const srcQuota = srcQuotas[si];
      if (srcQuota <= 0) return;
      const picks = [];
      // 普通模块：子知识点配额分配
      const subWeights = m.subs.map(([, w]) => w);
      const subQuota = allocateQuota(subWeights, srcQuota);
      m.subs.forEach(([subName], si2) => {
        const q = subQuota[si2];
        if (q <= 0) return;
        // 判断推理·逻辑判断（市地一拖五）：配额 ≥5 时含 1 组材料题 + 单题补齐
        if (m.name === '判断推理' && subName === '逻辑判断' && q >= XINGCE_GROUP_SIZE) {
          const gids = pickGroups(subject, src, difficulty, types, 1, skipG, '%逻辑%', 4, 6);
          if (gids.length) {
            const gid = gids[0];
            const members = groupQuestionIds(subject, gid);
            for (const qid of members) {
              if (!skipQ.has(qid)) { skipQ.add(qid); picks.push({ questionId: qid, groupId: gid, subIdx: si2 }); }
            }
            const rest = q - members.length;
            if (rest > 0) {
              for (const qid of pickSingle(subject, m.name, subName, src, difficulty, types, rest, weakSet.has(m.name), skipQ)) picks.push({ questionId: qid, groupId: null, subIdx: si2 });
            }
            return;
          }
        }
        for (const qid of pickSingle(subject, m.name, subName, src, difficulty, types, q, weakSet.has(m.name), skipQ)) picks.push({ questionId: qid, groupId: null, subIdx: si2 });
      });
      if (picks.length) sourcePicks.get(src.id).push(...picks.map((p) => ({ ...p, module: m.name })));
    });
    await Promise.all(srcTasks);
    // 模块级补齐：该模块配额未满（题源不足），跨源补抽单题
    const have = [...sourcePicks.values()].flat().filter((p) => p.module === m.name).length;
    if (have < m.quota && m.name !== '资料分析') {
      const need = m.quota - have;
      const subWeights = m.subs.map(([, w]) => w);
      const subQuota = allocateQuota(subWeights, need);
      m.subs.forEach(([subName], si2) => {
        if (subQuota[si2] <= 0) return;
        for (const qid of pickSingle(subject, m.name, subName, { cond: '1=1' }, { min: 1, max: 9 }, types, subQuota[si2], false, skipQ)) {
          sourcePicks.get(activeSources[0].id).push({ questionId: qid, groupId: null, module: m.name, subIdx: si2, fallback: true });
        }
      });
    }
  }
  // 统计与失败源（fallback 补齐题归属首个启用源）
  const sourceCounts = {};
  for (const s of activeSources) sourceCounts[s.id] = sourcePicks.get(s.id).length;
  const failedSources = activeSources.filter((s) => sourceCounts[s.id] === 0).map((s) => s.id);
  for (const s of activeSources) if (sourceCounts[s.id] === 0) notices.push(`「${s.label}」无可用题目`);
  // 组卷顺序：官方模块序连排；模块内按子题型（模板 subs 顺序）稳定排序，同题型内随机；逐模块 enrichGroups 保证材料组内相邻
  const ordered = [];
  for (const m of modules) {
    const picks = [...sourcePicks.values()].flat().filter((p) => p.module === m.name);
    picks.sort((a, b) => (a.subIdx ?? 0) - (b.subIdx ?? 0)); // 稳定排序：同 subIdx 保持抽题随机序
    const rows = picks.map((p) => ({ questionId: p.questionId, groupId: p.groupId }));
    const enriched = enrichGroups(rows, subject);
    for (const q of enriched) q.module = m.name; // 规范模块名（粉笔原始 chapter 名不统一）
    ordered.push(...enriched);
  }
  const enriched = ordered;
  const total = enriched.length;
  if (total !== count && Math.abs(total - count) <= 6) trimToCount(enriched, count, sourceCounts); // 资料组超量裁剪，保组完整
  const total2 = enriched.length;
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
    questions: enriched,
    notice: notices.length ? notices.join('；') : undefined,
  };
}

// ============ 职测组卷引擎（事业编·职测）============
// 职测考情（2025 版考试大纲，联考 A/B/C 类与山东通用）：90 分钟 / 满分 150（2026 年起改 100）。
// 模块构成 = 官方通行口径 ∩ 题库实测均值（A/B/C 各 100 题、山东 90 题）；subs 权重 = 官方子模块配额比。
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
      { name: '数量分析', count: 15, tint: 'tint-orange', subs: [['数量关系', '数学运算', 5], ...ZHI_CE_COMMON_SUBS.资料分析] }, // 官方：数学运算 5 + 资料分析 10
      { name: '判断推理', count: 30, tint: 'tint-violet', subs: ZHI_CE_COMMON_SUBS.判断推理 },
      { name: '综合分析', count: 10, tint: 'tint-red', subs: [['言语理解与表达', '片段阅读', 10]] }, // 篇章阅读 ≈ 片段阅读
    ],
  },
  '联考C类': {
    total: 100, minutes: 90, score: 150,
    modules: [
      { name: '常识判断', count: 20, tint: 'tint-amber', subs: ZHI_CE_COMMON_SUBS.常识判断 },
      { name: '言语理解与表达', count: 25, tint: 'tint-blue', subs: ZHI_CE_COMMON_SUBS.言语理解与表达 },
      { name: '数量分析', count: 10, tint: 'tint-orange', subs: [['数量关系', '数学运算', 5], ['资料分析', '综合', 2], ['资料分析', '增长', 2], ['资料分析', '比重', 1]] }, // 数学运算 5 + 资料分析 5
      { name: '判断推理', count: 30, tint: 'tint-violet', subs: ZHI_CE_COMMON_SUBS.判断推理 },
      { name: '综合分析', count: 15, tint: 'tint-red', subs: [['数量关系', '数学运算', 5], ...ZHI_CE_COMMON_SUBS.资料分析] }, // 数学方法/策略制定/实验设计 ≈ 数运+资料
    ],
  },
  '山东': {
    total: 90, minutes: 90, score: 150,
    modules: [
      { name: '常识判断', count: 15, tint: 'tint-amber', subs: [...ZHI_CE_COMMON_SUBS.常识判断.slice(0, 5), ['政治理论', '新思想', 1]] }, // 山东含政治理论（并入常识）
      { name: '言语理解与表达', count: 20, tint: 'tint-blue', subs: ZHI_CE_COMMON_SUBS.言语理解与表达 },
      { name: '数量关系', count: 5, tint: 'tint-orange', subs: [['数量关系', '数学运算', 5]] },
      { name: '判断推理', count: 35, tint: 'tint-violet', subs: ZHI_CE_COMMON_SUBS.判断推理 },
      { name: '资料分析', count: 15, tint: 'tint-green', subs: ZHI_CE_COMMON_SUBS.资料分析 },
    ],
  },
};
// 四类卷型源（职测的"四源"= 四类卷，主源为所选类别，题不足时其他类别兜底）
const ZHI_CE_SOURCES = [
  { id: 'zcA', label: '联考A类', cond: "p.category = '联考A类'" },
  { id: 'zcB', label: '联考B类', cond: "p.category = '联考B类'" },
  { id: 'zcC', label: '联考C类', cond: "p.category = '联考C类'" },
  { id: 'sd', label: '山东', cond: "p.category = '山东'" },
];

/** 弱项加权：模块配额 +30%，差额从其余模块按比例扣回（行测/职测共用；保证总和 = total） */
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

/** 生成职测智能组卷：按所选卷型（类别）模板 → 主源抽题 + 其他类别兜底 → 官方模块序连排 */
async function buildZhiCePaper(opts) {
  const subject = '事业编·职测';
  const category = ZHI_CE_TEMPLATES[opts.category] ? opts.category : '联考A类';
  const template = ZHI_CE_TEMPLATES[category];
  const difficulty = (typeof opts.difficulty === 'string' && XINGCE_DIFFICULTY[opts.difficulty])
    ? XINGCE_DIFFICULTY[opts.difficulty]
    : { min: Number(opts.difficulty?.min) || 3, max: Number(opts.difficulty?.max) || 6 };
  const types = Array.isArray(opts.types) && opts.types.length ? opts.types.map(Number).filter((t) => t > 0) : [1];
  const weakSet = new Set(Array.isArray(opts.weak) ? opts.weak : []);
  // 模块配额 = 官方卷型题量（不缩放）；weak 模块 +30%
  let modules = template.modules.map((m) => ({ ...m, quota: m.count }));
  if (weakSet.size) {
    const boosted = applyWeakQuota(modules, weakSet, template.total);
    modules = modules.map((m, i) => ({ ...m, quota: boosted[i] })).filter((m) => m.quota > 0);
  }
  // 主源（所选类别）+ 兜底源（其他类别，题不足时按序补齐）
  const mainSrc = ZHI_CE_SOURCES.find((s) => s.cond.includes(`'${category}'`)) || ZHI_CE_SOURCES[0];
  const fallbackSrcs = ZHI_CE_SOURCES.filter((s) => s.id !== mainSrc.id);
  const skipQ = new Set();
  const skipG = new Set();
  const picks = []; // {questionId, groupId, module, srcId}
  const notices = [];
  /** 单题抽：主源优先（weak 时未做优先），不足 → 其他类别兜底 */
  const pickSubWithFallback = (cat, sub, quota) => {
    const out = [];
    const trySrc = (src, q, w) => {
      for (const qid of pickSingle(subject, cat, sub, src, difficulty, types, q, w, skipQ)) out.push({ questionId: qid, srcId: src.id });
    };
    trySrc(mainSrc, quota, weakSet.has(cat));
    let need = quota - out.length;
    for (const src of fallbackSrcs) {
      if (need <= 0) break;
      trySrc(src, need, false);
      need = quota - out.length;
    }
    return out;
  };
  for (const m of modules) {
    const subWeights = m.subs.map(([, , w]) => w);
    const subQuota = allocateQuota(subWeights, m.quota);
    // 资料分析子项合并为整组抽取；其余按知识点单题抽
    let dataQuota = 0;
    m.subs.forEach(([cat, sub], si) => {
      if (cat === '资料分析') dataQuota += subQuota[si];
      else if (subQuota[si] > 0) {
        picks.push(...pickSubWithFallback(cat, sub, subQuota[si]).map((p) => ({ ...p, groupId: null, module: m.name, subIdx: si })));
      }
    });
    if (dataQuota > 0) {
      // 资料组：A 类/山东在"资料分析"章节，B/C 类归入"数量分析"章节 → 多章节匹配
      const G = Math.max(1, Math.ceil(dataQuota / XINGCE_GROUP_SIZE));
      const gids = pickGroups(subject, mainSrc, difficulty, types, G, skipG, ['%资料%', '%数量分析%'], 3, 6);
      if (!gids.length) notices.push(`「资料分析」暂无可用整组材料`);
      for (const gid of gids) {
        for (const qid of groupQuestionIds(subject, gid)) {
          if (!skipQ.has(qid)) {
            skipQ.add(qid);
            picks.push({ questionId: qid, groupId: gid, module: m.name, srcId: sourceIdOfCategory(paperCategoryOf(qid)) ?? mainSrc.id, subIdx: 0 });
          }
        }
      }
    }
  }
  // 统计与失败源（职测仅主源为预期来源：只报告主源失败，兜底源 0 题不算失败）
  const sourceCounts = {};
  for (const s of ZHI_CE_SOURCES) sourceCounts[s.id] = picks.filter((p) => p.srcId === s.id).length;
  const failedSources = sourceCounts[mainSrc.id] === 0 ? [mainSrc.id] : [];
  if (sourceCounts[mainSrc.id] === 0) notices.push(`「${mainSrc.label}」无可用题目`);
  // 官方模块序连排；模块内按子题型（模板 subs 顺序）稳定排序，同题型内随机；逐模块 enrichGroups 保持材料组相邻
  const ordered = [];
  for (const m of modules) {
    const mPicks = picks.filter((p) => p.module === m.name);
    mPicks.sort((a, b) => (a.subIdx ?? 0) - (b.subIdx ?? 0));
    const enriched = enrichGroups(mPicks.map((p) => ({ questionId: p.questionId, groupId: p.groupId })), subject);
    for (const q of enriched) q.module = m.name;
    ordered.push(...enriched);
  }
  const total = ordered.length;
  if (total !== template.total && Math.abs(total - template.total) <= 6) trimToCount(ordered, template.total, sourceCounts); // 资料组超量裁剪，保组完整
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

// 只读题库的静态统计缓存（题库运行时不变；仅缓存 totals/idxMap 等不含做题统计的数据）
const chapterCache = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  // ---- API ----
  if (pathname.startsWith('/api/')) {
    try {
      // 科目列表（questions = 唯一题目数，跨卷重复题去重；done = 该科目答对且去重的已做题目数）
      if (pathname === '/api/subjects' && req.method === 'GET') {
        if (!chapterCache.has('subjects|static')) {
          chapterCache.set('subjects|static', pdb.prepare(`
            SELECT tp.subjectName,
                   COUNT(DISTINCT tp.id) AS papers,
                   COUNT(DISTINCT tq.questionId) AS questions
            FROM tiku.papers tp
            LEFT JOIN tiku.questions tq ON tq.paperId = tp.id
            GROUP BY tp.subjectName
          `).all());
        }
        const staticRows = chapterCache.get('subjects|static');
        // 综应只保留 A 类：主界面题目数按分类树口径（question_categories），与专项练习一致
        const zongyingN = pdb.prepare(`SELECT COUNT(DISTINCT question_id) AS n FROM question_categories WHERE subject = '事业编·综应'`).get().n;
        // 动态部分：已做对的去重题数（随做题记录变化，不缓存；subject 以题库为准）
        const doneRows = pdb.prepare(`
          SELECT tp.subjectName, COUNT(DISTINCT r.question_id) AS done
          FROM tiku.papers tp
          JOIN tiku.questions tq ON tq.paperId = tp.id
          JOIN practice_records r ON r.question_id = tq.questionId AND r.is_correct = 1
          GROUP BY tp.subjectName
        `).all();
        const doneMap = new Map(doneRows.map((r) => [r.subjectName, Number(r.done || 0)]));
        return json(res, 200, staticRows.map((r) => {
          const questions = r.subjectName === '事业编·综应' ? Number(zongyingN) : Number(r.questions);
          return { ...r, papers: Number(r.papers), questions, done: doneMap.get(r.subjectName) || 0 };
        }));
      }
      // 科目下分类（questions = 唯一题目数，跨卷重复题去重）
      if (pathname === '/api/categories' && req.method === 'GET') {
        const subject = url.searchParams.get('subject');
        if (!subject) return err(res, 400, '缺少 subject');
        const catKey = `categories|${subject}`;
        if (!chapterCache.has(catKey)) {
          // 综应只保留 A 类（用户要求）：过滤联考B/C/D类试卷分类
          const rows = db.prepare(
            "SELECT p.category, COUNT(DISTINCT p.id) AS papers, COUNT(DISTINCT q.questionId) AS questions FROM papers p LEFT JOIN questions q ON q.paperId = p.id WHERE p.subjectName = ? GROUP BY p.category ORDER BY papers DESC"
          ).all(subject);
          const filtered = subject === '事业编·综应' ? rows.filter((r) => !['联考B类', '联考C类', '联考D类'].includes(r.category)) : rows;
          chapterCache.set(catKey, filtered);
        }
        return json(res, 200, chapterCache.get(catKey));
      }
      // 试卷列表
      if (pathname === '/api/papers' && req.method === 'GET') {
        const subject = url.searchParams.get('subject');
        const category = url.searchParams.get('category');
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 500);
        if (!subject) return err(res, 400, '缺少 subject');
        const rows = category
          ? qPapersByCategory.all(subject, category).slice(0, limit)
          : qPapersBySubject.all(subject).slice(0, limit);
        return json(res, 200, rows);
      }
      // 试卷详情（含题目）
      if (pathname.match(/^\/api\/papers\/\d+$/) && req.method === 'GET') {
        const id = Number(pathname.split('/')[3]);
        const paper = qPaperById.get(id);
        if (!paper) return err(res, 404, '试卷不存在');
        paper.chapters = JSON.parse(paper.chapters || '[]');
        paper.questions = qQuestionsByPaper.all(id).map(toQuestion);
        return json(res, 200, paper);
      }
      // 试卷材料（materials.db 分块：材料1..N）
      if (pathname.match(/^\/api\/papers\/\d+\/materials$/) && req.method === 'GET') {
        const id = Number(pathname.split('/')[3]);
        if (!mdb) return json(res, 200, []);
        const rows = mdb.prepare('SELECT title, idx, text FROM materials WHERE paperId = ? ORDER BY idx').all(id);
        return json(res, 200, rows);
      }
      // 按 paperId 查材料（同卷多题复用缓存）
      if (pathname === '/api/materials' && req.method === 'GET') {
        const paperId = Number(url.searchParams.get('paperId') || 0);
        if (!mdb || !paperId) return json(res, 200, []);
        const rows = mdb.prepare('SELECT title, idx, text FROM materials WHERE paperId = ? ORDER BY idx').all(paperId);
        return json(res, 200, rows);
      }
      // 按章节随机出题（刷题；mock=0 真题 / mock=1 模拟题 / 缺省不限；chapters 逗号分隔多章节；group+sub 按树节点）
      if (pathname === '/api/practice' && req.method === 'GET') {
        const subject = url.searchParams.get('subject');
        const chapter = url.searchParams.get('chapter');
        const chapters = url.searchParams.get('chapters');
        const group = url.searchParams.get('group');
        const sub = url.searchParams.get('sub');
        const mock = url.searchParams.get('mock');
        const n = Math.min(Number(url.searchParams.get('n') || 10), 50);
        if (!subject) return err(res, 400, '缺少 subject');
        const chList = chapters ? chapters.split(',').map((s) => s.trim()).filter(Boolean) : (chapter ? [chapter] : null);
        const max = practiceMax(subject, group, chList);
        // 按树节点出题（ESSAY_TREE：综应/申论查分类索引，事业编查章节映射）
        if (group) {
          if (subject === '公务员·申论' || subject === '事业编·综应' || subject === '公务员·行测' || subject === '事业编·职测') {
            // sub='全部' → 该大模块全部题（不限子模块）；只取库中真实存在的题
            const ids = (sub === '全部'
              ? pdb.prepare('SELECT qc.question_id FROM question_categories qc WHERE qc.category = ? AND qc.subject = ? AND EXISTS (SELECT 1 FROM tiku.questions q WHERE q.questionId = qc.question_id) ORDER BY RANDOM() LIMIT ?')
              : pdb.prepare('SELECT qc.question_id FROM question_categories qc WHERE qc.category = ? AND qc.sub = ? AND qc.subject = ? AND EXISTS (SELECT 1 FROM tiku.questions q WHERE q.questionId = qc.question_id) ORDER BY RANDOM() LIMIT ?')
            ).all(...(sub === '全部' ? [group, subject, n] : [group, sub, subject, n])).map((r) => r.question_id);
            if (!ids.length) return json(res, 200, []);
            const qs = db.prepare(
              `SELECT q.questionId, q.paperId, q.chapter, q.type, q.content, q.contentHtml, q.options, q.answer, q.answerIndex, q.difficulty, q.analysis
               FROM questions q WHERE q.questionId IN (${ids.map(() => '?').join(',')}) GROUP BY q.questionId`
            ).all(...ids);
            return json(res, 200, trimToMax(enrichGroups(qs, subject), max));
          }
          // 事业编：查 ESSAY_TREE 节点对应章节
          const chs = db.prepare(`
            SELECT DISTINCT q.chapter FROM questions q JOIN papers p ON p.id = q.paperId
            WHERE p.subjectName = ? AND q.chapter != ''
          `).all(subject).map((r) => r.chapter).filter((ch) => {
            const node = mapEssayChapterToNode(ch);
            return node && node.group === group && (sub === '全部' || node.sub === sub);
          });
          const rows = randomQuestions(subject, chs.length ? chs : null, n, mock);
          return json(res, 200, trimToMax(enrichGroups(rows, subject), max));
        }
        const rows = randomQuestions(subject, chList, n, mock);
        return json(res, 200, trimToMax(enrichGroups(rows, subject), max));
      }
      // 单题详情（错题本/收藏夹点进重练用；与 /api/practice 同一输出结构）
      if (pathname === '/api/question' && req.method === 'GET') {
        const id = Number(url.searchParams.get('id'));
        if (!id) return err(res, 400, '缺少 id');
        const q = qQuestionById.get(id);
        if (!q) return err(res, 404, '题目不存在');
        const subject = pdb.prepare('SELECT subjectName FROM tiku.papers WHERE id = ?').get(q.paperId)?.subjectName ?? '';
        return json(res, 200, { ...toQuestion(q), subject });
      }
      // 章节列表（含题量 + 用户做题统计，支持 mock 过滤）
      if (pathname === '/api/chapters' && req.method === 'GET') {
        const subject = url.searchParams.get('subject');
        const mock = url.searchParams.get('mock');
        if (!subject) return err(res, 400, '缺少 subject');
        const cond = mockCond(mock);
        // 题库只读：章节题量统计缓存（key=subject|mock；做题记录变化只影响下方 done，不缓存）
        const totalsKey = `totals|${subject}|${mock ?? ''}`;
        if (!chapterCache.has(totalsKey)) {
          chapterCache.set(totalsKey, db.prepare(`
            SELECT q.chapter, COUNT(*) c FROM questions q JOIN papers p ON p.id = q.paperId
            WHERE p.subjectName = ? ${cond} GROUP BY q.chapter ORDER BY c DESC
          `).all(subject));
        }
        const totals = chapterCache.get(totalsKey);
        const done = pdb.prepare(`
          SELECT chapter, COUNT(*) c, SUM(is_correct) ok FROM practice_records
          WHERE subject = ? AND is_correct IS NOT NULL GROUP BY chapter
        `).all(subject);
        const doneMap = new Map(done.map((d) => [d.chapter, d]));
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
        // ===== 粉笔树 1:1 复刻：把章节挂载到粉笔知识点树节点 =====
        // 行测/职测 用 FENBI_TREE；主观题题库（申论/综应/事业编公基）用 ESSAY_TREE
        const isXingce = subject === '公务员·行测' || subject === '事业编·职测';
        const essaySubjects = ['公务员·申论', '事业编·综应'];
        const nodeChapters = new Map(); // key = group|sub|leaf
        const otherChapters = []; // 无法匹配的章节（其他大模块）
        const objectiveChapters = []; // 事业编客观题章节（归"客观题"组）
        const objByType = new Map(); // 客观题题型 → 章节对象列表
        for (const c of list) {
          if (isXingce) {
            const node = mapChapterToNode(c.name);
            if (!node) { otherChapters.push(c); continue; }
            const key = node.leaf ? `${node.group}|${node.sub}|${node.leaf}` : `${node.group}|${node.sub}`;
            if (!nodeChapters.has(key)) nodeChapters.set(key, []);
            nodeChapters.get(key).push(c);
          } else if (essaySubjects.includes(subject)) {
            // 申论/综应：无章节，走分类索引（下方单独处理）
            otherChapters.push(c);
          } else {
            // 事业编：章节映射到 ESSAY_TREE 或客观题组
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
        // 组装树：行测用 FENBI_TREE；主观题题库用 ESSAY_TREE + 分类索引/客观题组
        let groups;
        if (isXingce) {
          // 行测：子模块题量 = 章节映射题（nodeChapters）+ 内容分类索引题（question_categories）
          // 只数库中真实存在的题（排除已删占位题的索引残留）
          const idxMap = new Map(); // `${category}|${sub}` -> 题数
          const idxKey = `idxmap|${subject}`;
          if (!chapterCache.has(idxKey)) {
            chapterCache.set(idxKey, pdb.prepare(`
              SELECT qc.category, qc.sub, COUNT(*) c FROM question_categories qc
              WHERE qc.subject = ? AND EXISTS (SELECT 1 FROM tiku.questions q WHERE q.questionId = qc.question_id)
              GROUP BY qc.category, qc.sub
            `).all(subject));
          }
          for (const r of chapterCache.get(idxKey)) {
            idxMap.set(`${r.category}|${r.sub}`, r.c);
          }
          groups = FENBI_TREE.map((g) => {
            // 统一口径：唯一题数（跨卷重复题去重），纯索引
            const subs = g.subs.map((sub) => {
              const idxTotal = idxMap.get(`${g.group}|${sub.name}`) || 0;
              return { name: sub.name, total: idxTotal, done: 0, rate: null, chapters: [], leaves: [] };
            });
            const total = subs.reduce((s, x) => s + x.total, 0);
            return { group: g.group, total, done: 0, rate: null, chapters: [], subs };
          });
        } else {
          // ESSAY_TREE 题库：节点数据来自分类索引（综应/申论）或章节映射（事业编）
          const essayFromIndex = essaySubjects.includes(subject);
          // 一次批量统计所有分类节点（避免对 ESSAY_TREE 每节点逐条执行 EXISTS 全表扫描）
          // 注意：含做题统计(done)属动态数据，不缓存
          const nodeStatsMap = new Map();
          if (essayFromIndex) {
            for (const r of pdb.prepare(`
              SELECT qc.category, qc.sub, COUNT(DISTINCT qc.question_id) c,
                     COUNT(DISTINCT CASE WHEN r.is_correct = 1 THEN qc.question_id END) ok
              FROM question_categories qc LEFT JOIN practice_records r ON r.question_id = qc.question_id
              WHERE qc.subject = ? AND EXISTS (SELECT 1 FROM tiku.questions q WHERE q.questionId = qc.question_id)
              GROUP BY qc.category, qc.sub
            `).all(subject)) {
              nodeStatsMap.set(`${r.category}|${r.sub}`, { total: Number(r.c) || 0, done: r.ok ?? null, rate: null });
            }
          }
          const nodeStats = (group, sub) => {
            if (essayFromIndex) {
              return nodeStatsMap.get(`${group}|${sub}`) || { total: 0, done: null, rate: null };
            }
            const cs = nodeChapters.get(`${group}|${sub}`) || [];
            return { ...sum(cs), chapters: cs.map((c) => c.name) };
          };
          // 主观题题库：申论用 SHENLUN_TREE（标准五题型），综应用 ZONGYING_TREE（A/B/C/D 类），事业编公基等其他用 ESSAY_TREE
          const tree = subject === '公务员·申论' ? SHENLUN_TREE : subject === '事业编·综应' ? ZONGYING_TREE : ESSAY_TREE;
          groups = tree.map((g) => {
            const subs = g.subs.map((sub) => {
              const st = nodeStats(g.group, sub.name);
              return { name: sub.name, ...st, chapters: st.chapters || [], leaves: [] };
            });
            // 大模块 total = 子模块之和
            const total = subs.reduce((s, x) => s + x.total, 0);
            return { group: g.group, total, done: subs.reduce((s, x) => s + (x.done || 0), 0), rate: null, chapters: [], subs };
          });
          // 事业编客观题组
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
        return json(res, 200, groups);
      }
      // 智能组卷：POST /api/paper/generate —— 契约 intelligent-paper-contract.md §4.1（行测 + 职测）
      if (pathname === '/api/paper/generate' && req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* 保持 {} */ }
        try {
          let paper;
          if (body.subject === '公务员·行测') paper = await buildXingcePaper(body);
          else if (body.subject === '事业编·职测') paper = await buildZhiCePaper(body);
          else return json(res, 200, { ok: false, error: `「${body.subject || '未知科目'}」智能组卷暂未开放，当前支持：公务员·行测、事业编·职测` });
          return json(res, 200, paper);
        } catch (e) {
          return json(res, 200, { ok: false, error: `组卷失败：${e.message}` });
        }
      }
      // 收藏：列表（join tiku.questions 取题目摘要；支持分页，兼容旧纯数组结构）
      if (pathname === '/api/favorites' && req.method === 'GET') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
        const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
        const rows = pdb.prepare(`
          SELECT f.question_id, f.subject, f.chapter, f.created_at, q.content, q.type
          FROM favorites f
          LEFT JOIN tiku.questions q ON q.questionId = f.question_id
          ORDER BY f.id DESC LIMIT ? OFFSET ?
        `).all(limit, offset);
        const total = pdb.prepare('SELECT COUNT(*) n FROM favorites').get().n;
        const list = rows.map((r) => ({
          questionId: r.question_id,
          subject: r.subject,
          chapter: r.chapter,
          time: r.created_at,
          content: r.content ? r.content.slice(0, 80) : null,
          type: r.type,
        }));
        return json(res, 200, { list, total, offset, limit, hasMore: offset + list.length < total });
      }
      // 收藏：添加/取消
      if (pathname === '/api/favorites' && (req.method === 'POST' || req.method === 'DELETE')) {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { questionId, subject, chapter } = JSON.parse(body || '{}');
        if (questionId == null) return err(res, 400, '缺少 questionId');
        if (req.method === 'POST') {
          pdb.prepare('INSERT OR IGNORE INTO favorites (question_id, subject, chapter) VALUES (?, ?, ?)').run(questionId, subject || '', chapter || '');
        } else {
          pdb.prepare('DELETE FROM favorites WHERE question_id = ?').run(questionId);
        }
        return json(res, 200, { ok: true });
      }
      // 判分（粉笔题 + 自定义题 custom- 前缀均支持）
      if (pathname === '/api/check' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { questionId, selected } = JSON.parse(body || '{}');
        if (questionId == null) return err(res, 400, '缺少 questionId');
        let q = null;
        if (String(questionId).startsWith('custom-')) {
          const cid = Number(String(questionId).replace(/^custom-/, ''));
          const r = pdb.prepare('SELECT * FROM custom_questions WHERE id = ?').get(cid);
          if (r) q = { content: r.prompt, material: r.material || '', options: r.options, answer: r.answer || '', answerIndex: r.answer_index == null ? -1 : Number(r.answer_index), analysis: r.analysis || '', type: 'custom' };
        } else {
          q = qQuestionById.get(questionId);
        }
        if (!q) return err(res, 404, '题目不存在');
        return json(res, 200, checkAnswer(q, selected));
      }
      // ---- 自定义题库（2026-08-15）：批次=一次导入的文件；题目字段与粉笔 questions 同构 ----
      // 导入：建批次 + 批量插题（前端已解析成结构化字段）
      if (pathname === '/api/custom/import' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { name, questions } = JSON.parse(body || '{}');
        if (!name || !Array.isArray(questions) || questions.length === 0) return err(res, 400, '缺少批次名或题目');
        const ins = pdb.prepare('INSERT INTO custom_questions (batch_id, prompt, material, options, answer, answer_index, analysis) VALUES (?, ?, ?, ?, ?, ?, ?)');
        let batchId;
        withTx(() => {
          const tb = pdb.prepare('INSERT INTO custom_batches (name) VALUES (?)').run(String(name).trim());
          batchId = tb.lastInsertRowid;
          for (const q of questions) {
            ins.run(
              batchId,
              String(q.prompt ?? '').trim(),
              String(q.material ?? ''),
              JSON.stringify(Array.isArray(q.options) ? q.options : []),
              String(q.answer ?? ''),
              q.answer_index == null ? -1 : Number(q.answer_index),
              String(q.analysis ?? ''),
            );
          }
        });
        return json(res, 200, { id: Number(batchId), name: String(name).trim(), count: questions.length });
      }
      // 批次列表（含题数）
      if (pathname === '/api/custom/batches' && req.method === 'GET') {
        const rows = pdb.prepare(`
          SELECT b.id, b.name, b.created_at,
                 (SELECT COUNT(*) FROM custom_questions c WHERE c.batch_id = b.id) AS count
          FROM custom_batches b ORDER BY b.id DESC
        `).all();
        return json(res, 200, { batches: rows.map((r) => ({ ...r, count: Number(r.count) })) });
      }
      // 批次内题目列表
      if (pathname === '/api/custom/questions' && req.method === 'GET') {
        const batchId = Number(url.searchParams.get('batch_id') || 0);
        if (!batchId) return err(res, 400, '缺少 batch_id');
        const rows = pdb.prepare('SELECT id, batch_id, prompt, material, options, answer, answer_index, analysis FROM custom_questions WHERE batch_id = ? ORDER BY id ASC').all(batchId);
        return json(res, 200, { questions: rows.map((r) => ({ ...r, options: JSON.parse(r.options || '[]') })) });
      }
      // 批改名
      if (pathname === '/api/custom/batch' && req.method === 'PUT') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { id, name } = JSON.parse(body || '{}');
        const nid = Number(id);
        if (!nid || !String(name || '').trim()) return err(res, 400, '缺少 id 或批次名');
        pdb.prepare("UPDATE custom_batches SET name = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(String(name).trim(), nid);
        return json(res, 200, { ok: true });
      }
      // 合并批次：把选中的批次题目并入第一个（id 最小）批次，删其余批次
      if (pathname === '/api/custom/batch/merge' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { ids, name } = JSON.parse(body || '{}');
        const idList = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
        if (idList.length < 2) return err(res, 400, '至少选择两个批次');
        const target = Math.min(...idList);
        const others = idList.filter((x) => x !== target);
        withTx(() => {
          for (const o of others) {
            pdb.prepare('UPDATE custom_questions SET batch_id = ? WHERE batch_id = ?').run(target, o);
          }
          for (const o of others) {
            pdb.prepare('DELETE FROM custom_batches WHERE id = ?').run(o);
          }
        });
        if (name && String(name).trim()) {
          pdb.prepare("UPDATE custom_batches SET name = ? WHERE id = ?").run(String(name).trim(), target);
        }
        const cnt = pdb.prepare('SELECT COUNT(*) n FROM custom_questions WHERE batch_id = ?').get(target).n;
        return json(res, 200, { id: target, count: Number(cnt) });
      }
      // 拆分批次：勾选题目移入新批次
      if (pathname === '/api/custom/batch/split' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { batch_id, question_ids, name } = JSON.parse(body || '{}');
        const bid = Number(batch_id);
        const qids = (Array.isArray(question_ids) ? question_ids : []).map(Number).filter(Boolean);
        if (!bid || qids.length === 0) return err(res, 400, '缺少批次或题目');
        const src = pdb.prepare('SELECT name FROM custom_batches WHERE id = ?').get(bid);
        if (!src) return err(res, 404, '批次不存在');
        const splitN = pdb.prepare("SELECT COUNT(*) n FROM custom_batches WHERE name LIKE ?").get(src.name + '-拆分%').n;
        const newName = String(name || '').trim() || `${src.name}-拆分${splitN + 1}`;
        const tb = pdb.prepare('INSERT INTO custom_batches (name) VALUES (?)').run(newName);
        const nb = tb.lastInsertRowid;
        withTx(() => {
          for (const qid of qids) {
            pdb.prepare('UPDATE custom_questions SET batch_id = ? WHERE id = ? AND batch_id = ?').run(nb, qid, bid);
          }
        });
        const cnt = pdb.prepare('SELECT COUNT(*) n FROM custom_questions WHERE batch_id = ?').get(nb).n;
        return json(res, 200, { id: Number(nb), name: newName, count: Number(cnt) });
      }
      // 删批次（级联删题）
      if (pathname === '/api/custom/batch' && req.method === 'DELETE') {
        const bid = Number(url.searchParams.get('id') || 0);
        if (!bid) return err(res, 400, '缺少 id');
        withTx(() => {
          pdb.prepare('DELETE FROM custom_questions WHERE batch_id = ?').run(bid);
          pdb.prepare('DELETE FROM custom_batches WHERE id = ?').run(bid);
        });
        return json(res, 200, { ok: true });
      }
      // 改单题
      if (pathname === '/api/custom/question' && req.method === 'PUT') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { id, prompt, material, options, answer, answer_index, analysis } = JSON.parse(body || '{}');
        const qid = Number(id);
        if (!qid) return err(res, 400, '缺少 id');
        pdb.prepare(`
          UPDATE custom_questions SET prompt = ?, material = ?, options = ?, answer = ?, answer_index = ?, analysis = ?
          WHERE id = ?
        `).run(
          String(prompt ?? '').trim(),
          String(material ?? ''),
          JSON.stringify(Array.isArray(options) ? options : []),
          String(answer ?? ''),
          answer_index == null ? -1 : Number(answer_index),
          String(analysis ?? ''),
          qid,
        );
        return json(res, 200, { ok: true });
      }
      // 删单题
      if (pathname === '/api/custom/question' && req.method === 'DELETE') {
        const qid = Number(url.searchParams.get('id') || 0);
        if (!qid) return err(res, 400, '缺少 id');
        pdb.prepare('DELETE FROM custom_questions WHERE id = ?').run(qid);
        return json(res, 200, { ok: true });
      }
      // 出题（刷题）：字段映射成粉笔 questions 结构，直接喂 enterQuiz
      if (pathname === '/api/custom/practice' && req.method === 'GET') {
        const bid = Number(url.searchParams.get('batch_id') || 0);
        if (!bid) return err(res, 400, '缺少 batch_id');
        const b = pdb.prepare('SELECT id, name FROM custom_batches WHERE id = ?').get(bid);
        if (!b) return err(res, 404, '批次不存在');
        const rows = pdb.prepare('SELECT * FROM custom_questions WHERE batch_id = ? ORDER BY id ASC').all(bid);
        const questions = rows.map((r) => ({
          id: `custom-${r.id}`,
          questionId: `custom-${r.id}`,
          content: r.prompt,
          material: r.material || '',
          options: JSON.parse(r.options || '[]'),
          answer: r.answer || '',
          answerIndex: r.answer_index == null ? -1 : Number(r.answer_index),
          analysis: r.analysis || '',
          type: 'custom',
          subjectName: '自定义',
          batchId: bid,
          chapter: b.name,
        }));
        return json(res, 200, { questions, batch: { id: bid, name: b.name } });
      }
      // 判分：复用 checkAnswer，写 practice_records（subject='自定义'，chapter=批次名）
      if (pathname === '/api/custom/check' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { questionId, selected, batchId, chapter } = JSON.parse(body || '{}');
        const cid = Number(String(questionId || '').replace(/^custom-/, ''));
        if (!cid) return err(res, 400, '缺少 questionId');
        const q = pdb.prepare('SELECT * FROM custom_questions WHERE id = ?').get(cid);
        if (!q) return err(res, 404, '题目不存在');
        const fq = {
          content: q.prompt,
          material: q.material || '',
          options: q.options,
          answer: q.answer || '',
          answerIndex: q.answer_index == null ? -1 : Number(q.answer_index),
          analysis: q.analysis || '',
          type: 'custom',
        };
        const result = checkAnswer(fq, selected);
        const ch = chapter || pdb.prepare('SELECT name FROM custom_batches WHERE id = ?').get(Number(batchId || 0))?.name || '';
        pdb.prepare(`
          INSERT INTO practice_records (question_id, paper_id, subject, chapter, question_type, selected, is_correct, cost_ms)
          VALUES (?, NULL, '自定义', ?, 0, ?, ?, 0)
        `).run(questionId, ch, JSON.stringify(selected ?? null), result.correct == null ? null : (result.correct ? 1 : 0));
        return json(res, 200, result);
      }
      // ---- 做题记录（practice.db，服务端跨设备同步） ----
      // 提交一条做题记录（前端判分后自动上报）
      if (pathname === '/api/records' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { questionId, subject, chapter, type, selected, correct, costMs, paperId } = JSON.parse(body || '{}');
        if (questionId == null) return err(res, 400, '缺少 questionId');
        const r = pdb.prepare(`
          INSERT INTO practice_records (question_id, paper_id, subject, chapter, question_type, selected, is_correct, cost_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          questionId,
          paperId ?? null,
          subject || '',
          chapter || '',
          type ?? 0,
          JSON.stringify(selected ?? null),
          correct == null ? null : (correct ? 1 : 0),
          costMs ?? 0,
        );
        // 错题自动移除：客观题累计做对 3 次（按不同日期计，避免同日多次去重口径不一致）→ 错题记录软删除（archived=1，统计历史保留）
        // 只针对行测/职测客观题（错题本收录范围），主观题（correct=null）不参与
        if (correct === true) {
          const okDays = pdb.prepare('SELECT COUNT(DISTINCT date(created_at)) n FROM practice_records WHERE question_id = ? AND is_correct = 1').get(questionId).n;
          if (okDays >= 3) {
            pdb.prepare('UPDATE practice_records SET archived = 1 WHERE question_id = ? AND is_correct = 0 AND archived = 0').run(questionId);
          }
        }
        return json(res, 200, { ok: true, id: r.lastInsertRowid, removedFromWrong: correct === true });
      }
      // 统计（学习进度 AI 的数据源）：总数/正确率/按章节/近7天
      // 参数: subject=真实科目(经 question_id 关联 tiku 判定); days=30|180|365 或 from+to(YYYY-MM-DD); 缺省不过滤
      if (pathname === '/api/records/stats' && req.method === 'GET') {
        const subject = url.searchParams.get('subject');
        const days = Number(url.searchParams.get('days') || 0);
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const tikuCond = subject ? "AND practice_records.question_id IN (SELECT tq.questionId FROM tiku.questions tq JOIN tiku.papers tp ON tp.id = tq.paperId WHERE tp.subjectName = ?)" : '';
        const tikuParams = subject ? [subject] : [];
        const timeCond = days > 0
          ? `AND date(created_at) >= date('now','localtime','-${days} days')`
          : (from ? `AND date(created_at) >= date(?)` : '');
        const timeParams = from ? [from] : [];
        const timeCond2 = to ? `AND date(created_at) <= date(?)` : '';
        const timeParams2 = to ? [to] : [];
        const total = pdb.prepare(`
          SELECT COUNT(*) c, SUM(is_correct) ok, SUM(is_correct IS NOT NULL) graded FROM practice_records
          WHERE 1=1 ${tikuCond} ${timeCond} ${timeCond2}
        `).get(...tikuParams, ...timeParams, ...timeParams2);
        // 错题 = 严格答错（is_correct=0），与错题本口径一致（主观题 is_correct=NULL 不计入；archived 已从错题本移除的不计）
        const wrong = pdb.prepare(`
          SELECT COUNT(*) c FROM practice_records WHERE is_correct = 0 AND archived = 0
          ${tikuCond} ${timeCond} ${timeCond2}
        `).get(...tikuParams, ...timeParams, ...timeParams2).c;
        const byChapter = pdb.prepare(`
          SELECT chapter, COUNT(*) c, SUM(is_correct) ok
          FROM practice_records
          WHERE 1=1 ${tikuCond} ${timeCond} ${timeCond2}
          GROUP BY chapter ORDER BY c DESC LIMIT 20
        `).all(...tikuParams, ...timeParams, ...timeParams2);
        const last7 = pdb.prepare(`
          SELECT date(created_at) d, COUNT(*) c, SUM(is_correct) ok
          FROM practice_records WHERE created_at >= datetime('now','localtime','-7 days')
          ${tikuCond} GROUP BY date(created_at) ORDER BY d
        `).all(...tikuParams);
        const daily = pdb.prepare(`
          SELECT date(created_at) d, COUNT(*) c FROM practice_records
          WHERE 1=1 ${tikuCond} ${timeCond} ${timeCond2}
          GROUP BY date(created_at) ORDER BY d DESC LIMIT 30
        `).all(...tikuParams, ...timeParams, ...timeParams2);
        return json(res, 200, {
          total: total.c || 0,
          correct: total.ok || 0,
          wrong,
          rate: total.graded ? Math.round((total.ok / total.graded) * 100) : 0,
          byChapter,
          last7,
          daily,
        });
      }
      // 服务端错题本（跨设备同步；联表 tiku.db 取题目内容；archived 标记移除但保留历史）
      if (pathname === '/api/records/wrong' && req.method === 'GET') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
        const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
        const subject = url.searchParams.get('subject');
        // 错题本只收客观题（公考行测 / 事业编职测）；申论·综应等主观题不进错题本
        const subjectCond = subject ? 'AND subject = ?' : "AND subject IN ('公务员·行测', '事业编·职测')";
        const params = subject ? [limit, offset, subject] : [limit, offset];
        const rows = pdb.prepare(`
          SELECT id, question_id, subject, chapter, selected, created_at
          FROM practice_records WHERE is_correct = 0 AND archived = 0 ${subjectCond}
          ORDER BY id DESC LIMIT ? OFFSET ?
        `).all(...params);
        const list = rows.map((r) => {
          const q = qQuestionById.get(r.question_id);
          let myAnswer = r.selected;
          try { const arr = JSON.parse(r.selected); if (Array.isArray(arr)) myAnswer = arr.slice().sort((a, b) => a - b).join(','); } catch { /* 保持原样 */ }
          return {
            id: r.id,
            questionId: r.question_id,
            available: !!q,   // 题库中已不存在的题（历史遗留）标记为不可重做
            subject: r.subject,
            chapter: r.chapter,
            myAnswer,
            time: r.created_at,
            content: q ? q.content.slice(0, 80) : null,
            type: q ? q.type : null,
          };
        });
        // 返回总数（标题显示真实错题数）+ 分页游标，前端可"加载更多"
        const totalParams = subject ? [subject] : [];
        const total = pdb.prepare(`SELECT COUNT(*) n FROM practice_records WHERE is_correct = 0 AND archived = 0 ${subjectCond}`).get(...totalParams).n;
        return json(res, 200, { list, total, offset, limit, hasMore: offset + list.length < total });
      }
      // 清空错题（软删除：archived=1，统计历史保留；按 id 单条移除；questionId 按题移除；subject 指定时只清该模块）
      if (pathname === '/api/records/wrong' && req.method === 'DELETE') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { id, questionId, subject } = JSON.parse(body || '{}');
        if (id) pdb.prepare('UPDATE practice_records SET archived = 1 WHERE id = ?').run(id);
        else if (questionId) pdb.prepare('UPDATE practice_records SET archived = 1 WHERE question_id = ? AND is_correct = 0 AND archived = 0').run(questionId);
        else if (subject) pdb.prepare('UPDATE practice_records SET archived = 1 WHERE is_correct = 0 AND subject = ?').run(subject);
        else pdb.prepare('UPDATE practice_records SET archived = 1 WHERE is_correct = 0').run();
        return json(res, 200, { ok: true });
      }
      // 最近记录（答题历史）
      if (pathname === '/api/records/recent' && req.method === 'GET') {
        const rows = pdb.prepare(`
          SELECT id, question_id, subject, chapter, is_correct, cost_ms, created_at
          FROM practice_records ORDER BY id DESC LIMIT 50
        `).all();
        return json(res, 200, rows);
      }
      // ---- AI 智能体配置 ----
      // 列表（key 脱敏）
      if (pathname === '/api/ai/agents' && req.method === 'GET') {
        return json(res, 200, listAgents(true));
      }
      // 单个配置（脱敏：与列表一致，改 key 走 PUT；完整 key 仅服务端内部使用）
      if (pathname.match(/^\/api\/ai\/agents\/\d+$/) && req.method === 'GET') {
        const id = Number(pathname.split('/')[4]);
        const a = getAgent(id);
        if (!a) return err(res, 404, 'AI 不存在');
        const k = String(a.api_key || '');
        if (k) {
          a.api_key_masked = k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '****';
          a.api_key = '';
        }
        return json(res, 200, a);
      }
      // 更新配置（热更新：只更新传入字段，prompt/skill 变更自动存历史；
      // prompt/skill 变化会清空题目解析缓存，否则改完提示词看到的还是旧解析）
      if (pathname.match(/^\/api\/ai\/agents\/\d+$/) && req.method === 'PUT') {
        const id = Number(pathname.split('/')[4]);
        let body = '';
        for await (const chunk of req) body += chunk;
        const fields = JSON.parse(body || '{}');
        const r = updateAgent(id, fields);
        if (r.error) return err(res, 400, r.error);
        if (r.promptChanged) {
          const n = pdb.prepare('DELETE FROM ai_explains').run().changes;
          if (n > 0) console.log(`[ai] prompt/skill 变更，已清空 ${n} 条题目解析缓存`);
        }
        return json(res, 200, { ok: true, promptChanged: !!r.promptChanged, agent: listAgents(true).find((a) => a.id === id) });
      }
      // 手动清空题目解析缓存
      if (pathname === '/api/ai/explain-cache' && req.method === 'DELETE') {
        const n = pdb.prepare('DELETE FROM ai_explains').run().changes;
        return json(res, 200, { ok: true, cleared: n });
      }
      // 版本历史
      if (pathname.match(/^\/api\/ai\/agents\/\d+\/history$/) && req.method === 'GET') {
        const id = Number(pathname.split('/')[4]);
        return json(res, 200, getHistory(id));
      }
      // 测试调用（用当前配置真实调用一次 LLM）
      if (pathname.match(/^\/api\/ai\/agents\/\d+\/test$/) && req.method === 'POST') {
        const id = Number(pathname.split('/')[4]);
        let body = '';
        for await (const chunk of req) body += chunk;
        const { content } = JSON.parse(body || '{}');
        const agent = getAgent(id);
        if (!agent) return err(res, 404, 'AI 不存在');
        const userContent = content || '（测试）请用一句话介绍你的职责，并说明你准备好了。';
        const r = await callAgent(agent, userContent);
        if (r.error) return json(res, 200, { ok: false, error: r.error });
        return json(res, 200, { ok: true, content: r.content });
      }
      // 行测 AI 解析（真实调用行测解析 AI，按题目 + 作答情况生成解析）
      if (pathname === '/api/ai/explain' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { questionId, selected, correct } = JSON.parse(body || '{}');
        if (questionId == null) return err(res, 400, '缺少 questionId');
        const agent = getAgent('xingce-explainer');
        if (!agent || !agent.api_key) {
          return json(res, 200, {
            notice: '行测解析 AI 尚未配置 api_key，请到「AI 设置」页面填写后重试。',
            content: null,
          });
        }
        const q = qQuestionById.get(questionId);
        if (!q) return err(res, 404, '题目不存在');
        // 缓存键：题 + 作答（selected/correct 归一化；同一题同一作答只调一次 LLM）
        const selKey = selected == null ? 'none' : JSON.stringify((Array.isArray(selected) ? selected : [selected]).map(Number));
        const corKey = correct == null ? 'none' : (correct ? 'true' : 'false');
        const hit = pdb.prepare('SELECT content, image_note, model FROM ai_explains WHERE question_id = ? AND selected = ? AND correct = ?')
          .get(questionId, selKey, corKey);
        if (hit) {
          return json(res, 200, {
            notice: '解析完成（已缓存，秒回）',
            content: hit.content,
            imageNote: hit.image_note,
            model: hit.model,
            cached: true,
          });
        }
        const opts = JSON.parse(q.options || '[]');
        const LETTERS = 'ABCDEFGH';
        // 多选判定与 checkAnswer 对齐：JSON 数组（"[0,1,3]"）或逗号分隔数字（"0,1,3"）
        const _a = String(q.answer || '').trim();
        const isMulti = _a.startsWith('[') || (/^[\d,\s]+$/.test(_a) && _a.includes(','));
        // 图片 URL 归一化：粉笔题库大量使用协议相对地址（//host/...），需补 https: 才能下载
        const normImgUrl = (u) => (/^\/\//.test(u) ? 'https:' + u : u);
        // 材料补充：资料分析/片段阅读等材料题，把材料原文带进 prompt（数据在材料里，题干只是问题）
        // 同时提取材料里的图表图片 URL —— 图表数字是解题关键，交给识图转写
        let materialText = '';
        let materialImgUrls = [];
        let materialImgCount = 0;
        let materialImgOk = 0;
        try {
          const mm = pdb.prepare('SELECT material_id FROM q_material_map WHERE question_id = ? LIMIT 1').get(questionId);
          if (mm && mm.material_id != null) {
            const mt = pdb.prepare('SELECT content FROM q_materials WHERE material_id = ? LIMIT 1').get(mm.material_id);
            if (mt && mt.content) {
              materialImgCount = (mt.content.match(/<img/g) || []).length;
              const mimgRe = /<img[^>]+src=["']([^"']+)["']/g;
              let mim;
              while ((mim = mimgRe.exec(mt.content)) !== null) {
                const mu = normImgUrl(mim[1]);
                if (/^https?:\/\//i.test(mu)) materialImgUrls.push(mu);
              }
              materialText = mt.content
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
              if (materialText.length > 6000) materialText = materialText.slice(0, 6000) + '\n…（材料过长已截断）';
            }
          }
        } catch {}
        const isJudgment = !opts.length && !isMulti; // 判断题（无选项）
        // 提取图片 URL（contentHtml 与选项中的 <img>）
        const imgUrls = [];
        const imgRe = /<img[^>]+src=["']([^"']+)["']/g;
        let im;
        while ((im = imgRe.exec(q.contentHtml || '')) !== null) imgUrls.push(normImgUrl(im[1]));
        for (const o of opts) {
          const om = String(o).match(/<img[^>]+src=["']([^"']+)["']/);
          if (om) imgUrls.push(normImgUrl(om[1]));
        }
        const hasImage = imgUrls.length > 0 || materialImgUrls.length > 0;
        // 含图题：先调「识图转写员」（多模态视觉模型，如 GLM-4.1V-Thinking-Flash）把图片转成文字
        let imageNote = '';
        if (hasImage) {
          const downloads = await Promise.all(imgUrls.slice(0, 4).map(async (u) => {
            try {
              if (!/^https?:\/\//i.test(u)) return null;
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 10000);
              const r = await fetch(u, { signal: ctrl.signal });
              clearTimeout(t);
              if (!r.ok) return null;
              const len = parseInt(r.headers.get('content-length') || '0', 10);
              if (len > 5 * 1024 * 1024) return null; // 预检超大图
              const buf = Buffer.from(await r.arrayBuffer());
              if (buf.length > 5 * 1024 * 1024) return null; // 单图 ≤ 5MB
              return { url: u, mime: r.headers.get('content-type') || 'image/jpeg', b64: buf.toString('base64'), size: buf.length };
            } catch { return null; }
          }));
          const matDownloads = await Promise.all(materialImgUrls.slice(0, 3).map(async (u) => {
            try {
              if (!/^https?:\/\//i.test(u)) return null;
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 10000);
              const r = await fetch(u, { signal: ctrl.signal });
              clearTimeout(t);
              if (!r.ok) return null;
              const len = parseInt(r.headers.get('content-length') || '0', 10);
              if (len > 5 * 1024 * 1024) return null; // 预检超大图
              const buf = Buffer.from(await r.arrayBuffer());
              if (buf.length > 5 * 1024 * 1024) return null; // 单图 ≤ 5MB
              return { url: u, mime: r.headers.get('content-type') || 'image/jpeg', b64: buf.toString('base64'), size: buf.length };
            } catch { return null; }
          }));
          materialImgOk = matDownloads.filter(Boolean).length;
          const imgs = [...downloads, ...matDownloads].filter(Boolean);
          if (imgs.length) {
            const imgAgent = getAgent('image-reader');
            const model = (imgAgent && imgAgent.model) || 'glm-4v-flash';
            const key = (imgAgent && imgAgent.api_key) || agent.api_key;
            const baseUrl = (imgAgent && imgAgent.base_url) || agent.base_url;
            const v = await callVision(key, baseUrl, model, imgs);
            imageNote = v.content
              ? `【图片转写（AI 识图）】\n${v.content}`
              : `【图片转写失败】${v.error || '未知错误'}。图片链接：${imgs.map((i) => i.url).join('、')}`;
          }
        }
        // 材料图表提示：根据识图转写结果决定是"已提供数据"还是"无法读取"
        if (materialImgCount) {
          const note = (materialImgOk > 0 && imageNote)
            ? `\n（本题材料含 ${materialImgCount} 张图表图片，其数据已由下方 AI 识图转写提供）`
            : `\n（本题材料含 ${materialImgCount} 张图表图片，图片数据无法直接读取，请结合题干与材料文字数据推理；若文字数据不足以解题，请如实说明，切勿编造数字）`;
          materialText += note;
        }
        // 正确答案文本（单选/多选/判断）
        let correctText = '';
        if (isJudgment) {
          const a = Number(q.answer);
          correctText = a === 1 ? '正确' : '错误';
        } else if (isMulti) {
          const correctArr = _a.startsWith('[') ? JSON.parse(_a).map(Number) : _a.split(',').map(Number);
          correctText = correctArr.map((i) => `${LETTERS[i]}、${opts[i]}`).join('  ');
        } else if (q.answerIndex != null && q.answerIndex >= 0) {
          correctText = `${LETTERS[q.answerIndex]}、${opts[q.answerIndex] || ''}`;
        }
        // 用户选择文本
        let selectedText = '未作答';
        if (selected != null) {
          const sel = Array.isArray(selected) ? selected.map(Number) : [Number(selected)];
          selectedText = isJudgment
            ? (sel[0] === 1 ? '正确' : '错误')
            : sel.map((i) => `${LETTERS[i]}、${opts[i] || ''}`).join('  ');
        }
        // （材料查询与图表图片提取已提前到图片处理之前）
        const prompt = `【所属模块】${q.chapter || '未分类'}\n【题型】${isJudgment ? '判断' : isMulti ? '多选' : '单选'}${hasImage ? '（含图片/图形）' : '（纯文字）'}${materialText ? '（材料题）' : ''}\n【题干】${q.content}\n${opts.length ? `【选项】\n${opts.map((o, i) => `${LETTERS[i]}、${o}`).join('\n')}\n` : ''}${materialText ? `【材料】\n${materialText}\n` : ''}【正确答案】${correctText}\n【用户选择】${selectedText}${correct != null ? `\n【用户回答${correct ? '正确' : '错误'}】` : ''}${imageNote ? `\n${imageNote}\n（以上是 AI 识图转写的图片内容，请基于它解答图形/图表部分）` : ''}${hasImage && !imageNote ? '\n【注意】本题含图片但识图失败，你无法查看图片。请如实说明并提示用户结合题目原图，切勿猜测图形内容。' : ''}\n\n请解析这道题，输出以下结构：\n1. 【考点】本题考察的核心知识点\n2. 【正确项解析】为什么选这个答案\n3. 【错误项排除】其他选项为什么错（判断题/材料题可省略）\n4. 【解题技巧】这类题目的通用解法与避坑提醒\n语言简洁，面向备考学生。`;
        const r = await callAgent(agent, prompt);
        if (r.error) return json(res, 200, { notice: r.error, content: null });
        // 落库缓存：同一题同一作答下次秒回，不重复花钱
        try {
          pdb.prepare('INSERT OR REPLACE INTO ai_explains (question_id, selected, correct, content, image_note, model) VALUES (?, ?, ?, ?, ?, ?)')
            .run(questionId, selKey, corKey, r.content, imageNote || null, agent.model || '');
        } catch {}
        return json(res, 200, { notice: '解析完成', content: r.content, imageNote: imageNote || null, cached: false });
      }
      // ---- 识图导入作答（OCR）：拍照/上传答案图片 → 视觉AI 识别成文字 ----
      if (pathname === '/api/ai/ocr' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { image, subject } = JSON.parse(body || '{}'); // data:image/...;base64,xxx
        if (!image || !image.startsWith('data:image')) return err(res, 400, '缺少图片（data URL）');
        const m = image.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
        if (!m) return err(res, 400, '图片格式不正确');
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 8 * 1024 * 1024) return err(res, 400, '图片过大（≤8MB）');
        // 2026-08-15：识图统一走合并后的「识图转写员」（image-reader），申论/综应手写作答与行测图形图表同用一模型
        const imgAgent = getAgent('image-reader');
        const agent = getAgent('xingce-explainer') || {};
        const model = (imgAgent && imgAgent.model) || 'glm-4v-flash';
        const key = (imgAgent && imgAgent.api_key) || agent.api_key;
        const baseUrl = (imgAgent && imgAgent.base_url) || agent.base_url;
        if (!key || !baseUrl) {
          return json(res, 200, { notice: '识图 AI 尚未配置 api_key，请到「AI 设置」页面填写后重试。', text: null });
        }
        const v = await callVision(key, baseUrl, model, [{
          mime: m[1],
          b64: m[2],
          url: '(上传图片)',
          size: buf.length,
        }], 'ocr');
        if (v.error) return json(res, 200, { notice: v.error, text: null });
        return json(res, 200, { notice: '识别完成', text: v.content });
      }
      // ---- 自定义题库：题目筛选整理（custom-question-parser） ----
      if (pathname === '/api/ai/structure' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { text } = JSON.parse(body || '{}');
        if (!text || !String(text).trim()) return err(res, 400, '缺少文本');
        const agent = getAgent('custom-question-parser');
        if (!agent) return json(res, 200, { notice: '题目解析员未启用，请到 AI 设置页配置', text: null });
        const r = await callAgent(agent, String(text));
        if (r.error) return json(res, 200, { notice: r.error, text: null });
        return json(res, 200, { notice: '解析完成', text: r.content });
      }
      // ---- 申论材料：查缓存 / 懒提取（PDF → Chrome 渲染 → GLM OCR） ----
      const findPdfForPaper = (paperId) => {
        const p = db.prepare('SELECT subjectName, category, name FROM papers WHERE id = ?').get(paperId);
        if (!p) return null;
        const dir = path.join(outDir, p.subjectName, p.category || '');
        if (!fs.existsSync(dir)) return null;
        const clean = String(p.name ?? `paper-${paperId}`).replace(/[/\\:*?"<>|]/g, '_');
        const pdf = path.join(dir, clean + '.pdf');
        return fs.existsSync(pdf) ? pdf : null;
      };
      if (pathname === '/api/ai/material' && req.method === 'GET') {
        const paperId = Number(new URL(req.url, 'http://x').searchParams.get('paperId') || 0);
        if (!paperId) return err(res, 400, '缺少 paperId');
        // 新分块库优先（materials.db：材料1..N）
        if (mdb) {
          const blocks = mdb.prepare('SELECT title, idx, text FROM materials WHERE paperId = ? ORDER BY idx').all(paperId);
          if (blocks.length) {
            const text = blocks.map((b) => `${b.title}\n${b.text}`).join('\n\n');
            return json(res, 200, { text, blocks, cached: true, source: 'materials.db' });
          }
        }
        // 缓存命中（旧 practice.db 整卷）
        const cached = pdb.prepare('SELECT text, updated_at FROM materials WHERE paper_id = ?').get(paperId);
        if (cached) return json(res, 200, { text: cached.text, cached: true, updatedAt: cached.updated_at });
        // 未缓存 → 找 PDF 现场提取
        const pdf = findPdfForPaper(paperId);
        if (!pdf) return json(res, 200, { text: null, notice: '该试卷暂无 PDF（材料未采集），无法提取给定材料' });
        try {
          const text = await extractMaterialFromPdf(pdf);
          if (!text.trim()) return json(res, 200, { text: null, notice: '材料提取为空' });
          pdb.prepare('INSERT OR REPLACE INTO materials (paper_id, subject, name, text, pages) VALUES (?, ?, ?, ?, ?)')
            .run(paperId, db.prepare('SELECT subjectName FROM papers WHERE id = ?').get(paperId)?.subjectName || '', '', text, 0);
          return json(res, 200, { text, cached: false });
        } catch (e) {
          return json(res, 200, { text: null, notice: `材料提取失败：${e.message.slice(0, 80)}` });
        }
      }
      // 申论 AI 批改（真实调用申论批改 AI）
      if (pathname === '/api/ai/grade' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { questionId, content, material } = JSON.parse(body || '{}');
        const agent = getAgent('shenlun-grader');
        if (!agent || !agent.api_key) {
          return json(res, 200, {
            notice: '申论/综应批改 AI 尚未配置 api_key，请到「AI 设置」页面填写后重试。',
            score: null,
          });
        }
        const q = questionId ? qQuestionById.get(questionId) : null;
        // 从题干提取分值（如"（15分）"）
        const scoreMatch = (q?.content || '').match(/[（(]\s*(\d{1,2})\s*分\s*[）)]/);
        const fullScore = scoreMatch ? scoreMatch[1] : null;
        // 自动关联给定材料（优先请求参数，其次查材料缓存）
        let materialText = material || '';
        let materialFrom = material ? 'request' : null;
        if (!materialText && q && q.paperId) {
          // 新分块库优先（按题干引用的"给定资料N"精确取块；否则全卷合并）
          if (mdb) {
            const blocks = mdb.prepare('SELECT title, idx, text FROM materials WHERE paperId = ? ORDER BY idx').all(q.paperId);
            if (blocks.length) {
              const refs = [...(q.content || '').matchAll(/给定资料\s*[一二三四五六七八九十\d]+/g)].map((m) => m[0]);
              const wanted = refs.length ? refs.map((r) => r.replace(/给定资料\s*/, '')) : null;
              const picked = wanted
                ? blocks.filter((b) => wanted.includes(b.title.replace(/材料/, '')))
                : blocks;
              materialText = (picked.length ? picked : blocks).map((b) => `${b.title}\n${b.text}`).join('\n\n');
              materialFrom = wanted ? 'materials.db:ref' : 'materials.db:all';
            }
          }
          if (!materialText) {
            const cached = pdb.prepare('SELECT text FROM materials WHERE paper_id = ?').get(q.paperId);
            if (cached) { materialText = cached.text; materialFrom = 'cache'; }
          }
          // 综应等主观题：材料可能走 practice.db 的 q_material_map → q_materials（申论 PDF 体系查不到时回退）
          if (!materialText) {
            try {
              const mm = pdb.prepare('SELECT material_id FROM q_material_map WHERE question_id = ? LIMIT 1').get(questionId);
              if (mm && mm.material_id != null) {
                const mt = pdb.prepare('SELECT content FROM q_materials WHERE material_id = ? LIMIT 1').get(mm.material_id);
                if (mt && mt.content) {
                  materialText = mt.content
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<[^>]+>/g, '')
                    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
                  materialFrom = 'q_materials';
                }
              }
            } catch {}
          }
        }
        const prompt = `你是一名严格的申论/综应阅卷官，请按要点采分制批改。\n【题目要求】${q ? q.content : '(未提供题目)'}${fullScore ? `\n【满分】${fullScore} 分` : ''}${materialText ? `\n【给定材料】\n${materialText.slice(0, 8000)}\n` : '\n【注意】本题给定材料暂未关联，请基于题目要求评卷，并在结论中说明这一点。'}【用户作答】${content || '(空)'}\n\n请严格按以下格式输出批改结果：\n【总分】X/${fullScore || '满分'} 分\n【评分明细】逐条列出得分点与失分点（结合给定材料核对要点）\n【优点】2-3 条\n【不足】2-3 条，指出与题目要求及材料要点的差距\n【修改建议】具体、可操作的改进意见（针对内容、结构、语言）\n【参考思路】简要给出本题的答题思路/要点方向\n语言专业、中肯，面向备考学生。`;
        const r = await callAgent(agent, prompt);
        // 批改记录落库（主观题 is_correct=NULL，计入做题数但不计正确率）
        if (questionId && q) {
          try {
            const p = db.prepare('SELECT subjectName FROM papers WHERE id = ?').get(q.paperId);
            pdb.prepare(`
              INSERT INTO practice_records (question_id, paper_id, subject, chapter, question_type, selected, is_correct, cost_ms)
              VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
            `).run(questionId, q.paperId, p?.subjectName || '', q.chapter || '', q.type, JSON.stringify({ answer: content }));
          } catch { /* 落库失败不影响批改 */ }
        }
        if (r.error) return json(res, 200, { notice: r.error, score: null });
        return json(res, 200, { notice: '批改完成', score: null, result: r.content, fullScore });
      }
      // ---- 使用统计：接收埋点上报（带 CORS：App 离线模式跨域直报；事件 ts 为发生时原始时间戳） ----
      if (pathname === '/api/telemetry') {
        console.log(`[telemetry] 收到请求: ${req.method} ${req.url} from ${req.socket.remoteAddress || 'unknown'}`);
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
        if (req.method !== 'POST') return err(res, 405, 'method not allowed');
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { return err(res, 400, 'bad json'); }
        const events = Array.isArray(body.events) ? body.events : (body.event ? [body] : []);
        console.log(`[telemetry] 事件数=${events.length} 首个=${events[0] ? events[0].event + '/' + String(events[0].install_id || '').slice(0, 8) : '无'}`);
        const stmt = sdb.prepare('INSERT INTO telemetry_events (install_id, event, ts, data) VALUES (?, ?, ?, ?)');
        let saved = 0;
        for (const ev of events) {
          const id = String(ev.install_id || '').slice(0, 64);
          const name = String(ev.event || '').slice(0, 64);
          const ts = Number(ev.ts);
          if (!id || !name || !Number.isFinite(ts)) continue;
          stmt.run(id, name, Math.floor(ts), JSON.stringify(ev.data ?? {}).slice(0, 2000));
          saved++;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
        return res.end(JSON.stringify({ ok: true, saved }));
      }
      return err(res, 404, '接口不存在');
    } catch (e) {
      return err(res, 500, `服务器错误: ${e.message}`);
    }
  }

  // ---- 使用统计管理页（纯 HTML 自包含；访问 http://<host>:<port>/stats） ----
  if (pathname === '/stats' && req.method === 'GET') {
    const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const todayTs = dayStart();
    const monthTs = (() => { const d = new Date(todayTs); d.setDate(1); return d.getTime(); })();
    // 排除测试设备（install_id 以 test- 开头），避免自测数据污染统计
    const NOT_TEST = "install_id NOT LIKE 'test-%'";
    const totalUsers = sdb.prepare(`SELECT COUNT(DISTINCT install_id) c FROM telemetry_events WHERE ${NOT_TEST}`).get().c;
    const dau = sdb.prepare(`SELECT COUNT(DISTINCT install_id) c FROM telemetry_events WHERE ts >= ? AND ${NOT_TEST}`).get(todayTs).c;
    const mau = sdb.prepare(`SELECT COUNT(DISTINCT install_id) c FROM telemetry_events WHERE ts >= ? AND ${NOT_TEST}`).get(monthTs).c;
    const totalEvents = sdb.prepare(`SELECT COUNT(*) c FROM telemetry_events WHERE ${NOT_TEST}`).get().c;
    const last7 = sdb.prepare(`SELECT date(ts/1000,'unixepoch','localtime') d, COUNT(DISTINCT install_id) u, COUNT(*) n FROM telemetry_events WHERE ts >= ? AND ${NOT_TEST} GROUP BY d ORDER BY d`).all(Date.now() - 6 * 86400000);
    const byEvent = sdb.prepare(`SELECT event, COUNT(*) n, COUNT(DISTINCT install_id) u FROM telemetry_events WHERE ${NOT_TEST} GROUP BY event ORDER BY n DESC`).all();
    const recent = sdb.prepare(`SELECT install_id, event, ts, data FROM telemetry_events WHERE ${NOT_TEST} ORDER BY id DESC LIMIT 30`).all();
    const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rows7 = last7.map((r) => `<tr><td>${escH(r.d)}</td><td>${r.u}</td><td>${r.n}</td></tr>`).join('') || '<tr><td colspan="3" style="color:#999">暂无数据</td></tr>';
    const rowsE = byEvent.map((r) => `<tr><td>${escH(r.event)}</td><td>${r.n}</td><td>${r.u}</td></tr>`).join('') || '<tr><td colspan="3" style="color:#999">暂无数据</td></tr>';
    const rowsR = recent.map((r) => `<tr><td title="${escH(r.install_id)}">${escH(r.install_id.slice(0, 8))}…</td><td>${escH(r.event)}</td><td>${new Date(r.ts).toLocaleString('zh-CN')}</td><td>${escH(JSON.stringify(JSON.parse(r.data || '{}'))).slice(0, 80)}</td></tr>`).join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>使用统计 · 考公刷题</title><style>
      body{font-family:system-ui,-apple-system,'Microsoft YaHei',sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:24px}
      h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px;color:#94a3b8}
      .sub{color:#64748b;font-size:13px;margin-bottom:16px}
      .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
      .card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px}
      .card .v{font-size:26px;font-weight:700;color:#38bdf8}.card .k{font-size:12px;color:#94a3b8;margin-top:4px}
      table{width:100%;border-collapse:collapse;font-size:13px;background:#1e293b;border-radius:10px;overflow:hidden}
      th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #334155}th{color:#94a3b8;font-weight:500;background:#24344d}
      tr:last-child td{border-bottom:none}
    </style></head><body>
      <h1>📊 使用统计</h1>
      <div class="sub">数据从统计功能部署日起累计；人数 = 去重设备 ID（install_id），同一手机/浏览器只算 1 人</div>
      <div class="cards">
        <div class="card"><div class="v">${totalUsers}</div><div class="k">累计使用人数</div></div>
        <div class="card"><div class="v">${dau}</div><div class="k">今日活跃 DAU</div></div>
        <div class="card"><div class="v">${mau}</div><div class="k">本月活跃 MAU</div></div>
        <div class="card"><div class="v">${totalEvents}</div><div class="k">累计事件数</div></div>
      </div>
      <h2>近 7 天活跃趋势</h2>
      <table><tr><th>日期</th><th>活跃人数</th><th>事件数</th></tr>${rows7}</table>
      <h2>事件排行（功能使用量）</h2>
      <table><tr><th>事件</th><th>次数</th><th>人数</th></tr>${rowsE}</table>
      <h2>最近事件流水</h2>
      <table><tr><th>设备</th><th>事件</th><th>时间</th><th>附加数据</th></tr>${rowsR}</table>
    </body></html>`);
  }

  // ---- 静态文件 ----
  let file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC_DIR)) return err(res, 403, '禁止访问');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`✅ 考公刷题服务已启动: http://localhost:${PORT}`);
  console.log(`   题库: ${DB_FILE}`);
});

