import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('tiku.db', { readOnly: true });

const rows = db.prepare(
  "SELECT q.answer, COUNT(*) AS n FROM questions q JOIN papers p ON p.id=q.paperId WHERE p.subjectName='事业编' GROUP BY q.answer ORDER BY n DESC LIMIT 15"
).all();
for (const r of rows) console.log('answer=[' + r.answer + ']:', r.n);

const noOpt = db.prepare(
  "SELECT COUNT(*) AS n FROM questions q JOIN papers p ON p.id=q.paperId WHERE p.subjectName='事业编' AND (q.options='[]' OR q.options IS NULL)"
).get();
console.log('事业编无选项的题:', noOpt.n);

const t = db.prepare(
  "SELECT q.type, COUNT(*) AS n FROM questions q JOIN papers p ON p.id=q.paperId WHERE p.subjectName='事业编' GROUP BY q.type ORDER BY n DESC LIMIT 8"
).all();
for (const r of t) console.log('type=' + r.type + ':', r.n);
