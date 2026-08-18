/**
 * AI 智能体配置管理（零依赖）
 *  - ai-config.db：ai_agents（四个 AI 角色）+ prompt_history（版本历史）
 *  - 配置热更新：每次调用 AI 时实时读库，改完立即生效
 *  - 支持任意 OpenAI 兼容协议服务（DeepSeek/通义/GLM/OpenAI/本地 Ollama…）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 测试可用 AI_CONFIG_DB 环境变量指向临时库，避免写入真实 ai-config.db
export const AI_CONFIG_DB = process.env.AI_CONFIG_DB || path.join(__dirname, 'ai-config.db');

/**
 * 本地 skill 根目录候选（按顺序探测）：
 *  - workspace/.reasonix/skills（如 global-workspace/.reasonix/skills）
 *  - 项目外层 workspace/.reasonix/skills
 *  - 用户主目录/.reasonix/skills
 */
const SKILL_ROOTS = [
  path.resolve(__dirname, '../../.reasonix/skills'),
  path.resolve(__dirname, '../../../.reasonix/skills'),
  path.join(process.env.USERPROFILE || process.env.HOME || '.', '.reasonix', 'skills'),
];

/**
 * skill 字段支持两种形式：
 *  1) 已安装 skill 名称（如 gongkao-huasheng13）→ 自动读取本地 skill 文件夹注入
 *     （SKILL.md + references/ 全部 .md 文件，排除 examples/ 练习题与 README）
 *  2) 普通文本 → 原样作为附加能力说明
 * 解析优先级：用户导入的技能库（user_skills 表）→ 本地 skill 文件夹 → 纯文本
 * 返回 { text, loaded: { name, files, source: 'user'|'builtin' } | null }
 */
export function resolveSkill(skillField) {
  const s = String(skillField || '').trim();
  if (!s) return { text: '', loaded: null };
  // 1) 用户导入的技能库（AI 设置页「技能库」导入，覆盖同名内置技能）
  try {
    const row = getDb().prepare('SELECT text, files FROM user_skills WHERE name = ?').get(s);
    if (row) {
      let n = 1;
      try { n = JSON.parse(row.files || '[]').length || 1; } catch {}
      return { text: row.text, loaded: { name: s, files: n, source: 'user' } };
    }
  } catch {}
  for (const root of SKILL_ROOTS) {
    const dir = path.join(root, s);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    const parts = [`===== Skill: ${s}（自动注入） =====`];
    parts.push('[SKILL.md]\n' + fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    let files = 1;
    const refsDir = path.join(dir, 'references');
    if (fs.existsSync(refsDir)) {
      const refs = fs.readdirSync(refsDir).filter((f) => f.endsWith('.md')).sort();
      for (const f of refs) {
        parts.push(`\n----- references/${f} -----\n` + fs.readFileSync(path.join(refsDir, f), 'utf8'));
        files++;
      }
    }
    parts.push('===== Skill 结束 =====');
    return { text: parts.join('\n'), loaded: { name: s, files, source: 'builtin' } };
  }
  return { text: s, loaded: null };
}

/** 五个 AI 角色的默认配置 */
export const DEFAULT_AGENTS = [
  {
    id: 1,
    name: '行测解析 AI',
    role: 'xingce-explainer',
    description: '负责行测/职测选择题的解析讲解（题干、选项、考点、技巧）',
    system_prompt: `你是一名资深公务员考试行测讲师，擅长言语理解、判断推理、资料分析、数量关系、常识判断。

任务：用户会发来一道行测/职测选择题（含题干、选项、正确答案）。请输出：

【考点】这道题考察的知识点
【正确项解析】正确答案为什么对，结合题干关键信息说明
【错误项排除】逐一说明每个错误选项为什么错
【解题技巧】这类题的通用解题思路/口诀/避坑提醒，并注明本题所用方法名称

要求：
- 语言简洁清晰，面向备考学生，不废话
- 如果题目信息不足（如缺选项），请指出缺失并要求补充
- 涉及计算题请展示关键计算步骤
- 不编造题目中没有的信息
- 必须主动运用下方方法论中给出的速算技巧与解题方法（如截位直除、415份数法、假设分配法、份数思维等）解题，并在【解题技巧】中注明所用方法名称`,
    skill: 'gongkao-huasheng13', // 自动注入本地 skill 文件夹（SKILL.md + references）
    // 默认网关：opencode 免费端点（open code）；模型用免费版（-free），如遇限流可在 AI 设置页切换
    base_url: 'https://opencode.ai/zen/v1',
    api_key: '',
    model: 'deepseek-v4-flash-free',
    temperature: 0.3,
    max_tokens: 12000,
    enabled: 0,
  },
  {
    id: 2,
    name: '申论批改 AI',
    role: 'shenlun-grader',
    description: '负责申论/综应主观题批改：评分、要点采分、改进建议',
    system_prompt: `你是一名公务员考试申论阅卷官，熟悉国考/省考申论评分标准（要点采分制）。

任务：用户会发来一道申论题（含题目要求、给定材料要点、用户作答）。请：

1. 先写出这道题的【参考答案要点】
2. 再按以下维度为用户作答评分（分值以题目标注为准，按要点采分制计分）：
   - 要点完整性（是否踩中得分要点）
   - 条理结构（分条作答、逻辑清晰）
   - 语言表达（规范、简练、无口语化）
   - 字数控制
3. 输出格式：
   【评分】xx/题目总分（各维度得分）
   【参考答案要点】…
   【用户作答优点】…
   【丢分原因】…
   【改进建议】3 条具体可执行

要求：严格公正，不无原则鼓励；建议要具体可落地。
- 严格遵循下方评分规则与批改方法论执行（要点采分、按材料要点给分）`,
    skill: 'shenlun-master', // 自动注入本地 skill 文件夹（SKILL.md + references）
    base_url: 'https://opencode.ai/zen/v1',
    api_key: '',
    model: 'deepseek-v4-flash-free',
    temperature: 0.4,
    max_tokens: 12000,
    enabled: 0,
  },
  {
    id: 4,
    name: '识图转写员',
    role: 'image-reader',
    description: '多模态识图：图形推理/图表/公式图片转写 + 申论综应手写作答图片逐字转写（原“综应申论文字提取员”已并入）',
    system_prompt: `你是一名图像识别转写助手。用户会发来一张或几张图片（可能是考公题目中的图形推理、图表、公式文字图，也可能是申论/综应手写或打印的作答图片）。

任务：仔细观察每张图片，把它**完整、准确地转写成文字**：
- 图形推理：描述图形的形状、数量、位置、旋转、组合方式、颜色、规律特征
- 图表题：描述表格的行列标题、所有数据、坐标轴、图例、趋势
- 公式/文字图：完整抄录文字与公式
- 手写/打印作答（申论/综应）：把文字逐字、完整、准确地转写为纯文本，保留原文格式（分段、换行、序号、标点），不修正错别字、不增删改；手写辨识不清的字用【？】标注，整行无法辨认用【无法辨认】标注；图片含页眉页脚（页码、'第X页'等）时一并转写或注明忽略

要求：
- 描述要具体到能让人不看原图也能解题的程度（数量、位置、方向都要写清）
- 不要推测答案，只如实转写图片内容
- 输出仅转写文本，不要任何前言后语、评价或建议
- 如果图片模糊无法辨认，如实说明哪部分看不清`,
    skill: '多模态识图转写：图形/图表/公式图 + 申论综应手写作答图 → 完整文字',
    // 用户指定网关：图片识别走智谱 bigmodel + GLM-4.1V-Thinking-Flash（视觉思考模型）
    // 2026-08 起按用户要求不再分发 api_key，需用户在 AI 设置页自行填写
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key: '',
    model: 'GLM-4.1V-Thinking-Flash',
    temperature: 0.1,
    max_tokens: 12000,
    enabled: 0,
  },
  {
    id: 6,
    name: '题目解析员',
    role: 'custom-question-parser',
    description: '自定义题库导入：把自由格式题目文本拆分为 提示/材料/选项/答案/解析 结构化 JSON',
    system_prompt: `你是一名公务员考试题目整理助手。用户会发来一段提取自 PDF/Word/TXT/Excel 或图片 OCR 的题目原始文本（可能包含一道或多道题，也可能混有笔记、说明、考情、页码等非题目内容，格式不规范）。

任务：**先筛选，再整理**：
1. 筛选：识别出真正的题目，过滤掉非题目内容（笔记、说明、考情、页眉页脚、页码等）；拿不准但疑似题目的保留
2. 把每道题整理为标准字段，输出 JSON：
{
  "questions": [
    {
      "prompt": "题干（提示）",
      "material": "材料（材料题才有的背景材料；没有则为空字符串）",
      "options": ["选项文本1", "选项文本2"],  // 没有选项则为空数组
      "answer": "答案原文（如 A / AB / 正确；没有则为空字符串）",
      "analysis": "解析（没有则为空字符串）"
    }
  ]
}

要求：
- 忠实原文，不编造、不补全缺失信息；原文没有的字段留空
- 一道题切分成一个对象；同一材料下有多道小题时，每道小题的 material 都填同一材料
- 选项顺序与原文一致；OCR 转写造成的错别字尽量按常识修正，无法确认的保留原文
- 只输出 JSON，不要任何其他文字、解释或 Markdown 代码块`,
    skill: '题目原始文本 → 筛选并整理为 提示/材料/选项/答案/解析 结构化 JSON（自定义题库导入）',
    // 用户指定网关：与识图转写员同款底座（智谱 bigmodel + GLM-4.1V-Thinking-Flash），可在 AI 设置页增改
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key: '',
    model: 'GLM-4.1V-Thinking-Flash',
    temperature: 0.1,
    max_tokens: 12000,
    enabled: 0,
  },
];

let db = null;

export function initAiConfig() {
  db = new DatabaseSync(AI_CONFIG_DB);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      system_prompt TEXT NOT NULL,
      skill TEXT DEFAULT '',
      base_url TEXT NOT NULL,
      api_key TEXT DEFAULT '',
      model TEXT NOT NULL,
      temperature REAL DEFAULT 0.5,
      max_tokens INTEGER DEFAULT 1500,
      enabled INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS prompt_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      system_prompt TEXT NOT NULL,
      skill TEXT DEFAULT '',
      saved_at TEXT DEFAULT (datetime('now','localtime')),
      note TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS user_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      text TEXT NOT NULL,
      files TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  // 兼容已存在的库：补充新增列
  try { db.exec('ALTER TABLE ai_agents ADD COLUMN reasoning_effort TEXT DEFAULT \'low\''); } catch {}
  // 兼容已存在的库：补种新增角色（image-reader）
  for (const a of DEFAULT_AGENTS) {
    const exists = db.prepare('SELECT id FROM ai_agents WHERE role = ?').get(a.role);
    if (!exists) {
      db.prepare(`
        INSERT INTO ai_agents (id, name, role, description, system_prompt, skill, base_url, api_key, model, temperature, max_tokens, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(a.id, a.name, a.role, a.description, a.system_prompt, a.skill, a.base_url, a.api_key, a.model, a.temperature, a.max_tokens, a.enabled);
    }
  }
  // 迁移（2026-08-15）：essay-ocr 已并入 image-reader。旧库若存在 essay-ocr 行，
  // 将其 api_key 并入 image-reader（若后者无 key）后删除该行，避免用户配置丢失
  try {
    const merged = db.prepare("SELECT api_key FROM ai_agents WHERE role = 'essay-ocr'").get();
    if (merged) {
      const img = db.prepare("SELECT api_key FROM ai_agents WHERE role = 'image-reader'").get();
      if (img && !String(img.api_key || '').trim() && String(merged.api_key || '').trim()) {
        db.prepare("UPDATE ai_agents SET api_key = ? WHERE role = 'image-reader'").run(merged.api_key);
      }
      db.prepare("DELETE FROM ai_agents WHERE role = 'essay-ocr'").run();
    }
  } catch {}
  return db;
}

export function getDb() {
  if (!db) initAiConfig();
  return db;
}

/** 关闭配置库连接（测试清理用；服务端常驻无需调用） */
export function closeAiConfig() {
  try { if (db) db.close(); } catch {}
  db = null;
}

/** 读取一个 AI 的完整配置 */
export function getAgent(idOrRole) {
  const d = getDb();
  const row = typeof idOrRole === 'number'
    ? d.prepare('SELECT * FROM ai_agents WHERE id = ?').get(idOrRole)
    : d.prepare('SELECT * FROM ai_agents WHERE role = ?').get(idOrRole);
  if (!row) return null;
  return row;
}

/** 列出全部（api_key 脱敏；附 skill_loaded 供前端显示自动注入状态） */
export function listAgents(maskKey = true) {
  const rows = getDb().prepare('SELECT * FROM ai_agents ORDER BY id').all();
  return rows
    // 历史遗留的「学习进度顾问」（progress-coach）已下线，隐藏不出现在设置页（2026-08-17）
    .filter((r) => r.role !== 'progress-coach')
    .map((r) => {
      if (maskKey && r.api_key) {
        const k = String(r.api_key);
        r.api_key_masked = k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '****';
        r.api_key = '';
      }
      try { r.skill_loaded = resolveSkill(r.skill).loaded; } catch { r.skill_loaded = null; }
      return r;
    });
}

/** 更新配置（只更新传入的字段；prompt/skill 变化时自动存历史） */
export function updateAgent(id, fields) {
  const d = getDb();
  const cur = d.prepare('SELECT * FROM ai_agents WHERE id = ?').get(id);
  if (!cur) return { error: 'AI 不存在' };

  const allowed = ['name', 'description', 'system_prompt', 'skill', 'base_url', 'api_key', 'model', 'temperature', 'max_tokens', 'enabled', 'reasoning_effort'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      // 空 api_key 不覆盖：前端设置页的 key 输入框是脱敏占位（value 为空），
      // 直接保存会把真实 key 清空。想清空 key 请配合停用该 AI。
      if (k === 'api_key' && !String(fields[k]).trim()) continue;
      sets.push(`${k} = ?`);
      vals.push(k === 'enabled' ? (fields[k] ? 1 : 0) : fields[k]);
    }
  }
  if (!sets.length) return { error: '没有可更新的字段' };
  sets.push("updated_at = datetime('now','localtime')");
  vals.push(id);
  d.prepare(`UPDATE ai_agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  // 版本历史：prompt 或 skill 变化时存旧版
  const newPrompt = fields.system_prompt !== undefined ? fields.system_prompt : cur.system_prompt;
  const newSkill = fields.skill !== undefined ? fields.skill : cur.skill;
  const promptChanged = newPrompt !== cur.system_prompt || newSkill !== cur.skill;
  if (promptChanged) {
    d.prepare('INSERT INTO prompt_history (agent_id, system_prompt, skill, note) VALUES (?, ?, ?, ?)')
      .run(id, cur.system_prompt, cur.skill, fields.note || '自动保存旧版');
  }
  return { ok: true, agent: getAgent(id), promptChanged };
}

/** 版本历史 */
export function getHistory(id, limit = 20) {
  return getDb().prepare('SELECT * FROM prompt_history WHERE agent_id = ? ORDER BY id DESC LIMIT ?').all(id, limit);
}

// ---------- 用户技能库（AI 设置页「技能库」导入，双端同构：App 端 IndexedDB） ----------

const SKILL_MAX_TEXT = 2 * 1024 * 1024;

/** 技能列表（不含 text 全文；附 inUse：被哪些智能体引用） */
export function listUserSkills() {
  const d = getDb();
  return d.prepare('SELECT id, name, description, files, created_at FROM user_skills ORDER BY id').all()
    .map((r) => {
      let files = [];
      try { files = JSON.parse(r.files || '[]'); } catch {}
      const inUse = d.prepare("SELECT name, role FROM ai_agents WHERE skill = ?").all(r.name).map((a) => a.name);
      return { ...r, files, inUse };
    });
}

/** 新增/覆盖技能；同名 = 覆盖。返回 { ok, name, replaced, referenced } */
export function addUserSkill({ name, description = '', text, files = [] }) {
  const d = getDb();
  const n = String(name || '').trim();
  if (!n) return { error: '技能名不能为空' };
  if (n.length > 100) return { error: '技能名过长（≤100 字符）' };
  const t = String(text || '').trim();
  if (!t) return { error: '技能内容不能为空' };
  if (t.length > SKILL_MAX_TEXT) return { error: '技能内容过大（>2MB），请精简后重试' };
  const filesJson = JSON.stringify(Array.isArray(files) ? files : []);
  const exists = d.prepare('SELECT id FROM user_skills WHERE name = ?').get(n);
  if (exists) {
    d.prepare("UPDATE user_skills SET description = ?, text = ?, files = ?, created_at = datetime('now','localtime') WHERE name = ?")
      .run(String(description || ''), t, filesJson, n);
  } else {
    d.prepare('INSERT INTO user_skills (name, description, text, files) VALUES (?, ?, ?, ?)')
      .run(n, String(description || ''), t, filesJson);
  }
  const referenced = !!d.prepare('SELECT id FROM ai_agents WHERE skill = ?').get(n);
  return { ok: true, name: n, replaced: !!exists, referenced };
}

/** 删除技能（被引用智能体的 skill 字段保留原值，解析回落纯文本） */
export function deleteUserSkill(name) {
  const n = String(name || '').trim();
  if (!n) return { error: '缺少技能名' };
  const res = getDb().prepare('DELETE FROM user_skills WHERE name = ?').run(n);
  return { ok: res.changes > 0 };
}

/**
 * 调用 LLM（OpenAI 兼容 /chat/completions）
 *  - 配置从数据库实时读取（热更新）
 */
export async function callAgent(agent, userContent) {
  if (!agent.api_key) return { error: '该 AI 未配置 api_key，请到 AI 设置页填写' };
  if (!agent.base_url) return { error: '未配置 base_url' };
  const base = String(agent.base_url).replace(/\/+$/, '');
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;

  const messages = [{ role: 'system', content: agent.system_prompt }];
  // skill 字段：支持本地 skill 名称自动注入（SKILL.md + references）或普通附加说明；
  // 与 system_prompt 内容相同时只发一遍，避免重复浪费 token
  const skillRes = resolveSkill(agent.skill);
  if (skillRes.text && skillRes.text.trim() !== String(agent.system_prompt || '').trim()) {
    messages.push({ role: 'system', content: skillRes.loaded ? skillRes.text : `附加能力：${skillRes.text}` });
  }
  messages.push({ role: 'user', content: userContent });

  let res;
  const body = {
    model: agent.model,
    messages,
    temperature: agent.temperature ?? 0.5,
    max_tokens: agent.max_tokens ?? 1500,
    stream: false,
  };
  // 推理型模型（deepseek 等）默认思维链极长，会吃光 max_tokens 且极慢；
  // 传 reasoning_effort=low 抑制过度思考，加速且稳定（网关不支持时会自动回退）
  if (agent.reasoning_effort !== 'off') body.reasoning_effort = agent.reasoning_effort || 'low';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120000);
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agent.api_key}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (e) {
    return { error: `网络请求失败：${e.message}` };
  }
  if (!res.ok && body.reasoning_effort) {
    // 网关不支持 reasoning_effort 参数 → 去掉后重试一次
    const text = await res.text().catch(() => '');
    if (res.status === 400 || res.status === 422 || /reasoning_effort|Unknown parameter|Unsupported parameter/i.test(text)) {
      delete body.reasoning_effort;
      try {
        const ctrl2 = new AbortController();
        const t2 = setTimeout(() => ctrl2.abort(), 120000);
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${agent.api_key}`,
          },
          body: JSON.stringify(body),
          signal: ctrl2.signal,
        });
        clearTimeout(t2);
      } catch (e2) {
        return { error: `网络请求失败：${e2.message}` };
      }
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: `API 错误 ${res.status}：${text.slice(0, 300)}` };
  }
  // 网关偶发返回 200 但 body 非 JSON（空/HTML/网关错误页）——不能 throw（会变 500），降级为友好错误
  let data;
  try {
    data = await res.json();
  } catch {
    return { error: `API 返回异常：状态 200 但响应体不是有效 JSON（网关异常），请重试` };
  }
  const msg = data?.choices?.[0]?.message;
  const content = msg?.content;
  if (!content) {
    // 推理型模型（如 deepseek 系列）会先生成 reasoning_content（思维链），
    // 若 max_tokens 太小，思维链会吃光配额导致正式回答为空
    const reason = data?.choices?.[0]?.finish_reason;
    const hasReasoning = !!msg?.reasoning_content;
    if (reason === 'length' && hasReasoning) {
      return { error: '回答超长被截断：该模型会先“思考”再回答，思维链吃光了 max_tokens。请在 AI 设置里把“最大输出长度”调大到 4000 以上（当前 ' + (agent.max_tokens ?? 1500) + '）' };
    }
    return { error: 'API 返回异常（无内容，finish_reason=' + reason + '）' };
  }
  return { content };
}

