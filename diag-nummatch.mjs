// 验证 Fix3 方案：按 (季,题号) 合并匹配 stems → 题目，检查是否全部正确/无错配
import { getDocument, GlobalWorkerOptions } from './public/vendor/pdfjs/pdf.min.mjs';
import { parseTxt, deChineseSpace, computeFigureCrops } from './public/lib/custom-parser.js';
import { pathToFileURL } from 'url';
import fs from 'fs';
GlobalWorkerOptions.workerSrc = pathToFileURL('public/vendor/pdfjs/pdf.worker.min.mjs').href;
const doc = await getDocument({ data: new Uint8Array(fs.readFileSync('public/tmp-diag/600.pdf')), useSystemFonts: true }).promise;

function rowsOf(tc) {
  const rows = [];
  for (const it of tc.items) {
    if (!it.transform) continue;
    const y = it.transform[5];
    const t = String(it.str || '');
    if (!t.trim()) continue;
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - y) < 4) last.text += (it.hasEOL ? '\n' : ' ') + t;
    else rows.push({ y, text: t });
  }
  return rows;
}
// 收集 stems（含 num 与 crop）
const stemsAll = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const rows = rowsOf(tc).sort((a, b) => b.y - a.y);
  if (rows.length < 2) continue;
  const marks = computeFigureCrops(rows);
  for (const m of marks) stemsAll.push({ ...m, page: p });
}
const stemsWithCrop = stemsAll.filter((s) => s.crop);
console.log(`stems=${stemsAll.length} 有裁剪=${stemsWithCrop.length}`);

const texts = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  texts.push(deChineseSpace(tc.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim()));
}
const cleaned = texts.join('\n\n').split('\n').filter((l) => !/^\s*\d{4}\s*年.*(?:国考|联考|行政执法).*(?:卷|资料分析)/.test(l)).join('\n');
const qs = parseTxt(cleaned).filter((q) => q.options.length);
console.log(`题目(带选项)=${qs.length}`);

// 给 stems 和 questions 都打好 (季, 号) 键：题号回退 = 新一季
const seasonKey = (list, numOf) => {
  let season = 0, prev = 0;
  return list.map((x) => {
    const n = numOf(x);
    if (n != null && prev > 0 && n <= prev) season++;
    if (n != null) prev = n;
    return { x, season, num: n };
  });
};
const sk = seasonKey(stemsWithCrop, (s) => s.num);
const qk = seasonKey(qs, (q) => q.num);

// 合并匹配：stems 是 questions 的有编号子序列（季优先、号升序）
let s = 0, q = 0;
const matched = [];
while (s < sk.length && q < qk.length) {
  const stem = sk[s], que = qk[q];
  if (stem.season === que.season && stem.num === que.num) { matched.push({ s, q, season: stem.season, num: stem.num }); s++; q++; continue; }
  if (stem.season < que.season || (stem.season === que.season && stem.num < que.num)) { s++; continue; }
  q++; // 该题无对应裁剪
}
console.log(`匹配= ${matched.length} / stems=${sk.length}`);
const mismatches = matched.filter((m, i) => {
  const prev = matched[i - 1];
  return prev && (m.season < prev.season || (m.season === prev.season && m.num <= prev.num));
});
console.log(`顺序异常=${mismatches.length}`);
// 展示前若干季的匹配情况（s→q）
const bySeason = new Map();
for (const m of matched) {
  if (!bySeason.has(m.season)) bySeason.set(m.season, []);
  bySeason.get(m.season).push(m.num);
}
console.log('每季匹配题号数:', [...bySeason.entries()].map(([k, v]) => `${k+1}:${v.length}`).join(' '));
// 检查：有没有「有裁剪的 stem 没匹配上」或「匹配到不同号」
console.log('样例(季,号→s→q):', matched.slice(0, 10).map((m) => `s${m.s}q${m.q}(#${m.num})`).join(' '));
// 未匹配 stems（有裁剪但没对上题）
const unMatchedStems = sk.filter((st, i) => !matched.some((m) => m.s === i));
console.log('未匹配裁剪数:', unMatchedStems.length, unMatchedStems.slice(0, 10).map((st) => `${st.season}:#${st.num}`).join(', '));
