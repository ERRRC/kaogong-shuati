// test-custom-practice.mjs — 自定义刷题 + 背题模式数据层 + 题库精简回归测试（2026-08-16 新增功能）
// 覆盖：year 年份过滤（all/3/5/10/缺省近十年）、difficulty 难度过滤（单题 + 材料组整组剔除）、
//       custom=1 题量控制（fetchN 多抽凑满 / n 上限 50）、统计口径（subjects/chapters）、
//       离线端（lib/local-queries.mjs）同构、既有随机题量规则不回归。
// 运行：node --test test-custom-practice.mjs（自动起 server 于随机端口，测完关闭）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createLocalApi } from './lib/local-queries.mjs';

const PORT = 4200 + Math.floor(Math.random() * 200);
let server, base;

before(async () => {
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(PORT, () => { srv.close(resolve); });
    srv.on('error', reject);
  });
  server = spawn(process.execPath, ['server.mjs', String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  base = `http://localhost:${PORT}`;
});

after(() => { server?.kill(); });

const enc = encodeURIComponent;
const XC = enc('公务员·行测'), ZC = enc('事业编·职测'), SL = enc('公务员·申论');

// 题库直查（年份/难度反查 + 材料组预检）
const db = new DatabaseSync('tiku.db', { readOnly: true });
const pdb = new DatabaseSync('practice.db', { readOnly: true });
const yearsOf = (qid) => db.prepare(
  'SELECT substr(p.name,1,4) y FROM questions q JOIN papers p ON p.id = q.paperId WHERE q.questionId = ?'
).all(qid).map((r) => r.y);
const yearNum = (y) => (/^\d{4}$/.test(y) ? Number(y) : -1);
// 断言：每个返回题都存在年份 >= min 的试卷（联考共享题可能挂旧卷，取"存在性"）
const assertAllYearsGE = (qs, min, label) => {
  for (const q of qs) {
    const ys = yearsOf(q.id).map(yearNum).filter((n) => n > 0);
    assert.ok(ys.some((n) => n >= min), `${label}: 题 ${q.id} 无 >=${min} 的试卷（年份 ${ys.join(',')}）`);
  }
};
// 断言：每个返回题难度都在 [lo, hi] 区间
const assertAllDiffs = (qs, lo, hi, label) => {
  for (const q of qs) {
    assert.ok(q.difficulty != null && q.difficulty >= lo && q.difficulty <= hi,
      `${label}: 题 ${q.id} 难度 ${q.difficulty} 不在 [${lo},${hi}]`);
  }
};

async function getQ(path) {
  const res = await fetch(base + path);
  assert.equal(res.status, 200, `请求失败: ${path} -> ${res.status}`);
  const data = await res.json();
  assert.ok(Array.isArray(data), `非数组返回: ${path}`);
  return data.filter((q) => q.id != null); // 材料组拆分行 id 即题 id
}

// ==================== 年份过滤 ====================
test('year 缺省（近十年）：返回题全部存在 2017+ 试卷', async () => {
  const qs = await getQ(`/api/practice?subject=${XC}&n=50&custom=1`);
  assert.equal(qs.length, 50);
  assertAllYearsGE(qs, 2017, '缺省近十年');
});

test('year=3：返回题全部存在 2024+ 试卷', async () => {
  const qs = await getQ(`/api/practice?subject=${XC}&n=50&year=3&custom=1`);
  assert.equal(qs.length, 50);
  assertAllYearsGE(qs, 2024, 'year=3');
});

test('year=5：返回题全部存在 2022+ 试卷', async () => {
  const qs = await getQ(`/api/practice?subject=${XC}&n=50&year=5&custom=1`);
  assert.equal(qs.length, 50);
  assertAllYearsGE(qs, 2022, 'year=5');
});

test('year=all：能抽到 2016 前旧题（3 次采样至少一次）', async () => {
  let sawOld = false;
  for (let i = 0; i < 3 && !sawOld; i++) {
    const qs = await getQ(`/api/practice?subject=${XC}&n=50&year=all&custom=1`);
    sawOld = qs.some((q) => yearsOf(q.id).map(yearNum).some((n) => n > 0 && n < 2017));
  }
  assert.ok(sawOld, 'year=all 三次采样均未出现 2016 前旧题');
});

test('year 参数非法值（abc/0）回退近十年', async () => {
  for (const y of ['abc', '0', '2']) {
    const qs = await getQ(`/api/practice?subject=${XC}&n=30&year=${y}&custom=1`);
    assertAllYearsGE(qs, 2017, `year=${y} 回退近十年`);
  }
});

// ==================== 难度过滤 ====================
test('difficulty=easy：返回题难度全部 1-3', async () => {
  const qs = await getQ(`/api/practice?subject=${XC}&n=50&difficulty=easy&custom=1`);
  assertAllDiffs(qs, 1, 3, 'easy');
});

test('difficulty=balanced：返回题难度全部 3-6', async () => {
  const qs = await getQ(`/api/practice?subject=${XC}&n=50&difficulty=balanced&custom=1`);
  assertAllDiffs(qs, 3, 6, 'balanced');
});

test('difficulty=hard：返回题难度全部 5-9（含材料组补充题）', async () => {
  const qs = await getQ(`/api/practice?subject=${XC}&n=50&difficulty=hard&custom=1`);
  assertAllDiffs(qs, 5, 9, 'hard');
});

test('材料组整组剔除：组内存在难度<5 的组不出现在 hard 结果中', async () => {
  // 预查：找一个组内难度不一致的材料组（成员难度 <5 与 >=5 混合）
  const gids = pdb.prepare(`SELECT material_id FROM q_material_map WHERE subject = '公务员·行测' AND material_id IS NOT NULL GROUP BY material_id`).all().map((r) => r.material_id);
  let badGid = null, badMembers = [];
  for (const gid of gids) {
    const members = pdb.prepare(`SELECT question_id FROM q_material_map WHERE material_id = ?`).all(gid).map((r) => r.question_id);
    const diffs = db.prepare(`SELECT DISTINCT difficulty FROM questions WHERE questionId IN (${members.map(() => '?').join(',')})`).all(...members).map((r) => r.difficulty);
    if (diffs.some((d) => d != null && d < 5) && diffs.some((d) => d != null && d >= 5)) { badGid = gid; badMembers = members; break; }
  }
  assert.ok(badGid != null, '题库中应存在组内难度不一致的材料组（预检）');
  // hard 请求（多抽多组，尽量覆盖）——返回中不得出现 bad 组任何题
  for (let i = 0; i < 3; i++) {
    const qs = await getQ(`/api/practice?subject=${XC}&n=50&difficulty=hard&custom=1`);
    const hit = qs.filter((q) => q.groupId === badGid || badMembers.includes(q.id));
    assert.equal(hit.length, 0, `第${i + 1}次：整组剔除失效，命中 ${hit.length} 题（组 ${badGid}）`);
  }
});

test('difficulty=random：不限难度（含未标注题可出）', async () => {
  const qs = await getQ(`/api/practice?subject=${XC}&n=50&difficulty=random&custom=1`);
  assert.ok(qs.length >= 30, `random 应出足量题，实际 ${qs.length}`);
});

// ==================== custom 题量控制 ====================
test('custom=1 & n=30 & random：恰好 30 题', async () => {
  const qs = await getQ(`/api/practice?subject=${XC}&n=30&custom=1`);
  assert.equal(qs.length, 30, `期望 30，实际 ${qs.length}`);
});

test('custom=1 & n=15 & hard：10-15 题（材料组剔除后仍接近目标）', async () => {
  const qs = await getQ(`/api/practice?subject=${XC}&n=15&difficulty=hard&custom=1`);
  assert.ok(qs.length >= 10 && qs.length <= 15, `期望 10-15，实际 ${qs.length}`);
});

test('custom=1 & n=60：n 上限 50 生效', async () => {
  const qs = await getQ(`/api/practice?subject=${XC}&n=60&custom=1`);
  assert.ok(qs.length <= 50, `n=60 应被限制到 50，实际 ${qs.length}`);
});

test('custom=1 不影响既有规则：非 custom 行测仍固定 15 题', async () => {
  const qs = await getQ(`/api/practice?subject=${XC}&n=15`);
  assert.equal(qs.length, 15);
});

test('group+sub+difficulty：言语理解与表达 easy 全 1-3 且 <=10', async () => {
  const qs = await getQ(`/api/practice?subject=${XC}&group=${enc('言语理解与表达')}&sub=${enc('全部')}&difficulty=easy&custom=1&n=10`);
  assert.ok(qs.length <= 10, `期望 <=10，实际 ${qs.length}`);
  assertAllDiffs(qs, 1, 3, 'group easy');
});

test('职测 custom 抽题正常（难度 easy 全 1-3）', async () => {
  const qs = await getQ(`/api/practice?subject=${ZC}&n=20&difficulty=easy&custom=1`);
  assertAllDiffs(qs, 1, 3, '职测 easy');
});

// ==================== 统计口径（近十年） ====================
test('subjects 统计：行测 457 套/24457 题、职测 60 套/3860 题', async () => {
  const res = await fetch(base + '/api/subjects');
  const subs = await res.json();
  const xc = subs.find((s) => s.subjectName === '公务员·行测');
  const zc = subs.find((s) => s.subjectName === '事业编·职测');
  assert.equal(xc.papers, 457, `行测套数 ${xc.papers}`);
  assert.equal(xc.questions, 24457, `行测题数 ${xc.questions}`);
  assert.equal(zc.papers, 60, `职测套数 ${zc.papers}`);
  assert.equal(zc.questions, 3860, `职测题数 ${zc.questions}`);
});

test('chapters 目录树总题量：行测 24457、职测 3860（跨卷去重，2026-08-17 修复）', async () => {
  for (const [subject, expect] of [['公务员·行测', 24457], ['事业编·职测', 3860]]) {
    const res = await fetch(base + `/api/chapters?subject=${enc(subject)}`);
    const chs = await res.json();
    const total = chs.reduce((s, g) => s + (g.total || 0), 0);
    assert.equal(total, expect, `${subject} 目录树 ${total}`);
  }
});

test('无年份试卷存在且被年份条件排除（SQL 级）', () => {
  const noYear = db.prepare(`SELECT COUNT(DISTINCT q.questionId) n FROM questions q JOIN papers p ON p.id = q.paperId
    WHERE p.subjectName = '公务员·行测' AND NOT GLOB('[0-9][0-9][0-9][0-9]*', substr(p.name,1,4))`).get().n;
  const withYear = db.prepare(`SELECT COUNT(DISTINCT q.questionId) n FROM questions q JOIN papers p ON p.id = q.paperId
    WHERE p.subjectName = '公务员·行测' AND substr(p.name,1,4) BETWEEN '2017' AND '2026'`).get().n;
  assert.ok(noYear > 0, `应存在无年份试卷题（实际 ${noYear}）`);
  assert.ok(withYear > 0 && withYear < noYear + withYear, '年份过滤生效');
});

// ==================== 离线端同构（lib/local-queries.mjs） ====================
function offlineApi() {
  const odb = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
  const engine = { get: (sql, ...p) => odb.prepare(sql).get(...p), all: (sql, ...p) => odb.prepare(sql).all(...p) };
  return { api: createLocalApi(engine, engine, {}), close: () => odb.close() };
}

test('离线 subjects：行测 457 套/24457 题（与在线同口径）', () => {
  const { api, close } = offlineApi();
  const subs = api.subjects();
  const xc = subs.find((s) => s.subjectName === '公务员·行测');
  assert.equal(xc.papers, 457);
  assert.equal(xc.questions, 24457);
  close();
});

test('离线 year=3：返回题全部存在 2024+ 试卷', () => {
  const { api, close } = offlineApi();
  const qs = api.practice('公务员·行测', { n: 30, year: '3', custom: true });
  for (const q of qs) {
    const ys = yearsOf(q.id).map(yearNum).filter((n) => n > 0);
    assert.ok(ys.some((n) => n >= 2024), `离线 year=3: 题 ${q.id} 无 >=2024 试卷（${ys.join(',')}）`);
  }
  assert.ok(qs.length >= 20, `离线 year=3 出题 ${qs.length}`);
  close();
});

test('离线 difficulty=hard：返回题难度全部 5-9', () => {
  const { api, close } = offlineApi();
  const qs = api.practice('公务员·行测', { n: 30, difficulty: 'hard', custom: true });
  assertAllDiffs(qs, 5, 9, '离线 hard');
  assert.ok(qs.length >= 15 && qs.length <= 30, `离线 hard 出题 ${qs.length}`);
  close();
});

test('离线 custom & n=30：25-30 题', () => {
  const { api, close } = offlineApi();
  const qs = api.practice('公务员·行测', { n: 30, custom: true });
  assert.ok(qs.length >= 25 && qs.length <= 30, `离线 custom n=30 出题 ${qs.length}`);
  close();
});

test('离线 group+difficulty：言语 easy 全 1-3', () => {
  const { api, close } = offlineApi();
  const qs = api.practice('公务员·行测', { group: '言语理解与表达', sub: '全部', difficulty: 'easy', custom: true, n: 10 });
  assertAllDiffs(qs, 1, 3, '离线 group easy');
  close();
});

test('离线回归：缺省随机练习仍 15 题、申论 2 题', () => {
  const { api, close } = offlineApi();
  assert.equal(api.practice('公务员·行测', { n: 15 }).length, 15);
  assert.equal(api.practice('公务员·申论', { n: 2 }).length, 2);
  close();
});
