// 诊断2：全文档扫描 —— 找答案/解析区排版 + 跑 parseTxt 看整体质量
import { getDocument, GlobalWorkerOptions } from './public/vendor/pdfjs/pdf.min.mjs';
import { parseTxt, dedupeQuestions, deChineseSpace } from './public/lib/custom-parser.js';
import { pathToFileURL } from 'url';
import fs from 'fs';

GlobalWorkerOptions.workerSrc = pathToFileURL('public/vendor/pdfjs/pdf.worker.min.mjs').href;

const file = process.argv[2] || 'public/tmp-diag/600.pdf';
const data = new Uint8Array(fs.readFileSync(file));
const doc = await getDocument({ data, useSystemFonts: true }).promise;

const texts = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const pageText = tc.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim();
  const pt = deChineseSpace(pageText);
  texts.push({ p, pt });
}

// 1) 找含「答案」「解析」「正确率」等标记的页（每页只报一次）
console.log('== 标记页分布 ==');
for (const { p, pt } of texts) {
  const tags = [];
  if (/^\s*参考答案与解析/m.test(pt)) tags.push('参考答案与解析');
  if (/【答案】/.test(pt)) tags.push('【答案】x' + (pt.match(/【答案】/g) || []).length);
  if (/红领巾解析/.test(pt)) tags.push('红领巾解析');
  if (/粉笔解析/.test(pt)) tags.push('粉笔解析x' + (pt.match(/粉笔解析/g) || []).length);
  if (/^第\d+\s*季/m.test(pt.trim().slice(0, 40))) tags.push('季标题');
  if (tags.length) console.log(`p${p}: ${tags.join(' ')}`);
}
fs.writeFileSync('tmp-diag-pages.txt', texts.map(({ p, pt }) => `\n@@@PAGE ${p}@@@\n${pt}`).join(''));
console.log('\n全文已存 tmp-diag-pages.txt');

// 2) 跑 parseTxt（模拟 app.js 的清洗）
const cleaned = texts.map((t) => t.pt).join('\n\n').split('\n').filter((l) => !/^\s*\d{4}\s*年.*(?:国考|联考|行政执法).*(?:卷|资料分析)/.test(l)).join('\n');
const qs = parseTxt(cleaned);
const withOpts = qs.filter((q) => q.options.length);
const withAns = qs.filter((q) => q.answer);
const withAna = qs.filter((q) => q.analysis);
const figQs = qs.filter((q) => q.options.length && q.options.every((o) => /^[A-H]\.\s*[A-H]?\s*$/.test(String(o).trim())));
console.log(`\n== parseTxt 结果 == 总块=${qs.length} 带选项=${withOpts.length} 带答案=${withAns.length} 带解析=${withAna.length} 图形占位题=${figQs.length}`);
// 题干前 30 字抽样（看有没有垃圾块）
console.log('\n== 前 12 块 ==');
for (const q of qs.slice(0, 12)) console.log(`- opts=${q.options.length} ans=${q.answer || '-'} | ${(q.prompt || q.material || '').slice(0, 50).replace(/\n/g, '⏎')}`);
