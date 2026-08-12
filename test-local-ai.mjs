// test-local-ai.mjs — 本地模式 AI 功能回归：更改 prompt/skill/api_key 是否生效、skill 注入、降级提示
// 运行：node --test test-local-ai.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- mock 浏览器环境 ----------
const storage = new Map();
global.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
const fetchLog = [];
const defaultAgents = JSON.parse(readFileSync(path.join(__dirname, 'public/ai-agents.default.json'), 'utf8'));
global.fetch = async (url) => {
  fetchLog.push(String(url));
  const u = String(url);
  if (u.includes('ai-agents.default.json')) {
    return { ok: true, status: 200, json: async () => defaultAgents };
  }
  if (u.includes('skill-gongkao-huasheng13.json')) {
    return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(path.join(__dirname, 'public/app-assets/skill-gongkao-huasheng13.json'), 'utf8')) };
  }
  if (u.includes('skill-shenlun-master.json')) {
    return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(path.join(__dirname, 'public/app-assets/skill-shenlun-master.json'), 'utf8')) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// ---------- 题库引擎（node:sqlite 适配 sql.js 接口 {get, all}） ----------
const db = new DatabaseSync(path.join(__dirname, 'app-assets/tiku_app.db'), { readOnly: true });
const tiku = {
  get: (sql, ...args) => db.prepare(sql).get(...args),
  all: (sql, ...args) => db.prepare(sql).all(...args),
};
const qid = tiku.get('SELECT questionId FROM questions WHERE options IS NOT NULL LIMIT 1').questionId;

// ---------- request mock：记录消息，返回固定内容 ----------
const chatCalls = [];
function makeRequest(responder) {
  return async function request(url, opts) {
    chatCalls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    if (typeof responder === 'function') return responder(url, opts);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'MOCK_AI_RESPONSE' } }] }), text: async () => '' };
  };
}

// ---------- 测试 ----------
test('本地 AI：默认智能体列表', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({ request: makeRequest(), tiku, query: null });
  const list = await ai.agents();
  assert.ok(Array.isArray(list) && list.length >= 4, `应有 ≥4 个智能体，实际 ${list.length}`);
  for (const a of list) {
    assert.ok('id' in a && 'role' in a && 'system_prompt' in a && 'skill' in a, `字段齐全: ${a.name}`);
  }
});

test('本地 AI：默认配置自动注入技能包（行测→gongkao-huasheng13、申论→shenlun-master）', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({ request: makeRequest(), tiku, query: null });
  const list = await ai.agents();
  const xc = list.find((a) => a.id === 1);   // 行测解析 AI
  const sl = list.find((a) => a.id === 2);   // 申论批改 AI
  assert.equal(xc.skill, 'gongkao-huasheng13', '行测 agent 默认 skill 应为技能包名');
  assert.ok(xc.skill_loaded && xc.skill_loaded.name === 'gongkao-huasheng13', `行测技能包应已加载：${JSON.stringify(xc.skill_loaded)}`);
  assert.ok(xc.skill_loaded.files > 0, `行测技能包文件数：${xc.skill_loaded.files}`);
  assert.equal(sl.skill, 'shenlun-master', '申论 agent 默认 skill 应为技能包名');
  assert.ok(sl.skill_loaded && sl.skill_loaded.name === 'shenlun-master', `申论技能包应已加载：${JSON.stringify(sl.skill_loaded)}`);
  assert.ok(sl.skill_loaded.files > 0, `申论技能包文件数：${sl.skill_loaded.files}`);
});

test('本地 AI：更改 prompt 立即生效（同实例读回）', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({ request: makeRequest(), tiku, query: null });
  const r = await ai.updateAgent(1, { system_prompt: 'NEW_PROMPT_测试' });
  assert.equal(r.promptChanged, true, 'prompt 变更应标记 promptChanged');
  const a = await ai.getAgent(1);
  assert.equal(a.system_prompt, 'NEW_PROMPT_测试', '读回的新 prompt');
});

test('本地 AI：更改 prompt 跨实例持久化（localStorage）', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({ request: makeRequest(), tiku, query: null }); // 新实例
  const a = await ai.getAgent(1);
  assert.equal(a.system_prompt, 'NEW_PROMPT_测试', '新实例读回旧实例保存的 prompt');
});

test('本地 AI：prompt 未变更时 promptChanged=false', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({ request: makeRequest(), tiku, query: null });
  const r = await ai.updateAgent(1, { system_prompt: 'NEW_PROMPT_测试' }); // 相同值
  assert.equal(r.promptChanged, false, '相同 prompt 不应触发缓存清理');
});

test('本地 AI：更改 skill 为技能包名 → 注入完整技能包', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({ request: makeRequest(), tiku, query: null });
  const r = await ai.updateAgent(1, { skill: 'shenlun-master' }); // 默认已是 gongkao-huasheng13 → 改成另一个技能包
  assert.equal(r.promptChanged, true, 'skill 变更应标记 promptChanged');
  const a = await ai.getAgent(1);
  assert.equal(a.skill, 'shenlun-master');
  assert.ok(a.skill_loaded && a.skill_loaded.name, `skill_loaded 应包含加载信息：${JSON.stringify(a.skill_loaded)}`);
  assert.equal(a.skill_loaded.name, 'shenlun-master');
  assert.ok(a.skill_loaded.files > 0, `技能包应含文件，实际 ${a.skill_loaded.files}`);
  const fetchHit = fetchLog.some((u) => u.includes('skill-shenlun-master.json'));
  assert.ok(fetchHit, '应 fetch 技能包 json');
});

test('本地 AI：skill 注入内容进入 AI 请求 system 消息', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({ request: makeRequest(), tiku, query: null });
  await ai.updateAgent(1, { skill: 'gongkao-huasheng13', api_key: 'sk-test-123', enabled: 1 }); // 显式设技能包 + 启用
  const r = await ai.explain({ questionId: qid, selected: 'A' });
  assert.equal(r.content, 'MOCK_AI_RESPONSE', 'explain 应成功');
  const call = chatCalls[chatCalls.length - 1];
  assert.ok(call, '应有 AI 调用');
  const sys = call.body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert.ok(sys.includes('Skill: gongkao-huasheng13'), '技能包内容应注入 system 消息');
  assert.ok(sys.includes('===== Skill 结束 ====='), '技能包完整注入');
});

test('本地 AI：api_key 空值/脱敏占位不覆盖旧值', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({ request: makeRequest(), tiku, query: null });
  await ai.updateAgent(2, { api_key: 'sk-real-789' });
  await ai.updateAgent(2, { api_key: 'sk-****' });   // 脱敏占位
  assert.equal((await ai.getAgent(2)).api_key, 'sk-real-789', 'sk-**** 不覆盖');
  await ai.updateAgent(2, { api_key: '' });          // 空串
  assert.equal((await ai.getAgent(2)).api_key, 'sk-real-789', '空串不覆盖');
  await ai.updateAgent(2, { api_key: 'sk-new-000' }); // 真实新值
  assert.equal((await ai.getAgent(2)).api_key, 'sk-new-000', '真实值正常覆盖');
});

test('本地 AI：未配置 key → 可读降级提示', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({ request: makeRequest(), tiku, query: null });
  // agent 1 已在上个测试启用且带 key——用未配置的 agent 4（image-reader，无 key）
  const r = await ai.ocr({ image: 'data:image/png;base64,xxx', subject: '公务员·行测' });
  assert.ok(r.error && r.error.includes('api_key'), `应提示未配置 key：${r.error}`);
});

test('本地 AI：explain 对不存在题目返回可读错误', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({ request: makeRequest(), tiku, query: null });
  const r = await ai.explain({ questionId: 999999999, selected: 'A' });
  assert.ok(r.error && r.error.includes('未找到'), `应提示未找到题目：${r.error}`);
});

test('本地 AI：request 失败（断网）→ 可读错误', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({
    request: async () => { throw new Error('network down'); },
    tiku, query: null,
  });
  await ai.updateAgent(1, { api_key: 'sk-test-123', enabled: 1 });
  const r = await ai.explain({ questionId: qid, selected: 'A' });
  assert.ok(r.error && r.error.includes('网络请求失败'), `断网提示：${r.error}`);
});

test('本地 AI：ocr 分流（综应/申论→essay-ocr，行测→image-reader）', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const calls = [];
  const ai = await createAiApi({
    request: async (url, opts) => { calls.push(JSON.parse(opts.body).model); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' } }] }), text: async () => '' }; },
    tiku, query: null,
  });
  // 给两个 OCR agent 配 key + base_url（默认无 key/base_url 会先报错，这里直接断言选中的 agent）
  await ai.updateAgent(4, { api_key: 'sk-img', base_url: 'https://api.deepseek.com/v1', enabled: 1 });
  await ai.updateAgent(5, { api_key: 'sk-essay', base_url: 'https://api.deepseek.com/v1', enabled: 1 });
  // 申论 → essay-ocr（model: mimo-v2.5-free）
  const r1 = await ai.ocr({ image: 'data:image/png;base64,aaa', subject: '公务员·申论' });
  assert.ok(calls[calls.length - 1] === 'mimo-v2.5-free' || r1.content, `申论走 essay-ocr：${JSON.stringify(r1)}`);
  // 综应 → essay-ocr
  await ai.ocr({ image: 'data:image/png;base64,aaa', subject: '事业编·综应' });
  assert.equal(calls[calls.length - 1], 'mimo-v2.5-free', '综应走 essay-ocr');
  // 行测 → image-reader（model: mimo-v2.5）
  await ai.ocr({ image: 'data:image/png;base64,aaa', subject: '公务员·行测' });
  assert.equal(calls[calls.length - 1], 'mimo-v2.5', '行测走 image-reader');
});

test('本地 AI：clearExplainCache 不抛错（返回 {cleared}）', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({ request: makeRequest(), tiku, query: null });
  const r = await ai.clearExplainCache();
  assert.equal(typeof r.cleared, 'number', 'cleared 应为数字');
});

test('本地 AI：material 返回 {text}（与 app.js 期望一致）', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const pid = tiku.get('SELECT paperId FROM questions WHERE paperId IS NOT NULL LIMIT 1').paperId;
  const ai = await createAiApi({
    request: makeRequest(), tiku, query: {
      paperMaterials: (id) => [{ title: '材料一', idx: 0, text: '材料正文第一段。' }, { title: '材料二', idx: 1, text: '材料正文第二段。' }],
    },
  });
  const r = await ai.material(pid);
  assert.equal(typeof r.text, 'string', '应返回 text 全文');
  assert.ok(r.text.includes('材料正文第一段') && r.text.includes('材料正文第二段'), '多块材料拼接');
});

test('本地 AI：无材料卷 → notice 提示', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({
    request: makeRequest(), tiku, query: { paperMaterials: () => [] },
  });
  const r = await ai.material(123);
  assert.ok(r.notice, `应返回 notice：${JSON.stringify(r)}`);
});
