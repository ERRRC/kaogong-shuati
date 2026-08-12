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

async function resolveSkillLocal(skillField) {
  const s = String(skillField || '').trim();
  if (!s) return { text: '', loaded: null };
  if (!SKILL_BUNDLES[s]) return { text: s, loaded: null };
  if (_skillCache[s] !== undefined) return _skillCache[s];
  try {
    const res = await fetch(SKILL_BUNDLES[s], { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const bundle = await res.json();
    const r = { text: bundle.text, loaded: { name: s, files: bundle.files } };
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
  if (!agent.api_key) return { error: '该 AI 未配置 api_key，请到 AI 设置页填写' };
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

  let res;
  try {
    res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agent.api_key}` },
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
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agent.api_key}` },
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
      { id: 1, name: '行测解析 AI', role: 'xingce-explainer', description: '行测/职测选择题解析', system_prompt: '你是一名资深公务员考试行测讲师。请解析用户发来的行测选择题：给出考点、正确项解析、错误项排除、解题技巧。', skill: 'gongkao-huasheng13', base_url: 'https://api.deepseek.com/v1', api_key: '', model: 'deepseek-chat', temperature: 0.3, max_tokens: 4000, enabled: 0 },
      { id: 2, name: '申论批改 AI', role: 'shenlun-grader', description: '申论/综应主观题批改', system_prompt: '你是一名申论阅卷官。请对用户的作答按要点采分制评分（满分100），给出评分、参考答案要点、丢分原因、改进建议。', skill: 'shenlun-master', base_url: 'https://api.deepseek.com/v1', api_key: '', model: 'deepseek-chat', temperature: 0.4, max_tokens: 2000, enabled: 0 },
      { id: 3, name: '学习进度顾问', role: 'progress-coach', description: '学习数据分析与规划', system_prompt: '你是一名考公学习规划顾问。请分析用户的学习数据并给出总体评估、薄弱环节、趋势分析、下一步行动建议。', skill: '', base_url: 'https://api.deepseek.com/v1', api_key: '', model: 'deepseek-chat', temperature: 0.5, max_tokens: 4000, enabled: 0 },
      { id: 4, name: '识图转写员', role: 'image-reader', description: '图形/图表图片转写', system_prompt: '你是一名图像识别助手。请把图片内容完整准确地转写成文字。', skill: '', base_url: '', api_key: '', model: 'mimo-v2.5', temperature: 0.1, max_tokens: 2000, enabled: 0 },
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
    async explain({ questionId, selected, correct }) {
      const key = `explain|${questionId}|${selected || ''}|${correct || ''}`;
      const cached = await cacheGet(key);
      if (cached) return { content: cached, cached: true };

      let q = null;
      if (tiku) {
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
      if (tiku) {
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
      // deepseek 为纯文本模型收不到图 → 先调「识图转写员」（mimo 多模态）把题干+选项+材料图转成文字描述
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
            const imgAgent = loadAgents(defaults).find((x) => x.role === 'image-reader') || loadAgents(defaults)[3];
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
      lines.push(`正确答案：${q.answer}`);
      if (selected) lines.push(`我的作答：${selected}`);
      const agent = loadAgents(defaults).find((x) => x.role === 'xingce-explainer') || loadAgents(defaults)[0];
      if (!agent) return { error: 'AI 设置不可用' };
      const r = await callChat(agent, lines.join('\n'), request);
      if (r.content) await cacheSet(key, r.content);
      return r;
    },

    /** POST /api/ai/ocr — 识图转写（image 为 dataURL）；与 server 同构：综应/申论手写作答 → essay-ocr，其余 → image-reader；
     *  图片以多模态格式（image_url）真实发送给视觉模型 */
    async ocr({ image, subject }) {
      const ocrRole = (subject && /申论|综应/.test(subject)) ? 'essay-ocr' : 'image-reader';
      const agent = loadAgents(defaults).find((x) => x.role === ocrRole);
      if (!agent) return { error: `${ocrRole === 'essay-ocr' ? '综应申论文字提取员' : '识图转写员'}未启用，请到 AI 设置页配置` };
      if (!image || !String(image).startsWith('data:image')) return { error: '缺少图片（data URL）' };
      return callVisionLocal(agent, String(image), 'ocr', request);
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
      const lines = [];
      if (q) {
        lines.push(`题目：${stripHtml(q.content)}`);
        const opts = JSON.parse(q.options || '[]');
        opts.forEach((o, i) => lines.push(`${String.fromCharCode(65 + i)}. ${stripHtml(o)}`));
      }
      if (answer) lines.push(`我的作答：${answer}`);
      if (image) lines.push(`作答图片：${String(image).slice(0, 200)}`);
      const r = await callChat(agent, lines.join('\n'), request);
      if (r.content) return { content: r.content };
      return r;
    },

    /** POST /api/ai/progress — 学习数据分析 */
    async progress(body) {
      const agent = loadAgents(defaults).find((x) => x.role === 'progress-coach');
      if (!agent) return { error: '学习进度顾问未启用，请到 AI 设置页配置' };
      const r = await callChat(agent, `请分析以下学习数据并给出建议：\n${JSON.stringify(body || {})}`, request);
      if (r.content) return { content: r.content };
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
  };
}
