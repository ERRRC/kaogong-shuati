// 诊断3：全文档 computeFigureCrops 模拟（Node 无 canvas，只验证条目数与裁剪区）
import { getDocument, GlobalWorkerOptions } from './public/vendor/pdfjs/pdf.min.mjs';
import { computeFigureCrops, deChineseSpace } from './public/lib/custom-parser.js';
import { pathToFileURL } from 'url';
import fs from 'fs';

GlobalWorkerOptions.workerSrc = pathToFileURL('public/vendor/pdfjs/pdf.worker.min.mjs').href;
const file = process.argv[2] || 'public/tmp-diag/600.pdf';
const data = new Uint8Array(fs.readFileSync(file));
const doc = await getDocument({ data, useSystemFonts: true }).promise;

let totalStems = 0, totalCrops = 0;
const perPage = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const pt = deChineseSpace(tc.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim());
  if (pt.length <= 20) { perPage.push({ p, stems: 'SKIP(扫描页)' }); continue; }
  const rows = [];
  for (const it of tc.items) {
    if (!it.transform) continue;
    const y = it.transform[5];
    const t = String(it.str || '');
    if (!t.trim()) continue;
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - y) < 4) last.text += (it.hasEOL ? '\n' : '') + t;
    else rows.push({ y, text: t });
  }
  let marks = [];
  try { marks = computeFigureCrops(rows); } catch (e) { perPage.push({ p, err: String(e) }); continue; }
  const crops = marks.filter((m) => m.crop);
  totalStems += marks.length;
  totalCrops += crops.length;
  if (marks.length || crops.length) perPage.push({ p, stems: marks.length, crops: crops.length, gaps: crops.map((m) => Math.round(m.crop.yTop - m.crop.yBottom)) });
}
console.log(`总题干条目=${totalStems} 总裁剪命中=${totalCrops}（目标：条目=600）`);
for (const e of perPage) console.log(`p${e.p}: ${JSON.stringify(e)}`);
