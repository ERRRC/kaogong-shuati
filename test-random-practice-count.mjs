// 随机练习题量回归测试（2026-08 用户要求）：
// 行测/职测固定 15 题；言语理解与表达/判断推理/资料分析（材料组题）15-20 封顶；申论/综应固定 2 题。
// 运行：node --test test-random-practice-count.mjs（自动起 server 于随机端口，测完关闭）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createLocalApi } from './lib/local-queries.mjs';

const PORT = 3900 + Math.floor(Math.random() * 200);
let server, base;

before(async () => {
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(PORT, () => { srv.close(resolve); });
    srv.on('error', reject);
  });
  server = spawn(process.execPath, ['server.mjs', String(PORT)], { stdio: 'ignore' });
  // 轮询等待服务就绪（替代固定 sleep，避免并发跑多个 server 时启动慢导致误报）
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  base = `http://localhost:${PORT}`;
});

after(() => { server?.kill(); });

const enc = encodeURIComponent;
async function count(path) {
  const res = await fetch(base + path);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`请求失败: ${path} -> ${res.status} body=${body.slice(0, 400)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data.length : 0;
}
const XC = enc('公务员·行测'), ZC = enc('事业编·职测'), SL = enc('公务员·申论'), ZY = enc('事业编·综应');
const runs = 5;

async function assertRange(path, lo, hi) {
  for (let i = 0; i < runs; i++) {
    const c = await count(path);
    assert.ok(c >= lo && c <= hi, `${path} 第${i + 1}次出 ${c} 题，期望 ${lo}-${hi}`);
  }
}
async function assertExact(path, n) {
  for (let i = 0; i < runs; i++) {
    const c = await count(path);
    assert.equal(c, n, `${path} 第${i + 1}次出 ${c} 题，期望 ${n}`);
  }
}

test('行测·言语理解与表达（材料模块）15-20 题', () => assertRange(`/api/practice?subject=${XC}&group=${enc('言语理解与表达')}&sub=${enc('全部')}&n=15`, 15, 20));
test('行测·判断推理（材料模块）15-20 题', () => assertRange(`/api/practice?subject=${XC}&group=${enc('判断推理')}&sub=${enc('全部')}&n=15`, 15, 20));
test('行测·资料分析（材料模块）15-20 题', () => assertRange(`/api/practice?subject=${XC}&group=${enc('资料分析')}&sub=${enc('全部')}&n=15`, 15, 20));
test('行测·言语子模块逻辑填空 15-20 题', () => assertRange(`/api/practice?subject=${XC}&group=${enc('言语理解与表达')}&sub=${enc('逻辑填空')}&n=15`, 15, 20));
test('行测·数量关系（非材料模块）固定 15 题', () => assertExact(`/api/practice?subject=${XC}&group=${enc('数量关系')}&sub=${enc('全部')}&n=15`, 15));
test('行测·常识判断（非材料模块）固定 15 题（不误判为材料模块）', () => assertExact(`/api/practice?subject=${XC}&group=${enc('常识判断')}&sub=${enc('全部')}&n=15`, 15));
test('行测·政治理论（非材料模块）固定 15 题', () => assertExact(`/api/practice?subject=${XC}&group=${enc('政治理论')}&sub=${enc('全部')}&n=15`, 15));
test('行测·全科目随机固定 15 题', () => assertExact(`/api/practice?subject=${XC}&n=15`, 15));
test('行测·chapters 路径（材料模块）15-20 题', () => assertRange(`/api/practice?subject=${XC}&chapters=${enc('言语理解与表达,判断推理')}&n=15`, 15, 20));
test('行测·chapters 路径（非材料模块）固定 15 题', () => assertExact(`/api/practice?subject=${XC}&chapters=${enc('数学运算')}&n=15`, 15));
test('职测·言语理解与表达（材料模块）15-20 题', () => assertRange(`/api/practice?subject=${ZC}&group=${enc('言语理解与表达')}&sub=${enc('全部')}&n=15`, 15, 20));
test('职测·资料分析（材料模块）15-20 题', () => assertRange(`/api/practice?subject=${ZC}&group=${enc('资料分析')}&sub=${enc('全部')}&n=15`, 15, 20));
test('职测·全科目随机固定 15 题', () => assertExact(`/api/practice?subject=${ZC}&n=15`, 15));
test('申论·全科目随机固定 2 题', () => assertExact(`/api/practice?subject=${SL}&n=2`, 2));
test('申论·归纳概括题固定 2 题', () => assertExact(`/api/practice?subject=${SL}&group=${enc('归纳概括题')}&sub=${enc('全部')}&n=2`, 2));
test('申论·文章写作题固定 2 题', () => assertExact(`/api/practice?subject=${SL}&group=${enc('文章写作题')}&sub=${enc('全部')}&n=2`, 2));
test('综应·全科目随机固定 2 题', () => assertExact(`/api/practice?subject=${ZY}&n=2`, 2));
test('综应·A类应用文写作题固定 2 题', () => assertExact(`/api/practice?subject=${ZY}&group=${enc('A类·综合管理')}&sub=${enc('应用文写作题')}&n=2`, 2));
test('综应·A类归纳概括题固定 2 题', () => assertExact(`/api/practice?subject=${ZY}&group=${enc('A类·综合管理')}&sub=${enc('归纳概括题')}&n=2`, 2));
test('前端真实参数（mock=0）下数量规则仍生效', () => assertRange(`/api/practice?subject=${XC}&group=${enc('资料分析')}&sub=${enc('全部')}&mock=0&n=15`, 15, 20));

// ===== App 离线模式（lib/local-queries.mjs，与 server 同构实现）=====
test('离线·行测言语理解与表达（材料模块）15-20 题', () => {
  const db = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
  const engine = { get: (sql, ...p) => db.prepare(sql).get(...p), all: (sql, ...p) => db.prepare(sql).all(...p) };
  const api = createLocalApi(engine, engine, {});
  for (let i = 0; i < runs; i++) {
    const c = api.practice('公务员·行测', { group: '言语理解与表达', sub: '全部', n: 15 }).length;
    assert.ok(c >= 15 && c <= 20, `第${i + 1}次出 ${c} 题，期望 15-20`);
  }
  db.close();
});
test('离线·行测判断推理/资料分析（材料模块）15-20 题', () => {
  const db = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
  const engine = { get: (sql, ...p) => db.prepare(sql).get(...p), all: (sql, ...p) => db.prepare(sql).all(...p) };
  const api = createLocalApi(engine, engine, {});
  for (const group of ['判断推理', '资料分析']) {
    for (let i = 0; i < runs; i++) {
      const c = api.practice('公务员·行测', { group, sub: '全部', n: 15 }).length;
      assert.ok(c >= 15 && c <= 20, `${group} 第${i + 1}次出 ${c} 题，期望 15-20`);
    }
  }
  db.close();
});
test('离线·行测数量关系/常识判断（非材料模块）固定 15 题', () => {
  const db = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
  const engine = { get: (sql, ...p) => db.prepare(sql).get(...p), all: (sql, ...p) => db.prepare(sql).all(...p) };
  const api = createLocalApi(engine, engine, {});
  for (const group of ['数量关系', '常识判断']) {
    for (let i = 0; i < runs; i++) {
      const c = api.practice('公务员·行测', { group, sub: '全部', n: 15 }).length;
      assert.equal(c, 15, `${group} 第${i + 1}次出 ${c} 题，期望 15`);
    }
  }
  db.close();
});
test('离线·申论/综应固定 2 题', () => {
  const db = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
  const engine = { get: (sql, ...p) => db.prepare(sql).get(...p), all: (sql, ...p) => db.prepare(sql).all(...p) };
  const api = createLocalApi(engine, engine, {});
  for (let i = 0; i < runs; i++) {
    assert.equal(api.practice('公务员·申论', { group: '归纳概括题', sub: '全部', n: 2 }).length, 2, `申论第${i + 1}次`);
    assert.equal(api.practice('事业编·综应', { group: 'A类·综合管理', sub: '应用文写作题', n: 2 }).length, 2, `综应第${i + 1}次`);
  }
  db.close();
});
