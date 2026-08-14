// make-icons-final.mjs — 应用选定方案 C（三条波浪：白底 + 三道蓝波浪线）到 Android 全尺寸 mipmap
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const RES = 'app/android/app/src/main/res';
const SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

// 整图（白底 + 波浪），legacy 与 round 用
function fullSvg(shape) {
  const bg = shape === 'round'
    ? `<circle cx="96" cy="96" r="94" fill="#ffffff"/>`
    : `<rect x="4" y="4" width="184" height="184" rx="46" fill="#ffffff"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg}
  <path d="M40 78 Q58 66 76 78 Q94 90 112 78 Q130 66 148 78" fill="none" stroke="#3b82f6" stroke-width="11" stroke-linecap="round"/>
  <path d="M40 106 Q58 94 76 106 Q94 118 112 106 Q130 94 148 106" fill="none" stroke="#60a5fa" stroke-width="11" stroke-linecap="round"/>
  <path d="M40 134 Q58 122 76 134 Q94 146 112 134 Q130 122 148 134" fill="none" stroke="#93c5fd" stroke-width="11" stroke-linecap="round"/>
</svg>`;
}

// foreground（透明底 + 波浪缩进 66% 安全区，adaptive icon 用）
function fgSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <g transform="translate(96 96) scale(0.68) translate(-96 -96)">
    <path d="M40 78 Q58 66 76 78 Q94 90 112 78 Q130 66 148 78" fill="none" stroke="#3b82f6" stroke-width="11" stroke-linecap="round"/>
    <path d="M40 106 Q58 94 76 106 Q94 118 112 106 Q130 94 148 106" fill="none" stroke="#60a5fa" stroke-width="11" stroke-linecap="round"/>
    <path d="M40 134 Q58 122 76 134 Q94 146 112 134 Q130 122 148 134" fill="none" stroke="#93c5fd" stroke-width="11" stroke-linecap="round"/>
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

// 自适应图标背景色 → 白色（与整图底色一致）
const colorsPath = join(RES, 'values', 'ic_launcher_background.xml');
writeFileSync(colorsPath, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#FFFFFF</color>\n</resources>\n`);
console.log('✓ ic_launcher_background.xml → #FFFFFF');
console.log('应用完成');
