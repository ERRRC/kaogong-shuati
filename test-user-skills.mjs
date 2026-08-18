// test-user-skills.mjs — 自定义技能库测试（node --test 风格，直接断言）
// 覆盖：
//   - skill-importer.js 解析器：frontmatter / 拼接格式 / zip 解析（含 examples 排除）/ URL 判定 / 校验 / base64
//   - lib/ai-agents.mjs（Web 端）：user_skills CRUD + resolveSkill 优先级（用户导入 > 内置 > 纯文本），
//     用 AI_CONFIG_DB 环境变量指向临时库（不影响真实 ai-config.db）
//   - public/ai-local.js（App 端）：IndexedDB mock 下的技能库 CRUD + 解析优先级（用户导入优先于内置 bundle）
// 运行：node --test test-user-skills.mjs（已并入 npm run test:local）

import test from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---------- 工具：手拼最小 zip（deflate-raw，仅 local header + central directory + EOCD） ----------
function buildZip(files) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = enc.encode(f.name);
    const dataBuf = zlib.deflateRawSync(enc.encode(f.content));
    const local = new Uint8Array(30 + nameBuf.length + dataBuf.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 8, true);
    dv.setUint32(18, dataBuf.length, true);
    dv.setUint32(22, dataBuf.length, true);
    dv.setUint16(26, nameBuf.length, true);
    local.set(nameBuf, 30);
    local.set(dataBuf, 30 + nameBuf.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBuf.length);
    const cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, 8, true);
    cdv.setUint32(20, dataBuf.length, true);
    cdv.setUint32(24, dataBuf.length, true);
    cdv.setUint16(28, nameBuf.length, true);
    cdv.setUint32(42, offset, true);
    central.set(nameBuf, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  const all = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const l of locals) { all.set(l, p); p += l.length; }
  for (const c of centrals) { all.set(c, p); p += c.length; }
  all.set(eocd, p);
  return all;
}

// ---------- 解析器测试（skill-importer.js） ----------
test('frontmatter 解析：name/description/引号/续行', async () => {
  const { extractFrontmatter } = await import('./public/lib/skill-importer.js');
  const r1 = extractFrontmatter('---\nname: my-skill\ndescription: 我的技能\n---\n正文内容');
  assert.strictEqual(r1.name, 'my-skill');
  assert.strictEqual(r1.description, '我的技能');
  assert.strictEqual(r1.body, '正文内容');
  const r2 = extractFrontmatter('---\nname: "quoted"\ndescription: line1\n  line2\n---\nbody');
  assert.strictEqual(r2.name, 'quoted');
  assert.strictEqual(r2.description, 'line1 line2');
  const r3 = extractFrontmatter('无 frontmatter 的纯文本');
  assert.strictEqual(r3.name, '');
  assert.strictEqual(r3.body, '无 frontmatter 的纯文本');
});

test('parseSkillText：缺 name 回退 + 拼接格式', async () => {
  const { parseSkillText, composeSkillText } = await import('./public/lib/skill-importer.js');
  const p = parseSkillText('---\ndescription: 说明\n---\n正文', 'fallback-name');
  assert.strictEqual(p.name, 'fallback-name');
  assert.strictEqual(p.description, '说明');
  assert.strictEqual(p.body, '正文');
  assert.ok(p.text.includes('===== Skill: fallback-name（用户导入） ====='));
  assert.ok(p.text.includes('[SKILL.md]\n正文'));
  assert.ok(p.text.includes('===== Skill 结束 ====='));
  assert.strictEqual(composeSkillText('x', 'main', [{ path: 'references/a.md', text: 'refA' }])
    .includes('----- references/a.md -----\nrefA'), true);
});

test('parseSkillZip：SKILL.md + references 任意层级 md/json，排除 examples/README', async () => {
  const { parseSkillZip } = await import('./public/lib/skill-importer.js');
  const zip = buildZip([
    { name: 'my-pack/SKILL.md', content: '---\nname: pack-skill\ndescription: 打包技能\n---\n主正文' },
    { name: 'my-pack/references/ref1.md', content: '参考一' },
    { name: 'my-pack/references/ref2.md', content: '参考二' },
    { name: 'my-pack/references/contracts/grade.md', content: '契约内容' },
    { name: 'my-pack/references/config/weights.json', content: '{"w":1}' },
    { name: 'my-pack/examples/example.md', content: '练习题（应排除）' },
    { name: 'my-pack/README.md', content: '说明（应排除）' },
  ]);
  const p = await parseSkillZip(zip);
  assert.strictEqual(p.name, 'pack-skill');
  assert.strictEqual(p.description, '打包技能');
  assert.strictEqual(p.body, '主正文');
  assert.strictEqual(p.files.length, 5, JSON.stringify(p.files));
  assert.ok(p.text.includes('----- my-pack/references/ref1.md -----'));
  assert.ok(p.text.includes('参考二'));
  assert.ok(p.text.includes('----- my-pack/references/contracts/grade.md -----'));
  assert.ok(p.text.includes('契约内容'));
  assert.ok(p.text.includes('----- my-pack/references/config/weights.json -----'));
  assert.ok(!p.text.includes('练习题（应排除）'));
  assert.ok(!p.text.includes('说明（应排除）'));
  assert.strictEqual(p.refs.length, 4);
});

test('parseSkillZip：无 frontmatter 用顶层目录名；无 SKILL.md 报错', async () => {
  const { parseSkillZip } = await import('./public/lib/skill-importer.js');
  const zip = buildZip([
    { name: 'dir-name/SKILL.md', content: '正文' },
    { name: 'dir-name/references/a.md', content: 'r' },
  ]);
  const p = await parseSkillZip(zip);
  assert.strictEqual(p.name, 'dir-name');
  await assert.rejects(parseSkillZip(buildZip([{ name: 'no-skill.txt', content: 'x' }])), /SKILL\.md/);
});

test('detectSkillUrlKind / validateSkill / base64ToBytes', async () => {
  const { detectSkillUrlKind, validateSkill, base64ToBytes } = await import('./public/lib/skill-importer.js');
  assert.strictEqual(detectSkillUrlKind('https://x/y.zip?raw=1'), 'zip');
  assert.strictEqual(detectSkillUrlKind('https://x/SKILL.md'), 'text');
  assert.strictEqual(detectSkillUrlKind('https://x/a.txt'), 'text');
  assert.strictEqual(detectSkillUrlKind('https://x/page'), null);
  assert.strictEqual(validateSkill({ name: '', text: 'x' }).ok, false);
  assert.strictEqual(validateSkill({ name: 'a', text: '' }).ok, false);
  assert.strictEqual(validateSkill({ name: 'a', text: 'x'.repeat(2 * 1024 * 1024 + 1) }).ok, false);
  assert.strictEqual(validateSkill({ name: 'a', text: 'x' }).ok, true);
  assert.deepStrictEqual([...base64ToBytes('AAEC')], [0, 1, 2]);
});

// ---------- Web 端：lib/ai-agents.mjs（临时 AI_CONFIG_DB 隔离） ----------
test('Web 端 user_skills CRUD + resolveSkill 优先级', async () => {
  const tmpDb = path.join(os.tmpdir(), `ai-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.AI_CONFIG_DB = tmpDb;
  const agents = await import('./lib/ai-agents.mjs');

  // 初始：未知名 → 纯文本回退
  assert.deepStrictEqual(agents.resolveSkill('no-such-skill').loaded, null);
  assert.strictEqual(agents.resolveSkill('no-such-skill').text, 'no-such-skill');

  // 新增
  let r = agents.addUserSkill({ name: 'my-skill', description: 'd', text: '===== Skill: my-skill =====\n正文', files: [{ path: 'SKILL.md' }] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.replaced, false);
  assert.strictEqual(r.referenced, false);
  const list = agents.listUserSkills();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'my-skill');
  assert.deepStrictEqual(list[0].inUse, []);
  assert.strictEqual(list[0].text, undefined, '列表不应含 text 全文');

  // resolveSkill 优先用户导入
  const loaded = agents.resolveSkill('my-skill');
  assert.strictEqual(loaded.loaded.source, 'user');
  assert.strictEqual(loaded.loaded.files, 1);

  // 同名覆盖
  r = agents.addUserSkill({ name: 'my-skill', text: '新内容' });
  assert.strictEqual(r.replaced, true);
  assert.ok(agents.resolveSkill('my-skill').text.includes('新内容'));

  // 被智能体引用 → inUse + referenced
  agents.updateAgent(1, { skill: 'my-skill' });
  r = agents.addUserSkill({ name: 'my-skill', text: '再覆盖' });
  assert.strictEqual(r.referenced, true);
  assert.deepStrictEqual(agents.listUserSkills()[0].inUse, ['行测解析 AI']);
  assert.strictEqual(agents.resolveSkill('my-skill').loaded.source, 'user');

  // 删除 → 回落纯文本（智能体 skill 字段保留）
  assert.strictEqual(agents.deleteUserSkill('my-skill').ok, true);
  assert.strictEqual(agents.resolveSkill('my-skill').loaded, null);
  assert.strictEqual(agents.getAgent(1).skill, 'my-skill', '删除技能不影响 agent 字段');

  // 校验错误
  assert.ok(agents.addUserSkill({ name: '', text: 'x' }).error);
  assert.ok(agents.addUserSkill({ name: 'x', text: '' }).error);
  assert.ok(agents.addUserSkill({ name: 'x', text: 'y'.repeat(2 * 1024 * 1024 + 1) }).error);

  // listAgents 的 skill_loaded 带 source
  agents.addUserSkill({ name: 'gongkao-huasheng13', text: '用户版同名覆盖' });
  assert.strictEqual(agents.resolveSkill('gongkao-huasheng13').loaded.source, 'user');

  agents.closeAiConfig();
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(tmpDb + '-wal', { force: true });
  fs.rmSync(tmpDb + '-shm', { force: true });
});

// ---------- App 端：public/ai-local.js（IndexedDB mock） ----------
test('App 端技能库 CRUD + 解析优先级（IndexedDB mock）', async () => {
  // mock indexedDB / localStorage / fetch（defaults 拉取失败走内置兜底）
  const stores = new Map(); // db::store -> Map(key, value)
  const fakeReq = (fire) => {
    const r = {};
    queueMicrotask(() => fire && fire(r));
    return r;
  };
  global.indexedDB = {
    open(dbName) {
      const db = {
        objectStoreNames: { contains: (s) => stores.has(`${dbName}::${s}`) },
        createObjectStore: (s) => { stores.set(`${dbName}::${s}`, new Map()); return {}; },
        transaction: (storeName) => {
          const map = stores.get(`${dbName}::${storeName}`) || new Map();
          const tx = { oncomplete: null, objectStore: () => ({
            get: (k) => fakeReq((r) => { r.result = map.get(k); r.onsuccess && r.onsuccess(); }),
            getAll: () => fakeReq((r) => { r.result = [...map.values()]; r.onsuccess && r.onsuccess(); }),
            put: (v) => fakeReq((r) => { map.set(v && v.name != null ? v.name : v.id, v); r.onsuccess && r.onsuccess(); }),
            delete: (k) => fakeReq((r) => { map.delete(k); r.onsuccess && r.onsuccess(); }),
            openCursor: () => { const c = {}; queueMicrotask(() => { c.result = null; c.onsuccess && c.onsuccess(); }); return c; },
          }) };
          queueMicrotask(() => tx.oncomplete && tx.oncomplete());
          return tx;
        },
      };
      return fakeReq((r) => {
        r.result = db;
        r.onupgradeneeded && r.onupgradeneeded();
        r.onsuccess && r.onsuccess();
      });
    },
  };
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({ request: async () => ({ ok: false, status: 0 }), tiku: null, query: null, defaultsUrl: 'file:///nonexistent-defaults.json' });

  // 初始为空
  assert.deepStrictEqual(await ai.skills(), []);

  // 新增
  let r = await ai.addSkill({ name: 'my-skill', description: 'd', text: '正文', files: [{ path: 'SKILL.md' }] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.replaced, false);
  assert.strictEqual(r.referenced, false);
  let list = await ai.skills();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'my-skill');
  assert.deepStrictEqual(list[0].inUse, []);
  assert.strictEqual(list[0].text, undefined);

  // 解析优先级：用户导入优先（内置 bundle 名被用户覆盖）
  r = await ai.addSkill({ name: 'gongkao-huasheng13', text: '用户版覆盖内置 bundle' });
  assert.strictEqual(r.referenced, true, '行测解析 AI 默认 skill 即该名');
  const agents = await ai.agents();
  const xc = agents.find((a) => a.id === 1);
  assert.strictEqual(xc.skill_loaded.source, 'user');
  assert.strictEqual(xc.skill_loaded.name, 'gongkao-huasheng13');

  // 同名覆盖 + inUse 标记
  await ai.addSkill({ name: 'my-skill', text: 'v2' });
  r = await ai.addSkill({ name: 'my-skill', text: 'v3' });
  assert.strictEqual(r.replaced, true);
  assert.strictEqual((await ai.skills()).length, 2);

  // 删除
  assert.strictEqual((await ai.deleteSkill('my-skill')).ok, true);
  list = await ai.skills();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'gongkao-huasheng13');

  // 校验错误
  assert.ok((await ai.addSkill({ name: '', text: 'x' })).error);
  assert.ok((await ai.addSkill({ name: 'x', text: '' })).error);

  delete global.indexedDB;
  delete global.localStorage;
});
