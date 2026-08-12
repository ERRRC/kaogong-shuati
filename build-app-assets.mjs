/**
 * build-app-assets.mjs — 阶段 1：题库离线化打包脚本
 *
 * 输入（只读）：
 *   tiku.db      — 题库（papers / questions）
 *   practice.db  — 只读辅助表：question_categories / q_materials / q_material_map（章节树、题组）
 *   materials.db — 申论材料分块 materials
 * 输出 app-assets/：
 *   tiku_app.db       — 精简列 + 辅助表合并后的只读 SQLite（供 local-api.js 查询）
 *   tiku_app.db.gz    — gzip 压缩包（打进 APK，首启解压）
 *   images.db         — 公式图（img_key → blob），键为 formulas?latex= 参数
 *   images.db.gz
 *   report.json       — 体积 / 行数 / 验证结果
 *
 * 用法：
 *   node build-app-assets.mjs [输出目录] [--skip-download] [--max-downloads N]
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const ROOT = process.cwd();
const OUT_DIR = path.resolve(ROOT, process.argv[2] || 'app-assets');
const SKIP_DOWNLOAD = process.argv.includes('--skip-download');
const MAX_DOWNLOADS = Number(process.argv.find((a) => a.startsWith('--max-downloads='))?.split('=')[1] || Infinity);

const DB_FILES = {
  tiku: path.join(ROOT, 'tiku.db'),
  practice: path.join(ROOT, 'practice.db'),
  materials: path.join(ROOT, 'materials.db'),
};
for (const [k, f] of Object.entries(DB_FILES)) {
  if (!fs.existsSync(f)) { console.error(`✗ 缺少 ${k} 库: ${f}`); process.exit(1); }
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// ============ 1. 构建精简题库库 ============
console.log('① 构建精简题库 tiku_app.db …');
const out = path.join(OUT_DIR, 'tiku_app.db');
if (fs.existsSync(out)) fs.unlinkSync(out);
const db = new DatabaseSync(out);
db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
db.exec(`ATTACH DATABASE ${JSON.stringify(DB_FILES.tiku)} AS tiku`);
db.exec(`ATTACH DATABASE ${JSON.stringify(DB_FILES.practice)} AS practice`);
db.exec(`ATTACH DATABASE ${JSON.stringify(DB_FILES.materials)} AS materials`);

// papers：去掉前端/查询不用的 exerciseId、crawledAt、time
db.exec(`
  CREATE TABLE papers (
    id INTEGER PRIMARY KEY,
    subject TEXT NOT NULL,
    subjectName TEXT NOT NULL,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    questionCount INTEGER,
    difficulty REAL,
    chapters TEXT
  );
  INSERT INTO papers (id, subject, subjectName, category, name, questionCount, difficulty, chapters)
    SELECT id, subject, subjectName, category, name, questionCount, difficulty, chapters FROM tiku.papers;
  CREATE INDEX idx_papers_subject ON papers(subjectName, category);
`);
// questions：去掉全空列 source/analysis/analysisHtml 与前端不用的 questionType/optionType/material/hasVideo
db.exec(`
  CREATE TABLE questions (
    id INTEGER PRIMARY KEY,
    questionId INTEGER NOT NULL,
    paperId INTEGER NOT NULL,
    chapter TEXT,
    type INTEGER,
    content TEXT NOT NULL,
    contentHtml TEXT,
    options TEXT,
    answer TEXT,
    answerIndex INTEGER,
    difficulty INTEGER
  );
  INSERT INTO questions (id, questionId, paperId, chapter, type, content, contentHtml, options, answer, answerIndex, difficulty)
    SELECT id, questionId, paperId, chapter, type, content, contentHtml, options, answer, answerIndex, difficulty FROM tiku.questions;
  CREATE INDEX idx_questions_qid ON questions(questionId);
  CREATE INDEX idx_questions_paper ON questions(paperId);
  CREATE INDEX idx_questions_chapter ON questions(chapter);
`);
// 只读辅助表：章节树分类索引 / 题组映射 / 题组材料（原 practice.db）
db.exec(`
  CREATE TABLE question_categories (question_id INTEGER, subject TEXT, category TEXT, sub TEXT);
  INSERT INTO question_categories SELECT question_id, subject, category, sub FROM practice.question_categories;
  CREATE INDEX idx_qc_subject ON question_categories(subject, category, sub);
  CREATE INDEX idx_qc_qid ON question_categories(question_id);

  CREATE TABLE q_materials (material_id INTEGER, subject TEXT, content TEXT);
  INSERT INTO q_materials SELECT material_id, subject, content FROM practice.q_materials;
  CREATE INDEX idx_qm ON q_materials(subject, material_id);

  CREATE TABLE q_material_map (question_id INTEGER, subject TEXT, material_id INTEGER);
  INSERT INTO q_material_map SELECT question_id, subject, material_id FROM practice.q_material_map;
  CREATE INDEX idx_qmm_qid ON q_material_map(subject, question_id);
  CREATE INDEX idx_qmm_mid ON q_material_map(subject, material_id);
`);
// 申论材料分块（原 materials.db；去掉本地 pdf 路径列）
db.exec(`
  CREATE TABLE materials (paperId INTEGER, title TEXT, idx INTEGER, text TEXT);
  INSERT INTO materials SELECT paperId, title, idx, text FROM materials.materials;
  CREATE INDEX idx_mat_paper ON materials(paperId);
`);
db.exec('DETACH tiku; DETACH practice; DETACH materials;');
db.exec('VACUUM;');
db.close();

// ============ 2. gzip 压缩 ============
console.log('② gzip 压缩 …');
function gzipFile(src) {
  const buf = zlib.gzipSync(fs.readFileSync(src), { level: 9 });
  fs.writeFileSync(src + '.gz', buf);
}
gzipFile(out);

// ============ 3. 公式图下载 → images.db ============
const imagesDbPath = path.join(OUT_DIR, 'images.db');
const imgDb = new DatabaseSync(imagesDbPath);
imgDb.exec('CREATE TABLE IF NOT EXISTS images (key TEXT PRIMARY KEY, mime TEXT, blob BLOB);');

// 3.1 收集全部图片 URL（contentHtml 中 <img src>）
const tdb = new DatabaseSync(out, { readOnly: true });
const rows = tdb.prepare(`SELECT contentHtml FROM questions WHERE contentHtml LIKE '%<img%'`).all();
const formulaKeys = new Set();
const realImageUrls = new Set();
for (const r of rows) {
  for (const m of (r.contentHtml || '').matchAll(/src="([^"]+)"/g)) {
    const u = m[1];
    const fm = u.match(/formulas\?latex=([^&"']+)/);
    if (fm) formulaKeys.add(decodeURIComponent(fm[1]));
    else realImageUrls.add(u);
  }
}
console.log(`   公式图 ${formulaKeys.size} 张 / 真图形 ${realImageUrls.size} 个 URL`);

// 3.2 断点续传：跳过已下载的 key
const existing = new Set(imgDb.prepare('SELECT key FROM images').all().map((r) => r.key));
const todo = [...formulaKeys].filter((k) => !existing.has(k));
if (SKIP_DOWNLOAD) {
  console.log(`   --skip-download：跳过下载（已有 ${existing.size}，待下 ${todo.length}）`);
} else {
  const limit = Math.min(todo.length, MAX_DOWNLOADS);
  console.log(`   开始下载 ${limit} 张公式图（并发 20，失败自动重试 2 次）…`);
  const failLog = path.join(OUT_DIR, 'download-fail.log');
  const fails = fs.existsSync(failLog) ? fs.readFileSync(failLog, 'utf8').split('\n').filter(Boolean) : [];
  const failSet = new Set(fails);
  let done = 0, okCount = 0;
  const CONCURRENCY = 20;

  function download(key) {
    return new Promise((resolve) => {
      const url = `https://fb.fbstatic.cn/api/planet/accessories/formulas?latex=${encodeURIComponent(key)}`;
      const attempt = (left) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://tiku.fenbi.com/' } }, (res) => {
          if (res.statusCode !== 200) { res.resume(); return finish(left, `HTTP ${res.statusCode}`); }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (buf.length > 200 * 1024) return finish(left, '超限');
            imgDb.prepare('INSERT OR REPLACE INTO images (key, mime, blob) VALUES (?, ?, ?)')
              .run(key, res.headers['content-type'] || 'image/png', buf);
            finish(0);
          });
          res.on('error', () => finish(left, 'net'));
        });
        req.on('error', () => finish(left, 'net'));
        req.setTimeout(15000, () => { req.destroy(); finish(left, 'timeout'); });
        function finish(left2, reason) {
          if (!left2) { done++; okCount++; resolve(); }
          else if (left2 > 1) attempt(left2 - 1);
          else { done++; fails.push(key); resolve(); }
        }
      };
      attempt(3);
    });
  }
  const queue = [...todo].slice(0, limit);
  await (async () => {
    let i = 0;
    async function worker() {
      while (i < queue.length) {
        const k = queue[i++];
        await download(k);
        if (done % 200 === 0 || done === queue.length) {
          process.stdout.write(`\r   进度 ${done}/${queue.length}（成功 ${okCount}，失败 ${fails.length}）`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  })();
  process.stdout.write('\n');
  // 失败重试一轮（慢速网络场景）
  if (fails.length) {
    const retry = [...fails];
    fails.length = 0;
    const todo2 = retry.filter((k) => !imgDb.prepare('SELECT 1 FROM images WHERE key = ?').get(k));
    console.log(`   第一轮失败 ${todo2.length} 张，重试…`);
    for (const k of todo2) await download(k);
  }
  fs.writeFileSync(failLog, fails.join('\n'));
  console.log(`   下载完成：成功 ${imgDb.prepare('SELECT COUNT(*) c FROM images').get().c} 张，失败 ${fails.length} 张（详见 ${path.basename(failLog)}）`);
}
imgDb.exec('VACUUM;');
imgDb.close();
tdb.close();
gzipFile(imagesDbPath);

// ============ 4. 验证：关键查询 SQL 跑通 ============
console.log('④ 验证关键查询 …');
const vdb = new DatabaseSync(out, { readOnly: true });
const results = {};
// 4.1 随机出题（与 server randomQuestions 同构）
const subjects = vdb.prepare("SELECT DISTINCT subjectName FROM papers").all().map((r) => r.subjectName);
results.subjects = subjects;
const subject = subjects[0];
const t0 = Date.now();
const rand = vdb.prepare(`
  SELECT q.questionId, q.paperId, q.chapter, q.type, q.content, q.contentHtml, q.options, q.answer, q.answerIndex, q.difficulty
  FROM questions q JOIN papers p ON p.id = q.paperId
  WHERE p.subjectName = ? ORDER BY RANDOM() LIMIT 10
`).all(subject);
results.randomQuestions = { subject, count: rand.length, ms: Date.now() - t0 };
// 4.2 单题
const one = vdb.prepare('SELECT questionId, content FROM questions WHERE questionId = ? LIMIT 1').get(rand[0]?.questionId);
results.singleQuestion = !!one;
// 4.3 章节树（question_categories 分组，与 /api/chapters 同构）
const t1 = Date.now();
const tree = vdb.prepare(`
  SELECT qc.category, qc.sub, COUNT(*) c FROM question_categories qc
  WHERE qc.subject = ? AND EXISTS (SELECT 1 FROM questions q WHERE q.questionId = qc.question_id)
  GROUP BY qc.category, qc.sub
`).all(subject);
results.chapterTree = { groups: tree.length, ms: Date.now() - t1 };
// 4.4 题组（enrichGroups 同构）
const t2 = Date.now();
const mapRows = vdb.prepare(`
  SELECT question_id, material_id FROM q_material_map WHERE subject = ? AND question_id IN (${rand.map(() => '?').join(',')})
`).all(subject, ...rand.map((r) => r.questionId));
results.materialMap = { matched: mapRows.filter((m) => m.material_id != null).length, ms: Date.now() - t2 };
// 4.5 材料
const mat = vdb.prepare('SELECT COUNT(*) c FROM materials').get().c;
results.materials = mat;
// 4.6 试卷详情
const paper = vdb.prepare('SELECT id FROM papers LIMIT 1').get();
const paperQ = vdb.prepare('SELECT COUNT(*) c FROM questions WHERE paperId = ?').get(paper.id);
results.paperDetail = { paperId: paper.id, questions: paperQ.c };
vdb.close();

// ============ 5. 体积报告 ============
console.log('⑤ 体积报告 …');
const size = (f) => { const s = fs.statSync(f).size; return { bytes: s, mb: +(s / 1048576).toFixed(2) }; };
const report = {
  builtAt: new Date().toISOString(),
  images: { formulas: formulaKeys.size, realImages: realImageUrls.size, downloaded: imgDbCount(imagesDbPath) },
  files: {},
};
function imgDbCount(p) {
  try { const d = new DatabaseSync(p, { readOnly: true }); const c = d.prepare('SELECT COUNT(*) c FROM images').get().c; d.close(); return c; } catch { return 0; }
}
for (const f of ['tiku_app.db', 'tiku_app.db.gz', 'images.db', 'images.db.gz']) {
  const p = path.join(OUT_DIR, f);
  if (fs.existsSync(p)) report.files[f] = size(p);
}
// 行数统计
const rdb = new DatabaseSync(out, { readOnly: true });
report.rows = {};
for (const t of ['papers', 'questions', 'question_categories', 'q_materials', 'q_material_map', 'materials']) {
  report.rows[t] = rdb.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
}
rdb.close();
report.verification = results;
report.totalMb = +(Object.values(report.files).reduce((s, f) => s + f.mb, 0)).toFixed(2);
fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

console.log('\n════════ 打包完成 ════════');
console.log(`输出目录: ${OUT_DIR}`);
for (const [f, s] of Object.entries(report.files)) console.log(`  ${f.padEnd(16)} ${String(s.mb).padStart(8)} MB`);
console.log(`资源合计: ${report.totalMb} MB（目标 ≤60MB）`);
console.log(`验证: 随机出题 ${report.verification.randomQuestions.count} 题 / 单题 ${report.verification.singleQuestion} / 章节组 ${report.verification.chapterTree.groups} / 材料 ${report.verification.materials} 块`);
if (imgDbCount(imagesDbPath) < formulaKeys.size) {
  console.warn(`⚠ 公式图未全部下载成功（${imgDbCount(imagesDbPath)}/${formulaKeys.size}），请重跑本脚本续传`);
  process.exitCode = 2;
}
