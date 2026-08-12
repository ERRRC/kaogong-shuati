/**
 * AI 智能体配置管理（零依赖）
 *  - ai-config.db：ai_agents（五个 AI 角色）+ prompt_history（版本历史）
 *  - 配置热更新：每次调用 AI 时实时读库，改完立即生效
 *  - 支持任意 OpenAI 兼容协议服务（DeepSeek/通义/GLM/OpenAI/本地 Ollama…）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AI_CONFIG_DB = path.join(__dirname, 'ai-config.db');

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
 * 返回 { text, loaded: { name, files } | null }
 */
export function resolveSkill(skillField) {
  const s = String(skillField || '').trim();
  if (!s) return { text: '', loaded: null };
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
    return { text: parts.join('\n'), loaded: { name: s, files } };
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
    // 用户指定网关：行测/申论文本 AI 统一走 opencode 网关 + deepseek-v4-flash（推理模型，max_tokens 需预留思维链空间）
    base_url: 'https://opencode.ai/zen/go/v1',
    api_key: '',
    model: 'deepseek-v4-flash',
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
    base_url: 'https://opencode.ai/zen/go/v1',
    api_key: '',
    model: 'deepseek-v4-flash',
    temperature: 0.4,
    max_tokens: 12000,
    enabled: 0,
  },
  {
    id: 3,
    name: '学习进度顾问',
    role: 'progress-coach',
    description: '监控整体学习进度，分析做题数据，给出个性化学习建议',
    system_prompt: `你是一名考公学习规划顾问。用户会发来一段学习数据（做题统计：各模块做题数、正确率、趋势、最近表现、薄弱模块）。

任务：分析数据并输出：

【总体评估】一句话概括当前学习状态
【数据亮点】做得好的 1-2 个方面
【薄弱环节】正确率低/下滑的模块，结合数据说明
【趋势分析】正确率随时间的变化，是否在进步
【下一步行动】3-5 条具体建议（含优先级），如"每天专项刷 20 题资料分析"、"优先补言语理解中成语辨析"等

要求：
- 基于数据说话，不要泛泛而谈
- 建议具体到模块、题量、频次
- 语气务实，不灌鸡汤也不打击人`,
    skill: '学习数据分析 + 个性化备考规划',
    // 与行测/申论一致：用户指定网关 + deepseek-v4-flash
    base_url: 'https://opencode.ai/zen/go/v1',
    api_key: '',
    model: 'deepseek-v4-flash',
    temperature: 0.5,
    max_tokens: 12000,
    enabled: 0,
  },
  {
    id: 4,
    name: '识图转写员',
    role: 'image-reader',
    description: '多模态识图：把图形推理/图表题中的图片转写成文字描述，供行测解析 AI 使用',
    system_prompt: `你是一名图像识别助手。用户会发来一张或几张图片（考公题目中的图形推理、图表、资料分析插图等）。

任务：仔细观察每张图片，把它**完整、准确地转写成文字**：
- 图形推理：描述图形的形状、数量、位置、旋转、组合方式、颜色、规律特征
- 图表题：描述表格的行列标题、所有数据、坐标轴、图例、趋势
- 公式/文字图：完整抄录文字与公式

要求：
- 描述要具体到能让人不看原图也能解题的程度（数量、位置、方向都要写清）
- 不要推测答案，只如实转写图片内容
- 如果图片模糊无法辨认，如实说明哪部分看不清`,
    skill: '图形/图表/公式图片 → 详细文字转写',
    // 用户指定网关：图片识别走智谱 bigmodel + GLM-4.1V-Thinking-Flash（视觉思考模型，实测无 429 限流）
    // 该模型为免费模型，key 随安装包分发（用户明确要求），开箱即用无需手动配置
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key: '***REMOVED***',
    model: 'GLM-4.1V-Thinking-Flash',
    temperature: 0.1,
    max_tokens: 12000,
    enabled: 0,
  },
  {
    id: 5,
    name: '综应申论文字提取员',
    role: 'essay-ocr',
    description: '专职识别综应/申论手写作答图片中的文字（拍照上传、逐字转写、保留原文格式）',
    system_prompt: `你是一名考公申论/综应作答图片文字提取专家。用户会发来手写或打印的申论/综应作答图片（可能多张、按页拼接）。

任务：把图片中的文字**逐字、完整、准确地转写**为纯文本：
- 保留原文格式：分段、换行、序号（一、二、三 / 1. 2. 3.）、标点
- 不增删改：不修正错别字、不补全内容、不添加任何解释
- 手写辨识不清的字用【？】标注；整行无法辨认用【无法辨认】标注
- 图片含页眉页脚（页码、'第X页'等）时一并转写或注明忽略
- 输出仅转写文本，不要任何前言后语、评价或建议`,
    skill: '申论/综应手写作答图片 → 逐字转写，保留原文格式',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    // 免费模型 key 随安装包分发（与识图转写员共用智谱 key），开箱即用
    api_key: '***REMOVED***',
    model: 'GLM-4.1V-Thinking-Flash',
    temperature: 0.1,
    // 视觉模型输出上限实测后确定；GLM 对 max_tokens 上限较宽松，保留 12000 防截断
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
  return db;
}

export function getDb() {
  if (!db) initAiConfig();
  return db;
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
  return rows.map((r) => {
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

