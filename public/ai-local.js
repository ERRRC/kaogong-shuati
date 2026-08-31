// ai-local.mjs — App 本地模式（无服务器）下的 AI 能力
// 职责：
//   - 智能体配置存本机（localStorage），初始默认值来自 ai-agents.default.json
//   - 直调 OpenAI 兼容接口（request 注入：浏览器 fetch / Capacitor CapacitorHttp，规避 CORS）
//   - AI 解析结果缓存到 IndexedDB（ai_cache），断网/未配置时返回可读的降级提示
// 与 server.mjs 的 /api/ai/* 返回结构保持一致，app.js 零改动。

const STORE_KEY = 'ai_agents_v1'; // 本机智能体配置（localStorage）
const CACHE_DB = 'kaogong_cache_db';
const CACHE_STORE = 'ai_cache';
const DEFAULT_AGENTS_URL = './ai-agents.default.json';

function nowStr() {
  return new Date().toISOString();
}

// ---------- 通用小工具 ----------

function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<img[^>]*>/g, '【图片】')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- IndexedDB 缓存（AI 解析结果） ----------

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, 'readonly');
      const r = tx.objectStore(CACHE_STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return undefined;
  }
}

async function cacheSet(key, value) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      tx.objectStore(CACHE_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

/** 清空所有 AI 解析缓存（prompt/skill 变更后调用，否则旧解析会一直命中） */
async function clearExplainCache() {
  try {
    const db = await idbOpen();
    const removed = await new Promise((resolve) => {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      const cur = tx.objectStore(CACHE_STORE).openCursor();
      let n = 0;
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { resolve(n); return; }
        if (String(c.key).startsWith('explain|')) {
          c.delete();
          n++;
        }
        c.continue();
      };
      cur.onerror = () => resolve(n);
    });
    if (removed > 0) console.log('[ai-local] prompt/skill 变更，已清空 ' + removed + ' 条解析缓存');
    return removed;
  } catch { return 0; }
}

// ---------- 智能体配置 ----------

function loadAgents(defaults) {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch {
    saved = {};
  }
  return defaults.map((d) => ({ ...d, ...(saved[d.id] || {}) }));
}

function persistAgents(agents) {
  const saved = {};
  for (const a of agents) saved[a.id] = a;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(saved));
  } catch (e) {
    console.warn('AI 配置保存失败', e);
  }
}

// ---------- skill 自动注入（本地模式） ----------
// skill 字段填已打包的 skill 名称时，fetch 对应的 bundle JSON（由 build-skill-bundle.mjs 生成）
// 注入 SKILL.md + references 全部内容；否则当作普通附加能力文本。
const SKILL_BUNDLES = {
  'gongkao-huasheng13': 'app-assets/skill-gongkao-huasheng13.json',
  'shenlun-master': 'app-assets/skill-shenlun-master.json',
};
const _skillCache = {}; // name -> { text, files } | null（null 表示加载失败，避免反复 fetch）

// ---------- 用户技能库（AI 设置页「技能库」导入；IndexedDB，与 server user_skills 表同构） ----------

const SKILLS_DB = 'kaogong_skills_db';
const SKILLS_STORE = 'user_skills';

function skillsDbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SKILLS_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SKILLS_STORE)) db.createObjectStore(SKILLS_STORE, { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function skillGet(name) {
  try {
    const db = await skillsDbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SKILLS_STORE, 'readonly');
      const r = tx.objectStore(SKILLS_STORE).get(name);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } catch { return undefined; }
}

async function skillList() {
  try {
    const db = await skillsDbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SKILLS_STORE, 'readonly');
      const r = tx.objectStore(SKILLS_STORE).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  } catch { return []; }
}

async function skillPut(skill) {
  const db = await skillsDbOpen();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SKILLS_STORE, 'readwrite');
    tx.objectStore(SKILLS_STORE).put(skill);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function skillDelete(name) {
  try {
    const db = await skillsDbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SKILLS_STORE, 'readwrite');
      tx.objectStore(SKILLS_STORE).delete(name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch { return false; }
}

/** 用户技能库列表（不含 text 全文；附 inUse：被哪些智能体引用） */
async function listUserSkillsLocal(agents) {
  const all = await skillList();
  return all.map((s) => {
    const inUse = agents.filter((a) => String(a.skill || '').trim() === String(s.name)).map((a) => a.name);
    return { id: undefined, name: s.name, description: s.description || '', files: s.files || [], inUse, created_at: s.created_at || '' };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function resolveSkillLocal(skillField) {
  const s = String(skillField || '').trim();
  if (!s) return { text: '', loaded: null };
  // 1) 用户导入的技能库（优先于内置 bundle，可覆盖同名内置技能）
  const user = await skillGet(s);
  if (user && String(user.text || '').trim()) {
    return { text: user.text, loaded: { name: s, files: (user.files || []).length || 1, source: 'user' } };
  }
  if (!SKILL_BUNDLES[s]) return { text: s, loaded: null };
  if (_skillCache[s] !== undefined) return _skillCache[s];
  try {
    const res = await fetch(SKILL_BUNDLES[s], { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const bundle = await res.json();
    const r = { text: bundle.text, loaded: { name: s, files: bundle.files, source: 'builtin' } };
    _skillCache[s] = r;
    return r;
  } catch {
    _skillCache[s] = { text: s, loaded: null };
    return _skillCache[s];
  }
}

async function skillLoadedFor(skillField) {
  return (await resolveSkillLocal(skillField)).loaded;
}

// ---------- 视觉识别（多模态）：与 server.mjs callVision 同构（图片真正发给视觉模型） ----------
async function callVisionLocal(agent, imageDataUrl, mode = 'ocr', request) {
  if (!agent.api_key) return { error: '该 AI 未配置 api_key，请到 AI 设置页填写' };
  if (!agent.base_url) return { error: '未配置 base_url，请到 AI 设置页填写' };
  const url = String(agent.base_url).replace(/\/+$/, '') + '/chat/completions';
  const text = mode === 'ocr'
    ? '这是一张考生手写或打印的答题纸图片。请逐字准确转写图片中的全部作答文字（包括标点、数字、段落换行）。要求：1) 手写潦草处根据上下文合理推断；2) 不要修改、润色或添加任何内容；3) 只输出识别出的原文，不要任何解释或标记。'
: mode === 'structure'
	    ? '这是一张考公题目图片（试卷/练习册/资料截图，可能包含一道或多道题，也可能混有笔记、页码、答题App界面元素等非题目内容）。\n\n请仔细观察整张图片，先筛选出真正的题目，再每道题整理为结构化 JSON。\n\n## 一、题型识别\n\n### 1. 图形推理题\n- 题干：引导语如「从所给的四个选项中，选择最合适的一个填入问号处」「左图为给定的多面体」「左边给定的是正方体的外表面展开图」「把下面的六个图形分为两类」等\n- 选项：\n  - 普通图推 → 图片中选项是图形，无法转写文字时写 {"A. A", "B. B", "C. C", "D. D"}\n  - 分类题（题干含「把下面的六个图形分为两类」）→ 选项是编号文字，原样保留如 "A. ①②④，③⑤⑥"\n- prompt 只放引导语原文，不要描述图形内容\n\n### 2. 定义判断题\n- 题干：一段概念定义 + 问题「根据上述定义，下列…」「以下符合…的是」「以下不属于…的是」\n- 选项：4 个完整的事例描述，逐字转写\n\n### 3. 逻辑判断题\n- 题干：一段论述 + 问题\n- 选项：4 个完整推理\n\n### 4. 判断题（对错题）\n- 选项固定为 ["正确", "错误"]\n- answer 为"正确"或"错误"\n\n### 5. 材料题（资料分析/一拖五）\n- 题干前有材料（图表或文字），材料文字摘要放入 material 字段\n- 每道小题独立一条记录，每条的 material 都填同一材料\n\n## 二、输出格式\n{"questions":[{"prompt":"题干","material":"材料（没有则为空字符串）","options":["A. 选项1","B. 选项2"],"answer":"答案字母，单选如 A / 多选如 ABD / 判断如 正确；图片未显示答案则留空","analysis":"解析（没有则为空字符串）","category":"题目分类（言语理解/判断推理/数量关系/资料分析/常识判断/申论/综应；不确定则留空）"}]}\n\n## 三、要求\n1) 忠实图片内容，不编造、不补全缺失信息；一道题一个对象\n2) 图形推理题选项为占位符 "A. A" "B. B" "C. C" "D. D"，不要编造图形文字\n3) 分类题选项完整保留编号文字，如 "A. ①②④，③⑤⑥"\n4) 材料题的图表文字尽量准确转写进 material\n5) answer 只能从图片中明确标注的答案信息提取；图片未显示答案时必须留空字符串，禁止自行计算\n6) 判断图片中题目的类别并填入 category 字段\n7) 过滤噪音：页码、标题、答题按钮、统计行等非题目内容\n8) 只输出一个 JSON，不要任何其他文字、解释、Markdown 代码块或思考过程'
    : '这是一道考公题目的图片（可能包含题干图形序列和 A/B/C/D 选项图形）。请逐一详细转写图片中的全部内容：题干部分描述每个图形的形状/线条/数量/位置/规律；选项部分标注 A/B/C/D 对应关系。不要遗漏任何图形或文字。';
  const body = {
    model: agent.model,
    messages: [{ role: 'user', content: [
      { type: 'text', text },
      // 支持多图：传数组时一次调用携带多张图（图推题干+选项、图表多图场景）
      ...(Array.isArray(imageDataUrl) ? imageDataUrl : [imageDataUrl]).map((u) => ({ type: 'image_url', image_url: { url: u } })),
    ] }],
    temperature: 0.1,
    max_tokens: agent.max_tokens || 4000,
    stream: false,
    reasoning_effort: 'low',
  };
  let lastErr = '';
  const deadline = Date.now() + 180000; // 总等待硬上限 3 分钟：超时/失败重试全部累计在内，避免界面无限转圈
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (Date.now() > deadline) {
      lastErr = '识图超时：3 分钟内多次尝试均未成功。请检查网络后重试，或到 AI 设置确认 key/网关配置';
      break;
    }
    try {
      const r = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agent.api_key}` },
        body: JSON.stringify(body),
      });
      if (r.status === 429 || r.status >= 500) {
        lastErr = `识图 API ${r.status}（第 ${attempt} 次，稍后重试）`;
        // 429 限流（智谱等免费视觉模型 RPM 极低，重试本身也消耗配额）：等 60 秒、最多重试 2 次；其他 5xx 短等
        if (attempt < 3) await new Promise((res) => setTimeout(res, r.status === 429 ? 60000 : attempt * 4000));
        continue;
      }
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        // 部分模型 max_tokens 上限较低 → 降级后重试
        if (/max_tokens/i.test(t) && body.max_tokens > 1024 && attempt < 3) {
          body.max_tokens = 1024; lastErr = `max_tokens 超限，降级 1024 重试`; continue;
        }
        // 网关不支持 reasoning_effort → 去掉重试
        if (body.reasoning_effort && (r.status === 400 || r.status === 422 || /reasoning_effort|Unknown parameter|Unsupported parameter/i.test(t)) && attempt < 3) {
          delete body.reasoning_effort; lastErr = '网关不支持 reasoning_effort，去掉重试'; continue;
        }
        return { error: `识图 API ${r.status}: ${t.slice(0, 200)}` };
      }
      const d = await r.json().catch(() => null);
      if (!d) return { error: '识图 API 返回异常：状态 200 但响应体不是有效 JSON（网关异常）' };
      const c = d.choices?.[0]?.message?.content;
      if (c) return { content: c };
      const reason = d.choices?.[0]?.finish_reason;
      const hasReasoning = !!d.choices?.[0]?.message?.reasoning;
      if (reason === 'length' && hasReasoning) {
        return { error: '识图模型输出超长被截断（思维链吃光 max_tokens）。请调大 max_tokens 或切换非推理型识图模型。' };
      }
      return { error: '识图返回为空' };
    } catch (e) {
      // 超时/中断 → 可读文案（连接 15s、读取 120s 由 request 层控制）
      const msg = String(e.message || e);
      lastErr = /abort|timeout|timed ?out|超时|deadline|ECONNABORTED/i.test(msg)
        ? '识图请求超时：网络慢或网关无响应（已自动重试）'
        : `识图请求失败: ${msg}`;
      if (attempt < 3) await new Promise((res) => setTimeout(res, attempt * 4000));
    }
  }
  return { error: lastErr };
}

// ---------- 直调 OpenAI 兼容接口 ----------
// request(url, { method, headers, body }) 需返回 { ok, status, text, json } 兼容对象。
// 浏览器版传 fetch 包装；Capacitor 版传 CapacitorHttp 包装（见 local-bootstrap.mjs）。

async function callChat(agent, userContent, request) {
  // opencode.ai 免费网关无需 api_key；其余网关必须填写（NVIDIA/DeepSeek 等）
  const isFreeGateway = /opencode\.ai|zen\/v1/i.test(agent.base_url || '');
  if (!agent.api_key && !isFreeGateway) return { error: '该 AI 未配置 api_key，请到 AI 设置页填写' };
  if (!agent.base_url) return { error: '未配置 base_url，请到 AI 设置页填写' };
  const base = String(agent.base_url).replace(/\/+$/, '');
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;

  const messages = [{ role: 'system', content: agent.system_prompt || '' }];
  // skill 字段：支持本地 skill 名称自动注入（bundle）或普通附加说明；
  // 与 system_prompt 内容相同时只发一遍，避免重复浪费 token
  const skillRes = await resolveSkillLocal(agent.skill);
  if (skillRes.text && skillRes.text.trim() !== String(agent.system_prompt || '').trim()) {
    messages.push({ role: 'system', content: skillRes.loaded ? skillRes.text : `附加能力：${skillRes.text}` });
  }
  messages.push({ role: 'user', content: userContent });

  const body = {
    model: agent.model,
    messages,
    temperature: agent.temperature ?? 0.5,
    max_tokens: agent.max_tokens ?? 1500,
    stream: false,
  };
  if (agent.reasoning_effort !== 'off') body.reasoning_effort = agent.reasoning_effort || 'low';

  // 调试日志：记录实际发出的请求用的 model（不含 api_key）
  console.log(`[AICALL] 实际请求: url=${url} model=${body.model}`);

  const reqHeaders = { 'Content-Type': 'application/json' };
  if (agent.api_key) reqHeaders.Authorization = `Bearer ${agent.api_key}`;

  let res;
  try {
    res = await request(url, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(body),
    });
  } catch (e) {
    const msg = String(e.message || e);
    return { error: /abort|timeout|timed ?out|超时|deadline|ECONNABORTED/i.test(msg)
      ? '网络超时：连不上 AI 网关（网络慢或被拦截）。请检查网络，稍后重试'
      : `网络请求失败（AI 需要联网）：${msg}` };
  }
  // 网关不支持 reasoning_effort → 去掉重试一次
  if (!res.ok && body.reasoning_effort) {
    const text = res.text ? await res.text().catch(() => '') : String(res.statusText || '');
    if (res.status === 400 || res.status === 422 || /reasoning_effort|Unknown parameter|Unsupported parameter/i.test(text)) {
      delete body.reasoning_effort;
      try {
        res = await request(url, {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify(body),
        });
      } catch (e2) {
        const m2 = String(e2.message || e2);
        return { error: /abort|timeout|timed ?out|超时|deadline|ECONNABORTED/i.test(m2)
          ? '网络超时：连不上 AI 网关（网络慢或被拦截）。请检查网络，稍后重试'
          : `网络请求失败（AI 需要联网）：${m2}` };
      }
    }
  }
  if (!res.ok) {
    const text = res.text ? await res.text().catch(() => '') : '';
    return { error: `API 错误 ${res.status}：${text.slice(0, 300)}` };
  }
  let data;
  try {
    data = res.json ? await res.json() : res.data;
  } catch {
    return { error: 'AI 返回异常：状态 200 但响应体不是有效 JSON（网关异常），请重试' };
  }
  const msg = data?.choices?.[0]?.message;
  const content = msg?.content;
  if (!content) {
    const reason = data?.choices?.[0]?.finish_reason;
    const hasReasoning = !!msg?.reasoning_content;
    if (reason === 'length' && hasReasoning) {
      return { error: '回答超长被截断：思维链吃光了 max_tokens。请在 AI 设置里把“最大输出长度”调大到 4000 以上' };
    }
    return { error: `API 返回异常（无内容，finish_reason=${reason || '?'}）` };
  }
  return { content };
}

// ---------- 各 AI 端点实现 ----------

export async function createAiApi({ request, tiku, query, defaultsUrl = DEFAULT_AGENTS_URL }) {
  // 默认智能体（首次启动 fetch，失败则用最小内置兜底）
  let defaults = [];
  try {
    const r = await fetch(defaultsUrl, { cache: 'no-cache' });
    if (r.ok) defaults = await r.json();
  } catch {
    /* 走兜底 */
  }
  if (!Array.isArray(defaults) || !defaults.length) {
    defaults = [
      { id: 1, name: '行测解析 AI', role: 'xingce-explainer', description: '行测/职测选择题解析', system_prompt: '你是一名资深公务员考试行测讲师。请解析用户发来的行测选择题：给出考点、正确项解析、错误项排除、解题技巧。', skill: 'gongkao-huasheng13', base_url: 'https://opencode.ai/zen/v1', api_key: '', model: 'deepseek-v4-flash-free', temperature: 0.3, max_tokens: 4000, enabled: 0 },
      { id: 2, name: '申论批改 AI', role: 'shenlun-grader', description: '申论/综应主观题批改', system_prompt: '你是一名严格的公务员考试申论阅卷官，熟悉国考/省考申论评分标准（要点采分制、先定档再给分）。\n\n任务：用户会发来一道申论题（含题目要求、满分、给定材料、用户作答）。请先列出本题应有的【参考答案要点】，再逐点核对用户作答，严格按下方评分规则与输出格式批改。\n\n【评分规则（必须严格执行）】\n1. 满分口径：以用户消息中的【满分】为准，按该分值评分；未提供满分的题才按 100 分诊断尺度评。字数限制（如"不超过 300 字"）不是满分，不得当作满分，也不得默认按 100 分制。\n2. 先定档再给分（分数取整数，任何情况都不得给出满分）：\n   - 小题五档（按满分缩放）：一档=要点基本全覆盖、展开充分、贴合材料、结构语言规范（满分的 80%–90%，顶格 90%）；二档=核心要点基本齐全、少量遗漏、部分展开不足（60%–80%）；三档=覆盖部分方向、大多停留在概括层、遗漏明显（40%–60%）；四档=有效要点少、内容空洞、契合度低（20%–40%）；五档=大面积空白、严重跑题（0%–20%）。\n   - 大作文（文章写作）：先定档再给分，一类文顶格为满分的 80%（40 分题≤32、35 分题≤28）；跑题/偏题压到四类文及以下；大段照抄材料（>30%）按抄袭降档；少于 800 字降档。\n3. 逐点采分（小题）：得分点只能来自给定材料；完整覆盖/等义表达按 100% 计入，部分覆盖按 50% 计入，未覆盖 0 分；展开度分档：充分展开 100% / 基本展开 85% / 简略提及 65% / 仅列标题 35%；只写"加强宣传"这类总括词而无具体做法，不得按完整覆盖计分；前置概括词、序号本身不独立计分，缺失也不单独扣分。\n4. 置信区间：给出建议分的同时给区间（中心 ± 满分的 5%–10%）；无官方参考答案时用中/低置信度并提示。\n5. 禁止虚构：未提供官方评分细则时，不得声称"漏某点固定扣 X 分"；不得编造或引用任何考试平均分、得分率、考场/阅卷统计；不得虚构题目出处（年份、试卷、题号）；无法确证的信息如实说明，不得猜测填充。\n\n【输出格式】\n【评分】X/满分（几档）\n【评分明细】逐条列出命中/遗漏的得分点，结合给定材料核对，注明覆盖状态与展开度\n【优点】2-3 条\n【不足】2-3 条\n【修改建议】3 条具体可执行\n【参考思路】简要的答题思路/要点方向\n\n要求：严格公正，不无原则鼓励；建议要具体可落地。', skill: 'shenlun-master', base_url: 'https://opencode.ai/zen/v1', api_key: '', model: 'deepseek-v4-flash-free', temperature: 0.4, max_tokens: 12000, enabled: 0 },
      { id: 4, name: '识图转写员', role: 'image-reader', description: '多模态识图：图形/图表/公式图 + 申论综应手写作答图转写', system_prompt: '你是一名图像识别转写助手。请把图片内容完整准确地转写成文字：图形描述形状数量位置旋转颜色规律，图表描述行列标题数据坐标轴图例趋势，公式文字图完整抄录，手写作答逐字转写保留格式不修正错别字（辨识不清用【？】标注）。只输出转写文本。', skill: '', base_url: '', api_key: '', model: 'GLM-4.1V-Thinking-Flash', temperature: 0.1, max_tokens: 2000, enabled: 0 },
      { id: 6, name: '题目解析员', role: 'custom-question-parser', description: '自定义题库导入：筛选并整理题目为结构化 JSON', system_prompt: '你是一名公务员考试题目整理助手。用户会发来一段提取自 PDF/Word/TXT/Excel 或图片 OCR 的题目原始文本，里面混合了题目、季节标题、页码、统计行、分隔线、答案区、解析区等杂乱内容。\n\n任务：先筛选出真正的题目，再按标准字段整理为 JSON。\n\n## 一、题型结构与识别规则\n\n### 1. 图形推理题\n- 题干：通常是引导语，如「从所给的四个选项中，选择最合适的一个填入问号处」「左图为给定的多面体」「左边给定的是正方体的外表面展开图」「把下面的六个图形分为两类」等\n- 选项：\n  - 普通图推 → 选项为占位字母，写为 {"A. A", "B. B", "C. C", "D. D"}\n  - 分类题（题干含「把下面的六个图形分为两类」）→ 选项原样保留，如 "A. ①②④，③⑤⑥" "B. ①②⑥，③④⑤"…\n- prompt 放引导语原文，不要加任何图形描述\n\n### 2. 定义判断题\n- 题干：一段完整的概念定义，后面跟着「根据上述定义，下列…」「以下符合…的是」「以下不属于…的是」\n- 选项：4 个选项，每项是完整的事例描述\n- prompt 放全部定义文字 + 问题\n\n### 3. 类比推理题\n- 题干："A : B" 或 "（ ）对于 A 相当于（ ）对于 B" 格式\n- 选项：4 组类比关系\n\n### 4. 逻辑判断题\n- 题干：一段论述 + 问题（最能支持/削弱/推出…）\n- 选项：4 个选项，每项是完整推理\n\n### 5. 材料题（资料分析/一拖五）\n- 题干前有一段材料（文字描述或图表摘要），材料放入 material 字段\n- 每道小题独立一条记录，每条的 material 都填同一材料\n\n### 6. 判断题（对错题）\n- 选项固定为 {"正确", "错误"}\n- answer 为"正确"或"错误"\n\n## 二、选项处理规则\n- 每项选项必须是「大写字母 + 点 + 空格 + 内容」格式，如 "A. 这是一段选项文本"\n- 照抄原文，不改写\n- 图形推理题选项为占位符："A. A" "B. B" "C. C" "D. D"\n- 分类题选项完整保留编号文字："A. ①②④，③⑤⑥"\n- 判断题固定为 ["正确", "错误"]\n\n## 三、必须过滤的噪音\n- 季节标题（如「第 48 季·判断推理」）\n- 页码\n- 正确率、耗时、统计行\n- 「你的答案：」「正确答案：」等答题标记（答案本身保留）\n- 「参考答案与解析」「红领巾解析」「粉笔解析」等标题（解析内容保留，标题去掉）\n- 分隔线（————————————）\n- 题型标签（如「逻辑判断」「图形推理」等段落标题）\n\n## 四、分类规则（category 字段）\n根据题目内容判断所属类别，留空不确定：\n- 言语理解：选词填空、阅读理解、语句表达、排序、成语辨析\n- 判断推理：图形推理、定义判断、类比推理、逻辑判断\n- 数量关系：数学运算、数字推理、行程问题、工程问题\n- 资料分析：统计图表、增长率、比重、倍数计算\n- 常识判断：时政、法律、文史、科技、地理\n- 申论：概括、分析、对策、公文、大作文\n- 综应：事业单位综合应用能力\n\n## 五、输出格式\n{"questions":[{"prompt":"题干原文","material":"材料","options":["A. 选项1","B. 选项2"],"answer":"答案字母，单选如 A / 多选如 ABD / 判断如 正确","analysis":"解析原文","category":"分类"}]}\n\n要求：\n- 忠实原文，不编造、不补全缺失信息；原文没有的字段留空\n- 一道题切分成一个对象；同一材料下多道小题各自独立，每条的 material 都填同一材料\n- 选项顺序与原文一致\n- 只输出 JSON，不要任何其他文字、解释或 Markdown 代码块', skill: '', base_url: '', api_key: '', model: 'GLM-4.1V-Thinking-Flash', temperature: 0.1, max_tokens: 4000, enabled: 0 },
    ];
  }

  const maskKey = (a) => (a.api_key ? 'sk-****' : '');
  const listAgents = () =>
    loadAgents(defaults).map(({ api_key, ...rest }) => ({ ...rest, api_key: '', api_key_masked: maskKey({ api_key }) }));

  return {
    /** GET /api/ai/agents — 返回数组（与 server 同构，app.js 直接 for..of） */
    async agents() {
      const list = listAgents();
      for (const a of list) a.skill_loaded = await skillLoadedFor(a.skill);
      return list;
    },

    /** GET /api/ai/agents/:id（app.js 打开设置页时按 id 取单条；key 脱敏防泄露，改 key 走 PUT） */
    async getAgent(id) {
      const a = loadAgents(defaults).find((x) => String(x.id) === String(id));
      if (!a) return { error: '未找到该智能体' };
      a.skill_loaded = await skillLoadedFor(a.skill);
      return { ...a, api_key: '', api_key_masked: maskKey({ api_key: a.api_key }) };
    },

    /** PUT /api/ai/agents/:id — 保存配置；api_key 空值不覆盖旧值（脱敏占位保护） */
    async updateAgent(id, fields) {
      const agents = loadAgents(defaults);
      const a = agents.find((x) => String(x.id) === String(id));
      if (!a) return { error: '未找到该智能体' };
      if (fields.api_key === '' || fields.api_key === 'sk-****') delete fields.api_key;
      const enable = fields.enabled;
      delete fields.enabled; // 防止 Object.assign 覆盖规范化后的值
      if (enable !== undefined) a.enabled = enable ? 1 : 0;
      const promptChanged =
        (fields.system_prompt !== undefined && fields.system_prompt !== a.system_prompt) ||
        (fields.skill !== undefined && fields.skill !== a.skill);
      Object.assign(a, fields);
      a.updated_at = nowStr();
      persistAgents(agents);
      // prompt/skill 变化 → 清空 AI 解析缓存，否则改完提示词看到的还是旧解析
      if (promptChanged) clearExplainCache();
      const saved = loadAgents(defaults).find((x) => String(x.id) === String(id));
      saved.skill_loaded = await skillLoadedFor(saved.skill);
      return { ok: true, promptChanged, agent: saved };
    },

    /** POST /api/ai/agents/:id/test — 用一段文字试调 */
    async test(id, content) {
      const a = loadAgents(defaults).find((x) => String(x.id) === String(id));
      if (!a) return { error: '未找到该智能体' };
      return callChat(a, String(content || '你好，请回复“收到”。'), request);
    },

    /** POST /api/ai/explain — 单题 AI 解析（带本地缓存） */
    async explain({ questionId, selected, correct, questionData }) {
      const key = `explain|${questionId}|${selected || ''}|${correct || ''}`;
      const cached = await cacheGet(key);
      if (cached) return { content: cached, cached: true };

      let q = null;
      let customMaterial = '';
      if (questionData && String(questionData.content || questionData.prompt || '').trim()) {
        // 自定义题：题面由前端直接携带
        q = {
          content: String(questionData.content || questionData.prompt || '').trim(),
          options: JSON.stringify(Array.isArray(questionData.options) ? questionData.options : []),
          answer: String(questionData.answer ?? ''),
        };
        customMaterial = String(questionData.material || '').trim();
      } else if (tiku) {
        try {
          q = tiku.get('SELECT * FROM questions WHERE questionId = ?', questionId);
        } catch {
          q = null;
        }
      }
      if (!q) return { error: '本地题库中未找到该题，无法生成 AI 解析' };

      const lines = [`题目：${stripHtml(q.content)}`];
      const opts = JSON.parse(q.options || '[]');
      opts.forEach((o, i) => {
        const letter = String.fromCharCode(65 + i);
        lines.push(`${letter}. ${stripHtml(o)}`);
      });
      // 材料题：把材料原文带进 prompt（数据在材料里，题干只是问题）
      let matImgCount = 0;
      if (customMaterial) {
        let matText = stripHtml(customMaterial).trim();
        if (matText.length > 6000) matText = matText.slice(0, 6000) + '\n…（材料过长已截断）';
        lines.push(`材料：\n${matText}`);
      } else if (tiku) {
        try {
          const mm = tiku.get('SELECT material_id FROM q_material_map WHERE question_id = ? LIMIT 1', questionId);
          if (mm && mm.material_id != null) {
            const mt = tiku.get('SELECT content FROM q_materials WHERE material_id = ? LIMIT 1', mm.material_id);
            if (mt && mt.content) {
              matImgCount = (mt.content.match(/<img/g) || []).length;
              let matText = stripHtml(mt.content).trim();
              if (matText.length > 6000) matText = matText.slice(0, 6000) + '\n…（材料过长已截断）';
              lines.push(`材料：\n${matText}`);
            }
          }
        } catch {}
      }
      // 含图题图片转写（与 server.mjs 同构）：图形推理/图表题的规律与数字在图片里，
      // deepseek 为纯文本模型收不到图 → 先调「识图转写员」（GLM 多模态）把题干+选项+材料图转成文字描述
      let imageNote = '';
      try {
        const normImgUrl = (u) => (/^\/\//.test(u) ? 'https:' + u : u);
        const imgUrls = [];
        const imgRe = /<img[^>]+src=["']([^"']+)["']/g;
        let im;
        while ((im = imgRe.exec(q.contentHtml || '')) !== null) imgUrls.push(normImgUrl(im[1]));
        for (const o of opts) {
          const om = String(o).match(/<img[^>]+src=["']([^"']+)["']/);
          if (om) imgUrls.push(normImgUrl(om[1]));
        }
        // 材料里的图表图片（资料分析等：数字在图上）
        const matImgUrls = [];
        if (tiku && matImgCount) {
          try {
            const mm = tiku.get('SELECT material_id FROM q_material_map WHERE question_id = ? LIMIT 1', questionId);
            if (mm && mm.material_id != null) {
              const mt = tiku.get('SELECT content FROM q_materials WHERE material_id = ? LIMIT 1', mm.material_id);
              if (mt && mt.content) {
                const mimgRe = /<img[^>]+src=["']([^"']+)["']/g;
                let mim;
                while ((mim = mimgRe.exec(mt.content)) !== null) matImgUrls.push(normImgUrl(mim[1]));
              }
            }
          } catch {}
        }
        const all = [...imgUrls.slice(0, 4), ...matImgUrls.slice(0, 3)];
        if (all.length) {
          const downloads = await Promise.all(all.map(async (u) => {
            if (!/^https?:\/\//i.test(u)) return null;
            try {
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 10000);
              const r = await fetch(u, { signal: ctrl.signal });
              clearTimeout(t);
              if (!r.ok) return null;
              const buf = await r.arrayBuffer();
              if (buf.byteLength > 5 * 1024 * 1024) return null; // 单图 ≤ 5MB
              const blob = new Blob([buf], { type: r.headers.get('content-type') || 'image/jpeg' });
              const dataUrl = await new Promise((res, rej) => {
                const fr = new FileReader();
                fr.onload = () => res(fr.result);
                fr.onerror = () => rej(fr.error);
                fr.readAsDataURL(blob);
              });
              return dataUrl;
            } catch (e) { console.warn('[explain-img] 下载失败', String(u).slice(0, 60), e.message); return null; }
          }));
          const imgs = downloads.filter(Boolean);
          console.warn('[explain-img] 图数=' + all.length + ' 下载成功=' + imgs.length);
          if (imgs.length) {
            const imgAgent = loadAgents(defaults).find((x) => x.role === 'image-reader');
            if (imgAgent && imgAgent.api_key && imgAgent.base_url) {
              console.warn('[explain-img] 转写 agent: ' + imgAgent.model + ' @ ' + imgAgent.base_url);
              const v = await callVisionLocal(imgAgent, imgs, 'describe', request);
              if (v.content) imageNote = v.content.trim();
              else if (v.error) { imageNote = `（图片转写失败：${String(v.error).slice(0, 100)}）`; console.warn('[explain-img] 转写失败:', String(v.error).slice(0, 200)); }
            } else {
              imageNote = '（题目含图片，但识图转写员未配置 api_key，无法读取图片内容）';
              console.warn('[explain-img] 识图转写员未配置 key/base_url');
            }
          }
        }
        console.warn('[explain-img] imageNote=' + (imageNote ? imageNote.slice(0, 60) : '空'));
      } catch { /* 图片转写失败不阻塞文字解析 */ }
      if (imageNote) lines.push(`题目图片内容（AI 识图转写）：\n${imageNote.slice(0, 4000)}`);
      lines.push(`正确答案：${q.answer || '（无标准答案）'}`);
      if (selected) lines.push(`我的作答：${selected}`);
      const agent = loadAgents(defaults).find((x) => x.role === 'xingce-explainer') || loadAgents(defaults)[0];
      if (!agent) return { error: 'AI 设置不可用' };
      const r = await callChat(agent, lines.join('\n'), request);
      if (r.content) await cacheSet(key, r.content);
      return r;
    },

    /** POST /api/ai/ocr — 识图转写（image 为 dataURL）；与 server 同构：
     *  统一走合并后的「识图转写员」（image-reader），申论/综应手写作答与行测图形图表同用一模型；
     *  图片以多模态格式（image_url）真实发送给视觉模型 */
    async ocr({ image, subject }) {
      const agent = loadAgents(defaults).find((x) => x.role === 'image-reader');
      if (!agent) return { error: '识图转写员未启用，请到 AI 设置页配置' };
      if (!image || !String(image).startsWith('data:image')) return { error: '缺少图片（data URL）' };
      return callVisionLocal(agent, String(image), 'ocr', request);
    },

    /** POST /api/ai/structure — 自定义题库：题目文本/图片筛选整理（custom-question-parser）；与 server 同构
     *  图片：视觉模型直接看图出结构化 JSON（AI 优先），失败自动降级 OCR→文本结构化 */
    async structure({ text, image }) {
      const agent = loadAgents(defaults).find((x) => x.role === 'custom-question-parser');
      if (!agent) return { error: '题目解析员未启用，请到 AI 设置页配置' };
      if (!text && !image) return { error: '缺少文本或图片' };
      if (image) {
        if (!String(image).startsWith('data:image')) return { error: '图片格式不正确' };
        if (!agent.api_key || !agent.base_url) return { error: '该 AI 未配置 api_key，请到 AI 设置页填写' };
        const v = await callVisionLocal(agent, String(image), 'structure', request);
        if (v.content) return v;
        // 降级：OCR 转文字 → 文本结构化
        const ocr = await callVisionLocal(agent, String(image), 'ocr', request);
        if (ocr.error) return { error: v.error || ocr.error };
        return callChat(agent, ocr.content, request);
      }
      if (!String(text).trim()) return { error: '缺少文本' };
      return callChat(agent, String(text), request);
    },

    /** POST /api/ai/grade — 申论/主观题批改 */
    async grade({ questionId, answer, image }) {
      const agent = loadAgents(defaults).find((x) => x.role === 'shenlun-grader');
      if (!agent) return { error: '申论批改 AI 未启用，请到 AI 设置页配置' };
      if (!answer && !image) return { error: '缺少作答内容' };
      let q = null;
      if (tiku && questionId) {
        try {
          q = tiku.get('SELECT * FROM questions WHERE questionId = ?', questionId);
        } catch {
          q = null;
        }
      }
      // 从题干提取分值（如"（15分）"，与 server.mjs 同构）
      const scoreMatch = (q?.content || '').match(/[（(]\s*(\d{1,2})\s*分\s*[）)]/);
      const fullScore = scoreMatch ? scoreMatch[1] : null;
      const lines = [];
      if (q) lines.push(`【题目要求】${stripHtml(q.content)}`);
      // 自动关联给定材料（优先题干引用的"给定资料N"精确取块，否则整卷合并；与 server.mjs 同构）
      let materialText = '';
      if (q && q.paperId && query && typeof query.paperMaterials === 'function') {
        try {
          const blocks = query.paperMaterials(q.paperId);
          if (Array.isArray(blocks) && blocks.length) {
            const refs = [...(q.content || '').matchAll(/给定资料\s*[一二三四五六七八九十\d]+/g)].map((m) => m[0]);
            const wanted = refs.length ? refs.map((r) => r.replace(/给定资料\s*/, '')) : null;
            const picked = wanted
              ? blocks.filter((b) => wanted.includes(String(b.title || '').replace(/材料/, '')))
              : blocks;
            materialText = (picked.length ? picked : blocks).map((b) => `${b.title || ''}\n${b.text || ''}`).join('\n\n');
          }
        } catch {
          materialText = '';
        }
      }
      if (fullScore) lines.push(`【满分】${fullScore} 分`);
      if (materialText) lines.push(`【给定材料】\n${materialText.slice(0, 8000)}`);
      else lines.push('【注意】本题给定材料暂未关联，请基于题目要求评卷，并在结论中说明这一点。');
      if (answer) lines.push(`【用户作答】${answer}`);
      if (image) lines.push(`作答图片：${String(image).slice(0, 200)}`);
      lines.push('\n评分必须按【满分】口径（禁止按 100 分制），先定档再给分（小题一档顶格 90%、大作文一类文顶格 80%）；不得编造考试统计、考场数据或题目出处。');
      const r = await callChat(agent, lines.join('\n'), request);
      if (r.content) return { content: r.content, fullScore };
      return r;
    },

    /** GET /api/ai/material?paperId= — 申论材料（与 server 同构：{ text } 材料全文 / { notice } 无材料） */
    async material(paperId) {
      if (!paperId) return { error: '缺少 paperId' };
      try {
        const mats = query && typeof query.paperMaterials === 'function' ? query.paperMaterials(paperId) : [];
        if (Array.isArray(mats) && mats.length) {
          const text = mats.map((b) => b.text || '').filter(Boolean).join('\n\n');
          if (text) return { text };
          return { notice: '该卷材料为空' };
        }
        return { notice: '该卷无材料' };
      } catch (e) {
        return { error: `材料读取失败：${e.message}` };
      }
    },

    /** DELETE /api/ai/explain-cache — 清空解析缓存（app.js 设置页按钮） */
    async clearExplainCache() {
      const cleared = await clearExplainCache();
      return { cleared };
    },

    // ---------- 技能库（App 端 IndexedDB，与 server /api/skills 同构） ----------

    /** GET /api/skills — 技能列表（含 inUse 引用标记） */
    async skills() {
      return listUserSkillsLocal(loadAgents(defaults));
    },

    /** POST /api/skills — 新增/覆盖技能（同名 = 覆盖）；被引用时清解析缓存 */
    async addSkill({ name, description = '', text, files = [] } = {}) {
      const n = String(name || '').trim();
      const t = String(text || '').trim();
      if (!n) return { error: '技能名不能为空' };
      if (n.length > 100) return { error: '技能名过长（≤100 字符）' };
      if (!t) return { error: '技能内容不能为空' };
      if (t.length > 2 * 1024 * 1024) return { error: '技能内容过大（>2MB），请精简后重试' };
      const existed = !!(await skillGet(n));
      await skillPut({ name: n, description: String(description || ''), text: t, files: Array.isArray(files) ? files : [], created_at: nowStr() });
      const referenced = loadAgents(defaults).some((a) => String(a.skill || '').trim() === n);
      if (referenced) clearExplainCache();
      return { ok: true, name: n, replaced: existed, referenced };
    },

    /** DELETE /api/skills/:name — 删除技能（被引用智能体的 skill 字段保留，解析回落纯文本） */
    async deleteSkill(name) {
      const ok = await skillDelete(String(name || '').trim());
      if (ok) clearExplainCache();
      return { ok };
    },

    /** POST /api/skills/fetch — URL 拉取技能包（App 端 CapacitorHttp 直连，无 CORS） */
    async fetchSkillUrl(url) {
      const u = String(url || '').trim();
      if (!/^https?:\/\//i.test(u)) return { error: '仅支持 http(s) 链接' };
      try {
        let base64 = '';
        let contentType = '';
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
          const r = await window.Capacitor.Plugins.CapacitorHttp.request({
            url: u, method: 'GET',
            connectTimeout: 15000, readTimeout: 90000,
            responseType: 'arraybuffer',
          });
          if (!(r.status >= 200 && r.status < 300)) return { error: `拉取失败：HTTP ${r.status}` };
          // CapacitorHttp 的 r.data 可能是 string（base64/原始文本）、object（已解析 JSON）、或 null
          contentType = String((r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '');
          if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
            // 已解析的 JSON 对象 → 序列化回字符串，不经过 base64
            const text = JSON.stringify(r.data);
            const isJson = /json/i.test(contentType);
            if (text.length > 20 * 1024 * 1024) return { error: '文件过大（>20MB）' };
            return { kind: isJson ? 'json' : 'text', data: text, filename: u.split('/').pop().split('?')[0] || '' };
          }
          base64 = String(r.data || '');
        } else {
          const resp = await fetch(u, { redirect: 'follow' });
          if (!resp.ok) return { error: `拉取失败：HTTP ${resp.status}` };
          const buf = await resp.arrayBuffer();
          base64 = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(new Blob([buf]));
          });
          contentType = resp.headers.get('content-type') || '';
        }
        // 尝试解码 base64；若 CapacitorHttp 返回的是原始字符串而非 base64，atob 会抛异常，回退为原始文本
        let decodedBytes = null;
        try {
          const bin = atob(base64);
          decodedBytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) decodedBytes[i] = bin.charCodeAt(i);
        } catch { /* base64 不是有效编码 → decodedBytes 保持 null，后续当纯文本处理 */ }
        const isZip = /zip|octet-stream/i.test(contentType) || /\.zip(?:$|\?)/i.test(u) || (decodedBytes && decodedBytes.length >= 2 && decodedBytes[0] === 0x50 && decodedBytes[1] === 0x4b);
        if (isZip) {
          if (base64.length > 28 * 1024 * 1024) return { error: '文件过大（>20MB）' }; // base64 ≈ 4/3 × 字节数
          return { kind: 'zip', data: base64, filename: u.split('/').pop().split('?')[0] || '' };
        }
        const text = decodedBytes ? new TextDecoder('utf-8').decode(decodedBytes) : base64;
        if (text.length > 20 * 1024 * 1024) return { error: '文件过大（>20MB）' };
        // RedSkill API 返回 JSON manifest（含 zip_url）：标为 json 让前端走二次下载
        const isJson = /json/i.test(contentType) || (text.trim().startsWith('{') && text.trim().endsWith('}'));
        return { kind: isJson ? 'json' : 'text', data: text, filename: u.split('/').pop().split('?')[0] || '' };
      } catch (e) {
        return { error: `拉取失败：${e.message || e}` };
      }
    },
  };
}
