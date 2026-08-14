// make-icons.mjs — 生成考公主题 App 图标（深蓝渐变 + 书本 + 金色对勾）
// 覆盖 Android 全部 mipmap 密度：mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const RES = 'app/android/app/src/main/res';
const SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

// ---- 全图 SVG（圆角方底 / 圆形底），viewBox 0 0 192 192 ----
function fullSvg(shape) {
  const bg = shape === 'round'
    ? `<circle cx="96" cy="96" r="94" fill="url(#bg)"/>`
    : `<rect x="4" y="4" width="184" height="184" rx="44" fill="url(#bg)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1e3a8a"/>
      <stop offset="0.55" stop-color="#2748c8"/>
      <stop offset="1" stop-color="#3b82f6"/>
    </linearGradient>
    <linearGradient id="page" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#dbeafe"/>
    </linearGradient>
  </defs>
  ${bg}
  <g transform="translate(96 96) scale(0.86) translate(-96 -96)">
    <!-- 左页 -->
    <path d="M96 84 L58 74 L58 132 L96 142 Z" fill="url(#page)" opacity="0.96"/>
    <!-- 右页 -->
    <path d="M96 84 L134 74 L134 132 L96 142 Z" fill="url(#page)" opacity="0.82"/>
    <!-- 书脊 -->
    <path d="M92 82 L100 82 L100 144 L92 144 Z" fill="#60a5fa"/>
    <!-- 左页横线（文字感） -->
    <line x1="67" y1="92" x2="88" y2="96" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="67" y1="103" x2="88" y2="107" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="67" y1="114" x2="88" y2="118" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <!-- 右页横线 -->
    <line x1="104" y1="96" x2="125" y2="92" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="104" y1="107" x2="125" y2="103" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="104" y1="118" x2="125" y2="114" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <!-- 金色对勾（盖在书上，象征做对/上岸） -->
    <path d="M74 106 L92 124 L122 84" fill="none" stroke="#fbbf24" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;
}

// ---- foreground SVG（透明底，内容缩进 66% 安全区，adaptive icon 用）----
function fgSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <defs>
    <linearGradient id="page" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#dbeafe"/>
    </linearGradient>
  </defs>
  <g transform="translate(96 96) scale(0.66) translate(-96 -96)">
    <!-- 左页 -->
    <path d="M96 84 L58 74 L58 132 L96 142 Z" fill="url(#page)" opacity="0.96"/>
    <!-- 右页 -->
    <path d="M96 84 L134 74 L134 132 L96 142 Z" fill="url(#page)" opacity="0.82"/>
    <!-- 书脊 -->
    <path d="M92 82 L100 82 L100 144 L92 144 Z" fill="#3b82f6"/>
    <!-- 左页横线 -->
    <line x1="67" y1="92" x2="88" y2="96" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="67" y1="103" x2="88" y2="107" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="67" y1="114" x2="88" y2="118" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <!-- 右页横线 -->
    <line x1="104" y1="96" x2="125" y2="92" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="104" y1="107" x2="125" y2="103" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <line x1="104" y1="118" x2="125" y2="114" stroke="#93c5fd" stroke-width="3.4" stroke-linecap="round"/>
    <!-- 金色对勾 -->
    <path d="M74 106 L92 124 L122 84" fill="none" stroke="#f59e0b" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;
}

const svgCache = {};
function svgFor(kind) {
  if (!svgCache[kind]) svgCache[kind] = kind === 'fg' ? fgSvg() : fullSvg(kind);
  return svgCache[kind];
}

for (const [dpi, px] of Object.entries(SIZES)) {
  for (const kind of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) {
    const svgKind = kind === 'ic_launcher' ? 'square' : kind === 'ic_launcher_round' ? 'round' : 'fg';
    const out = join(RES, `mipmap-${dpi}`, `${kind}.png`);
    mkdirSync(dirname(out), { recursive: true });
    await sharp(Buffer.from(svgFor(svgKind))).resize(px, px).png().toFile(out);
    console.log('✓', `mipmap-${dpi}/${kind}.png (${px}px)`);
  }
}

// 自适应图标背景色 → 深蓝（与渐变起点一致）
const colorsPath = join(RES, 'values', 'ic_launcher_background.xml');
writeFileSync(colorsPath, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1E3A8A</color>\n</resources>\n`);
console.log('✓ ic_launcher_background.xml → #1E3A8A');
console.log('全部完成');
