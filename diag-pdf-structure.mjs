// 诊断：行测判断推理 PDF 结构（文本层 / 图形题排版 / 裁剪命中情况）
import { getDocument, GlobalWorkerOptions, OPS } from './public/vendor/pdfjs/pdf.min.mjs';
import { computeFigureCrops, deChineseSpace } from './public/lib/custom-parser.js';
import { pathToFileURL } from 'url';

GlobalWorkerOptions.workerSrc = pathToFileURL('public/vendor/pdfjs/pdf.worker.min.mjs').href;

const file = process.argv[2] || 'public/tmp-diag/600.pdf';
const data = new Uint8Array((await import('fs')).readFileSync(file));
const doc = await getDocument({ data, useSystemFonts: true }).promise;
console.log(`pages=${doc.numPages}`);

function rowsOf(tc) {
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
  return rows;
}

const PAGES = Math.min(doc.numPages, parseInt(process.argv[3] || '12', 10));
for (let p = 1; p <= PAGES; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const pageText = deChineseSpace(tc.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim());
  // 图片对象数
  let imgCount = 0;
  try {
    const ol = await page.getOperatorList();
    for (let i = 0; i < ol.fnArray.length; i++) if (ol.fnArray[i] === OPS.paintImageXObject) imgCount++;
  } catch {}
  const rows = rowsOf(tc);
  let marks = [];
  try { marks = computeFigureCrops(rows); } catch (e) { marks = [{ err: String(e) }]; }
  console.log(`\n===== 第${p}页 textLen=${pageText.length} imgs=${imgCount} rows=${rows.length} stems=${marks.length} crops=${marks.filter(m => m.crop).length}`);
  // 打印前 25 行（y 降序=自上而下）
  const sorted = [...rows].sort((a, b) => b.y - a.y);
  for (const r of sorted.slice(0, 22)) console.log(`  y=${r.y.toFixed(1).padStart(7)} | ${r.text.slice(0, 80).replace(/\n/g, '⏎')}`);
  if (sorted.length > 22) console.log(`  …共 ${sorted.length} 行`);
}
