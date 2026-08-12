// 裁剪器纯逻辑单元测试（node test-crop-math.mjs）
await import('./public/crop-math.js'); // ESM 环境下以副作用挂到 globalThis
const M = globalThis.CropMath;
const { clampV, resizeRect, moveRect, calcCropOutput, OCR_MAX_W } = M;

let pass = 0, fail = 0;
function t(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n    got  ${g}\n    want ${w}`); }
}
function near(name, got, want, eps = 0.6) {
  const ok = Math.abs(got - want) <= eps;
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}: got ${got}, want ~${want}`); }
}

console.log('== clampV ==');
t('clamp within', clampV(5, 0, 10), 5);
t('clamp low', clampV(-3, 0, 10), 0);
t('clamp high', clampV(13, 0, 10), 10);

console.log('== resizeRect（锚点缩放 + 边界 + 最小尺寸） ==');
const view = { x: 10, y: 20, w: 300, h: 400 };
// 从右下角往左上拖（锚点=右下角），框应跟随
let r = resizeRect(60, 80, 200, 220, view);
t('se->nw 拖拽', r, { x: 60, y: 80, w: 140, h: 140 });
// 拖出左边界：x1 clamp 到 view.x
r = resizeRect(-50, 100, 200, 220, view);
t('拖出左边界 clamp', { x: r.x, w: r.w }, { x: 10, w: 190 });
// 拖到 0 尺寸：最小 48 对称扩展
r = resizeRect(150, 150, 150, 150, view);
t('零尺寸最小扩展', r, { x: 126, y: 126, w: 48, h: 48 });

console.log('== moveRect ==');
const crop = { x: 100, y: 100, w: 80, h: 80 };
r = moveRect(150, 130, crop, view);
t('框内移动', r, { x: 150, y: 130 });
r = moveRect(400, 130, crop, view);
t('移动越界 clamp 右侧', r, { x: 230, y: 130 }); // view.x+view.w-crop.w = 310-80 = 230
r = moveRect(0, 600, crop, view);
t('移动越界 clamp 下方', r, { x: 10, y: 340 }); // 20+400-80 = 340

console.log('== calcCropOutput ==');
// 全图裁剪（crop == view）：源坐标应覆盖全图
const view2 = { x: 50, y: 30, w: 200, h: 300 };
let o = calcCropOutput(4000, 3000, { x: 50, y: 30, w: 200, h: 300 }, view2);
t('全图裁剪 → 源全图', o, { sx: 0, sy: 0, sw: 4000, sh: 3000, outW: 1600, outH: 1200 });
// 中心 1/4 区域（显示 100x150 @ (100,105)）→ 源中心 2000x1500 @ (1000,750)
o = calcCropOutput(4000, 3000, { x: 100, y: 105, w: 100, h: 150 }, view2);
t('中心 1/4 裁剪', o, { sx: 1000, sy: 750, sw: 2000, sh: 1500, outW: 1600, outH: 1200 });
// 小图（不超 1600）：不缩放
o = calcCropOutput(1200, 900, { x: 50, y: 30, w: 200, h: 300 }, view2);
t('小图不放大', o, { sx: 0, sy: 0, sw: 1200, sh: 900, outW: 1200, outH: 900 });
// 窄长裁剪：宽度超限时按宽等比缩放（sh = 60/300*3000 = 600 → outH = 600*1600/4000 = 240）
o = calcCropOutput(4000, 3000, { x: 50, y: 30, w: 200, h: 60 }, view2);
t('窄长等比缩放', { outW: o.outW, outH: o.outH }, { outW: 1600, outH: 240 });
// 竖图（旋转 90° 后 3000x4000）：全图 → outW 1600 outH 2133
o = calcCropOutput(3000, 4000, { x: 50, y: 30, w: 200, h: 300 }, view2);
t('竖图全图（旋转后）', { outW: o.outW, outH: o.outH }, { outW: 1600, outH: 2133 });
// 裁剪框贴着视图右下（浮点边界）：sx+sw 不越出源图（1998+2002=4000 恰好）
o = calcCropOutput(4000, 3000, { x: 149.9, y: 229.9, w: 100.1, h: 100.1 }, view2);
t('右下角裁剪不越界', { sx: o.sx, sw: o.sw, sy: o.sy, sh: o.sh }, { sx: 1998, sw: 2002, sy: 1999, sh: 1001 });

console.log(`\nOCR_MAX_W = ${OCR_MAX_W}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
