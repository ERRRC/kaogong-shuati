// 原生桥适配层测试：mock window.NativeDB（与 NativeDbBridge.java 返回格式一致）
//   - open 成功/失败
//   - get 命中/未命中/错误
//   - all 多行
//   - blob 列 {"__b64":...} → Uint8Array（与 sql.js getAsObject 一致）
//   - 参数规范化（null 保留）
import test from 'node:test';
import assert from 'node:assert';

// 模拟浏览器环境
globalThis.window = globalThis;
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

// 简单 SQLite 模拟（用 node:sqlite 真库，保证 SQL 行为一致）
import { DatabaseSync } from 'node:sqlite';
const mem = new DatabaseSync(':memory:');
mem.exec(`CREATE TABLE questions (id INTEGER PRIMARY KEY, questionId INTEGER, content TEXT, answer TEXT);
CREATE TABLE images (key TEXT, mime TEXT, blob BLOB);
INSERT INTO questions VALUES (1, 101, '题干A', 'A'), (2, 101, '题干A2', 'B');
INSERT INTO images VALUES ('k1', 'image/png', x'89504E470D0A1A0A')`);

function toJsonParams(arr) {
  return arr == null ? null : JSON.stringify(arr.map((p) => (p == null ? null : p)));
}
function colValue(v) {
  if (v == null) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Uint8Array) return { __b64: Buffer.from(v).toString('base64') };
  return v;
}
const mockNativeDB = {
  openCalls: 0,
  open() { this.openCalls++; return 'ok'; },
  get(sql, paramsJson) {
    const params = paramsJson == null ? [] : JSON.parse(paramsJson);
    const row = mem.prepare(sql).get(...params);
    if (row === undefined) return 'null';
    return JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, colValue(v)])));
  },
  all(sql, paramsJson) {
    const params = paramsJson == null ? [] : JSON.parse(paramsJson);
    const rows = mem.prepare(sql).all(...params);
    return JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, colValue(v)]))));
  },
};
window.NativeDB = mockNativeDB;

const { loadNativeEngine } = await import('./public/sqljs-engine.js');

test('原生桥：open 成功并返回引擎', () => {
  const engine = loadNativeEngine();
  assert.ok(engine.get && engine.all && engine.close, '引擎接口齐全');
  assert.strictEqual(mockNativeDB.openCalls, 1, 'open 只调用一次');
});

test('原生桥：get 命中/未命中', () => {
  const engine = loadNativeEngine();
  const hit = engine.get('SELECT questionId, content, answer FROM questions WHERE questionId = ?', 101);
  assert.strictEqual(hit.questionId, 101, '命中行 questionId');
  assert.strictEqual(hit.answer, 'A', 'ORDER BY id 后取第一条');
  const miss = engine.get('SELECT * FROM questions WHERE questionId = ?', 999);
  assert.strictEqual(miss, undefined, '未命中返回 undefined（与 sql.js 一致）');
});

test('原生桥：all 多行 + ORDER BY id', () => {
  const engine = loadNativeEngine();
  const rows = engine.all('SELECT questionId FROM questions WHERE questionId = ? ORDER BY id', 101);
  assert.strictEqual(rows.length, 2, '两行都返回');
  assert.strictEqual(rows[0].questionId, 101);
});

test('原生桥：blob 列还原为 Uint8Array（公式图）', () => {
  const engine = loadNativeEngine();
  const img = engine.get('SELECT key, mime, blob FROM images WHERE key = ?', 'k1');
  assert.ok(img && img.blob instanceof Uint8Array, 'blob 应为 Uint8Array');
  assert.strictEqual(Buffer.from(img.blob).toString('hex'), '89504e470d0a1a0a', 'b64 解码内容正确');
  assert.strictEqual(img.mime, 'image/png');
});

test('原生桥：错误返回抛异常', () => {
  mockNativeDB.get = () => '{"__error":"no such table: xyz"}';
  const engine = loadNativeEngine();
  assert.throws(() => engine.get('SELECT * FROM xyz'), /no such table/, '错误应抛异常');
  mockNativeDB.get = (sql, p) => {
    const params = p == null ? [] : JSON.parse(p);
    const row = mem.prepare(sql).get(...params);
    return row === undefined ? 'null' : JSON.stringify(row);
  };
});

test('原生桥：参数 null 透传', () => {
  const engine = loadNativeEngine();
  // paperId 可为 null：SQL 参数化传 null 不应报错
  const r = engine.get('SELECT COUNT(*) AS c FROM questions WHERE answer = ?', null);
  assert.strictEqual(r.c, 0, 'null 参数查询不报错');
});
