// make-icons-preview.mjs — 生成 5 版图标预览（HTML + PNG），供用户选择
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const OUT = 'icon-preview';
mkdirSync(OUT, { recursive: true });

// ============ 版本定义 ============
// 每版提供 fullSvg(shape) 与描述。统一 viewBox 0 0 192 192，内容居中。
const VERSIONS = {
  A: {
    name: 'A · 深蓝书勾',
    desc: '深蓝渐变 + 翻开的书 + 金色对勾：沉稳、刷题感强，最"备考"',
  },
  B: {
    name: 'B · 靛紫上岸帽',
    desc: '靛蓝紫渐变 + 学士帽（毕业帽）+ 金色流苏：寓意"上岸"',
  },
  C: {
    name: 'C · 朱红折桂',
    desc: '红橙渐变 + 书本 + 金色桂冠：热血冲刺、金榜题名',
  },
  D: {
    name: 'D · 青绿盾牌',
    desc: '青绿渐变 + 盾牌 + 白色对勾：可靠、专业、公信力',
  },
  E: {
    name: 'E · 暖橙书星',
    desc: '暖橙渐变 + 书卷 + 金色星星：轻松积极、日积月累',
  },
};

function bgRect(g1, g2, shape) {
  const grad = `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${g1}"/><stop offset="1" stop-color="${g2}"/>
    </linearGradient>`;
  const bg = shape === 'round'
    ? `<circle cx="96" cy="96" r="94" fill="url(#bg)"/>`
    : `<rect x="4" y="4" width="184" height="184" rx="44" fill="url(#bg)"/>`;
  return { grad, bg };
}

// ---- A：深蓝书勾 ----
function svgA(shape) {
  const { grad, bg } = bgRect('#1e3a8a', '#3b82f6', shape);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <defs>${grad}
    <linearGradient id="page" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dbeafe"/>
    </linearGradient>
  </defs>
  ${bg}
  <g transform="translate(96 96) scale(0.86) translate(-96 -96)">
    <path d="M96 84 L58 74 L58 132 L96 142 Z" fill="url(#page)" opacity="0.96"/>
    <path d="M96 84 L134 74 L134 132 L96 142 Z" fill="url(#page)" opacity="0.82"/>
    <path d="M92 82 L100 82 L100 144 L92 144 Z" fill="#60a5fa"/>
    <line x1="67" y1="92" x2="88" y2="96" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="67" y1="103" x2="88" y2="107" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="67" y1="114" x2="88" y2="118" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="104" y1="96" x2="125" y2="92" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="104" y1="107" x2="125" y2="103" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="104" y1="118" x2="125" y2="114" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <path d="M74 106 L92 124 L122 84" fill="none" stroke="#fbbf24" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;
}

// ---- B：靛紫上岸帽 ----
function svgB(shape) {
  const { grad, bg } = bgRect('#4c1d95', '#8b5cf6', shape);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <defs>${grad}</defs>
  ${bg}
  <g transform="translate(96 96) scale(0.86) translate(-96 -96)">
    <!-- 帽顶菱形 -->
    <path d="M96 46 L142 72 L96 98 L50 72 Z" fill="#ffffff"/>
    <path d="M96 98 L96 128" stroke="#fbbf24" stroke-width="7" stroke-linecap="round"/>
    <path d="M96 46 L96 98" stroke="#e2e8f0" stroke-width="4"/>
    <!-- 帽檐 -->
    <path d="M54 74 Q96 90 138 74 L142 80 Q96 100 50 80 Z" fill="#f1f5f9"/>
    <!-- 帽穗（右侧金色） -->
    <path d="M132 76 Q140 96 132 112" fill="none" stroke="#fbbf24" stroke-width="6" stroke-linecap="round"/>
    <circle cx="132" cy="116" r="6" fill="#fbbf24"/>
    <!-- 底部小书（毕业证书本感） -->
    <rect x="64" y="128" width="64" height="14" rx="7" fill="#ffffff" opacity="0.85"/>
    <path d="M96 128 L96 142" stroke="#8b5cf6" stroke-width="3"/>
  </g>
</svg>`;
}

// ---- C：朱红折桂 ----
function svgC(shape) {
  const { grad, bg } = bgRect('#b91c1c', '#f97316', shape);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <defs>${grad}
    <linearGradient id="page" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#fee2e2"/>
    </linearGradient>
  </defs>
  ${bg}
  <g transform="translate(96 96) scale(0.86) translate(-96 -96)">
    <!-- 桂冠：两枝月桂叶 -->
    <path d="M96 52 Q62 48 48 66 Q72 72 84 64" fill="none" stroke="#fde047" stroke-width="6" stroke-linecap="round"/>
    <path d="M96 52 Q130 48 144 66 Q120 72 108 64" fill="none" stroke="#fde047" stroke-width="6" stroke-linecap="round"/>
    <circle cx="96" cy="52" r="7" fill="#fde047"/>
    <ellipse cx="60" cy="60" rx="7" ry="4" fill="#fde047" transform="rotate(-20 60 60)"/>
    <ellipse cx="132" cy="60" rx="7" ry="4" fill="#fde047" transform="rotate(20 132 60)"/>
    <!-- 书本 -->
    <path d="M96 84 L58 76 L58 132 L96 140 Z" fill="url(#page)"/>
    <path d="M96 84 L134 76 L134 132 L96 140 Z" fill="url(#page)" opacity="0.85"/>
    <path d="M92 82 L100 82 L100 142 L92 142 Z" fill="#fca5a5"/>
    <line x1="67" y1="92" x2="88" y2="95" stroke="#fecaca" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="67" y1="103" x2="88" y2="106" stroke="#fecaca" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="104" y1="95" x2="125" y2="92" stroke="#fecaca" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="104" y1="106" x2="125" y2="103" stroke="#fecaca" stroke-width="3.4" stroke-linecap="round"/>
  </g>
</svg>`;
}

// ---- D：青绿盾牌 ----
function svgD(shape) {
  const { grad, bg } = bgRect('#065f46', '#10b981', shape);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <defs>${grad}
    <linearGradient id="shield" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d1fae5"/>
    </linearGradient>
  </defs>
  ${bg}
  <g transform="translate(96 96) scale(0.86) translate(-96 -96)">
    <!-- 盾牌 -->
    <path d="M96 40 L140 58 L140 102 Q140 142 96 158 Q52 142 52 102 L52 58 Z" fill="url(#shield)"/>
    <path d="M96 50 L132 64 L132 102 Q132 134 96 148 Q60 134 60 102 L60 64 Z" fill="none" stroke="#34d399" stroke-width="4"/>
    <!-- 金色对勾 -->
    <path d="M76 98 L92 114 L118 82" fill="none" stroke="#d97706" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;
}

// ---- E：暖橙书星 ----
function svgE(shape) {
  const { grad, bg } = bgRect('#c2410c', '#f59e0b', shape);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <defs>${grad}
    <linearGradient id="page" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#fef3c7"/>
    </linearGradient>
  </defs>
  ${bg}
  <g transform="translate(96 96) scale(0.86) translate(-96 -96)">
    <!-- 金色星星 -->
    <path d="M96 40 L104 64 L128 64 L109 79 L116 103 L96 88 L76 103 L83 79 L64 64 L88 64 Z" fill="#fde68a"/>
    <!-- 书卷 -->
    <path d="M58 82 L134 82 L134 132 Q134 140 126 140 L66 140 Q58 140 58 132 Z" fill="url(#page)"/>
    <path d="M58 82 Q96 92 134 82" fill="none" stroke="#f59e0b" stroke-width="4"/>
    <line x1="70" y1="98" x2="122" y2="98" stroke="#fcd34d" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="70" y1="108" x2="122" y2="108" stroke="#fcd34d" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="70" y1="118" x2="104" y2="118" stroke="#fcd34d" stroke-width="3.4" stroke-linecap="round"/>
  </g>
</svg>`;
}

const svgMap = { A: svgA, B: svgB, C: svgC, D: svgD, E: svgE };

// 渲染 PNG（预览 256px 方形 + 圆形 各一张）
const previewCards = [];
for (const [key, def] of Object.entries(VERSIONS)) {
  const square = join(OUT, `icon-${key}-square.png`);
  const round = join(OUT, `icon-${key}-round.png`);
  await sharp(Buffer.from(svgMap[key]('square'))).resize(256, 256).png().toFile(square);
  await sharp(Buffer.from(svgMap[key]('round'))).resize(256, 256).png().toFile(round);
  console.log('✓', key, def.name);
  previewCards.push({ key, ...def, square, round });
}

// HTML 预览页（深色背景 + 卡片网格）
const cards = previewCards.map((c) => `
  <div class="card" style="--accent: ${['#3b82f6','#8b5cf6','#f97316','#10b981','#f59e0b'][c.key.charCodeAt(0) - 65]}">
    <div class="icons">
      <img src="icon-${c.key}-square.png" alt="方形"/>
      <img src="icon-${c.key}-round.png" alt="圆形"/>
    </div>
    <div class="name">${c.name}</div>
    <div class="desc">${c.desc}</div>
  </div>`).join('');

writeFileSync(join(OUT, 'preview.html'), `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><title>App 图标方案预览</title>
<style>
  body { background:#0f172a; color:#e2e8f0; font-family: system-ui, 'Microsoft YaHei', sans-serif; margin:0; padding:40px 24px; }
  h1 { text-align:center; font-size:22px; margin:0 0 6px; }
  .sub { text-align:center; color:#94a3b8; font-size:13px; margin-bottom:32px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:20px; max-width:1180px; margin:0 auto; }
  .card { background:#1e293b; border-radius:16px; padding:20px; text-align:center; border:1px solid #334155; }
  .icons { display:flex; gap:14px; justify-content:center; margin-bottom:14px; }
  .icons img { width:112px; height:112px; border-radius:18px; box-shadow:0 8px 24px rgba(0,0,0,.35); }
  .name { font-size:16px; font-weight:700; margin-bottom:6px; color:#fff; }
  .desc { font-size:12.5px; color:#94a3b8; line-height:1.7; }
</style>
</head>
<body>
  <h1>🎯 请选择 App 图标方案</h1>
  <div class="sub">左为桌面方形图标 · 右为圆形图标（同一方案两种裁切）· 告诉我你要哪一版（如 "B"）</div>
  <div class="grid">${cards}</div>
</body>
</html>`);
console.log('✓ preview.html 已生成 →', join(OUT, 'preview.html'));
