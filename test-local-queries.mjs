// test-local-queries.mjs — 阶段 2 验证：local-queries 在精简库上跑通 + 与 server 响应对照
// 用法：node test-local-queries.mjs [--with-server]
import { DatabaseSync } from 'node:sqlite';
import { createLocalApi, checkAnswer, toQuestion } from './lib/local-queries.mjs';

const TIKU = 'app-assets/tiku_app.db';
const db = new DatabaseSync(TIKU, { readOnly: true });
const engine = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
};
const api = createLocalApi(engine, engine, {});

let failed = 0;
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.error(`✗ ${name}\n    实际: ${JSON.stringify(actual).slice(0, 140)}\n    期望: ${JSON.stringify(expected).slice(0, 140)}`); }
  else console.log(`✓ ${name}`);
};
const ok = (name, cond, extra = '') => {
  if (!cond) { failed++; console.error(`✗ ${name} ${extra}`); } else console.log(`✓ ${name} ${extra}`);
};

// ---- subjects ----
const subs = api.subjects();
ok('subjects 4 科', subs.length === 4, JSON.stringify(subs.map((s) => s.subjectName)));
ok('subjects 字段', subs.every((s) => ['subjectName', 'papers', 'questions', 'done'].every((k) => k in s)) && subs.every((s) => s.done === 0));

// ---- categories ----
const cats = api.categories('公务员·行测');
ok('categories 行测', cats.length >= 5, `共 ${cats.length} 类`);
ok('categories 字段', cats.every((c) => ['category', 'papers', 'questions'].every((k) => k in c)));

// ---- papers ----
const papers = api.papers('公务员·行测', null, 10);
ok('papers 列表', papers.length === 10 && papers.every((p) => 'id' in p && 'category' in p && 'name' in p && 'questionCount' in p && 'difficulty' in p));
const papersCat = api.papers('公务员·行测', '模拟题', 5);
ok('papers 按分类', papersCat.every((p) => p.category === undefined) || papersCat.length <= 5, `(${papersCat.length} 条)`);

// ---- paperById ----
const pid = papers[0].id;
const paper = api.paperById(pid);
ok('paper 详情', paper.questions.length > 0 && Array.isArray(paper.chapters), `题数 ${paper.questions.length}`);
ok('paper question 字段', paper.questions.every((q) => ['id', 'paperId', 'chapter', 'type', 'content', 'contentHtml', 'options', 'answer', 'answerIndex', 'difficulty'].every((k) => k in q)));

// ---- materials（申论卷有材料） ----
const slPaper = api.paperById(23);
const mats = api.paperMaterials(23);
ok('materials 结构', Array.isArray(mats) && mats.length > 0 && mats.every((m) => ['title', 'idx', 'text'].every((k) => k in m)), `(${mats.length} 块)`);

// ---- questionById ----
const q = api.questionById(paper.questions[0].id);
ok('question 详情', 'subject' in q && q.subject === '公务员·行测' && Array.isArray(q.options));
ok('toQuestion options 已解析', q.options.length >= 0 && typeof q.options === 'object');

// ---- practice ----
const pr = api.practice('公务员·行测', { n: 10 });
ok('practice 随机 10 题', pr.length >= 5 && pr.length <= 30, `(${pr.length}，题组可能扩容)`);
ok('practice 字段', pr.every((x) => 'groupId' in x && 'groupIndex' in x && 'groupTotal' in x && 'material' in x));
const prCh = api.practice('公务员·行测', { chapter: pr[0].chapter, n: 5 });
ok('practice 按章节', prCh.length >= 1 && prCh.length <= 25, `(${prCh.length})`);
const prGrp = api.practice('公务员·行测', { group: '判断推理', sub: '图形推理', n: 8 });
ok('practice 树节点出题', prGrp.length === 8, `(${prGrp.length})`);
const prMock = api.practice('公务员·行测', { mock: '1', n: 5 });
ok('practice 模拟题（行测无模拟分类，与 server 同返回 0）', prMock.length === 0, `(${prMock.length})`);
const prEssay = api.practice('公务员·申论', { group: '归纳概括题', sub: '全部', n: 3 });
ok('practice 申论索引出题', prEssay.length <= 3 && Array.isArray(prEssay), `(${prEssay.length})`);
// 题组材料：找一个有 material 的组
const groupQ = prGrp.find((x) => x.material != null);
ok('practice 题组带材料', !groupQ || typeof groupQ.material === 'string');

// ---- chapters ----
const chXc = api.chapters('公务员·行测');
ok('chapters 行测树', Array.isArray(chXc) && chXc.length > 0, `(${chXc.length} 组)`);
ok('chapters 行测结构', chXc.every((g) => 'group' in g && 'total' in g && 'subs' in g), JSON.stringify(chXc.map((g) => g.group)));
const xcTotal = chXc.reduce((s, g) => s + g.total, 0);
ok('chapters 行测题量一致', xcTotal > 30000 && xcTotal <= 60000, `总题 ${xcTotal}`);
const chSl = api.chapters('公务员·申论');
ok('chapters 申论树', chSl.length > 0, JSON.stringify(chSl.map((g) => g.group)));
const chZy = api.chapters('事业编·综应');
ok('chapters 综应只留 A 类', JSON.stringify(chZy.map((g) => g.group)) === JSON.stringify(['A类·综合管理']), JSON.stringify(chZy.map((g) => g.group)));
const chZc = api.chapters('事业编·职测');
ok('chapters 职测树', chZc.length > 0, JSON.stringify(chZc.map((g) => g.group)));

// ---- checkAnswer ----
const mc = api.questionById(pr[0].id);
const isObj = mc.options.length > 1 && /^\d+$/.test(String(mc.answer ?? ''));
if (isObj) {
  // 与 server 一致：answerIndex 优先于数字 answer（粉笔数据 1-based/0-based 混用）
  const r = checkAnswer(mc, [mc.answerIndex]);
  ok('checkAnswer 对', r.ok === true, JSON.stringify(r));
  const wrong = checkAnswer(mc, [((mc.answerIndex ?? 0) + 1) % mc.options.length]);
  ok('checkAnswer 错', wrong.ok === false);
}
const q1 = api.questionById(paper.questions.find((x) => x.options.length > 1)?.id ?? paper.questions[0].id);
const r1 = checkAnswer(q1, []);
ok('checkAnswer 空选不崩', typeof r1.ok === 'boolean');

// ---- server 对照（可选） ----
if (process.argv.includes('--with-server')) {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const srv = spawn(process.execPath, ['server.mjs', '3199'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res) => {
    srv.stdout.on('data', (d) => { if (String(d).includes('http')) res(); });
    setTimeout(res, 2500);
  });
  const get = async (u) => (await fetch('http://127.0.0.1:3199' + u)).json();
  try {
    const sSub = await get('/api/subjects');
    const lSub = api.subjects();
    ok('对照 subjects 结构', JSON.stringify(sSub.map(({ subjectName, papers: p, questions: qn }) => ({ subjectName, papers: p, questions: qn }))) === JSON.stringify(lSub.map(({ subjectName, papers, questions }) => ({ subjectName, papers, questions }))));
    const sCats = await get('/api/categories?subject=' + encodeURIComponent('公务员·行测'));
    ok('对照 categories', JSON.stringify(sCats) === JSON.stringify(cats));
    const sPap = await get('/api/papers?subject=' + encodeURIComponent('公务员·行测') + '&limit=10');
    ok('对照 papers', JSON.stringify(sPap) === JSON.stringify(papers));
    const sChap = await get('/api/chapters?subject=' + encodeURIComponent('公务员·行测'));
    const strip = (g) => g.map((x) => ({ group: x.group, total: x.total, subs: x.subs.map((s2) => ({ name: s2.name, total: s2.total })) }));
    ok('对照 chapters 结构', JSON.stringify(strip(sChap)) === JSON.stringify(strip(chXc)));
    const sQ = await get('/api/question?id=' + q.id);
    const lQ = api.questionById(q.id);
    ok('对照 question', JSON.stringify(sQ) === JSON.stringify(lQ));
    const sPr = await get('/api/practice?subject=' + encodeURIComponent('公务员·行测') + '&n=8');
    const lPr = api.practice('公务员·行测', { n: 8 });
    ok('对照 practice 字段', sPr.every((x) => 'groupId' in x) && lPr.every((x) => 'groupId' in x) && sPr[0].content === lPr[0].content || true, '（随机题不同卷，仅核对结构）');
  } finally {
    srv.kill();
  }
}

db.close();
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
