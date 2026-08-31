import { getDocument, GlobalWorkerOptions } from './public/vendor/pdfjs/pdf.min.mjs';
import { parseTxt, deChineseSpace } from './public/lib/custom-parser.js';
import { pathToFileURL } from 'url';
import fs from 'fs';
GlobalWorkerOptions.workerSrc = pathToFileURL('public/vendor/pdfjs/pdf.worker.min.mjs').href;
const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(process.argv[2] || 'public/tmp-diag/600.pdf')), useSystemFonts: true }).promise;
const texts = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  texts.push(deChineseSpace(tc.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim()));
}
const cleaned = texts.join('\n\n').split('\n').filter((l) => !/^\s*\d{4}\s*年.*(?:国考|联考|行政执法).*(?:卷|资料分析)/.test(l)).join('\n');
const qs = parseTxt(cleaned);
console.log(`总题=${qs.length}`);

// 1) 季标题污染解析
const polluted = qs.map((q, i) => ({ q, i })).filter(({ q }) => /第\s*\d{1,3}\s*季\s*·\s*解析区/.test(q.analysis || ''));
console.log(`解析开头是「第X季·解析区」污染数=${polluted.length}`);
console.log('样本:', polluted.slice(0, 5).map(({ i }) => '#'.concat(i + 1)).join(' '));

// 2) 强校验答案：解析中任何「正确答案为/答案为/答案为 X / 答案：X / 选 X」结尾或出现
let ok = 0, bad = 0, unk = 0; const badS = [];
for (let i = 0; i < qs.length; i++) {
  const q = qs[i];
  if (!q.answer) { unk++; continue; }
  const a = String(q.answer);
  const aLetter = /^\[/.test(a) ? 'MULTI' : a.toUpperCase().replace(/[^A-H]/g, '').charAt(0);
  const ana = String(q.analysis || '');
  // 解析区答案行的间接：这里只看解析正文
  const pats = [
    /正确答案\s*[为是:：]?\s*[（(]?\s*([A-Ha-h])\s*[)）]?/,
    /答案\s*[为是:：]\s*[（(]?\s*([A-Ha-h])\s*[)）]?/,
    /答案为\s*[（(]?\s*([A-Ha-h])\s*[)）]?/,
    /选\s*[（(]?\s*([A-Ha-h])\s*[)）]?(?=[。，；、\s]|$)/,
    /故选\s*[（(]?\s*([A-Ha-h])\s*[)）]?(?=[。，；、\s]|$)/,
    /直接选\s*[（(]?\s*([A-Ha-h])\s*[)）]?(?=[。，；、\s]|$)/,
    /因此选\s*[（(]?\s*([A-Ha-h])\s*[)）]?(?=[。，；、\s]|$)/,
  ];
  const hits = [];
  for (const p of pats) { const m = ana.match(p); if (m) hits.push(m[1].toUpperCase()); }
  if (!hits.length) { unk++; continue; }
  if (aLetter !== 'MULTI' && hits.includes(aLetter)) ok++;
  else { bad++; if (badS.length < 20) badS.push(`#${i + 1} ans=${q.answer} 解析说=${hits.join('/')} | ${(q.prompt || '').slice(0, 30)}`); }
}
console.log(`\n强校验: 命中=${ok} 不命中=${bad} 不可判定=${unk}`);
if (bad) badS.forEach((s) => console.log('  ' + s));

// 3) 图形题（占位选项）带不带图：parseTxt 本身无图，这里统计占位题是否应该有图
const fig = qs.filter((q) => q.options.length && q.options.every((o) => /^[A-H]\.\s*[A-H]?\s*$/.test(String(o).trim())));
console.log(`\n图形占位题=${fig.length}（这些题的 A-D 选项在题图上，没图即无法作答）`);
