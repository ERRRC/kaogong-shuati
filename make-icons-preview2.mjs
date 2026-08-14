// make-icons-preview2.mjs — 第二版图标：轻量诙谐风（上岸鸭/锦鲤/拟人书/咸鱼/铜钱袋）
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const OUT = 'icon-preview';
mkdirSync(OUT, { recursive: true });

const VERSIONS = {
  A: { name: 'A · 上岸鸭', desc: '谐音梗「上岸鸭」：天蓝水面 + 小黄鸭，考公圈最火的梗' },
  B: { name: 'B · 锦鲤', desc: '「转发锦鲤」上岸梗：薄荷绿底 + 白色锦鲤跃出水面' },
  C: { name: 'C · 笑面书', desc: '拟人化：一本咧嘴笑的书，轻快治愈、做题不苦' },
  D: { name: 'D · 咸鱼翻身', desc: '「咸鱼翻身」梗：深夜蓝底 + 白色微笑咸鱼，自嘲又励志' },
  E: { name: 'E · 铜钱袋', desc: '自嘲「没钱」：暖黄底 + 鼓鼓钱袋 + 金色方孔铜钱，求上岸发财' },
};

// 通用：浅色圆角方/圆底（不同版本底色不同）
function bg(shape, color) {
  const bg = shape === 'round'
    ? `<circle cx="96" cy="96" r="94" fill="${color}"/>`
    : `<rect x="4" y="4" width="184" height="184" rx="46" fill="${color}"/>`;
  return bg;
}

// ---- A：上岸鸭（天蓝底 + 小黄鸭站在水面）----
function svgA(shape) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg(shape, '#7dd3fc')}
  <g transform="translate(96 106) scale(0.92) translate(-96 -106)">
    <!-- 水面（两段波浪） -->
    <path d="M30 118 Q48 108 66 118 Q84 128 102 118 Q120 108 138 118 Q156 128 170 118 L170 134 L30 134 Z" fill="#38bdf8" opacity="0.9"/>
    <path d="M30 128 Q48 118 66 128 Q84 138 102 128 Q120 118 138 128 Q156 138 170 128" fill="none" stroke="#bae6fd" stroke-width="4" stroke-linecap="round"/>
    <!-- 鸭身 -->
    <ellipse cx="96" cy="96" rx="40" ry="32" fill="#fde047"/>
    <!-- 鸭头 -->
    <circle cx="124" cy="66" r="22" fill="#fde047"/>
    <!-- 鸭嘴 -->
    <path d="M142 66 Q158 70 142 76 Q136 72 142 66 Z" fill="#f97316"/>
    <!-- 眼睛 -->
    <circle cx="130" cy="62" r="4.5" fill="#0f172a"/>
    <circle cx="131.5" cy="60.5" r="1.6" fill="#fff"/>
    <!-- 翅膀 -->
    <path d="M80 92 Q70 104 82 112 Q96 108 96 96 Z" fill="#facc15"/>
    <!-- 腮红 -->
    <circle cx="120" cy="76" r="5" fill="#fda4af" opacity="0.8"/>
  </g>
</svg>`;
}

// ---- B：锦鲤（薄荷绿底 + 白色锦鲤跃出）----
function svgB(shape) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg(shape, '#a7f3d0')}
  <g transform="translate(96 98) scale(0.9) translate(-96 -98)">
    <!-- 水面 -->
    <path d="M26 118 Q42 110 58 118 Q74 126 90 118 Q106 110 122 118 Q138 126 154 118 Q168 112 168 118 L168 134 L26 134 Z" fill="#34d399" opacity="0.75"/>
    <!-- 鱼身 -->
    <path d="M60 86 Q78 58 108 62 Q132 66 138 88 Q132 112 106 116 Q76 118 60 86 Z" fill="#ffffff"/>
    <!-- 鱼尾 -->
    <path d="M60 86 Q42 74 36 62 Q50 74 56 84 Z" fill="#ffffff"/>
    <path d="M60 86 Q42 98 38 110 Q50 98 58 88 Z" fill="#ffffff"/>
    <!-- 眼睛 -->
    <circle cx="122" cy="80" r="5" fill="#0f172a"/>
    <circle cx="123.5" cy="78.5" r="1.8" fill="#fff"/>
    <!-- 背鳍 -->
    <path d="M96 64 Q104 50 112 62 Z" fill="#ffffff" opacity="0.9"/>
    <!-- 水花 -->
    <circle cx="78" cy="60" r="3" fill="#ffffff"/>
    <circle cx="66" cy="66" r="2.2" fill="#ffffff"/>
    <circle cx="86" cy="52" r="2" fill="#ffffff"/>
  </g>
</svg>`;
}

// ---- C：笑面书（奶白底 + 蓝色咧嘴笑的书）----
function svgC(shape) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg(shape, '#fef3c7')}
  <g transform="translate(96 96) scale(0.88) translate(-96 -96)">
    <!-- 书身（打开的书 = 笑脸轮廓） -->
    <path d="M96 70 L52 58 L52 122 L96 134 Z" fill="#3b82f6"/>
    <path d="M96 70 L140 58 L140 122 L96 134 Z" fill="#60a5fa"/>
    <path d="M92 66 L100 66 L100 136 L92 136 Z" fill="#1d4ed8"/>
    <!-- 左眼 -->
    <circle cx="74" cy="90" r="7" fill="#ffffff"/>
    <circle cx="76" cy="92" r="3" fill="#1e3a8a"/>
    <!-- 右眼 -->
    <circle cx="118" cy="90" r="7" fill="#ffffff"/>
    <circle cx="120" cy="92" r="3" fill="#1e3a8a"/>
    <!-- 咧嘴笑 -->
    <path d="M76 108 Q96 126 116 108" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/>
    <!-- 腮红 -->
    <circle cx="66" cy="104" r="5" fill="#fda4af" opacity="0.85"/>
    <circle cx="126" cy="104" r="5" fill="#fda4af" opacity="0.85"/>
  </g>
</svg>`;
}

// ---- D：咸鱼翻身（深夜蓝底 + 白色微笑咸鱼 + 翻转弧线）----
function svgD(shape) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg(shape, '#312e81')}
  <g transform="translate(96 100) scale(0.92) translate(-96 -100)">
    <!-- 翻身弧线（动态感） -->
    <path d="M56 118 Q96 96 138 116" fill="none" stroke="#818cf8" stroke-width="5" stroke-linecap="round" stroke-dasharray="2 14"/>
    <!-- 咸鱼身 -->
    <path d="M62 92 Q70 72 96 72 Q122 72 130 92 Q134 106 96 112 Q58 106 62 92 Z" fill="#e2e8f0"/>
    <!-- 鱼头（左侧） -->
    <circle cx="70" cy="90" r="6" fill="#cbd5e1"/>
    <circle cx="68" cy="88" r="2.4" fill="#0f172a"/>
    <!-- 微笑嘴 -->
    <path d="M64 98 Q70 104 78 99" fill="none" stroke="#64748b" stroke-width="3" stroke-linecap="round"/>
    <!-- 尾鳍 -->
    <path d="M130 92 L146 84 L144 96 L146 108 L130 100 Z" fill="#cbd5e1"/>
    <!-- 背鳍 -->
    <path d="M86 72 Q92 60 98 72 Z" fill="#cbd5e1"/>
    <!-- 鳞片线 -->
    <path d="M88 84 Q96 90 104 84 M88 98 Q96 104 104 98" fill="none" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round"/>
  </g>
</svg>`;
}

// ---- E：铜钱袋（暖黄底 + 鼓鼓钱袋 + 方孔铜钱）----
function svgE(shape) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  ${bg(shape, '#fde68a')}
  <g transform="translate(96 102) scale(0.92) translate(-96 -102)">
    <!-- 钱袋 -->
    <path d="M60 92 Q60 62 96 62 Q132 62 132 92 Q132 126 96 126 Q60 126 60 92 Z" fill="#b45309"/>
    <path d="M60 92 Q96 102 132 92" fill="none" stroke="#92400e" stroke-width="4"/>
    <!-- 束口 -->
    <path d="M70 66 Q96 56 122 66 L118 74 Q96 64 74 74 Z" fill="#78350f"/>
    <rect x="66" y="60" width="60" height="8" rx="4" fill="#d97706"/>
    <!-- 铜钱 -->
    <circle cx="96" cy="92" r="17" fill="#fbbf24"/>
    <circle cx="96" cy="92" r="10" fill="#f59e0b"/>
    <rect x="89" y="84" width="14" height="16" rx="2" fill="#fbbf24"/>
    <path d="M91 88 L96 92 L101 88 M91 100 L96 96 L101 100" fill="none" stroke="#b45309" stroke-width="1.8"/>
  </g>
</svg>`;
}

const svgMap = { A: svgA, B: svgB, C: svgC, D: svgD, E: svgE };

const previewCards = [];
for (const [key, def] of Object.entries(VERSIONS)) {
  const square = join(OUT, `v2-${key}-square.png`);
  const round = join(OUT, `v2-${key}-round.png`);
  await sharp(Buffer.from(svgMap[key]('square'))).resize(256, 256).png().toFile(square);
  await sharp(Buffer.from(svgMap[key]('round'))).resize(256, 256).png().toFile(round);
  console.log('✓', key, def.name);
  previewCards.push({ key, ...def, square, round });
}

const cards = previewCards.map((c) => `
  <div class="card">
    <div class="icons">
      <img src="v2-${c.key}-square.png" alt="方形"/>
      <img src="v2-${c.key}-round.png" alt="圆形"/>
    </div>
    <div class="name">${c.name}</div>
    <div class="desc">${c.desc}</div>
  </div>`).join('');

writeFileSync(join(OUT, 'preview-v2.html'), `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><title>App 图标方案预览 · 第二版（轻量诙谐风）</title>
<style>
  body { background:#f8fafc; color:#1e293b; font-family: system-ui, 'Microsoft YaHei', sans-serif; margin:0; padding:40px 24px; }
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
  <h1>🎈 第二版：轻量诙谐风（请选择）</h1>
  <div class="sub">左为方形 · 右为圆形 · 告诉我用哪一版（如 "A"），或者还要继续调</div>
  <div class="grid">${cards}</div>
</body>
</html>`);
console.log('✓ preview-v2.html 已生成');
