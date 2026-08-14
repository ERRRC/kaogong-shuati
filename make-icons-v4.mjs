// make-icons-v4.mjs — 第四版：超极简（单元素 + 纯色块，贴纸/涂鸦风）
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'icon-preview';
mkdirSync(OUT, { recursive: true });

// 每版：纯色圆角底 + 单个图形，无渐变、无描边堆叠

function bg(shape, color) {
  return shape === 'round'
    ? `<circle cx="96" cy="96" r="94" fill="${color}"/>`
    : `<rect x="4" y="4" width="184" height="184" rx="46" fill="${color}"/>`;
}

// A · 蓝色对勾：蓝底 + 白色大勾（做对了/上岸）
function svgA(shape) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg(shape, '#2563eb')}
  <path d="M56 100 L84 128 L138 66" fill="none" stroke="#ffffff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

// B · 小黄鸭：天蓝底 + 白色鸭子剪影（简化：身+头+嘴）
function svgB(shape) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg(shape, '#38bdf8')}
  <!-- 水面 -->
  <path d="M36 138 Q52 128 68 138 Q84 148 100 138 Q116 128 132 138 Q146 146 158 140 L158 152 L36 152 Z" fill="#ffffff" opacity="0.55"/>
  <!-- 鸭身 -->
  <ellipse cx="92" cy="100" rx="40" ry="30" fill="#ffffff"/>
  <!-- 鸭头 -->
  <circle cx="126" cy="66" r="21" fill="#ffffff"/>
  <!-- 鸭嘴 -->
  <path d="M144 64 Q162 66 146 74 Q138 72 144 64 Z" fill="#f59e0b"/>
  <!-- 眼睛 -->
  <circle cx="130" cy="62" r="4" fill="#0f172a"/>
</svg>`;
}

// C · 三条波浪：白底 + 蓝色波浪线（水面/上岸）
function svgC(shape) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg(shape, '#ffffff')}
  <path d="M40 78 Q58 66 76 78 Q94 90 112 78 Q130 66 148 78" fill="none" stroke="#3b82f6" stroke-width="9" stroke-linecap="round"/>
  <path d="M40 106 Q58 94 76 106 Q94 118 112 106 Q130 94 148 106" fill="none" stroke="#60a5fa" stroke-width="9" stroke-linecap="round"/>
  <path d="M40 134 Q58 122 76 134 Q94 146 112 134 Q130 122 148 134" fill="none" stroke="#93c5fd" stroke-width="9" stroke-linecap="round"/>
</svg>`;
}

// D · 笑脸贴纸：黄色底 + 白色眨眼笑
function svgD(shape) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg(shape, '#facc15')}
  <!-- 左眼（正常） -->
  <circle cx="74" cy="84" r="7" fill="#1e293b"/>
  <!-- 右眼（wink 弯线） -->
  <path d="M104 84 Q112 76 120 84" fill="none" stroke="#1e293b" stroke-width="6" stroke-linecap="round"/>
  <!-- 笑嘴 -->
  <path d="M70 112 Q96 134 122 112" fill="none" stroke="#1e293b" stroke-width="7" stroke-linecap="round"/>
</svg>`;
}

// E · 小金币：暖黄底 + 白色圆 + 中间 ¥（没钱梗，反着来）
function svgE(shape) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg(shape, '#fbbf24')}
  <circle cx="96" cy="96" r="46" fill="#ffffff"/>
  <text x="96" y="120" text-anchor="middle" font-size="52" font-weight="bold" fill="#d97706" font-family="Arial, sans-serif">¥</text>
</svg>`;
}

const VERSIONS = {
  A: { name: 'A · 蓝色对勾', desc: '蓝底白勾：做对了 / 上岸，一个元素极简到顶', svg: svgA },
  B: { name: 'B · 小黄鸭', desc: '天蓝底 + 白色鸭子剪影，极简版上岸鸭', svg: svgB },
  C: { name: 'C · 三条波浪', desc: '白底蓝波浪：水面/上岸，纯线条', svg: svgC },
  D: { name: 'D · 眨眼笑', desc: '黄底 + 白色眨眼笑脸，贴纸感', svg: svgD },
  E: { name: 'E · 大金币', desc: '暖黄底 + 白圆 ¥：没钱的人画个金币', svg: svgE },
};

const cards = [];
for (const [key, def] of Object.entries(VERSIONS)) {
  for (const shape of ['square', 'round']) {
    const out = join(OUT, `v4-${key}-${shape}.png`);
    await sharp(Buffer.from(def.svg(shape))).resize(256, 256).png().toFile(out);
  }
  console.log('✓', key, def.name);
  cards.push({ key, ...def });
}

// 拼图大图
const cell = 200, gap = 24, pad = 32;
const W = pad * 2 + cell * 5 + gap * 4;
const H = pad * 2 + cell * 2 + gap;
const composite = [];
Object.keys(VERSIONS).forEach((k, i) => {
  const x = pad + i * (cell + gap);
  composite.push({ input: join(OUT, `v4-${k}-square.png`), left: x, top: pad, width: cell, height: cell });
  composite.push({ input: join(OUT, `v4-${k}-round.png`), left: x, top: pad + cell + gap, width: cell, height: cell });
});
await sharp({ create: { width: W, height: H, channels: 4, background: { r: 241, g: 245, b: 249, alpha: 1 } } })
  .composite(composite).png().toFile(join(OUT, '第四版拼图.png'));
console.log('✓ 拼图', W + 'x' + H);
