/* ===== 裁剪器纯逻辑（无 DOM，可在 Node 中单测） =====
 * 显示坐标系：裁剪框 crop/view 均相对画布 CSS 像素；
 * 源坐标系：旋转后的原图画布（像素）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof globalThis !== 'undefined') globalThis.CropMath = factory();
  else root.CropMath = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // OCR 上传图片最大宽（手写识别需要足够分辨率；超宽等比缩放）
  const OCR_MAX_W = 1600;

  function clampV(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /** 拖拽缩放裁剪框（锚点 = 对角点）。返回新 {x,y,w,h}，含最小尺寸与视图边界约束。 */
  function resizeRect(px, py, anchorX, anchorY, view, MIN = 48) {
    let x1 = Math.min(px, anchorX), x2 = Math.max(px, anchorX);
    let y1 = Math.min(py, anchorY), y2 = Math.max(py, anchorY);
    x1 = clampV(x1, view.x, view.x + view.w);
    x2 = clampV(x2, view.x, view.x + view.w);
    y1 = clampV(y1, view.y, view.y + view.h);
    y2 = clampV(y2, view.y, view.y + view.h);
    // 最小尺寸：以当前中心对称扩展，避免拖拽到 0 时框"翻边"
    if (x2 - x1 < MIN) {
      const mid = (x1 + x2) / 2;
      x1 = clampV(mid - MIN / 2, view.x, view.x + view.w);
      x2 = clampV(mid + MIN / 2, view.x, view.x + view.w);
    }
    if (y2 - y1 < MIN) {
      const mid = (y1 + y2) / 2;
      y1 = clampV(mid - MIN / 2, view.y, view.y + view.h);
      y2 = clampV(mid + MIN / 2, view.y, view.y + view.h);
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  /** 移动裁剪框（拖拽框内）。返回新 {x,y}，约束在视图内。 */
  function moveRect(dx, dy, crop, view) {
    return {
      x: clampV(dx, view.x, view.x + view.w - crop.w),
      y: clampV(dy, view.y, view.y + view.h - crop.h),
    };
  }

  /** 显示坐标裁剪框 → 源坐标裁剪区域 + 输出尺寸。
   *  srcW/srcH：旋转后原图宽高；crop/view：显示坐标。
   *  返回 { sx, sy, sw, sh, outW, outH }（均已取整并 clamp，输出 ≤ maxW 宽等比缩放）。 */
  function calcCropOutput(srcW, srcH, crop, view, maxW = OCR_MAX_W) {
    const sw = Math.max(1, Math.round((crop.w / view.w) * srcW));
    const sh = Math.max(1, Math.round((crop.h / view.h) * srcH));
    const sx = Math.max(0, Math.min(srcW - sw, Math.round(((crop.x - view.x) / view.w) * srcW)));
    const sy = Math.max(0, Math.min(srcH - sh, Math.round(((crop.y - view.y) / view.h) * srcH)));
    let outW = sw, outH = sh;
    if (outW > maxW) { outH = Math.max(1, Math.round((outH * maxW) / outW)); outW = maxW; }
    return { sx, sy, sw, sh, outW, outH };
  }

  return { OCR_MAX_W, clampV, resizeRect, moveRect, calcCropOutput };
});
