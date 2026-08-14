// make-icons-v3.mjs — 第三版：白底蓝字「没钱 · 考什么公」文字图标
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'icon-preview';
mkdirSync(OUT, { recursive: true });

// 文字图标：白底 + 蓝字。viewBox 0 0 192 192。
// 变体：
//  A 横排大字「没钱」+ 下方小字「考什么公」
//  B 竖排「没钱」+ 右下角小字「考什么公」（章样式）
//  C 大字「没钱」+ 下方波浪线 + 小字「考什么公」（活泼）
//  D 大字「没钱」+ 小字带引号气泡（对话感）

const FONT = `font-family='Microsoft YaHei, PingFang SC, SimHei, sans-serif'`;

function svgA(shape) {
  const bg = shape === 'round'
    ? `<circle cx="96" cy="96" r="94" fill="#ffffff"/>`
    : `<rect x="4" y="4" width="184" height="184" rx="46" fill="#ffffff"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg}
  <text x="96" y="112" text-anchor="middle" font-size="62" font-weight="bold" fill="#1d4ed8" ${FONT}>没钱</text>
  <text x="96" y="152" text-anchor="middle" font-size="24" fill="#3b82f6" ${FONT}>考什么公</text>
</svg>`;
}

function svgB(shape) {
  const bg = shape === 'round'
    ? `<circle cx="96" cy="96" r="94" fill="#ffffff"/>`
    : `<rect x="4" y="4" width="184" height="184" rx="46" fill="#ffffff"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg}
  <text x="96" y="104" text-anchor="middle" font-size="58" font-weight="bold" fill="#1d4ed8" ${FONT}>没</text>
  <text x="96" y="156" text-anchor="middle" font-size="58" font-weight="bold" fill="#1d4ed8" ${FONT}>钱</text>
  <text x="148" y="176" text-anchor="end" font-size="17" fill="#60a5fa" ${FONT}>考什么公</text>
</svg>`;
}

function svgC(shape) {
  const bg = shape === 'round'
    ? `<circle cx="96" cy="96" r="94" fill="#ffffff"/>`
    : `<rect x="4" y="4" width="184" height="184" rx="46" fill="#ffffff"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg}
  <text x="96" y="104" text-anchor="middle" font-size="58" font-weight="bold" fill="#1d4ed8" ${FONT}>没钱</text>
  <path d="M52 122 Q70 116 88 122 Q106 128 124 122 Q140 116 152 121" fill="none" stroke="#f59e0b" stroke-width="5" stroke-linecap="round"/>
  <text x="96" y="152" text-anchor="middle" font-size="24" fill="#3b82f6" ${FONT}>考什么公</text>
</svg>`;
}

function svgD(shape) {
  const bg = shape === 'round'
    ? `<circle cx="96" cy="96" r="94" fill="#ffffff"/>`
    : `<rect x="4" y="4" width="184" height="184" rx="46" fill="#ffffff"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg}
  <text x="96" y="102" text-anchor="middle" font-size="56" font-weight="bold" fill="#1d4ed8" ${FONT}>没钱</text>
  <rect x="46" y="118" width="100" height="34" rx="17" fill="#eff6ff" stroke="#93c5fd" stroke-width="3"/>
  <text x="96" y="142" text-anchor="middle" font-size="21" fill="#2563eb" ${FONT}>考什么公？</text>
  <path d="M84 152 L88 160 L96 152 Z" fill="#eff6ff" stroke="#93c5fd" stroke-width="2.5"/>
</svg>`;
}

const VERSIONS = {
  A: { name: 'A · 横排大字', desc: '白底蓝字：「没钱」大字 + 下方「考什么公」小字，最简洁直接', svg: svgA },
  B: { name: 'B · 竖排盖章', desc: '「没钱」竖排两字 + 右下角小字，像盖了个蓝章', svg: svgB },
  C: { name: 'C · 波浪线', desc: '横排大字 + 一条金色波浪线 + 小字，活泼一点', svg: svgC },
  D: { name: 'D · 气泡对话', desc: '大字 + 蓝色气泡里「考什么公？」，像在自问自答', svg: svgD },
};

const cards = [];
for (const [key, def] of Object.entries(VERSIONS)) {
  for (const shape of ['square', 'round']) {
    const out = join(OUT, `v3-${key}-${shape}.png`);
    await sharp(Buffer.from(def.svg(shape))).resize(256, 256).png().toFile(out);
  }
  console.log('✓', key, def.name);
  cards.push({ key, ...def });
}

const cardHtml = cards.map((c) => `
  <div class="card">
    <div class="icons">
      <img src="v3-${c.key}-square.png" alt="方形"/>
      <img src="v3-${c.key}-round.png" alt="圆形"/>
    </div>
    <div class="name">${c.name}</div>
    <div class="desc">${c.desc}</div>
  </div>`).join('');

writeFileSync(join(OUT, 'preview-v3.html'), `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><title>App 图标方案预览 · 第三版（白底蓝字）</title>
<style>
  body { background:#f1f5f9; color:#1e293b; font-family: system-ui, 'Microsoft YaHei', sans-serif; margin:0; padding:40px 24px; }
  h1 { text-align:center; font-size:22px; margin:0 0 6px; }
  .sub { text-align:center; color:#64748b; font-size:13px; margin-bottom:32px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:20px; max-width:1180px; margin:0 auto; }
  .card { background:#ffffff; border-radius:16px; padding:20px; text-align:center; border:1px solid #e2e8f0; box-shadow:0 4px 14px rgba(15,23,42,.05); }
  .icons { display:flex; gap:14px; justify-content:center; margin-bottom:14px; }
  .icons img { width:112px; height:112px; border-radius:18px; box-shadow:0 8px 24px rgba(15,23,42,.12); }
  .name { font-size:16px; font-weight:700; margin-bottom:6px; }
  .desc { font-size:12.5px; color:#64748b; line-height:1.7; }
</style>
</head>
<body>
  <h1>🔵 第三版：白底蓝字（请选择）</h1>
  <div class="sub">左为方形 · 右为圆形 · 告诉我用哪一版（如 "A"），或者还要继续调</div>
  <div class="grid">${cardHtml}</div>
</body>
</html>`);
console.log('✓ preview-v3.html 已生成');
