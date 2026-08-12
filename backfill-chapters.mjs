import { DatabaseSync } from 'node:sqlite';

/**
 * 回填 questions.chapter：利用 papers.chapters 的 questionCount 顺序分段。
 * 原理：crawl-all.js 按 sheet.questionIds 顺序拉题，questions 插入顺序 = 题目顺序；
 *       chapters[i].questionCount 表示该章节题数，累计即分段边界。
 * 零网络请求，纯本地更新。
 */
const db = new DatabaseSync('tiku.db');

const papers = db.prepare('SELECT id, chapters FROM papers WHERE chapters IS NOT NULL AND chapters != \'\'').all();
let updated = 0, unmatched = 0;

for (const paper of papers) {
  let chapters;
  try {
    chapters = JSON.parse(paper.chapters);
  } catch { continue; }
  if (!Array.isArray(chapters) || !chapters.length) continue;

  const qs = db.prepare('SELECT id FROM questions WHERE paperId = ? ORDER BY id ASC').all(paper.id);
  if (!qs.length) continue;

  // 分段边界
  const bounds = [];
  let offset = 0;
  for (const ch of chapters) {
    const n = Number(ch.questionCount) || 0;
    bounds.push({ name: ch.name ?? '', start: offset, end: offset + n });
    offset += n;
  }
  if (offset !== qs.length) {
    // 章节计数与题目数不一致：按比例近似或放弃（保留未匹配）
    unmatched++;
    continue;
  }

  const upd = db.prepare('UPDATE questions SET chapter = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (let i = 0; i < qs.length; i++) {
      const b = bounds.find((x) => i >= x.start && i < x.end);
      if (!b) continue;
      if (b.name) {
        upd.run(b.name, qs[i].id);
        updated++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

console.log(`回填完成：更新 ${updated} 题章节名 | 计数不匹配跳过 ${unmatched} 套`);

const stats = db.prepare(
  "SELECT p.subjectName, COUNT(DISTINCT CASE WHEN q.chapter != '' THEN q.paperId END) AS paperWithChapter, COUNT(*) AS questions, SUM(CASE WHEN q.chapter != '' THEN 1 ELSE 0 END) AS withChapter FROM questions q JOIN papers p ON p.id=q.paperId GROUP BY p.subjectName"
).all();
console.log('\n===== 回填后统计 =====');
for (const s of stats) {
  console.log(`  ${s.subjectName}: ${s.questions} 题 | 有章节名 ${s.withChapter}（${(s.withChapter / s.questions * 100).toFixed(1)}%）`);
}
const top = db.prepare(
  "SELECT p.subjectName, q.chapter, COUNT(*) AS n FROM questions q JOIN papers p ON p.id=q.paperId WHERE q.chapter != '' GROUP BY p.subjectName, q.chapter ORDER BY n DESC LIMIT 18"
).all();
console.log('\n章节名 TOP18：');
for (const t of top) console.log(`  ${t.subjectName} | ${t.chapter}: ${t.n}`);
