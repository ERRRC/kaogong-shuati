/* ===== 考公刷题 - 前端逻辑（原生 JS SPA） ===== */
'use strict';

/* ===== 图片离线兜底（SW 不可用环境：Capacitor WebView） =====
 * Capacitor WebView 中 Service Worker 无法注册（虚拟 https://localhost 不走 SW 网络栈），
 * 而公式图/真图形的离线显示原本依赖 SW 拦截。这里做前端兜底：
 * img 加载失败（error 事件）时，从 IndexedDB 取打包的公式图（kaogong_images_db，
 * 由 sqljs-engine 启动时从 images.db 导入）或已缓存真图形（kaogong_imgcache_db）。
 * 在线场景不受影响（CDN 正常加载不触发 error）；PC 浏览器 SW 可用，兜底不干扰。
 */
(function () {
  if (typeof indexedDB === 'undefined') return;
  const IMG_DB = 'kaogong_images_db';
  const IMG_STORE = 'images';
  const CACHE_DB = 'kaogong_imgcache_db';
  const CACHE_STORE = 'imgs';
  const PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="100%" height="100%" fill="#f2f2f7"/><text x="50%" y="50%" font-size="14" fill="#999" text-anchor="middle" dominant-baseline="middle">图片需联网查看</text></svg>');

  function idbGet(dbName, storeName, key) {
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(dbName, 1); } catch { resolve(null); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(storeName)) d.createObjectStore(storeName);
      };
      req.onsuccess = () => {
        const d = req.result;
        try {
          const tx = d.transaction(storeName, 'readonly');
          const r = tx.objectStore(storeName).get(key);
          r.onsuccess = () => resolve(r.result || null);
          r.onerror = () => resolve(null);
        } catch { resolve(null); }
      };
      req.onerror = () => resolve(null);
    });
  }

  async function fallback(img, src) {
    try {
      if (!src || img.dataset.offlineFb) return;
      img.dataset.offlineFb = '1';
      // 公式图：/formula/<key>（本地改写路径）或 CDN formulas?latex=<key>
      // 注意 src 可能是绝对 URL（currentSrc）也可能是相对路径（getAttribute）→ 两者都兼容
      let key = null;
      const fm = src.match(/^(?:https?:\/\/[^/]*)?\/formula\/(.+)$/);
      if (fm) key = decodeURIComponent(fm[1]);
      else {
        const lm = src.match(/[?&]latex=([^&"]+)/);
        if (lm) key = decodeURIComponent(lm[1]);
      }
      if (key) {
        const hit = await idbGet(IMG_DB, IMG_STORE, key);
        if (hit && hit.blob) { img.src = URL.createObjectURL(hit.blob); return; }
        img.src = PLACEHOLDER;
        return;
      }
      // 真图形：tarzan CDN URL → 查已缓存（无 SW 时无写入，命中即显示）
      if (/\/tarzan\/images\//i.test(src)) {
        const c = await idbGet(CACHE_DB, CACHE_STORE, src);
        if (c && c.blob) { img.src = URL.createObjectURL(c.blob); return; }
        img.src = PLACEHOLDER;
      }
    } catch { /* 兜底失败保持原样 */ }
  }

  // 捕获阶段拦截所有 <img> error（动态渲染的图片同样覆盖）
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLImageElement)) return;
    // 优先原始 src（getAttribute），currentSrc 会被解析成绝对 URL 导致相对路径匹配失败
    fallback(t, t.getAttribute('src') || t.currentSrc || '');
  }, true);
})();

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

const api = async (path, opts) => {
  // 本地模式（无服务器）：window.__LOCAL_API_PROMISE__ 由 local-bootstrap.js 设置，
  // 就绪后所有请求走本地路由（IndexedDB + sql.js 题库 + AI 直调）
  if (window.__LOCAL_API_PROMISE__) {
    const handler = await window.__LOCAL_API_PROMISE__;
    return handler(path, opts);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
};

const SUBJECT_ICONS = {
  '公务员·行测': '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 9-11 9 11"/><path d="M3 21h18"/><path d="m8 14 4-5 4 5"/></svg>',
  '公务员·申论': '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  '事业编·综应': '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5Z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/><path d="M9 7h7M9 11h5"/></svg>',
  '事业编·职测': '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 16v-5M12 16V8M16 16v-3"/></svg>',
};
const SUBJECT_DESC = {
  '公务员·行测': '言语·判断·资料·数量·常识',
  '公务员·申论': '归纳概括·综合分析·大作文',
  '事业编·综应': '归纳概括·综合分析·大作文',
  '事业编·职测': '言语·判断·资料·数量·常识',
};

/* 统一线性图标库：与快捷入口/科目卡同风格的白色描边 SVG（stroke=currentColor 随父级颜色） */
const ICO = {
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5Z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  bookOpen: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2Z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7Z"/>',
  bookX: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5Z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/><path d="m9.5 8 5 5M14.5 8l-5 5"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderTree: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M8 14h3M12 14h8"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M8 8h.01M16 16h.01M8 16h.01M16 8h.01"/>',
  play: '<path d="M5 3l14 9-14 9V3Z"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9Z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 16v-3M12 16V8M17 16v-6"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  home: '<path d="M3 9.5 12 3l9 6.5V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22v-8h6v8"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
  lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  trendingUp: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  flask: '<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z"/><path d="M4 22v-7"/>',
};
const ico = (name, size = 18, sw = 2) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICO[name] || ''}</svg>`;

const store = {
  subjects: [],
  state: { view: 'home', subject: null, chapter: null, mode: null, questions: [], idx: 0, results: [], answers: [], timing: null },
  wrong: JSON.parse(localStorage.getItem('wrong_questions') || '[]'), // [{id, content, answer, myAnswer, subject, chapter, time}]
  fav: new Set(), // 收藏题 id（服务端跨设备同步）
  navStack: [], // 导航栈：{name, subject, category, paperId, chapter, mock}，goBack 时逐级回退
};

// ---------- 答题辅助 ----------
const LETTERS = 'ABCDEFGH';
/** 前端判分（客观题）：返回 { ok, correct:number[], valid }；valid=false 表示无标准答案 */
function judge(q, sel) {
  const selected = (Array.isArray(sel) ? sel : [sel]).map(Number);
  const ans = String(q.answer ?? '').trim();
  // 多选：JSON 数组 或 逗号分隔数字（"0,1,2"）；兼容双层 JSON（如 "[[2,3]]"，JSON.parse 后取第一层）
  if (ans.startsWith('[')) {
    let parsed = JSON.parse(ans);
    if (Array.isArray(parsed) && parsed.length && Array.isArray(parsed[0])) parsed = parsed[0];
    const correct = parsed.map(Number);
    return { ok: correct.length === selected.length && correct.every((v) => selected.includes(v)), correct, valid: true };
  }
  if (ans && /^[\d,\s]+$/.test(ans) && ans.includes(',')) {
    const correct = ans.split(',').map(Number);
    return { ok: correct.length === selected.length && correct.every((v) => selected.includes(v)), correct, valid: true };
  }
  // 判断/无选项题
  if (!(q.options || []).length) {
    if (!ans) return { ok: false, correct: [], valid: false };
    const a = Number(ans);
    return { ok: selected[0] === a, correct: [a], valid: true };
  }
  // 单选：answerIndex 优先，其次单数字 answer
  if (q.answerIndex != null && q.answerIndex >= 0) {
    return { ok: selected[0] === q.answerIndex, correct: [q.answerIndex], valid: true };
  }
  if (ans && /^\d+$/.test(ans)) {
    const a = Number(ans);
    return { ok: selected[0] === a, correct: [a], valid: true };
  }
  return { ok: false, correct: [], valid: false }; // 真正无答案
}
function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
function startTimer(limitSec) {
  const s = store.state;
  if (s.timing && s.timing.timerId) clearInterval(s.timing.timerId);
  // limitSec > 0 → 考试倒计时模式（组卷）：剩余时间递减，到 0 自动交卷；否则为正计时（普通练习）
  s.timing = { elapsed: 0, running: true, timerId: null, limit: limitSec > 0 ? limitSec : null, remaining: limitSec > 0 ? limitSec : 0 };
  const tick = () => {
    const t = s.timing;
    if (!t || !t.running) return;
    t.elapsed++;
    if (t.limit) {
      t.remaining--;
      if (t.remaining <= 0) {
        t.remaining = 0;
        t.running = false;
        clearInterval(t.timerId);
        t.timerId = null;
        renderTimerText();
        toast('考试时间到，已自动交卷');
        submitExam(true);
        return;
      }
    }
    renderTimerText();
  };
  s.timing.timerId = setInterval(tick, 1000);
  renderTimerText();
}
/** 计时条文本：倒计时模式显示剩余时间，正计时模式显示已用时间 */
function renderTimerText() {
  const s = store.state;
  const el = $('#timer-text');
  if (!el || !s.timing) return;
  el.textContent = s.timing.limit ? fmtTime(s.timing.remaining) : fmtTime(s.timing.elapsed);
}
function pauseToggle() {
  const s = store.state;
  if (!s.timing) return;
  s.timing.running = !s.timing.running;
  const btn = $('#btn-pause');
  if (btn) btn.innerHTML = s.timing.running ? ico('pause', 14) : ico('play', 14);
  renderTimerText();
}
/** 是否处于暂停状态（暂停期间题目完全冻结：不能作答/排除/翻题/看解析/交卷） */
function paused() {
  const t = store.state.timing;
  return !!(t && !t.running);
}
/** 上一题（按钮与滑动共用；暂停时冻结） */
function prevQuestion() {
  const s = store.state;
  if (paused()) { toast('已暂停，先点继续再操作'); return; }
  confirmPendingMulti();   // 多选已选未确认 → 切题时自动判分（不点确认也算已作答）
  stampCost(s.idx);
  if (s.idx > 0) { s.idx--; renderQuestion(); } else toast('已是第一题');
}
/** 下一题（按钮与滑动共用；暂停时冻结） */
function nextQuestion() {
  const s = store.state;
  if (paused()) { toast('已暂停，先点继续再操作'); return; }
  confirmPendingMulti();
  stampCost(s.idx);
  const total = s.questions.length;
  if (s.idx < total - 1) { s.idx++; renderQuestion(); } else toast('已是最后一题，可交卷');
}
/** 多选已选未确认时自动判分（滑动切题 = 隐含确认；单选本就在 recordAnswer 判分，此处只处理多选） */
function confirmPendingMulti() {
  const s = store.state;
  const i = s.idx;
  const q = s.questions[i];
  if (!q) return;
  const ans = String(q.answer ?? '').trim();
  const isMulti = ans.startsWith('[') || (/^[\d,\s]+$/.test(ans) && ans.includes(','));
  const a = s.answers[i];
  if (!isMulti || !a || a.selected == null || a.selected.length === 0) return;
  if (a.correct != null) return; // 已确认过
  const j = judge(q, a.selected);
  a.correct = j.valid ? j.ok : null;
}
function stopTimer() {
  const s = store.state;
  if (s.timing && s.timing.timerId) clearInterval(s.timing.timerId);
}
/** 累计当前题用时 */
function stampCost(idx) {
  const s = store.state;
  const q = s.questions[idx];
  if (!q || !q._t0) return;
  const cost = Date.now() - q._t0;
  if (!s.answers[idx]) s.answers[idx] = { selected: null, correct: null, costMs: 0 };
  s.answers[idx].costMs = (s.answers[idx].costMs || 0) + cost;
  delete q._t0;
}
/** 记录答案并（客观题）自动下一题 */
function recordAnswer(q, sel) {
  const s = store.state;
  stampCost(s.idx);
  const j = judge(q, sel);
  if (!s.answers[s.idx]) s.answers[s.idx] = { selected: null, correct: null, costMs: 0 };
  s.answers[s.idx].selected = (Array.isArray(sel) ? sel : [sel]).map(Number).sort((a, b) => a - b);
  s.answers[s.idx].correct = j.valid ? j.ok : null; // 无答案题 correct=null
  // 最后一题：无漏答自动交卷
  if (s.idx >= s.questions.length - 1) {
    const unanswered = s.questions.map((_, i) => i).filter((i) => !s.answers[i] || s.answers[i].selected == null);
    if (!unanswered.length) submitExam();
    else toast(`已答完，还有 ${unanswered.length} 题未答，可交卷或继续检查`);
    return;
  }
  s.idx++;
  renderQuestion();
}

function saveWrong() {
  localStorage.setItem('wrong_questions', JSON.stringify(store.wrong.slice(0, 500)));
}

// ---------- 视图切换 ----------
function setView(name) {
  cropSession++;          // 任何页面切换：使未完成的裁剪会话失效
  closeCropEditor();      // 清理可能残留的裁剪器 overlay
  store.state.view = name;
  if (window.Telemetry) Telemetry.track('page_view', { page: name }); // 使用统计：页面访问
  const navBtns = document.querySelectorAll('#bottom-nav .nav-item');
  navBtns.forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  const showNav = ['home', 'papers', 'wrong', 'fav'].includes(name);
  $('#bottom-nav').style.display = showNav ? 'flex' : 'none';
  $('#view').classList.toggle('no-bottom', !showNav);
  $('#view').removeAttribute('data-exam'); // 离开做题页：滑动切题/长按排除失效
  $('#btn-back').style.visibility = (name === 'home') ? 'hidden' : 'visible';
}

function goBack() {
  const stack = store.navStack;
  stack.pop(); // 移除当前页
  const top = stack[stack.length - 1];
  if (!top) { renderHome(); return; }
  if (top.name === 'subject') renderSubject(top.subject, true);
  else if (top.name === 'category') renderCategory(top.subject, top.category, true);
  else if (top.name === 'paper-detail') renderPaperDetail(top.subject, top.paperId, true);
  else if (top.name === 'practice') renderPractice(top.subject, top.chapter || null, null, top.mock ?? '0', true);
  else if (top.name === 'wrong') renderWrong();
  else if (top.name === 'fav') renderFavorites();
  else if (top.name === 'custom-bank') renderCustomBank(true);
  else if (top.name === 'custom-batch') renderCustomBatch(top.batchId, true);
  else renderHome();
}

/** 退出单题重练：弹出 single 与来源层（wrong/fav）两层，避免残留污染后续导航 */
function exitSingle() {
  const stack = store.navStack;
  const src = stack[stack.length - 2]; // single 之下的来源层
  stack.pop(); // single
  stack.pop(); // 来源层
  if (src && src.name === 'fav') renderFavorites();
  else if (src && src.name === 'wrong') renderWrong();
  else renderHome();
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- 返回手势处理（标准方案：系统返回事件，非手写 touch 监听） ----------
// Android 的系统手势导航（左缘右滑/右缘左滑/底部上滑）与硬件返回键统一触发 backButton 事件
// （Capacitor App 插件，官方文档推荐做法）——比自监听 touch 可靠：不与系统手势抢事件、不受边缘像素判定影响。
// 层级处理：裁剪器 → 弹层 → 页面返回（goBack）→ 首页退出 App。
// 纯浏览器（联调）：无系统手势，保留轻量 touch 边缘监听作降级。
(function initBackHandler() {
  const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (App) {
    App.addListener('backButton', () => {
      const crop = document.querySelector('.crop-overlay');
      if (crop) { closeCropEditor(); return; }          // 裁剪器优先关闭
      const sheet = document.querySelector('.sheet-overlay');
      if (sheet) { sheet.remove(); return; }            // 弹层优先关闭
      const back = $('#btn-back');
      if (back && back.style.visibility !== 'hidden') { goBack(); return; } // 页面返回
      // 首页/无上级页面：不直接退出，2 秒内再按一次才退出（避免误滑直接退 App）
      const now = Date.now();
      if (window.__lastBackTs && now - window.__lastBackTs < 2000) {
        window.__lastBackTs = 0;
        App.exitApp();
        return;
      }
      window.__lastBackTs = now;
      toast('再按一次返回键退出 App');
    });
    return; // native：不注册 touch 监听（避免与系统手势冲突/双重返回）
  }
  if (!('ontouchstart' in window)) return;
  // 浏览器联调降级：左缘右滑 / 右缘左滑 → 返回
  const EDGE = 35, THRESHOLD = 60;
  let edge = null, sx = 0, sy = 0;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (document.querySelector('.crop-overlay, .sheet-overlay')) return;
    const x = e.touches[0].clientX;
    if (x <= EDGE) edge = 'left';
    else if (x >= window.innerWidth - EDGE) edge = 'right';
    else edge = null;
    if (edge) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!edge || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
    const ok = edge === 'left' ? dx > THRESHOLD : dx < -THRESHOLD;
    if (ok && Math.abs(dx) > Math.abs(dy) * 1.4) {
      edge = null;
      const back = $('#btn-back');
      if (back && back.style.visibility !== 'hidden') goBack();
    }
  }, { passive: true });
  document.addEventListener('touchend', () => { edge = null; });
  document.addEventListener('touchcancel', () => { edge = null; });
})();

// ---------- 题目区滑动切题（左滑=下一题、右滑=上一题；仅做题态、仅屏幕中部，不与边缘返回手势冲突） ----------
(function initSwipeNav() {
  if (!('ontouchstart' in window)) return;
  const EDGE = 35, THRESHOLD = 70; // 边缘留给返回手势（native 走系统 backButton，浏览器联调走左/右缘滑动）
  let sx = 0, sy = 0, tracking = false;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (!document.querySelector('#view[data-exam]')) return; // 非做题态
    if (paused()) return;                                    // 暂停冻结
    if (document.querySelector('.sheet-overlay, .crop-overlay')) return;
    const x = e.touches[0].clientX;
    if (x <= EDGE || x >= window.innerWidth - EDGE) return;  // 边缘不抢返回手势
    tracking = true;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!tracking || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
    // 横向位移优先且超阈值才翻题（避免与页面纵向滚动冲突）
    if (Math.abs(dx) > Math.abs(dy) * 1.4 && Math.abs(dx) > THRESHOLD) {
      tracking = false;
      if (dx < 0) nextQuestion(); else prevQuestion();
    }
  }, { passive: true });
  document.addEventListener('touchend', () => { tracking = false; });
  document.addEventListener('touchcancel', () => { tracking = false; });
})();

// ---------- 登录 / 个人中心 ----------
// ---------- 首页 ----------
async function renderHome() {
  setView('home');
  $('#app-title').textContent = '没钱考什么公';
  const view = $('#view');
  view.innerHTML = '<div class="spinner"></div>';
  try {
    const [subjects, stats] = await Promise.all([
      api('/api/subjects'),
      api('/api/records/stats').catch(() => null),
    ]);
    store.subjects = subjects;
    view.innerHTML = '';

    // Hero：今日作答卡
    const hasData = stats && stats.total > 0;
    const hero = el('div', 'hero', `
      <div class="hero-eyebrow">EXAM ARCHIVE · ${hasData ? '你的学习档案' : '新档案'}</div>
      <div class="hero-title">${hasData ? '继续保持，坚持就是上岸' : '开始刷第一道题'}</div>
      <div class="hero-stats">
        ${hasData ? `
          <div class="hero-stat"><div class="hs-num">${stats.total}</div><div class="hs-label">累计做题</div></div>
          <div class="hero-stat"><div class="hs-num">${stats.rate}%</div><div class="hs-label">正确率</div></div>
          <div class="hero-stat"><div class="hs-num">${stats.wrong}</div><div class="hs-label">待订错题</div></div>
        ` : `
          <div class="hero-stat"><div class="hs-num">0</div><div class="hs-label">累计做题</div></div>
          <div class="hero-stat"><div class="hs-num">—</div><div class="hs-label">正确率</div></div>
        `}
      </div>
      <button class="hero-cta" id="hero-cta"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3Z"/></svg> ${hasData ? '继续学习' : '开始刷题'}</button>
    `);
    view.appendChild(hero);
    $('#hero-cta').onclick = () => { if (store.subjects[0]) renderPractice(store.subjects[0].subjectName, null, null, '0'); };

    // 题库网格（试卷封面卡）
    const grid = el('div', 'subject-grid');
    // 自定义题库入口卡（2026-08-15：文件导入 → 批次 → 刷题）
    const customCard = el('div', 'subject-card custom-entry', `
      <span class="emoji tint-cyan"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg></span>
      <div class="name">自定义题库</div>
      <div class="desc">导入 PDF / Excel / Word / TXT 题目，自由刷题</div>
      <div class="stat-line"><span id="custom-batch-count">加载中…</span></div>
    `);
    customCard.onclick = () => renderCustomBank();
    grid.appendChild(customCard);
    api('/api/custom/batches').then((d) => {
      const el0 = $('#custom-batch-count');
      if (el0) el0.innerHTML = d.batches.length ? `<b>${d.batches.length}</b> 个批次 · <b>${d.batches.reduce((s, b) => s + b.count, 0)}</b> 题` : '暂无批次，点击导入';
    }).catch(() => { const el0 = $('#custom-batch-count'); if (el0) el0.textContent = '点击导入'; });
    const SUBJECT_TINTS = {
      '公务员·行测': 'tint-orange',
      '公务员·申论': 'tint-green',
      '事业编·综应': 'tint-violet',
      '事业编·职测': 'tint-blue',
    };
    for (const s of subjects) {
      const card = el('div', 'subject-card', `
        <span class="emoji ${SUBJECT_TINTS[s.subjectName] || ''}">${SUBJECT_ICONS[s.subjectName] || ''}</span>
        <div class="name">${s.subjectName}</div>
        <div class="desc">${SUBJECT_DESC[s.subjectName] || ''}</div>
        <div class="stat-line">
          <span><b>${s.papers}</b> 套</span>
          <span><b>${s.done || 0}/${s.questions}</b> 题</span>
        </div>
      `);
      card.onclick = () => renderSubject(s.subjectName);
      grid.appendChild(card);
    }
    view.appendChild(grid);

    // 快捷入口
    const quick = el('div', 'card', `
      <h3>快捷入口</h3>
      <div class="quick-grid">
        <div class="quick-item" id="quick-random"><span class="qi-ico qg-violet"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M8 8h.01M16 16h.01M8 16h.01M16 8h.01"/></svg></span><span class="qi-label">随机练习</span></div>
        <div class="quick-item" id="quick-wrong"><span class="qi-ico qg-coral"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5Z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/><path d="m9 12 2 2 4-4"/></svg></span><span class="qi-label" id="quick-wrong-label">错题本</span></div>
        <div class="quick-item" id="quick-fav"><span class="qi-ico qg-amber"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1Z"/></svg></span><span class="qi-label" id="quick-fav-label">收藏</span></div>
        <div class="quick-item" id="quick-ai"><span class="qi-ico qg-blue"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9Z"/></svg></span><span class="qi-label">AI 设置</span></div>
        <div class="quick-item" id="quick-paper"><span class="qi-ico qg-orange"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg></span><span class="qi-label">智能组卷</span></div>
      </div>
    `);
    view.appendChild(quick);
    $('#quick-random').onclick = () => { if (store.subjects[0]) renderPractice(store.subjects[0].subjectName, null, null, '0'); };
    $('#quick-wrong').onclick = () => renderWrong();
    $('#quick-fav').onclick = () => renderFavorites();
    $('#quick-ai').onclick = () => renderAiSettings();
    $('#quick-paper').onclick = () => openPaperConfig();
    // 服务端错题/收藏计数（异步刷新）
    api('/api/records/stats').then((s) => {
      const lbl = $('#quick-wrong-label');
      if (lbl) lbl.textContent = `错题本${s.wrong ? ` (${s.wrong})` : ''}`;
    }).catch(() => {});
    api('/api/favorites?limit=1&offset=0').then((d) => {
      const lbl = $('#quick-fav-label');
      const total = Array.isArray(d) ? d.length : (d.total ?? 0);
      if (lbl) lbl.textContent = `收藏${total ? ` (${total})` : ''}`;
    }).catch(() => {});
  } catch (e) {
    view.innerHTML = `<div class="empty">加载失败：${e.message}</div>`;
  }
}

// ================= 自定义题库（2026-08-15：文件导入 → 批次管理 → 刷题判分） =================
let customMergeMode = false;   // 合并模式（批次页勾选）
let customSplitMode = false;   // 拆分模式（批次内勾选题目）
const customSel = new Set();   // 勾选集合（合并=批次id，拆分=题目id）

function customSheet(html, wide) {
  const o = el('div', 'sheet-overlay');
  o.innerHTML = `<div class="sheet${wide ? ' sheet-wide' : ''}">${html}</div>`;
  document.body.appendChild(o);
  o.addEventListener('click', (e) => { if (e.target === o) o.remove(); });
  return o;
}

/** 批次列表页：导入 / 合并 / 刷新 / 批次卡（刷题·拆分·改名·删除） */
async function renderCustomBank(skipNav) {
  setView('custom-bank');
  $('#app-title').textContent = '自定义题库';
  if (!skipNav) store.navStack.push({ name: 'custom-bank' });
  const view = $('#view');
  view.innerHTML = '<div class="spinner"></div>';
  try {
    const { batches } = await api('/api/custom/batches');
    view.innerHTML = '';
    const head = el('div', 'custom-head', `
      <button class="btn primary" id="cb-import">＋ 导入题目</button>
      ${batches.length > 1 ? '<button class="btn" id="cb-merge">合并批次</button>' : ''}
      <button class="btn" id="cb-refresh">刷新</button>
    `);
    view.appendChild(head);
    $('#cb-import').onclick = renderImport;
    const mb = $('#cb-merge');
    if (mb) mb.onclick = () => { customMergeMode = true; customSel.clear(); renderCustomBank(true); };
    $('#cb-refresh').onclick = () => { customMergeMode = false; renderCustomBank(true); };
    if (customMergeMode) {
      const bar = el('div', 'custom-toolbar', `
        <div class="custom-hint">勾选要合并的批次（至少 2 个）→ 执行合并（题目并入最先勾选的批次，其余删除）</div>
        <div class="custom-toolbar-btns">
          <button class="btn primary" id="cb-do-merge" disabled>执行合并</button>
          <button class="btn" id="cb-cancel-merge">取消</button>
        </div>
      `);
      view.appendChild(bar);
      $('#cb-cancel-merge').onclick = () => { customMergeMode = false; renderCustomBank(true); };
      $('#cb-do-merge').onclick = async () => {
        const ids = [...customSel].map(Number);
        if (ids.length < 2) { toast('至少勾选两个批次'); return; }
        try {
          const r = await api('/api/custom/batch/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
          toast(`合并完成：${r.count} 题`);
          customMergeMode = false; customSel.clear();
          renderCustomBank(true);
        } catch (e) { toast('合并失败：' + e.message); }
      };
    }
    if (batches.length === 0) {
      view.appendChild(el('div', 'empty', '还没有批次。点「＋ 导入题目」上传 PDF / Excel / Word / TXT 开始。'));
      return;
    }
    const list = el('div', 'custom-list');
    for (const b of batches) {
      const card = el('div', 'custom-batch', `
        ${customMergeMode ? `<label class="cb-check-wrap"><input type="checkbox" class="cb-check" data-id="${b.id}"><span></span></label>` : ''}
        <div class="cb-main" data-go="${b.id}">
          <div class="cb-name">${esc(b.name)}${(b.subject && b.subject !== '自定义') ? `<span class="cb-subject">${esc(b.subject)}</span>` : ''}</div>
          <div class="cb-meta">${b.count} 题 · ${esc(b.created_at || '')}</div>
        </div>
        <div class="cb-actions">
          <button class="mini primary" data-act="practice">刷题</button>
          <button class="mini" data-act="split">拆分</button>
          <button class="mini" data-act="rename">改名</button>
          <button class="mini danger" data-act="del">删除</button>
        </div>
      `);
      const check = card.querySelector('.cb-check');
      if (check) {
        check.onchange = () => {
          if (check.checked) customSel.add(Number(check.dataset.id)); else customSel.delete(Number(check.dataset.id));
          const btn = $('#cb-do-merge');
          if (btn) btn.disabled = customSel.size < 2;
        };
      }
      card.querySelector('[data-go]').onclick = () => renderCustomBatch(b.id);
      card.querySelector('[data-act="practice"]').onclick = (e) => { e.stopPropagation(); customPractice(b.id, b.name); };
      card.querySelector('[data-act="split"]').onclick = (e) => { e.stopPropagation(); customSplitMode = true; customSel.clear(); renderCustomBatch(b.id, true); };
      card.querySelector('[data-act="rename"]').onclick = (e) => { e.stopPropagation(); customRenameBatch(b); };
      card.querySelector('[data-act="del"]').onclick = (e) => { e.stopPropagation(); customDeleteBatch(b); };
      list.appendChild(card);
    }
    view.appendChild(list);
  } catch (e) {
    view.innerHTML = `<div class="empty">加载失败：${e.message}</div>`;
  }
}

/** 批次内题目列表：刷题 / 拆分勾选 / 单题编辑删除 */
async function renderCustomBatch(id, skipNav) {
  setView('custom-batch');
  $('#app-title').textContent = '批次题目';
  if (!skipNav) store.navStack.push({ name: 'custom-batch', batchId: id });
  const view = $('#view');
  view.innerHTML = '<div class="spinner"></div>';
  try {
    const [{ batches }, { questions }] = await Promise.all([
      api('/api/custom/batches'),
      api('/api/custom/questions?batch_id=' + id),
    ]);
    const batch = batches.find((b) => b.id === id) || { id, name: '批次' };
    view.innerHTML = '';
    const head = el('div', 'custom-head', `
      <div class="cb-title-row">
        <div class="cb-name big">${esc(batch.name)} <span class="cb-meta">${questions.length} 题</span></div>
      </div>
      <div class="custom-toolbar-btns">
        <button class="btn primary" id="cbq-practice">开始刷题</button>
        ${questions.length > 1 ? '<button class="btn" id="cbq-split">拆分勾选题目</button>' : ''}
      </div>
    `);
    view.appendChild(head);
    $('#cbq-practice').onclick = () => customPractice(batch.id, batch.name);
    const splitBtn = $('#cbq-split');
    if (splitBtn) splitBtn.onclick = () => { customSplitMode = true; customSel.clear(); renderCustomBatch(id, true); };
    if (customSplitMode) {
      const bar = el('div', 'custom-toolbar', `
        <div class="custom-hint">勾选要拆出的题目 → 拆分为新批次（其余留在原批次）</div>
        <div class="custom-toolbar-btns">
          <button class="btn primary" id="cbq-do-split" disabled>拆出为新批次</button>
          <button class="btn" id="cbq-cancel-split">取消</button>
        </div>
      `);
      view.appendChild(bar);
      $('#cbq-cancel-split').onclick = () => { customSplitMode = false; renderCustomBatch(id, true); };
      $('#cbq-do-split').onclick = async () => {
        const qids = [...customSel].map(Number);
        if (!qids.length) { toast('请先勾选题目'); return; }
        const sheet = customSheet(`
          <h3>拆分为新批次</h3>
          <label>新批次名称</label>
          <input type="text" id="split-name" value="${esc(batch.name)}-拆分1" placeholder="${esc(batch.name)}-拆分N">
          <div class="sheet-actions">
            <button class="btn primary" id="split-ok">确认拆分</button>
            <button class="btn" id="split-cancel">取消</button>
          </div>
        `);
        $('#split-cancel').onclick = () => sheet.remove();
        $('#split-ok').onclick = async () => {
          const nm = $('#split-name').value.trim();
          try {
            const r = await api('/api/custom/batch/split', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch_id: id, question_ids: qids, name: nm || undefined }) });
            sheet.remove();
            toast(`已拆出「${r.name}」${r.count} 题`);
            customSplitMode = false; customSel.clear();
            renderCustomBatch(id, true);
          } catch (e) { toast('拆分失败：' + e.message); }
        };
      };
    }
    if (questions.length === 0) {
      view.appendChild(el('div', 'empty', '该批次暂无题目。'));
      return;
    }
    const list = el('div', 'custom-qlist');
    questions.forEach((q, i) => {
      const row = el('div', 'custom-q', `
        ${customSplitMode ? `<label class="cb-check-wrap"><input type="checkbox" class="cq-check" data-id="${q.id}"><span></span></label>` : ''}
        <div class="cq-body">
          <div class="cq-no">${i + 1}</div>
          <div class="cq-main">
            <div class="cq-prompt">${esc((q.prompt || '（空题干）').slice(0, 80))}</div>
            <div class="cq-meta">
              ${q.material ? '<span class="tag">材料</span>' : ''}
              <span class="tag">${q.options.length ? q.options.length + ' 选项' : '无选项'}</span>
              <span class="tag ${q.answer ? 'ok' : ''}">${q.answer ? '答案 ' + customAnswerDisplay(q.answer, q.options) : '无答案'}</span>
              <span class="tag ${q.analysis ? 'ok' : ''}">${q.analysis ? '有解析' : '无解析'}</span>
            </div>
          </div>
        </div>
        <div class="cq-actions">
          <button class="mini" data-a="edit">编辑</button>
          <button class="mini danger" data-a="del">删除</button>
        </div>
      `);
      const check = row.querySelector('.cq-check');
      if (check) check.onchange = () => { if (check.checked) customSel.add(Number(check.dataset.id)); else customSel.delete(Number(check.dataset.id)); const b = $('#cbq-do-split'); if (b) b.disabled = customSel.size === 0; };
      row.querySelector('[data-a="edit"]').onclick = () => customEditQuestion(q, batch.name);
      row.querySelector('[data-a="del"]').onclick = () => customDeleteQuestion(q);
      list.appendChild(row);
    });
    view.appendChild(list);
  } catch (e) {
    view.innerHTML = `<div class="empty">加载失败：${e.message}</div>`;
  }
}

/** 答案显示：JSON 索引数组 → 字母 */
function customAnswerDisplay(answer, options) {
  if (/^\[/.test(answer)) {
    try { return JSON.parse(answer).map((i) => String.fromCharCode(65 + i)).join(''); } catch { return answer; }
  }
  return answer;
}

/** 刷题：复用做题流程（subject='自定义'，chapter=批次名） */
async function customPractice(batchId, name) {
  try {
    const r = await api('/api/custom/practice?batch_id=' + batchId);
    if (!r.questions || r.questions.length === 0) { toast('该批次暂无题目'); return; }
    enterQuiz(r.questions, (r.batch && r.batch.subject) || '自定义', 'custom', null, null, null);
  } catch (e) { toast('加载失败：' + e.message); }
}

/** 导入页：文件选择 → 解析 → 预览 → 确认导入 */
async function renderImport() {
  setView('custom-import');
  $('#app-title').textContent = '导入题目';
  store.navStack.push({ name: 'custom-import' });
  const view = $('#view');
  view.innerHTML = `
    <div class="card">
      <h3>选择文件（可多选）</h3>
      <p class="muted">支持 PDF（扫描版自动识图）、Excel（.xlsx/.xls，固定列或自由格式）、Word（.docx）、TXT、图片（jpg/png/webp 等，自动识别图中文字）。一次导入 = 一个批次。</p>
      <input type="file" id="import-file" accept=".pdf,.xlsx,.xls,.txt,.docx,.jpg,.jpeg,.png,.webp,.bmp,.gif" multiple>
      <div id="import-progress" class="import-progress"></div>
    </div>
    <div class="card" style="margin-top:12px">
      <h3>或直接粘贴文字</h3>
      <p class="muted">粘贴题目文本（含题干/选项/答案/解析，可多题），点「解析文字」自动切分。</p>
      <textarea id="import-paste" rows="6" style="width:100%;box-sizing:border-box;border:1.5px solid var(--border);border-radius:10px;padding:10px;font-size:13.5px;font-family:inherit;resize:vertical" placeholder="示例：&#10;1. 我国现行宪法是哪一年颁布的？&#10;A. 1949年  B. 1954年  C. 1978年  D. 1982年&#10;答案：D&#10;解析：现行宪法是1982年颁布的。"></textarea>
      <div style="margin-top:10px"><button class="btn primary" id="import-paste-btn">解析文字</button></div>
    </div>
    <div id="import-preview"></div>
  `;
  $('#import-paste-btn').onclick = async () => {
    const text = $('#import-paste').value.trim();
    if (!text) { toast('请先粘贴题目文字'); return; }
    const progress = $('#import-progress');
    progress.innerHTML = '<div class="spinner"></div><div class="muted">解析粘贴文字…</div>';
    try {
      const r = await customParsePasted(text);
      progress.innerHTML = '';
      customRenderPreview(r.questions || r, '粘贴文字');
    } catch (e) { progress.innerHTML = ''; toast('解析失败：' + e.message); }
  };
  $('#import-file').onchange = async () => {
    const files = [...$('#import-file').files];
    if (!files.length) return;
    const progress = $('#import-progress');
    progress.innerHTML = '<div class="spinner"></div><div class="muted">解析中（扫描版 PDF / 图片需识图，约 5~20 秒/张）…</div>';
    const all = [];
    for (let i = 0; i < files.length; i++) {
      progress.innerHTML = `<div class="muted">解析 ${files[i].name}（${i + 1}/${files.length}）…</div>`;
      try {
        const r = await customParseFile(files[i]);
        all.push(...(Array.isArray(r) ? r : (r.questions || [])));
      } catch (e) {
        all.push({ prompt: `【解析失败】${files[i].name}：${e.message}`, material: '', options: [], answer: '', answer_index: -1, analysis: '', failed: true });
      }
    }
    progress.innerHTML = '';
    customRenderPreview(all, files.map((f) => f.name.replace(/\.[^.]+$/, '')).join('+') || '未命名批次');
  };
}

async function customParseFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const P = () => import('./lib/custom-parser.js');
  if (ext === 'txt') { const { parseTxt } = await P(); const text = await file.text(); return { questions: parseTxt(text), raw: text }; }
  if (ext === 'docx') { const { docxToText, parseTxt } = await P(); const text = await docxToText(file); return { questions: parseTxt(text), raw: text }; }
  if (ext === 'doc') throw new Error('旧版 .doc 请用 Word 另存为 .docx 或 TXT 后再导入');
  if (ext === 'xlsx' || ext === 'xls') {
    const { parseExcel, aiStructure } = await P();
    const XLSX = window.XLSX;
    if (!XLSX) throw new Error('Excel 解析库未加载，请刷新页面重试');
    const wb = XLSX.read(await file.arrayBuffer());
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const r = parseExcel(rows);
    const raw = r.freeText || rows.map((rr) => rr.filter(Boolean).join(' | ')).filter(Boolean).join('\n');
    if (r.questions.length && r.questions.some((q) => q.prompt)) return { questions: r.questions, raw };
    if (r.freeText && r.freeText.trim().length > 20) {
      const ai = await customAiStructure(r.freeText);
      if (ai.length) return { questions: ai, raw: r.freeText };
    }
    return { questions: r.questions, raw };
  }
  if (ext === 'pdf') { const r = await customParsePdf(file); return { questions: r, raw: '' }; }
  // 图片（jpg/png/webp/bmp/gif）：OCR 转文字 → 规则切分 + AI 兜底
  if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].includes(ext)) return customParseImage(file);
  throw new Error('不支持的格式：' + (ext || '未知'));
}

/** 图片 OCR：读 dataURL → 识图转写员（合并后 image-reader）→ 文本 → 规则切分 + AI 兜底 */
async function customParseImage(file) {
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(new Error('读取图片失败'));
    fr.readAsDataURL(file);
  });
  const r = await api('/api/ai/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl, subject: '自定义' }) });
  if (!r.text) throw new Error(r.notice || 'OCR 识别失败');
  const { parseTxt } = await import('./lib/custom-parser.js');
  const qs = parseTxt(r.text);
  if (qs.length) return { questions: qs, raw: r.text };
  return { questions: await customAiStructure(r.text), raw: r.text };
}

/** 粘贴文字解析：规则切分优先，失败走 AI 结构化 */
async function customParsePasted(text) {
  const { parseTxt } = await import('./lib/custom-parser.js');
  const qs = parseTxt(text);
  if (qs.length) return { questions: qs, raw: text };
  return { questions: await customAiStructure(text), raw: text };
}

/** PDF：文本层优先；扫描页转图走识图转写员（合并后 image-reader）
 * 文本层拼接用 hasEOL 保留换行（pdf.js items 是字符级片段，join(' ') 会丢换行导致整页成一行） */
async function customParsePdf(file) {
  const { parseTxt, dedupeQuestions } = await import('./lib/custom-parser.js');
  const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const texts = [];
  const pendingOcr = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // hasEOL=true 的行尾补换行，其余补空格（保留 PDF 行结构）
    const pageText = tc.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim();
    if (pageText.length > 20) { texts.push(pageText); continue; }
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(viewport.width, 2600);
    canvas.height = Math.min(viewport.height, 2600);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    pendingOcr.push(canvas.toDataURL('image/jpeg', 0.85));
  }
  for (let i = 0; i < pendingOcr.length; i++) {
    try {
      const r = await api('/api/ai/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: pendingOcr[i], subject: '自定义' }) });
      if (r.text) texts.push(r.text.trim());
      else texts.push(`【第 ${i + 1} 页扫描件：${r.notice || '识别失败'}】`);
    } catch (e) { texts.push(`【第 ${i + 1} 页扫描件识别失败：${e.message}】`); }
  }
  const joined = texts.join('\n').trim();
  // 过滤封面/页眉等无题结构的块（无选项且无答案且无解析）；保留真正题目
  const qs = dedupeQuestions(parseTxt(joined)).filter((q) => q.options.length || q.answer || q.analysis);
  if (qs.length) return qs;
  if (joined) return customAiStructure(joined);
  return [];
}

/** AI 结构化兜底（题目解析员 custom-question-parser，分批 ≤10 段） */
async function customAiStructure(text) {
  const { aiStructure } = await import('./lib/custom-parser.js');
  const chunks = String(text).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (!chunks.length) return [];
  return aiStructure(chunks, async (input) => {
    const res = await api('/api/ai/structure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: input }) });
    if (!res.text) throw new Error(res.notice || '解析失败');
    return res.text;
  });
}

/** 预览表格 + 确认导入 */
function customRenderPreview(qs, defaultName) {
  const box = $('#import-preview');
  if (!box) return;
  if (!qs.length) { box.innerHTML = '<div class="card"><h3>解析结果</h3><div class="empty">未解析出题目，请检查文件内容或格式。</div></div>'; return; }
  box.innerHTML = `
    <div class="card">
      <h3>解析结果：${qs.length} 题（<span class="muted">解析失败的题目会原样导入，可导入后在批次里编辑修正</span>）</h3>
      <div class="custom-preview-scroll"><table class="custom-preview">
        <thead><tr><th>#</th><th>提示</th><th>材料</th><th>选项</th><th>答案</th><th>解析</th><th></th></tr></thead>
        <tbody>${qs.map((q, i) => `<tr class="${q.failed ? 'fail' : ''}">
          <td>${i + 1}</td>
          <td>${esc((q.prompt || '').slice(0, 60))}</td>
          <td>${esc((q.material || '').slice(0, 40))}</td>
          <td>${esc((q.options || []).join(' | ').slice(0, 40))}</td>
          <td>${esc(q.answer ? customAnswerDisplay(q.answer, q.options) : '无答案')}</td>
          <td>${esc((q.analysis || '').slice(0, 30))}</td>
          <td>${q.failed ? '<span class="tag warn">待人工修正</span>' : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="import-confirm">
        <input type="text" id="import-name" placeholder="批次名称" value="${esc(defaultName)}">
        <select id="import-subject" title="这批题属于哪个科目（影响刷题统计与错题本归属）">
          <option value="">科目：不限（归入「自定义」）</option>
          <option value="行测">行测</option>
          <option value="职测">职测</option>
          <option value="综应">综应</option>
          <option value="申论">申论</option>
        </select>
        <button class="btn primary" id="import-ok">确认导入</button>
      </div>
    </div>
  `;
  $('#import-ok').onclick = async () => {
    const name = $('#import-name').value.trim() || '未命名批次';
    try {
      const r = await api('/api/custom/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name,
        subject: $('#import-subject').value,
        questions: qs.map((q) => ({ prompt: q.prompt || '', material: q.material || '', options: q.options || [], answer: q.answer || '', answer_index: q.answer_index == null ? -1 : q.answer_index, analysis: q.analysis || '' })),
      }) });
      toast(`已导入「${r.name}」${r.count} 题`);
      renderCustomBank();
    } catch (e) { toast('导入失败：' + e.message); }
  };
}

/** 单题编辑弹窗（保存时自动重算 answer_index） */
function customEditQuestion(q, batchName) {
  const ansDisplay = /^\[/.test(q.answer || '') ? customAnswerDisplay(q.answer, q.options) : q.answer || '';
  const sheet = customSheet(`
    <h3>编辑题目 <span class="muted">（${esc(batchName || '')}）</span></h3>
    <label>提示（题干）</label>
    <textarea id="eq-prompt" rows="3">${esc(q.prompt || '')}</textarea>
    <label>材料（无则留空）</label>
    <textarea id="eq-material" rows="2">${esc(q.material || '')}</textarea>
    <label>选项（每行一个，如 A. 选项内容；无选项留空）</label>
    <textarea id="eq-options" rows="${Math.max(2, (q.options || []).length)}">${esc((q.options || []).join('\n'))}</textarea>
    <label>答案（A / AB / 正确 / 错误，留空=无答案不判分）</label>
    <input type="text" id="eq-answer" value="${esc(ansDisplay)}" placeholder="如 B 或 AB">
    <label>解析（无则留空）</label>
    <textarea id="eq-analysis" rows="2">${esc(q.analysis || '')}</textarea>
    <div class="sheet-actions">
      <button class="btn primary" id="eq-save">保存</button>
      <button class="btn" id="eq-cancel">取消</button>
    </div>
  `, true);
  $('#eq-cancel').onclick = () => sheet.remove();
  $('#eq-save').onclick = async () => {
    const options = $('#eq-options').value.split('\n').map((s) => s.trim()).filter(Boolean);
    const { normalizeAnswer } = await import('./lib/custom-parser.js');
    const norm = normalizeAnswer($('#eq-answer').value.trim(), options);
    try {
      await api('/api/custom/question?id=' + q.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id: q.id,
        prompt: $('#eq-prompt').value.trim(),
        material: $('#eq-material').value.trim(),
        options: norm.options,
        answer: norm.answer,
        answer_index: norm.answer_index,
        analysis: $('#eq-analysis').value.trim(),
      }) });
      sheet.remove();
      toast('已保存');
      renderCustomBatch(q.batch_id, true);
    } catch (e) { toast('保存失败：' + e.message); }
  };
}

function customRenameBatch(b) {
  const sheet = customSheet(`
    <h3>批次改名</h3>
    <input type="text" id="rn-name" value="${esc(b.name)}">
    <div class="sheet-actions">
      <button class="btn primary" id="rn-ok">保存</button>
      <button class="btn" id="rn-cancel">取消</button>
    </div>
  `);
  $('#rn-cancel').onclick = () => sheet.remove();
  $('#rn-ok').onclick = async () => {
    const name = $('#rn-name').value.trim();
    if (!name) { toast('名称不能为空'); return; }
    try {
      await api('/api/custom/batch?id=' + b.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.id, name }) });
      sheet.remove();
      toast('已改名');
      renderCustomBank(true);
    } catch (e) { toast('改名失败：' + e.message); }
  };
}

function customDeleteBatch(b) {
  const sheet = customSheet(`
    <h3>删除批次「${esc(b.name)}」？</h3>
    <p class="muted">将同时删除该批次的 ${b.count} 道题（做题记录保留）。此操作不可恢复。</p>
    <div class="sheet-actions">
      <button class="btn danger" id="del-ok">确认删除</button>
      <button class="btn" id="del-cancel">取消</button>
    </div>
  `);
  $('#del-cancel').onclick = () => sheet.remove();
  $('#del-ok').onclick = async () => {
    try {
      await api('/api/custom/batch?id=' + b.id, { method: 'DELETE' });
      sheet.remove();
      toast('已删除');
      renderCustomBank(true);
    } catch (e) { toast('删除失败：' + e.message); }
  };
}

function customDeleteQuestion(q) {
  const sheet = customSheet(`
    <h3>删除这道题？</h3>
    <p class="muted">${esc((q.prompt || '').slice(0, 50))}</p>
    <div class="sheet-actions">
      <button class="btn danger" id="dq-ok">确认删除</button>
      <button class="btn" id="dq-cancel">取消</button>
    </div>
  `);
  $('#dq-cancel').onclick = () => sheet.remove();
  $('#dq-ok').onclick = async () => {
    try {
      await api('/api/custom/question?id=' + q.id, { method: 'DELETE' });
      sheet.remove();
      toast('已删除');
      renderCustomBatch(q.batch_id, true);
    } catch (e) { toast('删除失败：' + e.message); }
  };
}

// ---------- 科目页（粉笔风格：统计条 + 模块列表 + 分类试卷） ----------
async function renderSubject(subject, skipNav) {
  setView('category');
  store.state.subject = subject;
  if (!skipNav) store.navStack.push({ name: 'subject', subject });
  $('#app-title').textContent = subject;
  const view = $('#view');
  view.innerHTML = '<div class="spinner"></div>';
  try {
    const [categories, chapters] = await Promise.all([
      api(`/api/categories?subject=${encodeURIComponent(subject)}`),
      api(`/api/chapters?subject=${encodeURIComponent(subject)}&mock=0`),
    ]);
    view.innerHTML = '';

    // 顶部统计条
    const statBar = el('div', 'stat-row');
    view.appendChild(statBar);
    const totalQ = chapters.reduce((s, c) => s + c.total, 0);
    const doneQ = chapters.reduce((s, c) => s + c.done, 0);
    const doneWithRate = chapters.filter((c) => c.rate != null);
    const avgRate = doneWithRate.length ? Math.round(doneWithRate.reduce((s, c) => s + c.rate, 0) / doneWithRate.length) : null;
    statBar.innerHTML = `
      <div class="stat-card"><div class="num">${totalQ}</div><div class="label">总题量</div></div>
      <div class="stat-card"><div class="num">${doneQ}</div><div class="label">已做题</div></div>
      <div class="stat-card"><div class="num">${avgRate != null ? avgRate + '%' : '—'}</div><div class="label">平均正确率</div></div>
    `;

    // 专项练习（粉笔 1:1 三级树：大模块 → 子模块 → 知识点）
    const chapCard = el('div', 'card', `<h3>专项练习</h3><div class="card-sub">与粉笔同步的知识点目录，逐级展开开始刷题</div>`);
    const chapList = el('div');
    chapCard.appendChild(chapList);
    view.appendChild(chapCard);
    if (!chapters.length) {
      chapList.innerHTML = '<div class="empty">该题库暂无模块分类</div>';
    } else {
      for (const g of chapters) {
        const group = el('div', 'mod-group');
        const head = el('div', 'mod-group-head', `
          <span class="mg-ico tint-violet">${ico('book', 17)}</span>
          <span class="mg-name">${esc(g.group)}</span>
          <span class="mg-stat">${g.total} 题 · 已做 ${g.done}${g.rate != null ? ` · ${g.rate}%` : ''}</span>
          <span class="mg-arrow">▾</span>
        `);
        const body = el('div', 'mod-group-body');
        body.style.display = 'none';
        // 第一个子项：全部（该大模块全部题）
        const allNames = [];
        for (const sub of g.subs || []) {
          for (const cn of sub.chapters || []) allNames.push(cn);
          for (const lf of sub.leaves || []) for (const cn of lf.chapters || []) allNames.push(cn);
        }
        const allItem = el('div', 'mod-sub', `
          <div class="mod-sub-head" data-all>
            <span class="ms-ico tint-blue">${ico('fileText', 15)}</span>
            <span class="ms-name">全部</span>
            <span class="ms-stat">${g.total} 题</span>
            <span class="mg-arrow">▶</span>
          </div>
        `);
        allItem.querySelector('[data-all]').onclick = () => {
          if (allNames.length) renderPractice(subject, allNames, null, '0');
          else renderPractice(subject, null, null, '0', false, g.group, '全部');
        };
        body.appendChild(allItem);
        // 子模块
        for (const sub of g.subs || []) {
          const subGroup = el('div', 'mod-sub');
          const subHead = el('div', 'mod-sub-head', `
            <span class="ms-ico tint-green">${ico('folder', 15)}</span>
            <span class="ms-name">${esc(sub.name)}</span>
            <span class="ms-stat">${sub.total} 题${sub.rate != null ? ` · ${sub.rate}%` : ''}</span>
            <span class="mg-arrow">${sub.leaves && sub.leaves.length ? '▾' : '▶'}</span>
          `);
          const subBody = el('div', 'mod-sub-body');
          subBody.style.display = 'none';
          // 知识点叶子：点击刷题（叶子无专属章节时出该子模块全部题）
          for (const lf of sub.leaves || []) {
            const leafChapters = (lf.chapters && lf.chapters.length) ? lf.chapters : (sub.chapters || []);
            const item = el('div', 'list-item', `
              <span class="li-icon tint-orange">${ico('target', 18)}</span>
              <div class="li-main">
                <div class="li-title">${esc(lf.name)}</div>
                <div class="li-sub">${lf.total > 0 ? `${lf.total} 题` : `含于「${esc(sub.name)}」`}</div>
              </div>
              <button class="btn btn-primary btn-sm" data-start>开始</button>
            `);
            item.querySelector('[data-start]').onclick = (e) => { e.stopPropagation(); renderPractice(subject, leafChapters, null, '0'); };
            item.onclick = () => renderPractice(subject, leafChapters, null, '0');
            subBody.appendChild(item);
          }
          // 子模块：有叶子则展开知识点；无叶子（ESSAY_TREE 题型）直接按节点刷题
          if (sub.leaves && sub.leaves.length) {
            subHead.onclick = () => {
              const open = subBody.style.display !== 'none';
              subBody.style.display = open ? 'none' : 'block';
              subHead.querySelector('.mg-arrow').textContent = open ? '▾' : '▴';
              subHead.classList.toggle('open', !open);
            };
          } else {
            // 无叶子：行测（有章节）用章节出题；主观题库用 group/sub 节点出题
            subHead.onclick = () => {
              if (sub.chapters && sub.chapters.length) renderPractice(subject, sub.chapters, null, '0');
              else renderPractice(subject, null, null, '0', false, g.group, sub.name);
            };
          }
          subGroup.appendChild(subHead);
          subGroup.appendChild(subBody);
          body.appendChild(subGroup);
        }
        head.onclick = () => {
          const open = body.style.display !== 'none';
          body.style.display = open ? 'none' : 'block';
          head.querySelector('.mg-arrow').textContent = open ? '▾' : '▴';
          head.classList.toggle('open', !open);
        };
        group.appendChild(head);
        group.appendChild(body);
        chapList.appendChild(group);
      }
    }

    // 分类试卷列表（折叠）
    const catCard = el('div', 'card');
    const catHead = el('div');
    catHead.innerHTML = `<h3 style="display:flex;justify-content:space-between;align-items:center">${ico('folderTree', 17)} 按分类刷试卷 <span id="cat-toggle" style="font-size:12px;color:var(--text-3);cursor:pointer">展开 ▾</span></h3>`;
    catCard.appendChild(catHead);
    const catBody = el('div');
    catBody.id = 'cat-body';
    catBody.style.display = 'none';
    for (const c of categories) {
      const item = el('div', 'list-item', `
        <span class="li-icon tint-blue">${ico('folder', 18)}</span>
        <div class="li-main">
          <div class="li-title">${c.category}</div>
          <div class="li-sub">${c.papers} 套 · ${(c.questions / 10000).toFixed(1)}w 题</div>
        </div>
        <span class="li-arrow">›</span>
      `);
      item.onclick = () => renderCategory(subject, c.category);
      catBody.appendChild(item);
    }
    catCard.appendChild(catBody);
    view.appendChild(catCard);
    $('#cat-toggle').onclick = () => {
      const open = catBody.style.display !== 'none';
      catBody.style.display = open ? 'none' : 'block';
      $('#cat-toggle').textContent = open ? '展开 ▾' : '收起 ▴';
    };
    view.appendChild(catCard);
  } catch (e) {
    view.innerHTML = `<div class="empty">加载失败：${e.message}</div>`;
  }
}

// ---------- 分类 → 试卷列表 ----------
async function renderCategory(subject, category, skipNav) {
  setView('papers');
  store.state.subject = subject;
  store.state.category = category;
  store.state.mode = 'category';
  if (!skipNav) store.navStack.push({ name: 'category', subject, category });
  $('#app-title').textContent = `${subject} · ${category}`;
  [...document.querySelectorAll('#topbar-right > *:not(#btn-theme)')].forEach(n => n.remove());
  const view = $('#view');
  view.innerHTML = '<div class="spinner"></div>';
  try {
    const papers = await api(`/api/papers?subject=${encodeURIComponent(subject)}&category=${encodeURIComponent(category)}&limit=300`);
    view.innerHTML = '';
    if (!papers.length) { view.innerHTML = '<div class="empty">该分类暂无试卷</div>'; return; }
    // 一键整套练习
    const all = el('div', 'card', `<h3>${ico('zap', 17)} 整套练习（${papers.length} 套）</h3>
      <button class="btn btn-primary btn-block" id="btn-practice-all">${ico('dice', 15)} 随机抽 ${practiceCount(subject)} 题</button>`);
    view.appendChild(all);
    $('#btn-practice-all').onclick = () => renderPractice(subject, null, papers[0].id);

    const list = el('div');
    for (const p of papers) {
      const item = el('div', 'list-item', `
        <span class="li-icon tint-green">${ico('fileText', 18)}</span>
        <div class="li-main">
          <div class="li-title">${p.name}</div>
          <div class="li-sub">${p.questionCount} 题${p.difficulty != null ? ' · 难度 ' + p.difficulty : ''}</div>
        </div>
        <span class="li-arrow">›</span>
      `);
      item.onclick = () => renderPaperDetail(subject, p.id);
      list.appendChild(item);
    }
    view.appendChild(list);
  } catch (e) {
    view.innerHTML = `<div class="empty">加载失败：${e.message}</div>`;
  }
}

// ---------- 试卷详情 ----------
async function renderPaperDetail(subject, paperId, skipNav) {
  setView('paper-detail');
  store.state.subject = subject;
  if (!skipNav) store.navStack.push({ name: 'paper-detail', subject, paperId });
  const view = $('#view');
  view.innerHTML = '<div class="spinner"></div>';
  try {
    const p = await api(`/api/papers/${paperId}`);
    $('#app-title').textContent = p.name;
    view.innerHTML = '';
    const card = el('div', 'card', `
      <h3>${p.name}</h3>
      <div class="li-sub">${p.subjectName} · ${p.category} · ${p.questionCount} 题 · 难度 ${p.difficulty ?? '-'}</div>
    `);
    view.appendChild(card);

    if (p.chapters && p.chapters.length) {
      const chapCard = el('div', 'card');
      chapCard.appendChild(el('h3', null, `${ico('book', 17)} 章节结构`));
      for (const ch of p.chapters) {
        chapCard.appendChild(el('div', 'list-item', `
          <span class="li-icon tint-violet">${ico('file', 18)}</span>
          <div class="li-main"><div class="li-title">${ch.name}</div><div class="li-sub">${ch.questionCount} 题</div></div>
          <span class="li-arrow">›</span>
        `));
      }
      view.appendChild(chapCard);
    }

    view.appendChild(el('div', 'card', `
      <button class="btn btn-primary btn-block" id="btn-start">${ico('play', 15)} 开始做这套卷（${p.questionCount} 题）</button>
    `));
    $('#btn-start').onclick = () => {
      store.state.questions = p.questions;
      store.state.idx = 0;
      store.state.results = [];
      store.state.mode = 'paper';
      store.state.subject = p.subjectName;
      store.navStack.push({ name: 'practice', subject: p.subjectName, chapter: null, mock: '0' });
      renderQuestion();
    };
  } catch (e) {
    view.innerHTML = `<div class="empty">加载失败：${e.message}</div>`;
  }
}

// ---------- 刷题 ----------
/** 随机练习题量（2026-08 用户要求）：行测/职测固定 15 题；申论/综应（主观题难）固定 2 题 */
function practiceCount(subject) {
  return (subject === '公务员·申论' || subject === '事业编·综应') ? 2 : 15;
}
async function renderPractice(subject, chapter, paperId, mock, skipNav, group, sub) {
  setView('practice');
  if (!skipNav) store.navStack.push({ name: 'practice', subject, chapter: Array.isArray(chapter) ? chapter[0] : (chapter || null), mock: mock ?? '0' });
  // chapter 可为字符串或数组（多章节混刷）；group/sub 为树节点出题（ESSAY_TREE）
  const chName = group ? `${group} · ${sub}` : (Array.isArray(chapter) ? chapter.join('、') : chapter);
  const mockTag = mock === '1' ? ' · 模拟题' : (mock === '0' ? ' · 真题' : '');
  $('#app-title').textContent = chName ? `${subject} · ${chName}${mockTag}` : `${subject} · 随机练习`;
  const view = $('#view');
  view.innerHTML = '<div class="spinner"></div>';
  try {
    let chParam = '';
    if (group) chParam = `&group=${encodeURIComponent(group)}&sub=${encodeURIComponent(sub || '全部')}`;
    else chParam = Array.isArray(chapter) ? `&chapters=${encodeURIComponent(chapter.join(','))}` : (chapter ? `&chapter=${encodeURIComponent(chapter)}` : '');
    const url = `/api/practice?subject=${encodeURIComponent(subject)}${chParam}${mock != null ? `&mock=${mock}` : ''}&n=${practiceCount(subject)}`;
    const questions = await api(url);
    if (!questions.length) { view.innerHTML = '<div class="empty">暂无题目</div>'; return; }
    enterQuiz(questions, subject, (chapter || group) ? 'chapter' : 'random', Array.isArray(chapter) ? chapter[0] : chapter, mock);
  } catch (e) {
    view.innerHTML = `<div class="empty">加载失败：${e.message}</div>`;
  }
}

/** 进入刷题状态（随机/章节/组卷共用）：写入 store、开计时、渲染首题 */
function enterQuiz(questions, subject, mode, chapter, mock, limitSec) {
  store.state.questions = questions;
  store.state.idx = 0;
  store.state.results = [];
  store.state.answers = [];
  store.state.mode = mode || 'random';
  store.state.subject = subject;
  store.state.chapter = chapter ?? null;
  store.state.mock = mock ?? null;
  stopTimer();
  startTimer(limitSec); // 组卷（mode='quiz'）传 durationMinutes×60 → 倒计时；其余正计时
  renderQuestion();
}

// ============ 智能组卷（行测 + 职测）============
// 官方模块序与主题色（与后端模板一致）；考情：行测市地/执法 130 题 120 分钟；职测 A/B/C/山东 90 分钟 150 分
const XINGCE_MODULES = [
  { name: '政治理论', tint: 'tint-red' },
  { name: '常识判断', tint: 'tint-amber' },
  { name: '言语理解与表达', tint: 'tint-blue' },
  { name: '数量关系', tint: 'tint-orange' },
  { name: '判断推理', tint: 'tint-violet' },
  { name: '资料分析', tint: 'tint-green' },
];
const XINGCE_TOTAL = 130;      // 官方卷型题量（市地/执法基准）
const XINGCE_MINUTES = 120;    // 官方考试时长（分钟）
// 职测模块（含 B/C 类特有模块）与卷型类别
const ZHI_CE_MODULES = [
  { name: '常识判断', tint: 'tint-amber' },
  { name: '言语理解与表达', tint: 'tint-blue' },
  { name: '数量分析', tint: 'tint-orange' },
  { name: '数量关系', tint: 'tint-orange' },
  { name: '判断推理', tint: 'tint-violet' },
  { name: '综合分析', tint: 'tint-red' },
  { name: '资料分析', tint: 'tint-green' },
];
const ZHI_CE_CATEGORIES = [
  { name: '联考A类', total: 100 },
  { name: '联考B类', total: 100 },
  { name: '联考C类', total: 100 },
  { name: '山东', total: 90 },
];
const ZHI_CE_MINUTES = 90;     // 职测官方考试时长（分钟）
const XINGCE_DIFFS = [
  { key: 'easy', label: '简单', tip: '难度 1-3' },
  { key: 'balanced', label: '适中', tip: '难度 3-6' },
  { key: 'hard', label: '偏难', tip: '难度 5-9' },
  { key: 'random', label: '随机', tip: '不限难度' },
];

/** 打开智能组卷配置 sheet：官方卷型固定（题量/时长/全模块/全单选按科目），科目、职测类别、难度、智能加权可调 */
function openPaperConfig() {
  const overlay = el('div', 'sheet-overlay');
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-head"><b>${ico('target', 16)} 智能组卷</b><button class="sheet-close">✕</button></div>
      <div class="cfg-group">科目</div>
      <div class="cfg-row">
        <div class="chip-row" id="cfg-subject">
          <span class="chip on" data-sub="公务员·行测">公务员·行测</span>
          <span class="chip" data-sub="事业编·职测">事业编·职测</span>
        </div>
      </div>
      <div class="cfg-row" id="cfg-cat-row" style="display:none">
        <div class="cfg-group" style="margin-bottom:8px">卷型类别 <span class="cfg-note">各卷型模块构成不同，按官方大纲出题</span></div>
        <div class="chip-row" id="cfg-category">
          ${ZHI_CE_CATEGORIES.map((c) => `<span class="chip ${c.name === '联考A类' ? 'on' : ''}" data-cat="${c.name}">${c.name} · ${c.total} 题</span>`).join('')}
        </div>
      </div>
      <div class="cfg-banner" id="cfg-banner">${ico('chart', 14)} 公务员·行测 · 官方卷型：${XINGCE_TOTAL} 题 / ${XINGCE_MINUTES} 分钟 · 全单选</div>
      <div class="cfg-group">难度</div>
      <div class="cfg-row">
        <div class="chip-row" id="cfg-diff">
          ${XINGCE_DIFFS.map((d) => `<span class="chip ${d.key === 'balanced' ? 'on' : ''}" data-diff="${d.key}" title="${d.tip}">${d.label}</span>`).join('')}
        </div>
      </div>
      <div class="cfg-row cfg-switch-row">
        <label class="switch"><input type="checkbox" id="cfg-weak" checked><span class="switch-slider"></span></label>
        <div>
          <div class="cfg-row-title">智能加权</div>
          <div class="cfg-row-sub">优先未做过的题，向错题率高的模块倾斜（检测自你的学习记录）</div>
        </div>
      </div>
      <button class="btn btn-primary btn-block" id="btn-gen-paper" style="margin-top:16px">${ico('zap', 15)} 智能生成</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('.sheet-close').onclick = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  const banner = $('#cfg-banner');
  const catRow = $('#cfg-cat-row');
  // 科目：行测 / 职测 可切换；职测显示卷型类别区，banner 联动
  const updateBanner = (subject, catName) => {
    if (subject === '事业编·职测') {
      const cat = ZHI_CE_CATEGORIES.find((c) => c.name === catName) || ZHI_CE_CATEGORIES[0];
      banner.innerHTML = `${ico('chart', 14)} 事业编·职测 · ${cat.name}：${cat.total} 题 / ${ZHI_CE_MINUTES} 分钟 · 全单选`;
    } else {
      banner.innerHTML = `${ico('chart', 14)} 公务员·行测 · 官方卷型：${XINGCE_TOTAL} 题 / ${XINGCE_MINUTES} 分钟 · 全单选`;
    }
  };
  overlay.querySelectorAll('#cfg-subject .chip').forEach((chip) => {
    chip.onclick = () => {
      overlay.querySelectorAll('#cfg-subject .chip').forEach((c) => c.classList.toggle('on', c === chip));
      const isZc = chip.dataset.sub === '事业编·职测';
      catRow.style.display = isZc ? 'block' : 'none';
      updateBanner(chip.dataset.sub, overlay.querySelector('#cfg-category .chip.on')?.dataset.cat || '联考A类');
    };
  });
  // 职测类别：单选
  overlay.querySelectorAll('#cfg-category .chip').forEach((chip) => {
    chip.onclick = () => {
      overlay.querySelectorAll('#cfg-category .chip').forEach((c) => c.classList.toggle('on', c === chip));
      updateBanner('事业编·职测', chip.dataset.cat);
    };
  });
  // 难度：单选
  overlay.querySelectorAll('#cfg-diff .chip').forEach((chip) => {
    chip.onclick = () => {
      const row = chip.parentElement;
      row.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
    };
  });
  // 生成
  $('#btn-gen-paper').onclick = () => generatePaper(overlay);
}

/** 调后端组卷接口；成功 → 预览页；失败/降级 → toast 提示 */
async function generatePaper(overlay) {
  const btn = $('#btn-gen-paper');
  if (btn.disabled) return;
  const subject = overlay.querySelector('#cfg-subject .chip.on')?.dataset.sub || '公务员·行测';
  const difficulty = overlay.querySelector('#cfg-diff .chip.on')?.dataset.diff || 'balanced';
  const weak = overlay.querySelector('#cfg-weak').checked;
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner"></span> 正在从 4 个题库组卷…';
  try {
    // 官方卷型固定：行测 130 题全模块；职测按所选卷型类别（后端 ZHI_CE_TEMPLATES）
    const payload = { subject, difficulty };
    if (subject === '公务员·行测') payload.count = XINGCE_TOTAL;
    else payload.category = overlay.querySelector('#cfg-category .chip.on')?.dataset.cat || '联考A类';
    if (weak) {
      // 智能检测弱项模块：正确率最低（且做过 ≥5 题）的模块（按科目匹配模板模块名）
      try {
        const stats = await api('/api/records/stats');
        // byChapter 为数组 [{ chapter, c, ok }]（本地与 server 端同构）；c = 做题数，ok = 正确数
        const byChapter = Array.isArray(stats.byChapter) ? stats.byChapter : [];
        const modList = subject === '事业编·职测' ? ZHI_CE_MODULES : XINGCE_MODULES;
        let best = null;
        for (const v of byChapter) {
          const rate = v.c ? v.ok / v.c : 0;
          if (v.c >= 5 && modList.some((m) => m.name === v.chapter)) {
            if (!best || rate < (best.rate ?? 1)) best = { name: v.chapter, rate };
          }
        }
        if (best) payload.weak = [best.name];
      } catch { /* 统计不可用时跳过弱项加权 */ }
    }
    const res = await api('/api/paper/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { toast(res.error || '组卷失败'); return; }
    if (res.notice) toast(res.notice);
    if (window.Telemetry) Telemetry.track('paper_generate', { subject: payload.subject, n: res.questions ? res.questions.length : 0 });
    overlay.remove();
    // 组卷成功直接开始做题（跳过预览页），带考试倒计时；renderPaperPreview 保留作试卷详情查看
    enterQuiz(res.questions, res.subject, 'quiz', null, null, res.durationMinutes * 60); // 分钟→秒（startTimer 以秒递减）
  } catch (e) {
    toast(`组卷失败：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${ico('zap', 15)} 智能生成`;
  }
}

/** 题干去标签 → 纯文本（预览列表用） */
function stripHtml(h) {
  return String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 预览页：模块分布条 + 按模块分组的题目列表 + 重新生成/开始做题 */
function renderPaperPreview(res) {
  store.paperPreview = res;
  setView('paper-preview');
  store.navStack.push({ name: 'paper-preview' });
  $('#app-title').textContent = res.title;
  const view = $('#view');
  const byModule = {};
  for (const q of res.questions) (byModule[q.module || '未分类'] ||= []).push(q);
  // 模块 tint 映射：行测 + 职测模块表合并（重复名取先定义者，避免重名模块渲染两次）
  const MODULE_TINTS = [...new Map([...XINGCE_MODULES, ...ZHI_CE_MODULES].map((m) => [m.name, m])).values()];
  const mods = MODULE_TINTS.filter((m) => byModule[m.name]).map((m) => ({ ...m, qs: byModule[m.name] }));
  // 题源覆盖 = 实际出题的非零源数（职测仅主源卷型出题时显示 1）
  const srcCount = Object.values(res.sourceCounts || {}).filter((n) => n > 0).length;
  view.innerHTML = `
    <div class="stat-row">
      <div class="stat-card"><div class="num">${res.total}</div><div class="label">题量</div></div>
      <div class="stat-card"><div class="num">${res.durationMinutes}′</div><div class="label">预估时长</div></div>
      <div class="stat-card"><div class="num">${srcCount}</div><div class="label">题源覆盖</div></div>
    </div>
    <div class="card">
      <h3>${ico('chart', 16)} 模块分布</h3>
      <div class="pp-mod-list">
        ${mods.map((m) => `
          <div class="pp-mod-row">
            <span class="pp-mod-dot ${m.tint}"></span>
            <span class="pp-mod-name">${m.name}</span>
            <span class="pp-mod-bar"><span class="fill ${m.tint}" style="width:${Math.round((m.qs.length / res.total) * 100)}%"></span></span>
            <span class="pp-mod-num">${m.qs.length} 题</span>
          </div>`).join('')}
      </div>
      <div class="li-tip" style="margin-top:10px">${ico('info', 13)} 按官方模块序连排，资料分析为整组材料；${res.difficulty?.min ?? 3}~${res.difficulty?.max ?? 6} 难度区间</div>
    </div>
    <div class="card">
      <h3>${ico('fileText', 16)} 试卷预览 <span class="cfg-note">点击题目查看完整题干</span></h3>
      <div class="pp-q-list">
        ${res.questions.map((q, i) => `
          <div class="pp-q-item" data-i="${i}">
            <span class="pp-q-num">${i + 1}</span>
            <span class="pp-q-text">${esc(stripHtml(q.contentHtml || q.content || ''))}</span>
            <span class="pp-q-tags">
              ${q.groupTotal > 1 ? `<span class="tag tag-chapter">材料 ${q.groupIndex + 1}/${q.groupTotal}</span>` : ''}
              <span class="tag tag-chapter">${esc(q.module || q.chapter || '')}</span>
              ${q.difficulty != null ? `<span class="tag tag-difficulty">难度 ${q.difficulty}</span>` : ''}
            </span>
          </div>`).join('')}
      </div>
    </div>
    <div class="action-row">
      <button class="btn btn-ghost" id="btn-regen" style="flex:1">${ico('dice', 15)} 重新生成</button>
      <button class="btn btn-primary" id="btn-start" style="flex:2">${ico('play', 15)} 开始做题（${res.total} 题）</button>
    </div>
  `;
  view.querySelectorAll('.pp-q-item').forEach((row) => {
    row.onclick = () => paperQSheet(res.questions[Number(row.dataset.i)]);
  });
  $('#btn-regen').onclick = () => { store.navStack.pop(); openPaperConfig(); };
  $('#btn-start').onclick = () => enterQuiz(res.questions, res.subject, 'quiz');
}

/** 预览题详情 sheet：完整题干 + 选项 + 参考答案 */
function paperQSheet(q) {
  const overlay = el('div', 'sheet-overlay');
  const ans = String(q.answer || '').trim();
  const isMulti = ans.startsWith('[') || (/^[\d,\s]+$/.test(ans) && ans.includes(','));
  const opts = (q.options && q.options.length) ? q.options : [];
  const sel = new Set(ans.split(',').map((s) => s.trim()).filter(Boolean).map((s) => parseInt(s, 10)));
  const optHtml = opts.map((o, oi) => {
    const ohtml = sanitizeHtml(o);
    const hasHtml = /<[a-z][^>]*>/i.test(ohtml);
    return `<div class="opt-row ${sel.has(oi + 1) ? 'on' : ''}"><span class="opt-key">${LETTERS[oi] || oi + 1}</span><span class="opt-body">${hasHtml ? fixImgLoading(ohtml) : esc(o.replace(/<[^>]+>/g, '').trim())}</span></div>`;
  }).join('');
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-head"><b>题目预览</b><button class="sheet-close">✕</button></div>
      <div style="font-size:13px;line-height:1.9;max-height:70vh;overflow:auto">
        <div class="q-content">${sanitizeHtml(q.contentHtml) || esc(q.content || '')}</div>
        ${q.material ? `<div class="material-box"><div class="mat-body" style="display:block;font-size:13px;line-height:1.8;margin-top:8px;max-height:340px;overflow:auto;background:var(--bg-soft);border-radius:8px;padding:10px">${fixImgLoading(sanitizeHtml(q.material))}</div></div>` : ''}
        ${opts.length ? `<div style="margin-top:12px">${optHtml}</div>` : ''}
        <div class="ab-title" style="margin-top:14px">${ico('checkCircle', 14)} 参考答案</div>
        <div style="font-size:13.5px;line-height:1.8">${isMulti ? '多选' : '单选'}：${sel.size ? [...sel].map((s) => LETTERS[s - 1]).join('、') : esc(ans)}${q.answerDetail ? `<div style="margin-top:8px;color:var(--text-2)">${sanitizeHtml(q.answerDetail)}</div>` : ''}</div>
      </div>
    </div>
  `;
  overlay.querySelector('.sheet-close').onclick = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

const TYPE_NAME = { 1: '单选', 2: '多选', 3: '判断', 5: '判断', 21: '申论', 24: '综合', 25: '综合', 26: '综合' };

// ---------- HTML 净化：仅放行常用标签，防注入 ----------
function sanitizeHtml(h) {
  if (!h) return '';
  let s = String(h)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // 实体解码后局部删除危险协议（防 java&#x73;cript: 绕过；不整段清空，避免误伤正常题干）
  const decoded = s.replace(/&#x([0-9a-f]+);/gi, (m, hx) => String.fromCharCode(parseInt(hx, 16)))
                   .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)));
  return decoded.replace(/javascript:|vbscript:|data:text\/html/gi, '');
}
// 渲染题目内容：优先 contentHtml（含图片/公式），否则纯文本
function renderContent(el, q) {
  const html = sanitizeHtml(q.contentHtml);
  if (html && /<[a-z][^>]*>/i.test(html)) {
    el.innerHTML = fixImgLoading(html);
  } else {
    el.textContent = q.content || '';
  }
}
// 图片防盗链修复：粉笔图片带 Referer 会 403/裂图 → 加 no-referrer + 补全 https 协议
function fixImgLoading(html) {
  return String(html || '')
    .replace(/<img\s/gi, '<img referrerpolicy="no-referrer" ')
    .replace(/src=["']\/\//gi, 'src="https://');
}

function renderQuestion() {
  cropSession++;          // 视图切换：使未完成的裁剪会话失效
  closeCropEditor();      // 清理可能残留的裁剪器 overlay
  const s = store.state;
  const q = s.questions[s.idx];
  if (!q) { renderResult(); return; }
  const view = $('#view');
  view.dataset.exam = '1'; // 做题态标记：滑动切题/长按排除在此生效
  const isEssay = q.type === 21 || q.type >= 20;
  const total = s.questions.length;
  // 多选判定与 judge() 对齐：JSON 数组（"[0,1,3]"）或逗号分隔数字（"0,1,3"，type=2/3 共 918 题）
  const _ans = String(q.answer || '').trim();
  const isMulti = _ans.startsWith('[') || (/^[\d,\s]+$/.test(_ans) && _ans.includes(','));
  // 判断题（type 3/5）部分题 options 为空，前端补“正确/错误”两个选项（与粉笔 App 一致）
  const opts = (q.options && q.options.length)
    ? q.options
    : ((q.type === 3 || q.type === 5) ? ['正确', '错误'] : []);

  view.innerHTML = '';
  // 计时条（客观题模式显示）+ 答题进度条
  if (!isEssay) {
    view.appendChild(el('div', 'timer-bar', `
      <span class="timer-ico">${s.timing?.limit ? ico('hourglass', 15) : ico('clock', 15)}</span>
      <span id="timer-text">${s.timing?.limit ? fmtTime(s.timing.remaining) : fmtTime(s.timing?.elapsed ?? 0)}</span>
      <button class="btn btn-ghost btn-sm" id="btn-pause" title="${s.timing?.running === false ? '继续' : '暂停'}">${s.timing?.running === false ? ico('play', 14) : ico('pause', 14)}</button>
      <span class="timer-tip">${s.timing?.limit ? '倒计时结束自动交卷' : '交卷后查看解析与成绩'}</span>
    `));
    $('#btn-pause').onclick = pauseToggle;
  }
  // 答题进度条
  view.appendChild(el('div', 'q-progress-bar', `<div class="fill" style="width:${total ? Math.round(((s.idx) / total) * 100) : 0}%"></div>`));
  const meta = el('div', 'q-meta', `
    ${q.chapter ? `<span class="tag tag-chapter">${q.chapter}</span>` : ''}
    <span class="tag tag-type">${TYPE_NAME[q.type] || '题'}</span>
    ${q.difficulty != null ? `<span class="tag tag-difficulty">难度 ${q.difficulty}</span>` : ''}
    <span class="q-actions">
      <button class="q-fav" id="q-fav" title="收藏">${store.fav.has(q.id) ? `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICO.star}</svg>` : ico('star', 15)}</button>
      <button class="q-card-btn" id="q-card" title="答题卡">${ico('grid', 15)}</button>
    </span>
    <span class="q-progress-text">${q.groupTotal > 1 ? `第 ${q.groupIndex + 1}/${q.groupTotal} 小问 · ` : ''}${s.idx + 1} / ${total}</span>
  `);
  view.appendChild(meta);
  // 收藏切换（服务端跨设备同步）
  $('#q-fav').onclick = async () => {
    const fav = store.fav.has(q.id);
    await api('/api/favorites', {
      method: fav ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: q.id, subject: s.subject, chapter: q.chapter }),
    }).catch(() => {});
    if (fav) store.fav.delete(q.id); else store.fav.add(q.id);
    $('#q-fav').innerHTML = fav ? `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICO.star}</svg>` : ico('star', 15);
    $('#q-fav').classList.toggle('on', !fav);
  };
  // 答题卡弹层（粉笔风格：题号网格 + 已答标记 + 跳题）
  $('#q-card').onclick = () => {
    const overlay = el('div', 'sheet-overlay');
    overlay.innerHTML = `
      <div class="sheet">
        <div class="sheet-head">
          <b>答题卡</b>
          <span style="color:var(--text-3);font-size:12px">${s.results.filter(Boolean).length} / ${total} 已答</span>
          <button class="sheet-close">✕</button>
        </div>
        <div class="sheet-grid">
          ${s.questions.map((_, i) => {
            const answered = s.answers[i] && s.answers[i].selected != null;
            const st = answered ? 'ok' : '';
            return `<div class="sheet-cell ${i === s.idx ? 'cur' : ''} ${st}">${i + 1}</div>`;
          }).join('')}
        </div>
        <div class="sheet-legend">
          <span><i class="dot ok"></i>已答</span><span><i class="dot"></i>未答</span>
        </div>
      </div>`;
    overlay.querySelector('.sheet-close').onclick = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelectorAll('.sheet-cell').forEach((cell, i) => {
      cell.onclick = () => { s.idx = i; overlay.remove(); renderQuestion(); };
    });
    view.appendChild(overlay);
  };

  const content = el('div', 'q-content');
  renderContent(content, q);
  view.appendChild(content);

  // 材料题组：显示材料（material HTML）+ 小问标记
  if (q.material) {
    const matBox = el('div', 'material-box');
    matBox.innerHTML = `<div class="mat-head" style="cursor:pointer;font-weight:700;font-size:13px;color:var(--primary)">${ico('fileText', 14)} 给定材料 <span class="mat-status" style="color:var(--text-3);font-weight:600">点击展开</span></div><div class="mat-body" style="display:none;font-size:13px;line-height:1.8;margin-top:8px;max-height:340px;overflow:auto;background:var(--bg-soft);border-radius:8px;padding:10px">${fixImgLoading(sanitizeHtml(q.material))}</div>`;
    view.insertBefore(matBox, content.nextSibling);
    const body = matBox.querySelector('.mat-body');
    matBox.querySelector('.mat-head').onclick = () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      matBox.querySelector('.mat-status').textContent = open ? '点击展开' : '点击收起';
    };
  } else if (isEssay) {
    // 申论/综应：加载给定材料（题干带 [materialid] 或整卷材料）并展示
    const matBox = el('div', 'material-box');
    matBox.innerHTML = `<div class="mat-head" style="cursor:pointer;font-weight:700;font-size:13px;color:var(--primary)">${ico('fileText', 14)} 给定材料 <span class="mat-status" style="color:var(--text-3);font-weight:600">加载中…</span></div><div class="mat-body" style="display:none;white-space:pre-wrap;font-size:13px;line-height:1.8;margin-top:8px;max-height:320px;overflow:auto;background:var(--bg-soft);border-radius:8px;padding:10px"></div>`;
    view.insertBefore(matBox, content.nextSibling);
    const status = matBox.querySelector('.mat-status');
    const body = matBox.querySelector('.mat-body');
    matBox.querySelector('.mat-head').onclick = () => { body.style.display = body.style.display === 'none' ? 'block' : 'none'; };
    api(`/api/ai/material?paperId=${q.paperId || ''}`).then((m) => {
      if (m.text) {
        status.textContent = `（点击展开 · ${m.text.length} 字）`;
        body.textContent = m.text;
      } else {
        status.textContent = '（暂无材料）';
        body.textContent = m.notice || '材料未提取';
      }
    }).catch((e) => { status.textContent = '（加载失败）'; body.textContent = e.message; });
  }

  if (isEssay) {
    // 申论/主观题：AI 批改入口（拍照/相册双入口 + 裁剪旋转 + 多图队列 + 逐张识别拼接）
    // 队列绑定当前题目：切题后旧题图片不再显示，避免跨题答案污染
    if (ocrQueueQid !== q.id) { ocrQueue = []; ocrQueueQid = q.id; }
    const essayCard = el('div', 'card', `
      <h3>${ico('pen', 16)} ${s.subject && s.subject.includes('综应') ? '综应' : '申论'} AI 批改</h3>
      <div class="li-sub" style="margin-bottom:10px">写下作答，或拍照/上传答案图片让 AI 识别后批改。</div>
      <div style="display:flex;gap:8px;margin-bottom:6px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-ghost" id="btn-ocr-cam" type="button">${ico('camera', 15)} 拍照</button>
        <button class="btn btn-ghost" id="btn-ocr-pick" type="button">${ico('folder', 15)} 相册/上传照片</button>
        <input type="file" id="ocr-file-cam" accept="image/*" capture="environment" style="display:none">
        <input type="file" id="ocr-file-pick" accept="image/*" style="display:none">
      </div>
      <div id="ocr-queue" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"></div>
      <div id="ocr-status" style="font-size:12.5px;color:var(--muted);margin-bottom:8px;min-height:0"></div>
      <textarea id="essay-input" style="width:100%;min-height:120px;border:1.5px solid var(--border);border-radius:10px;padding:12px;font-size:14px;font-family:inherit;resize:vertical" placeholder="在此粘贴或输入你的答案…"></textarea>
    `);
    view.appendChild(essayCard);
    // ---- 识图导入作答：双入口 → 裁剪/旋转 → 图片队列 → 逐张识别按页拼接 ----
    // 拍照（Capacitor 原生相机 / 浏览器 input capture 降级）
    const openOcrCamera = async () => {
      const isCapacitor = !!(window.Capacitor && window.Capacitor.Plugins);
      if (isCapacitor) {
        // Capacitor 环境：必须走原生相机插件；不可用时明确提示，绝不静默退回相册选择器
        const Camera = window.Capacitor.Plugins.Camera;
        if (!Camera) {
          $('#ocr-status').innerHTML = `${ico('xCircle', 14)} 相机插件不可用：请确认安装的是最新版 App；也可先用「相册/上传」`;
          return;
        }
        try {
          const res = await Camera.getPhoto({ source: 'CAMERA', resultType: 'dataUrl', quality: 90, width: 2048 });
          if (res && res.dataUrl) await handleOcrImage(res.dataUrl, $('#ocr-file-cam'), openOcrCamera);
          else $('#ocr-status').innerHTML = `${ico('xCircle', 14)} 未获取到照片，请重试`;
        } catch (err) {
          $('#ocr-status').innerHTML = `${ico('xCircle', 14)} 相机打开失败：${esc(err.message)}`;
        }
        return;
      }
      $('#ocr-file-cam').click(); // 纯浏览器联调：input capture
    };
    // 统一处理一张图片（拍照/相册/原生相机共用）：进裁剪器 → 确认后入队
    const handleOcrImage = async (src, input, onRetake) => {
      const status = $('#ocr-status');
      status.innerHTML = `${ico('refresh', 14)} 读取图片…`;
      try {
        openCropEditor(src, {
          host: $('#essay-input'), // 会话校验锚点：题卡片离开 DOM 则丢弃
          retakeInput: input, // 「重拍/重选」时重新触发本次入口（input 降级路径）
          onRetake: onRetake, // 「重拍/重选」时优先走自定义行为（如原生相机）
          onCancel: () => { status.innerHTML = ''; }, // 取消裁剪：清掉「读取图片…」
          onDone: (dataUrl) => {
            ocrQueue.push({ dataUrl });
            renderOcrQueue();
            status.innerHTML = ''; // 入队成功：缩略图+加号即视觉反馈，不再弹提示
          },
        });
      } catch (err) {
        status.innerHTML = `${ico('xCircle', 14)} ${esc(err.message)}`;
      }
    };
    for (const id of ['ocr-file-cam', 'ocr-file-pick']) {
      document.getElementById(id).onchange = async (e) => {
        const input = e.target;
        const file = input.files && input.files[0];
        input.value = ''; // 允许重新选择同一文件
        if (!file) return;
        try {
          const src = await fileToDataUrl(file); // 原图进裁剪器（先裁后压，保留细节）
          await handleOcrImage(src, input);
        } catch (err) {
          $('#ocr-status').innerHTML = `${ico('xCircle', 14)} ${esc(err.message)}`;
        }
      };
    }
    $('#btn-ocr-cam').onclick = openOcrCamera;
    $('#btn-ocr-pick').onclick = () => $('#ocr-file-pick').click();
    renderOcrQueue(); // 切题后恢复队列缩略图
    const actions = el('div', 'action-row');
    const gradeBtn = el('button', 'btn btn-primary', `${ico('sparkles', 15)} AI 批改`);
    const resultBox = el('div', 'answer-box');
    resultBox.style.display = 'none';
    view.appendChild(resultBox);
    gradeBtn.onclick = async () => {
      let text = $('#essay-input').value.trim();
      // 有图片先识别合并进文本框再批改（识别失败但已有手输内容时，用手输内容继续批改）
      if (ocrQueue.length) {
        gradeBtn.disabled = true;
        gradeBtn.innerHTML = `${ico('pen', 15)} 识别图片并批改中…（最久约 3 分钟，超时会自动提示）`;
        try {
          const ocr = await runOcrAll(s.subjectName);
          text = $('#essay-input').value.trim();
          if (!ocr.ok && !text) {
            toast(ocr.failed || '图片识别失败，请重试');
            gradeBtn.disabled = false;
            gradeBtn.innerHTML = `${ico('sparkles', 15)} AI 批改`;
            return;
          }
        } catch (err) {
          // 防御：任何意外异常都不允许按钮永久卡在「识别中」
          toast(`图片识别异常：${err.message}`);
          gradeBtn.disabled = false;
          gradeBtn.innerHTML = `${ico('sparkles', 15)} AI 批改`;
          return;
        }
      }
      if (!text) { toast('请先输入答案或拍照上传'); return; }
      gradeBtn.disabled = true;
      gradeBtn.innerHTML = `${ico('pen', 15)} AI 批改中…（最久约 3 分钟，超时会自动提示）`;
      resultBox.style.display = 'block';
      resultBox.innerHTML = '<div class="spinner"></div>';
      try {
        const r = await api('/api/ai/grade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionId: q.id, content: text }),
        });
        if (r.result) {
          resultBox.innerHTML = `<div class="ab-title">${ico('sparkles', 15)} AI 批改结果</div><div style="white-space:pre-wrap;font-size:14px;line-height:1.9">${esc(r.result)}</div>`;
        } else {
          resultBox.innerHTML = `<div class="ab-title" style="color:var(--red)">${ico('alert', 15)} ${esc(r.notice || '批改失败')}</div>`;
        }
      } catch (e) {
        resultBox.innerHTML = `<div class="ab-title" style="color:var(--red)">${ico('xCircle', 15)} ${esc(e.message)}</div>`;
      }
      gradeBtn.disabled = false;
      gradeBtn.innerHTML = `${ico('sparkles', 15)} AI 批改`;
    };
    actions.appendChild(gradeBtn);
    view.appendChild(actions);
    appendNav(view, s, isEssay);
    return;
  }

  // 客观题：点选即记、自动下一题；顶部计时 + 底部操作条
  q._t0 = q._t0 || Date.now(); // 进入本题时间（累计用时用）
  const prevAnswer = s.answers[s.idx]?.selected || null; // 已答回看
  const optWrap = el('div');
  opts.forEach((opt, i) => {
    const b = el('button', 'option');
    const optHtml = sanitizeHtml(opt);
    const optText = opt.replace(/<[^>]+>/g, '').trim();
    const hasHtml = /<[a-z][^>]*>/i.test(optHtml);
    b.innerHTML = `<span class="opt-key">${LETTERS[i] || i + 1}</span><span class="opt-body">${hasHtml ? fixImgLoading(optHtml) : esc(optText)}</span>`;
    if (prevAnswer && prevAnswer.includes(i)) b.classList.add('selected');
    if ((s.answers[s.idx]?.excluded || []).includes(i)) b.classList.add('excluded');
    b.onclick = () => {
      if (b._lpFired) { b._lpFired = false; return; } // 长按触发的随后 click 吞掉
      if (paused()) { toast('已暂停，先点继续再作答'); return; }
      if (b.classList.contains('excluded')) { toast(`选项 ${LETTERS[i] || i + 1} 已被排除，长按可恢复`); return; }
      if (isMulti) {
        const cur = [...(s.answers[s.idx]?.selected || [])];
        const idx = cur.indexOf(i);
        if (idx >= 0) { cur.splice(idx, 1); b.classList.remove('selected'); }
        else { cur.push(i); b.classList.add('selected'); }
        cur.sort((a, b) => a - b); // 始终按字母序存储，成绩页/错题本显示一致
        if (cur.length) s.answers[s.idx] = { ...(s.answers[s.idx] || {}), selected: cur };
        else delete s.answers[s.idx]?.selected;
        const confirm = $('#btn-confirm');
        if (confirm) confirm.textContent = `确认选择（已选 ${cur.length}）`;
      } else {
        recordAnswer(q, i);
      }
    };
    // 长按 500ms 排除选项（排除法：置灰划线不可选；再长按恢复）。暂停期间不响应。
    let lpTimer = null, lpStart = { x: 0, y: 0 };
    const lpClear = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    b.addEventListener('pointerdown', (e) => {
      if (paused()) return;
      lpStart = { x: e.clientX, y: e.clientY };
      lpTimer = setTimeout(() => {
        lpTimer = null;
        b._lpFired = true; // 吞掉随后的 click，避免长按后误选
        const rec = (s.answers[s.idx] = s.answers[s.idx] || {});
        const ex = Array.isArray(rec.excluded) ? rec.excluded : (rec.excluded = []);
        const k = ex.indexOf(i);
        if (k >= 0) {
          ex.splice(k, 1);
          b.classList.remove('excluded');
        } else {
          ex.push(i);
          b.classList.add('excluded');
          // 该选项若处于选中态（多选进行中/回看单选）→ 自动取消选中
          const cur = Array.isArray(rec.selected) ? [...rec.selected] : [];
          const sk = cur.indexOf(i);
          if (sk >= 0) {
            cur.splice(sk, 1);
            b.classList.remove('selected');
            rec.selected = cur.length ? cur : undefined;
            if (isMulti) { const cf = $('#btn-confirm'); if (cf) cf.textContent = `确认选择（已选 ${cur.length}）`; }
          }
        }
      }, 500);
    });
    b.addEventListener('pointermove', (e) => {
      if (!lpTimer) return;
      if (Math.abs(e.clientX - lpStart.x) > 10 || Math.abs(e.clientY - lpStart.y) > 10) lpClear();
    });
    b.addEventListener('pointerup', lpClear);
    b.addEventListener('pointerleave', lpClear);
    b.addEventListener('pointercancel', lpClear);
    optWrap.appendChild(b);
  });
  view.appendChild(optWrap);
  if (!opts.length) {
    view.appendChild(el('div', 'empty-opt-tip', `${ico('info', 14)} 本题无选项（无标准答案的主观题），可直接下一题；交卷后按「无答案」统计`));
  }

  // 多选确认
  if (isMulti) {
    const confirmRow = el('div', 'action-row');
    const confirmBtn = el('button', 'btn btn-primary btn-block', `确认选择（已选 ${prevAnswer?.length ?? 0}）`);
    confirmBtn.id = 'btn-confirm';
    confirmBtn.onclick = () => {
      if (paused()) { toast('已暂停，先点继续再作答'); return; }
      const sel = s.answers[s.idx]?.selected;
      if (!sel || !sel.length) { toast('请先选择答案'); return; }
      recordAnswer(q, sel);
    };
    confirmRow.appendChild(confirmBtn);
    view.appendChild(confirmRow);
  }

  // 底部操作条：上一题 | 下一题 | 查看解析 | 交卷（窄屏两列：导航一行 / 操作一行）
  const actions = el('div', 'action-row');
  const prevBtn = el('button', 'btn btn-ghost', '上一题');
  prevBtn.onclick = prevQuestion;
  const nextBtn = el('button', 'btn btn-ghost', '下一题');
  nextBtn.onclick = nextQuestion;
  const explainBtn = el('button', 'btn btn-ghost', `${ico('book', 15)} 查看解析`);
  explainBtn.onclick = () => {
    if (paused()) { toast('已暂停，先点继续再操作'); return; }
    stampCost(s.idx);
    // 当前题展开解析（不自动判分，仅展示答案对照 + AI 解析入口）
    const existing = $('#inline-explain');
    if (existing) { existing.remove(); return; }
    const j = s.answers[s.idx] ? judge(q, s.answers[s.idx].selected) : null;
    const rightSel = j ? j.correct.map((x) => LETTERS[x]).join('') : '见解析';
    const mySel = [...(s.answers[s.idx]?.selected || [])].sort((x, y) => x - y).map((x) => LETTERS[x]).join('') || '未答';
    const box = el('div', 'answer-box');
    box.id = 'inline-explain';
    box.innerHTML = `
      <div class="ab-title">${ico('book', 16)} 解析</div>
      <div class="answer-cmp" style="margin:0 0 10px">
        <span class="cmp-item"><i class="cmp-dot mine"></i>我的答案 <b>${mySel || '—'}</b></span>
        <span class="cmp-item"><i class="cmp-dot right"></i>正确答案 <b>${rightSel}</b></span>
      </div>
      ${q.analysis ? `<div class="ab-body" style="margin:0 0 10px">${esc(q.analysis)}</div>` : ''}
      <button class="btn btn-ghost btn-block" style="margin-bottom:6px" id="btn-ai-explain">${ico('sparkles', 15)} AI 解析本题（考点/错项/技巧）</button>
      <div id="ai-explain-result" style="display:none"></div>
    `;
    view.appendChild(box);
    $('#btn-ai-explain').onclick = () => explainQuestion(q, s.answers[s.idx]?.selected, s.answers[s.idx]?.correct ?? null, box);
  };
  const submitBtn = el('button', 'btn btn-primary', '交卷');
  submitBtn.onclick = () => { if (paused()) { toast('已暂停，先点继续再交卷'); return; } submitExam(); };
  actions.appendChild(prevBtn);
  actions.appendChild(nextBtn);
  actions.appendChild(explainBtn);
  actions.appendChild(submitBtn);
  // 单题重练错题时：提供「移出错题本」按钮（直接删除该题错题记录，重练完成页不再出现）
  const navStack = store.navStack || [];
  const fromWrong = store.state.mode === 'single' && navStack[navStack.length - 2]?.name === 'wrong';
  if (fromWrong && q.id != null) {
    const rmBtn = el('button', 'btn btn-ghost', `${ico('trash', 14)} 移出错题本`);
    rmBtn.onclick = async () => {
      if (paused()) { toast('已暂停，先点继续再操作'); return; }
      const qid = q.questionId ?? q.id; // 删除接口按粉笔 questionId（两端 records 一致）
      await api('/api/records/wrong', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: qid }),
      }).catch(() => {});
      store.wrong = store.wrong.filter((x) => x.id !== q.id && x.id !== qid);
      saveWrong();
      toast('已移出错题本');
      exitSingle();
    };
    actions.appendChild(rmBtn);
  }
  view.appendChild(actions);
}

function submitAnswer(q, selected, optWrap, opts, isMulti) {
  api('/api/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: q.id, selected }),
  }).then((r) => {
    optWrap._locked = true;
    const correctSet = new Set((r.correct || []).map(Number));
    const graded = r.ok !== null; // null = 无标准答案，不判分
    optWrap.querySelectorAll('.option').forEach((o, i) => {
      if (correctSet.has(i)) o.classList.add('correct');
      else if (graded && (Array.isArray(r.selected) ? r.selected : [r.selected]).includes(i)) o.classList.add('wrong');
      o.style.pointerEvents = 'none';
    });
    const banner = el('div', `result-banner ${graded ? (r.ok ? 'ok' : 'no') : 'none'}`, graded ? (r.ok ? `${ico('checkCircle', 16)} 回答正确！` : `${ico('xCircle', 16)} 回答错误`) : `${ico('ban', 16)} 无标准答案（本题不判分）`);
    // 答案对照行（粉笔风格：我的答案 / 正确答案；多选按字母序显示）
    const mySel = [...(r.selected || [])].sort((a, b) => a - b).map((i) => 'ABCDEFGH'[i]).join('');
    const rightSel = [...(r.correct || [])].sort((a, b) => a - b).map((i) => 'ABCDEFGH'[i]).join('');
    const cmp = el('div', 'answer-cmp', `
      <span class="cmp-item"><i class="cmp-dot mine"></i>我的答案 <b>${mySel || '—'}</b></span>
      <span class="cmp-item"><i class="cmp-dot right"></i>正确答案 <b>${rightSel || '见解析'}</b></span>
    `);
    // 插入到选项后
    const view = $('#view');
    const actions = view.querySelector('.action-row');
    view.insertBefore(cmp, actions);
    view.insertBefore(banner, actions);
    // 解析框：答案对照 + AI 解析按钮
    const box = el('div', 'answer-box');
    box.innerHTML = `<div class="ab-title">${ico('book', 16)} 解析</div>${q.analysis ? `<div class="ab-body" style="margin:8px 0">${esc(q.analysis)}</div>` : ''}${r.correctText?.length ? '正确答案内容：' + r.correctText.map((t) => esc(t)).join(' | ') : ''}
      <button class="btn btn-ghost btn-block" style="margin-top:10px" id="btn-ai-explain">${ico('sparkles', 15)} AI 解析本题（解析考点/错项/技巧）</button>
      <div id="ai-explain-result" style="margin-top:8px;display:none"></div>`;
    view.insertBefore(box, actions);
    $('#btn-ai-explain').onclick = () => explainQuestion(q, selected, r.ok, box);
    // 服务端做题记录落库（判分后自动上报，供进度 AI 与跨设备同步）
    api('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questionId: q.id,
        subject: store.state.subject,
        chapter: q.chapter,
        type: q.type,
        selected: Array.isArray(selected) ? selected : [selected],
        correct: r.ok,
        costMs: (Date.now() - (q._t0 || Date.now())),
      }),
    }).catch(() => {});
    if (r.ok === false) {
      store.wrong.unshift({ id: q.id, content: q.content.slice(0, 60), answer: (r.correct || []).join(','), myAnswer: (r.selected || []).join(','), subject: store.state.subject, chapter: q.chapter, time: Date.now() });
      saveWrong();
    }
  }).catch((e) => toast(e.message));
}

// ---------- 交卷：漏答提示 + 批量落库 + 解析界面 ----------
async function submitExam(force) {
  const s = store.state;
  stampCost(s.idx);
  stopTimer();
  const unanswered = s.questions.map((_, i) => i).filter((i) => !s.answers[i] || s.answers[i].selected == null);
  if (unanswered.length && !force) { showUnanswered(unanswered); return; }
  // 强制交卷：未答的题按错误处理
  for (const i of unanswered) {
    if (!s.answers[i]) s.answers[i] = { selected: null, correct: false, costMs: 0 };
    else s.answers[i].selected = null, s.answers[i].correct = false;
  }
  // 批量落库 + 错题本
  for (let i = 0; i < s.questions.length; i++) {
    const q = s.questions[i];
    const a = s.answers[i];
    const j = judge(q, a.selected);
    // 多选已选但从未点「确认选择」的题：交卷时兜底判分，避免成绩页出现「无标准答案」
    const finalCorrect = a.correct != null ? a.correct : (j.valid ? j.ok : null);
    const selSorted = a.selected ? [...a.selected].sort((x, y) => x - y) : a.selected;
    api('/api/records', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questionId: q.id, subject: q.subject || s.subject, chapter: q.chapter, type: q.type,
        selected: selSorted || [], correct: finalCorrect, costMs: a.costMs,
      }),
    }).catch(() => {});
    if (finalCorrect === false) {
      store.wrong.unshift({ id: q.id, content: q.content.slice(0, 60), answer: j.correct.join(','), myAnswer: a.selected ? [...a.selected].sort((x, y) => x - y).join(',') : '未答', subject: q.subject || s.subject, chapter: q.chapter, time: Date.now() });
      saveWrong();
    }
  }
  if (window.Telemetry) {
    const _corr = s.answers.filter((a) => a && a.correct === true).length;
    Telemetry.track('practice_done', { n: s.questions.length, correct: _corr, subject: s.subject || '' });
  }
  renderReview();
}
/** 漏答提示弹层：未答题号 + 继续作答 / 直接交卷 */
function showUnanswered(list) {
  const view = $('#view');
  const overlay = el('div', 'sheet-overlay');
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-head"><b>${ico('alert', 14)} 还有 ${list.length} 题未作答</b><button class="sheet-close">✕</button></div>
      <div class="sheet-grid">${list.map((i) => `<div class="sheet-cell no" data-i="${i}">${i + 1}</div>`).join('')}</div>
      <div class="sheet-legend"><span>点击题号跳转作答</span></div>
      <div class="action-row" style="margin-top:14px">
        <button class="btn btn-ghost" id="btn-skip-close">继续作答</button>
        <button class="btn btn-primary" id="btn-force-submit">直接交卷</button>
      </div>
    </div>`;
  overlay.querySelector('.sheet-close').onclick = () => overlay.remove();
  overlay.querySelector('#btn-skip-close').onclick = () => overlay.remove();
  overlay.querySelector('#btn-force-submit').onclick = () => { overlay.remove(); submitExam(true); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelectorAll('.sheet-cell').forEach((cell) => {
    cell.onclick = () => {
      const i = Number(cell.dataset.i);
      store.state.idx = i;
      overlay.remove();
      renderQuestion();
    };
  });
  view.appendChild(overlay);
}
/** 交卷后解析界面：分数 / 每题解析 / 用时 / AI 解析（筛选 + 答题卡跳转 + 全部解析） */
function renderReview() {
  const s = store.state;
  setView('review');
  $('#app-title').innerHTML = `${ico('chart', 19)} 成绩与解析`;
  const view = $('#view');
  const total = s.questions.length;
  const scored = s.answers.filter((a) => a && a.correct != null); // 有标准答案可判分的题
  const correctN = scored.filter((a) => a.correct).length;
  const rate = scored.length ? Math.round((correctN / scored.length) * 100) : 0;
  const noAns = total - scored.length;
  const wrongN = scored.length - correctN;
  const elapsed = s.timing?.elapsed ?? 0;
  view.innerHTML = '';
  view.appendChild(el('div', 'hero', `
    <div class="hero-eyebrow">EXAM ARCHIVE · 本次成绩</div>
    <div class="hero-title">答对 ${correctN} / ${scored.length} 题</div>
    <div class="hero-stats">
      <div class="hero-stat"><div class="hs-num">${rate}%</div><div class="hs-label">正确率</div></div>
      <div class="hero-stat"><div class="hs-num">${fmtTime(elapsed)}</div><div class="hs-label">总用时</div></div>
      <div class="hero-stat"><div class="hs-num">${wrongN}${noAns ? ` +${noAns}` : ''}</div><div class="hs-label">错题${noAns ? '/无答案' : ''}</div></div>
    </div>
  `));
  /* ---- 工具条：筛选 tab + 答题卡 + 全部解析 ---- */
  const cards = [];
  const toolbar = el('div', 'review-toolbar');
  const tabs = el('div', 'rv-tabs');
  const mkTab = (key, label, cnt) => {
    const t = el('button', 'rv-tab' + (key === 'all' ? ' active' : ''), `${label}<b>${cnt}</b>`);
    t.dataset.f = key;
    t.onclick = () => {
      tabs.querySelectorAll('.rv-tab').forEach((x) => x.classList.toggle('active', x === t));
      applyReviewFilter(key, cards);
    };
    tabs.appendChild(t);
  };
  mkTab('all', '全部', total);
  mkTab('wrong', '错题', wrongN);
  mkTab('none', '无答案', noAns);
  toolbar.appendChild(tabs);
  const btnCard = el('button', 'btn btn-ghost btn-sm rv-act', `${ico('grid', 15)} 答题卡`);
  btnCard.onclick = () => showReviewSheet(cards);
  toolbar.appendChild(btnCard);
  const btnAll = el('button', 'btn btn-ghost btn-sm rv-act', `${ico('sparkles', 15)} 全部解析`);
  btnAll.onclick = () => explainAllReview(cards, btnAll);
  toolbar.appendChild(btnAll);
  view.appendChild(toolbar);
  // 悬浮答题卡入口（fixed 右下角，长卷滚动时始终可见；点开答题卡可跳任意题）
  const fab = el('button', 'review-fab', `${ico('grid', 16)} 答题卡`);
  fab.onclick = () => showReviewSheet(cards);
  view.appendChild(fab);
  s.questions.forEach((q, i) => {
    const a = s.answers[i] || { selected: null, correct: null, costMs: 0 };
    const j = judge(q, a.selected);
    const mySel = [...(a.selected || [])].sort((x, y) => x - y).map((x) => LETTERS[x]).join('') || '未答';
    const rightSel = j.valid ? j.correct.map((x) => LETTERS[x]).join('') : '';
    // 多选未点确认的题：显示时兜底判分（与 submitExam 落库一致）
    const ok = a.correct != null ? a.correct : (j.valid ? j.ok : null);
    const badge = ok == null ? 'badge-amber' : (ok ? 'badge-green' : 'badge-red');
    const badgeText = ok == null ? '◇ 无标准答案' : (ok ? '✓ 答对' : '✗ 答错');
    const card = el('div', 'card review-card');
    card.dataset.i = String(i);
    card.innerHTML = `
      <div class="review-head">
        <span class="badge ${badge}">${badgeText} · 第${i + 1}题</span>
        <span class="review-time">⏱ ${((a.costMs || 0) / 1000).toFixed(1)}s</span>
      </div>
      <div class="answer-cmp" style="margin:10px 0">
        <span class="cmp-item"><i class="cmp-dot mine"></i>我的答案 <b>${mySel || '—'}</b></span>
        <span class="cmp-item"><i class="cmp-dot right"></i>正确答案 <b>${rightSel || (j.valid ? '见解析' : '—')}</b></span>
      </div>`;
    const content = el('div', 'q-content');
    renderContent(content, q);
    card.appendChild(content);
    if ((q.options || []).length && j.valid) {
      const ow = el('div');
      const correctSet = new Set(j.correct);
      q.options.forEach((opt, oi) => {
        const b = el('div', 'option');
        const optHtml = sanitizeHtml(opt);
        const txt = opt.replace(/<[^>]+>/g, '').trim();
        const hasHtml = /<[a-z][^>]*>/i.test(optHtml);
        b.innerHTML = `<span class="opt-key">${LETTERS[oi]}</span><span class="opt-body">${hasHtml ? fixImgLoading(optHtml) : esc(txt)}</span>`;
        if (correctSet.has(oi)) b.classList.add('correct');
        else if (a.selected && a.selected.includes(oi)) b.classList.add('wrong');
        b.style.pointerEvents = 'none';
        b.style.cursor = 'default';
        ow.appendChild(b);
      });
      card.appendChild(ow);
    }
    if (q.analysis) {
      const oa = el('div', 'answer-box');
      oa.style.marginTop = '10px';
      oa.innerHTML = `<div class="ab-title">${ico('book', 16)} 解析</div><div class="ab-body">${esc(q.analysis)}</div>`;
      card.appendChild(oa);
    }
    const btn = el('button', 'btn btn-ghost btn-block', `${ico('sparkles', 15)} AI 解析本题`);
    btn.style.marginTop = '10px';
    const rbox = el('div', 'answer-box');
    rbox.style.display = 'none';
    btn.onclick = () => explainReview(q, a.selected, ok, rbox, btn);
    card.appendChild(btn);
    card.appendChild(rbox);
    cards.push(card);
    view.appendChild(card);
  });
  const back = el('button', 'btn btn-primary btn-block', '完成，返回');
  back.style.marginTop = '6px';
  back.onclick = () => (store.state.mode === 'single' ? exitSingle() : goBack());
  view.appendChild(back);
}

/** 结果页筛选：all=全部 / wrong=错题 / none=无标准答案 */
function applyReviewFilter(key, cards) {
  const s = store.state;
  cards.forEach((card, i) => {
    const ok = s.answers[i]?.correct;
    const show = key === 'all' || (key === 'wrong' && ok === false) || (key === 'none' && ok == null);
    card.style.display = show ? '' : 'none';
  });
}

/** 答题卡悬浮框：题号网格（绿=答对 红=答错 灰=无答案），点击跳转到对应题目 */
function showReviewSheet(cards) {
  const s = store.state;
  const overlay = el('div', 'sheet-overlay');
  const cells = s.questions.map((_, i) => {
    const ok = s.answers[i]?.correct;
    const cls = ok == null ? '' : (ok ? 'ok' : 'no');
    return `<div class="sheet-cell ${cls}" data-i="${i}">${i + 1}</div>`;
  }).join('');
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-head"><b>${ico('grid', 16)} 答题卡</b><span class="sheet-count">${s.questions.length} 题</span><button class="sheet-close">✕</button></div>
      <div class="sheet-grid">${cells}</div>
      <div class="sheet-legend">
        <span><i class="dot ok"></i>答对</span>
        <span><i class="dot no"></i>答错</span>
        <span><i class="dot"></i>无答案</span>
        <span class="sheet-hint">点击题号跳转</span>
      </div>
    </div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.sheet-close').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('.sheet-cell').forEach((cell) => {
    cell.onclick = () => {
      const i = Number(cell.dataset.i);
      close();
      jumpToReviewCard(cards, i);
    };
  });
  $('#view').appendChild(overlay);
}

/** 跳转到结果页第 i 题卡片并高亮闪烁（若被筛选隐藏则先切回“全部”） */
function jumpToReviewCard(cards, i) {
  const card = cards[i];
  if (!card) return;
  if (card.style.display === 'none') {
    const t = document.querySelector('.rv-tab[data-f="all"]');
    if (t) t.click();
  }
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.classList.remove('flash');
  void card.offsetWidth; // 重启动画
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1600);
}

/** 全部解析：对当前可见题目批量加载 AI 解析（并发 2 + 进度；再次点击收起） */
async function explainAllReview(cards, btn) {
  const s = store.state;
  const visible = cards.map((c, i) => ({ card: c, i })).filter((t) => t.card.style.display !== 'none');
  if (!visible.length) return;
  if (btn.dataset.mode === 'collapse') { // 收起模式
    visible.forEach(({ card }) => {
      const box = card.querySelector('.answer-box');
      if (box && box.innerHTML) box.style.display = 'none';
    });
    btn.dataset.mode = '';
    btn.innerHTML = `${ico('sparkles', 15)} 全部解析`;
    return;
  }
  visible.forEach(({ card }) => {
    const box = card.querySelector('.answer-box');
    if (box.innerHTML) box.style.display = 'block'; // 已有解析的直接展开
  });
  const need = visible.filter(({ card }) => {
    const box = card.querySelector('.answer-box');
    return !box.innerHTML;
  });
  if (!need.length) {
    btn.dataset.mode = 'collapse';
    btn.innerHTML = `${ico('sparkles', 15)} 收起解析`;
    toast('解析已全部加载');
    return;
  }
  btn.disabled = true;
  let done = 0;
  const total = need.length;
  const upd = () => { btn.innerHTML = `${ico('sparkles', 15)} 解析中 ${done}/${total}`; };
  upd();
  const CONC = 3; // 并发解析数：兼顾速度与 LLM 限流
  let next = 0;
  const worker = async () => {
    while (next < need.length) {
      const { card, i } = need[next++];
      const q = s.questions[i];
      const a = s.answers[i] || {};
      const box = card.querySelector('.answer-box');
      box.style.display = 'block';
      box.innerHTML = '<div class="spinner"></div>';
      const r = await api('/api/ai/explain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: q.id, selected: a.selected, correct: a.correct }),
      }).catch((e) => ({ notice: e.message }));
      if (r.content) {
        box.innerHTML = `<div class="ab-title">${ico('sparkles', 15)} AI 解析${r.cached ? '<span class="ab-cache">（缓存）</span>' : ''}</div><div class="ab-body">${esc(r.content)}</div>`;
      } else {
        box.innerHTML = `<div class="ab-title ab-err">${ico('alert', 15)} ${esc(r.notice || '解析失败')}</div>`;
      }
      done++;
      upd();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, need.length) }, () => worker()));
  btn.disabled = false;
  btn.dataset.mode = 'collapse';
  btn.innerHTML = `${ico('sparkles', 15)} 收起解析`;
}
/** 解析界面的 AI 解析（每题独立容器） */
async function explainReview(q, selected, correct, box, btn) {
  if (box.style.display === 'none' || !box.innerHTML) {
    btn.disabled = true;
    btn.innerHTML = `${ico('sparkles', 15)} AI 解析中…`;
    box.style.display = 'block';
    box.innerHTML = '<div class="spinner"></div>';
    const r = await api('/api/ai/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify((() => {
        const b = { questionId: q.id, selected, correct };
        if (q.type === 'custom' && (q.id || '').startsWith('custom-')) {
          b.questionData = {
            content: q.content || q.prompt || '',
            material: q.material || '',
            options: q.options || [],
            answer: q.answer || '',
            answerIndex: q.answerIndex != null ? q.answerIndex : -1,
          };
        }
        return b;
      })()),
    }).catch((e) => ({ notice: e.message }));
    if (r.content) box.innerHTML = `<div class="ab-title">${ico('sparkles', 15)} AI 解析${r.cached ? ' <span style="color:var(--muted);font-size:11px">（缓存）</span>' : ''}</div><div style="white-space:pre-wrap;font-size:13.5px;line-height:1.8">${esc(r.content)}</div>`;
    else box.innerHTML = `<div class="ab-title" style="color:var(--red)">${ico('alert', 15)} ${esc(r.notice || r.error || '解析失败')}</div>`;
    btn.disabled = false;
    btn.innerHTML = `${ico('sparkles', 15)} AI 解析本题`;
  } else {
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
  }
}

// ---------- 图片处理（OCR 拍照/上传） ----------
const OCR_MAX_W = CropMath.OCR_MAX_W; // 1600：手写识别需要足够分辨率，先裁后压

/** 读取文件为 data URL（原图，供裁剪器使用） */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

// ---------- 多页答案图片队列 ----------
let ocrQueue = [];   // [{ dataUrl }]：裁剪/旋转确认后加入，逐张识别后按页拼接
let ocrQueueQid = null; // 队列所属题目 id（切题后清空，避免跨题答案污染）
let cropSession = 0;    // 裁剪会话代次：视图切换后使未完成的裁剪会话失效
let cropInstance = null; // 单例：{ overlay, ro }，同时只开一个裁剪器

function renderOcrQueue() {
  const q = $('#ocr-queue');
  if (!q) return;
  // 缩略图 + 「＋」添加框（半透明、带边框）；已有图才显示加号，点击继续拍照连拍
  q.innerHTML = ocrQueue.map((item, i) => `
    <div class="ocr-thumb" data-i="${i}" title="点击重新裁剪">
      <img src="${item.dataUrl}" alt="第${i + 1}页">
      <span class="ocr-thumb-page">${i + 1}</span>
      <button class="ocr-thumb-del" data-i="${i}" title="移除">×</button>
    </div>`).join('')
    + (ocrQueue.length ? `<div class="ocr-add" title="继续添加图片">＋</div>` : '');
  q.querySelectorAll('.ocr-thumb').forEach((t) => {
    const i = Number(t.dataset.i);
    t.querySelector('img').onclick = () => {
      openCropEditor(ocrQueue[i].dataUrl, {
        host: $('#essay-input'), // 会话校验锚点
        onDone: (dataUrl) => { ocrQueue[i] = { dataUrl }; renderOcrQueue(); },
      });
    };
    t.querySelector('.ocr-thumb-del').onclick = (e) => {
      e.stopPropagation();
      ocrQueue.splice(i, 1);
      renderOcrQueue();
    };
  });
  const add = q.querySelector('.ocr-add');
  if (add) add.onclick = () => { const b = $('#btn-ocr-cam'); if (b) b.click(); }; // 继续拍照
}

/** 逐张串行识别，多页按「【第N页】」拼接填入文本框；某页失败立即中断并提示。
 *  @returns {Promise<{ok:boolean, text?:string, failed?:string}>} 供「AI 批改」一键识别+批改流程使用 */
async function runOcrAll(subject) {
  if (!ocrQueue.length) { toast('请先拍照或上传照片'); return { ok: false, failed: '请先拍照或上传照片' }; }
  const ta0 = $('#essay-input'); // 识别期间视图可能切换，写入前校验节点身份
  const parts = [];
  let failed = null;
  for (let i = 0; i < ocrQueue.length; i++) {
    const status = $('#ocr-status');
    if (!status) { failed = '视图已切换，识别中止'; break; } // 识别中切题：安全退出
    status.innerHTML = `${ico('refresh', 14)} AI 识别第 ${i + 1}/${ocrQueue.length} 页…（约 5~20 秒）`;
    try {
      const r = await api('/api/ai/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: ocrQueue[i].dataUrl, subject }),
      });
      if (r.text) parts.push(r.text.trim());
      else { failed = `第 ${i + 1} 页：${r.notice || '识别失败'}`; break; }
    } catch (err) { failed = `第 ${i + 1} 页：${err.message}`; break; }
  }
  if (parts.length && ta0 && ta0.isConnected) { // 视图已切换则丢弃，防止跨题污染
    const joined = parts.length > 1
      ? parts.map((t, i) => `【第${i + 1}页】\n${t}`).join('\n\n')
      : parts[0];
    const existing = ta0.value.trim();
    ta0.value = existing ? `${existing}\n\n${joined}` : joined; // 手输+图片识别内容合并
  }
  const status = $('#ocr-status');
  if (status) {
    if (failed) {
      status.innerHTML = `${ico('alert', 14)} ${esc(failed)}${parts.length ? `（已识别前 ${parts.length} 页，可修改后批改）` : ''}`;
    } else {
      status.innerHTML = `${ico('checkCircle', 14)} 已识别，可修改后批改`;
      toast('识别完成');
    }
  }
  return failed ? { ok: false, failed } : { ok: true, text: ta0 && ta0.isConnected ? ta0.value : '' };
}

// ---------- 图片裁剪器（拍照/上传后先裁剪旋转，确认再入队） ----------
function openCropEditor(srcDataUrl, opts = {}) {
  const session = cropSession; // 记录当前会话代次
  const img = new Image();
  img.onload = () => {
    if (session !== cropSession) return;                    // 视图已切换则丢弃
    if (opts.host && !opts.host.isConnected) return;        // 宿主题卡片已离开 DOM 则丢弃
    // 超大图先缩放到最长边 ≤2048：Android WebView canvas 有尺寸/内存限制，
    // 相机原图（4000×3000+）直接建 canvas 会分配失败 → 裁剪框空白（透出背后页面）
    if (Math.max(img.naturalWidth, img.naturalHeight) > 2048) {
      const scale = 2048 / Math.max(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const small = new Image();
      small.onload = () => { if (session === cropSession) buildCropEditor(small, opts); };
      small.onerror = () => toast('图片处理失败，请重试');
      small.src = c.toDataURL('image/jpeg', 0.9);
      return;
    }
    buildCropEditor(img, opts);
  };
  img.onerror = () => toast('图片无法解码（可能是 HEIC 格式），请转成 JPG/PNG 或截图后重试');
  img.src = srcDataUrl;
}

function closeCropEditor() {
  if (cropInstance) {
    const { overlay, ro } = cropInstance;
    if (ro) ro.disconnect();
    overlay.remove();
    cropInstance = null;
  }
}

function buildCropEditor(img, opts) {
  closeCropEditor(); // 清理旧实例
  const overlay = el('div', 'crop-overlay');
  overlay.innerHTML = `
    <div class="crop-head">
      <span class="crop-title">${ico('camera', 16)} 裁剪 / 旋转图片</span>
      <button id="crop-rot" type="button">${ico('refresh', 15)} 旋转 90°</button>
      <button id="crop-close" type="button" style="font-size:16px;padding:6px 11px" aria-label="关闭">✕</button>
    </div>
    <div class="crop-stage"><canvas id="crop-canvas"></canvas></div>
    <div class="crop-foot">
      <button class="crop-retake" id="crop-retake" type="button">${ico('camera', 15)} 重拍/重选</button>
      <button class="crop-cancel" id="crop-cancel" type="button">取消</button>
      <button class="crop-ok" id="crop-ok" type="button">${ico('checkCircle', 15)} 确认</button>
    </div>`;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector('#crop-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  let rot = 0;          // 0/1/2/3（90° 步进）
  let rotCanvas = null; // 旋转后的原图画布（源坐标系，供输出裁剪）
  let crop = null;      // {x,y,w,h} 显示坐标
  let drag = null;      // {mode, dx/dy 或 anchorX/anchorY}
  let view = { x: 0, y: 0, w: 0, h: 0 }; // 图片在画布中的显示区域

  function renderRotated() {
    const swap = rot % 2 === 1;
    const w = swap ? img.height : img.width;
    const h = swap ? img.width : img.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.translate(w / 2, h / 2);
    g.rotate((rot % 4) * Math.PI / 2);
    g.drawImage(img, -img.width / 2, -img.height / 2);
    rotCanvas = c;
  }

  function layout() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = Math.max(10, Math.round(rect.width * dpr));
    canvas.height = Math.max(10, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = rect.width, H = rect.height;
    const scale = Math.min(W / rotCanvas.width, H / rotCanvas.height);
    const dispW = rotCanvas.width * scale, dispH = rotCanvas.height * scale;
    view = { x: (W - dispW) / 2, y: (H - dispH) / 2, w: dispW, h: dispH };
  }

  function resetCrop() {
    // 默认框四周内缩，让四角手柄离开屏幕边缘，方便手指操作
    const m = Math.min(40, Math.floor(view.w / 6), Math.floor(view.h / 6));
    crop = { x: view.x + m, y: view.y + m, w: Math.max(1, view.w - m * 2), h: Math.max(1, view.h - m * 2) };
  }

  function draw() {
    const W = canvas.width / dpr, H = canvas.height / dpr; // 逻辑尺寸（避免与 setTransform 混用物理像素）
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a0c12';
    ctx.fillRect(0, 0, W, H);
    try {
      ctx.drawImage(rotCanvas, view.x, view.y, view.w, view.h);
    } catch (err) {
      // 图片绘制失败（内存不足等）：保持深色底，绝不让裁剪框透出页面
      console.error('[crop] drawImage 失败:', err);
      ctx.fillStyle = '#3a3f4a';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('图片加载失败，请重试', W / 2, H / 2);
    }
    // 裁剪框外遮罩：evenodd 路径填充——全屏矩形 + 裁剪区矩形，只填充裁剪区外；
    // 裁剪区保留照片（不能用 clearRect 挖空，否则会透出 overlay 背后的页面）
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(crop.x, crop.y, crop.w, crop.h);
    ctx.fill('evenodd');
    // 边框 + 九宫格参考线
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(crop.x, crop.y, crop.w, crop.h);
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (let i = 1; i <= 2; i++) {
      const gx = crop.x + (crop.w * i) / 3;
      const gy = crop.y + (crop.h * i) / 3;
      ctx.moveTo(gx, crop.y); ctx.lineTo(gx, crop.y + crop.h);
      ctx.moveTo(crop.x, gy); ctx.lineTo(crop.x + crop.w, gy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    // 四角手柄（加大 + 深色描边，浅色图片上也清晰）
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.lineWidth = 2;
    for (const [hx, hy] of [[crop.x, crop.y], [crop.x + crop.w, crop.y], [crop.x, crop.y + crop.h], [crop.x + crop.w, crop.y + crop.h]]) {
      ctx.beginPath();
      ctx.arc(hx, hy, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  function hitTest(px, py) {
    const m = 20;
    const { x, y, w, h } = crop;
    if (px >= x - m && px <= x + m && py >= y - m && py <= y + m) return 'nw';
    if (px >= x + w - m && px <= x + w + m && py >= y - m && py <= y + m) return 'ne';
    if (px >= x - m && px <= x + m && py >= y + h - m && py <= y + h + m) return 'sw';
    if (px >= x + w - m && px <= x + w + m && py >= y + h - m && py <= y + h + m) return 'se';
    if (px >= x && px <= x + w && py >= y && py <= y + h) return 'move';
    return 'new';
  }

  function onPointerDown(e) {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const mode = hitTest(px, py);
    if (mode === 'new') {
      // 框外按下：以按下点为起点拉新框
      crop = { x: px, y: py, w: 0, h: 0 };
      drag = { mode: 'se', anchorX: px, anchorY: py };
    } else if (mode === 'move') {
      drag = { mode: 'move', dx: crop.x - px, dy: crop.y - py };
    } else {
      const anchorX = mode.includes('w') ? crop.x + crop.w : crop.x;
      const anchorY = mode.includes('n') ? crop.y + crop.h : crop.y;
      drag = { mode, anchorX, anchorY };
    }
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (drag.mode === 'move') {
      const r = CropMath.moveRect(px + drag.dx, py + drag.dy, crop, view);
      crop.x = r.x; crop.y = r.y;
    } else {
      crop = CropMath.resizeRect(px, py, drag.anchorX, drag.anchorY, view);
    }
    draw();
  }

  function onPointerUp() { drag = null; }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  // 旋转 90°：重建旋转画布并重置裁剪框为全图
  overlay.querySelector('#crop-rot').onclick = () => {
    rot = (rot + 1) % 4;
    renderRotated();
    layout();
    resetCrop();
    draw();
  };
  // 重拍/重选：关闭裁剪器并重新触发本次图片入口（拍照或相册）
  overlay.querySelector('#crop-retake').onclick = () => {
    closeCropEditor();
    if (opts.onRetake) { opts.onRetake(); return; } // 自定义重拍（如 Capacitor 原生相机）
    if (opts.retakeInput && opts.retakeInput.isConnected) opts.retakeInput.click();
  };
  overlay.querySelector('#crop-cancel').onclick = () => { closeCropEditor(); if (opts.onCancel) opts.onCancel(); };
  overlay.querySelector('#crop-close').onclick = () => { closeCropEditor(); if (opts.onCancel) opts.onCancel(); };
  // 确认：显示坐标换算回原图坐标，先裁后压输出 ≤1600px JPEG
  overlay.querySelector('#crop-ok').onclick = () => {
    const o = CropMath.calcCropOutput(rotCanvas.width, rotCanvas.height, crop, view);
    const out = document.createElement('canvas');
    out.width = o.outW; out.height = o.outH;
    out.getContext('2d').drawImage(rotCanvas, o.sx, o.sy, o.sw, o.sh, 0, 0, o.outW, o.outH);
    const dataUrl = out.toDataURL('image/jpeg', 0.85);
    closeCropEditor();
    if (opts.onDone) opts.onDone(dataUrl);
  };

  // 初始化渲染：任何一步失败（超大图 canvas 内存不足等）都关闭裁剪器并提示，
  // 绝不能留下半透明 overlay 透出背后页面（用户曾反馈“裁剪框内是手机屏幕内容”即此现象）
  try {
    renderRotated();
    layout();
    resetCrop();
    draw();
  } catch (err) {
    console.error('[crop] 初始化渲染失败:', err);
    overlay.remove(); // 直接移除 overlay：此时 cropInstance 可能尚未赋值，closeCropEditor 无法清理
    closeCropEditor(); // 兜底清理已注册实例（ResizeObserver 等）
    toast('图片过大，无法裁剪，请重试或换一张图');
    if (opts.onCancel) opts.onCancel();
    return;
  }

  // 容器尺寸变化（地址栏收展/旋转屏幕）：重算布局并按相对位置保持裁剪框
  const ro = new ResizeObserver(() => {
    if (!overlay.isConnected) return;
    const oldView = view;
    layout();
    if (crop && oldView.w > 0 && oldView.h > 0) {
      const rx = (crop.x - oldView.x) / oldView.w;
      const ry = (crop.y - oldView.y) / oldView.h;
      const rw = crop.w / oldView.w;
      const rh = crop.h / oldView.h;
      crop = { x: view.x + rx * view.w, y: view.y + ry * view.h, w: rw * view.w, h: rh * view.h };
    } else resetCrop();
    draw();
  });
  ro.observe(canvas.parentElement);
  cropInstance = { overlay, ro };
}

// ---------- AI 解析本题 ----------
async function explainQuestion(q, selected, correct, box) {  const btn = $('#btn-ai-explain');
  const result = box.querySelector('#ai-explain-result');
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = `${ico('sparkles', 15)} AI 解析中…（约 5~15 秒）`;
  result.style.display = 'block';
  result.innerHTML = '<div class="spinner" style="width:20px;height:20px"></div>';
  try {
    const r = await api('/api/ai/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify((() => {
        const b = { questionId: q.id, selected, correct };
        if (q.type === 'custom' && (q.id || '').startsWith('custom-')) {
          b.questionData = {
            content: q.content || q.prompt || '',
            material: q.material || '',
            options: q.options || [],
            answer: q.answer || '',
            answerIndex: q.answerIndex != null ? q.answerIndex : -1,
          };
        }
        return b;
      })()),
    });
    if (r.content) {
      let html = `<div class="ab-title">${ico('sparkles', 15)} AI 解析${r.cached ? ' <span style="color:var(--muted);font-size:11px">（缓存）</span>' : ''}</div>`;
      if (r.imageNote) {
        html += `<details style="margin-bottom:8px"><summary style="font-size:13px;color:var(--muted);cursor:pointer">${ico('camera', 13)} 查看 AI 识图转写（含图题）</summary><div style="white-space:pre-wrap;font-size:12.5px;line-height:1.7;color:var(--muted);margin-top:6px;background:var(--bg);padding:8px;border-radius:8px">${esc(r.imageNote.replace(/^【图片转写（AI 识图）】\s*/, ''))}</div></details>`;
      }
      html += `<div style="white-space:pre-wrap;font-size:14px;line-height:1.8">${esc(r.content)}</div>`;
      result.innerHTML = html;
    } else {
      result.innerHTML = `<div class="ab-title" style="color:var(--red)">${ico('alert', 15)} ${esc(r.notice || r.error || '解析失败')}</div>`;
    }
  } catch (e) {
    result.innerHTML = `<div class="ab-title" style="color:var(--red)">${ico('xCircle', 15)} ${esc(e.message)}</div>`;
  }
  btn.disabled = false;
  btn.innerHTML = `${ico('sparkles', 15)} AI 解析本题（解析考点/错项/技巧）`;
}

function appendNav(view, s, isEssay) {  const row = el('div', 'action-row');
  if (s.idx > 0) {
    const prev = el('button', 'btn btn-ghost', '‹ 上一题');
    prev.onclick = prevQuestion;
    row.appendChild(prev);
  }
  const next = el('button', 'btn btn-primary', s.idx < s.questions.length - 1 ? '下一题 ›' : `${ico('flag', 15)} 完成`);
  next.onclick = () => {
    if (paused()) { toast('已暂停，先点继续再操作'); return; }
    if (isEssay && !s.results[s.idx]) { s.results[s.idx] = { ok: null }; }
    s.idx++;
    renderQuestion();
  };
  row.appendChild(next);
  view.appendChild(row);
}

// ---------- 结果页 ----------
function renderResult() {
  if (store.state.mode === 'single') {
    // 单题重练完成：清掉导航栈里的 single + 来源层（wrong/fav），避免残留污染后续导航
    const stack = store.navStack;
    stack.pop();
    stack.pop();
  }
  setView('practice');
  $('#app-title').innerHTML = `练习完成 ${ico('trophy', 20)}`;
  const view = $('#view');
  const done = store.wrong.filter((w) => w.time > (Date.now() - 3600 * 1000 * 24)).length;
  view.innerHTML = `
    <div class="card" style="text-align:center;padding:30px 16px">
      <div style="font-size:44px;margin-bottom:10px">${ico('trophy', 44)}</div>
      <h2>练习完成！</h2>
      <div class="li-sub" style="margin-top:6px">共 ${store.state.questions.length} 题</div>
      <div style="margin-top:16px">
        <button class="btn btn-primary btn-block" id="again">${ico('repeat', 15)} 再来一组</button>
        <button class="btn btn-ghost btn-block" style="margin-top:10px" id="home">${ico('home', 15)} 返回首页</button>
        <button class="btn btn-ghost btn-block" style="margin-top:10px" id="wrong">${ico('bookX', 15)} 查看错题本</button>
      </div>
    </div>`;
  $('#again').onclick = () => renderPractice(store.state.subject, store.state.chapter, null, store.state.mock);
  $('#home').onclick = () => renderHome();
  $('#wrong').onclick = () => renderWrong();
}

// ---------- 错题本（服务端同步，跨设备） ----------
// 错题本分页状态
const WRONG_PAGE = 50;
// 错题本两大模块：公考行测 / 事业编职测（申论·综应等主观题不进错题本）
const WRONG_TABS = [
  { key: '', name: '全部' },
  { key: '公务员·行测', name: '公考行测' },
  { key: '事业编·职测', name: '事业编职测' },
  { key: '自定义', name: '自定义题库' },
];
let wState = { total: 0, offset: 0, subject: '' };

async function renderWrong() {
  setView('wrong');
  $('#app-title').textContent = '错题本';
  [...document.querySelectorAll('#topbar-right > *:not(#btn-theme)')].forEach(n => n.remove());
  const view = $('#view');
  view.innerHTML = '<div class="spinner"></div>';
  wState = { total: 0, offset: 0, subject: '' };

  const loadPage = async (offset, subject) => {
    const q = subject ? `&subject=${encodeURIComponent(subject)}` : '';
    return api(`/api/records/wrong?limit=${WRONG_PAGE}&offset=${offset}${q}`);
  };

  const renderList = async (subject) => {
    wState.subject = subject;
    wState.offset = 0;
    view.innerHTML = '<div class="spinner"></div>';
    try {
      const data = await loadPage(0, subject);
      const list = Array.isArray(data) ? data : (data.list || []);
      wState.total = Array.isArray(data) ? list.length : (data.total ?? list.length);
      wState.offset = list.length;
      view.innerHTML = '';
      // 模块 Tab
      const tabs = el('div', 'mock-tabs');
      for (const t of WRONG_TABS) {
        const btn = el('button', `mock-tab${t.key === subject ? ' active' : ''}`, t.name);
        btn.onclick = () => renderList(t.key);
        tabs.appendChild(btn);
      }
      view.appendChild(tabs);
      if (!list.length) {
        view.appendChild(el('div', 'empty', `<span class="empty-ico">${ico('bookX', 40)}</span>暂无错题<br>刷题做错的题目会自动收录到这里`));
        return;
      }
      const card = el('div', 'card', `<h3>错题共 ${wState.total} 条</h3>
        <button class="btn btn-primary btn-block" id="wrong-random">${ico('play', 15)} 随机练习（从错题抽 10-15 题）</button>
        <button class="btn btn-ghost btn-block" id="clear-wrong">${ico('trash', 15)} 清空错题本</button>
        <div class="li-tip">${ico('lightbulb', 13)} 点击任意错题可直接重做该题</div>`);
      view.appendChild(card);
      $('#wrong-random').onclick = () => startWrongRandom(subject);
      $('#clear-wrong').onclick = async () => {
        // 只清当前模块（"全部"时传空 = 清全部），避免误清其他科目错题
        const payload = subject ? JSON.stringify({ subject }) : '{}';
        await api('/api/records/wrong', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: payload }).catch(() => {});
        store.wrong = []; saveWrong();
        renderList(subject);
      };
      const listEl = el('div');
      for (const w of list) {
        listEl.appendChild(wrongItemEl(w, () => openQuestionById(w.questionId, 'wrong'), async (w2) => {
          // 单条移出错题本（两端都按 questionId 删除错题记录）
          await api('/api/records/wrong', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ questionId: w2.questionId }),
          }).catch(() => {});
          store.wrong = store.wrong.filter((x) => x.id !== w2.questionId && x.id !== w2.id);
          saveWrong();
          toast('已移出错题本');
          renderList(subject);
        }));
      }
      view.appendChild(listEl);
      appendWrongMore(view, listEl, subject, loadPage);
    } catch (e) {
      view.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    }
  };

  await renderList('');
}

function wrongItemEl(w, onClick, onRemove) {
  const item = el('div', `list-item${w.available === false ? ' is-disabled' : ''}`, `
    <span class="li-icon tint-red">${ico('xCircle', 18)}</span>
    <div class="li-main">
      <div class="li-title">${w.available === false ? `${esc(w.content || '（题目已移除）')} <span class="li-badge">已移除</span>` : esc(w.content || '（无题干）')}</div>
      <div class="li-sub">你的答案 ${esc(w.myAnswer || '-')} · ${esc(w.subject || '')} ${esc(w.chapter || '')}</div>
    </div>
    <span class="li-del" title="移出错题本">${ico('trash', 15)}</span>
    <span class="li-arrow">›</span>
  `);
  const delBtn = item.querySelector('.li-del');
  delBtn.onclick = (e) => {
    e.stopPropagation();
    if (onRemove) onRemove(w);
  };
  if (w.available === false) {
    // 历史遗留：题库中已不存在的题不可重做（点击提示），但仍可移除
    item.classList.add('li-disabled');
    item.onclick = () => toast('该题已从题库移除，无法重做');
  } else {
    item.onclick = onClick;
  }
  return item;
}

// "加载更多"按钮：分页拉取后续错题
function appendWrongMore(view, listEl, subject, loadPage) {
  if (wState.offset >= wState.total) return;
  const more = el('button', 'btn btn-ghost btn-block', `加载更多（已显示 ${wState.offset} / ${wState.total} 条）`);
  more.onclick = async () => {
    more.disabled = true;
    more.textContent = '加载中…';
    try {
      const data = await loadPage(wState.offset, subject);
      const moreList = Array.isArray(data) ? data : (data.list || []);
      wState.total = Array.isArray(data) ? moreList.length : (data.total ?? wState.total);
      wState.offset += moreList.length;
      for (const w of moreList) listEl.appendChild(wrongItemEl(w, () => openQuestionById(w.questionId, 'wrong')));
      if (wState.offset >= wState.total) more.remove();
      else { more.disabled = false; more.textContent = `加载更多（已显示 ${wState.offset} / ${wState.total} 条）`; }
    } catch (e) {
      more.disabled = false;
      more.textContent = `加载失败，点此重试`;
    }
  };
  view.appendChild(more);
}

// ---------- 错题随机练习：从当前模块错题随机抽 10-15 题组一套练习 ----------
async function startWrongRandom(subject) {
  const toastBtn = $('#wrong-random');
  if (toastBtn) { toastBtn.disabled = true; toastBtn.textContent = '抽取中…'; }
  try {
    // 分页拉全当前模块错题 id（available 题）
    const ids = [];
    let offset = 0;
    for (;;) {
      const q = subject ? `&subject=${encodeURIComponent(subject)}` : '';
      const data = await api(`/api/records/wrong?limit=${WRONG_PAGE}&offset=${offset}${q}`);
      const list = Array.isArray(data) ? data : (data.list || []);
      for (const w of list) if (w.available !== false && w.questionId != null) ids.push(w.questionId);
      const total = Array.isArray(data) ? list.length : (data.total ?? list.length);
      offset += list.length;
      if (offset >= total || !list.length) break;
    }
    if (!ids.length) { toast('当前模块暂无错题可练'); return; }
    // 随机抽 10-15 道（不足则全量）
    const n = Math.min(10 + Math.floor(Math.random() * 6), ids.length);
    const picked = [...ids].sort(() => Math.random() - 0.5).slice(0, n);
    const questions = [];
    for (const id of picked) {
      try {
        const q = await api('/api/question?id=' + encodeURIComponent(id));
        if (q && q.id != null) questions.push(q);
      } catch { /* 单题加载失败跳过 */ }
    }
    if (!questions.length) { toast('题目加载失败，请重试'); return; }
    // 入栈错题本层：返回时回到错题本列表
    store.navStack.push({ name: 'wrong' });
    enterQuiz(questions, subject || questions[0].subject || '公务员·行测', 'wrong-random', null, '0');
  } catch (e) {
    toast('随机练习失败：' + e.message);
  } finally {
    if (toastBtn) { toastBtn.disabled = false; toastBtn.textContent = `${ico('play', 15)} 随机练习（从错题抽 10-15 题）`; }
  }
}

// ---------- 单题重练（错题本/收藏夹点进：重做 → 判分 → 看解析） ----------
async function openQuestionById(questionId, from) {
  try {
    const q = await api('/api/question?id=' + encodeURIComponent(questionId));
    // 记录来源（wrong/fav）与当前单题页：goBack 时 pop 单题页回到来源列表
    store.navStack.push({ name: from || 'wrong' });
    store.navStack.push({ name: 'single' });
    const s = store.state;
    s.questions = [q];
    s.idx = 0;
    s.results = [];
    s.answers = [];
    s.mode = 'single';
    s.subject = q.subject || store.state.subject || '';
    s.chapter = q.chapter || null;
    s.mock = '0';
    stopTimer();
    startTimer();
    renderQuestion();
  } catch (e) {
    toast('加载题目失败：' + e.message);
  }
}

// ---------- 我的收藏（列表 + 点击重练 + 移除） ----------
const FAV_PAGE = 50;
let fState = { total: 0, offset: 0 };

async function renderFavorites() {
  setView('fav');
  $('#app-title').textContent = '我的收藏';
  [...document.querySelectorAll('#topbar-right > *:not(#btn-theme)')].forEach(n => n.remove());
  const view = $('#view');
  view.innerHTML = '<div class="spinner"></div>';
  fState = { total: 0, offset: 0 };
  try {
    const data = await api(`/api/favorites?limit=${FAV_PAGE}&offset=0`);
    const list = Array.isArray(data) ? data : (data.list || []);
    fState.total = Array.isArray(data) ? list.length : (data.total ?? list.length);
    fState.offset = list.length;
    if (!list.length) {
      view.innerHTML = `<div class="empty"><span class="empty-ico">${ico('star', 40)}</span>还没有收藏<br>刷题时点题目右上角星标即可收藏</div>`;
      return;
    }
    view.innerHTML = '';
    const card = el('div', 'card', `<h3>收藏共 ${fState.total} 条</h3>
      <div class="li-tip">${ico('lightbulb', 13)} 点击收藏可直接重做该题</div>`);
    view.appendChild(card);
    const listEl = el('div');
    for (const f of list) listEl.appendChild(favItemEl(f, listEl, view));
    view.appendChild(listEl);
    appendFavMore(view, listEl);
  } catch (e) {
    view.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

function favItemEl(f, listEl, view) {
  const item = el('div', 'list-item', `
    <span class="li-icon tint-amber">${ico('star', 18)}</span>
    <div class="li-main">
      <div class="li-title">${esc(f.content || '（无题干）')}</div>
      <div class="li-sub">${esc(f.subject || '')} ${esc(f.chapter || '')} · ${esc(f.time || '')}</div>
    </div>
    <span class="li-arrow">›</span>
  `);
  item.onclick = () => openQuestionById(f.questionId, 'fav');
  // 长按/右键移除的替代：提供独立小按钮更直观
  const del = el('button', 'btn btn-ghost', '移除');
  del.style.cssText = 'padding:4px 8px;font-size:12px;margin-left:8px;flex-shrink:0;';
  del.onclick = async (ev) => {
    ev.stopPropagation();
    await api('/api/favorites', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: f.questionId }) }).catch(() => {});
    store.fav.delete(f.questionId);
    item.remove();
    fState.total = Math.max(fState.total - 1, 0);
    fState.offset = Math.max(fState.offset - 1, 0);
    if (!listEl.children.length) view.innerHTML = `<div class="empty"><span class="empty-ico">${ico('star', 40)}</span>还没有收藏<br>刷题时点题目右上角星标即可收藏</div>`;
  };
  item.querySelector('.li-arrow').before(del);
  return item;
}

function appendFavMore(view, listEl) {
  if (fState.offset >= fState.total) return;
  const more = el('button', 'btn btn-ghost btn-block', `加载更多（已显示 ${fState.offset} / ${fState.total} 条）`);
  more.onclick = async () => {
    more.disabled = true;
    more.textContent = '加载中…';
    try {
      const data = await api(`/api/favorites?limit=${FAV_PAGE}&offset=${fState.offset}`);
      const moreList = Array.isArray(data) ? data : (data.list || []);
      fState.total = Array.isArray(data) ? moreList.length : (data.total ?? fState.total);
      fState.offset += moreList.length;
      for (const f of moreList) listEl.appendChild(favItemEl(f, listEl, view));
      if (fState.offset >= fState.total) more.remove();
      else { more.disabled = false; more.textContent = `加载更多（已显示 ${fState.offset} / ${fState.total} 条）`; }
    } catch (e) {
      more.disabled = false;
      more.textContent = `加载失败，点此重试`;
    }
  };
  view.appendChild(more);
}

// ---------- AI 设置 ----------
async function renderAiSettings() {
  setView('ai');
  $('#app-title').textContent = 'AI 设置';
  [...document.querySelectorAll('#topbar-right > *:not(#btn-theme)')].forEach(n => n.remove());
  const view = $('#view');
  view.innerHTML = '<div class="spinner"></div>';
  let agents;
  try {
    agents = await api('/api/ai/agents');
  } catch (e) {
    view.innerHTML = `<div class="empty">加载失败：${e.message}</div>`;
    return;
  }
  view.innerHTML = '';
  // 使用统计配置入口已按要求隐藏（2026-08-15）：不上报地址/设备 ID 等展示，避免用户误解；底层上报逻辑保留
  view.appendChild(el('div', 'card', `
    <h3>${ico('sparkles', 17)} AI 智能体（独立配置）</h3>
    <div class="li-sub">每个 AI 可独立修改 prompt、skill、API Key、URL、模型。<br>修改后<b>立即生效</b>，无需重启；prompt/skill 变更自动保存历史版本，并<b>自动清空题目解析缓存</b>（否则已解析过的题会直接返回旧结果）。</div>
    <div style="margin-top:10px">
      <button class="btn" data-clear-explain-cache>${ico('trash', 14)} 清除解析缓存（重新解析所有已缓存题目）</button>
    </div>
  `));
  view.querySelector('[data-clear-explain-cache]').onclick = async () => {
    const r = await api('/api/ai/explain-cache', { method: 'DELETE' });
    toast(r.cleared > 0 ? `已清除 ${r.cleared} 条解析缓存` : '缓存本来就是空的');
  };

  for (const a of agents) {
    const card = el('div', 'card');
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <div style="flex:1">
          <h3 style="margin:0">${a.name} <span class="badge">${a.enabled ? '已启用' : '未启用'}</span></h3>
          <div class="li-sub">${a.description || ''}</div>
        </div>
        <button class="btn btn-ghost" style="flex:0 0 auto;padding:8px 14px" data-ai-toggle>${a.enabled ? '停用' : '启用'}</button>
      </div>
      <label class="field-label">Base URL（OpenAI 兼容）</label>
      <input class="field" data-f="base_url" value="${esc(a.base_url)}" placeholder="https://api.deepseek.com/v1">
      <label class="field-label">API Key</label>
      <input class="field" data-f="api_key" type="password" value="${esc(a.api_key)}" placeholder="${a.api_key_masked || '未配置'}">
      <label class="field-label">模型</label>
      <input class="field" data-f="model" value="${esc(a.model)}" placeholder="deepseek-chat">
      <button class="btn btn-ghost" data-ai-models style="margin-top:8px">${ico('list', 14)} 获取该 URL 的全部模型</button>
      <div class="ai-models-box" style="display:none;margin-top:8px;font-size:13px"></div>
      <div style="display:flex;gap:10px">
        <div style="flex:1">
          <label class="field-label">温度 (0~1)</label>
          <input class="field" data-f="temperature" type="number" step="0.1" min="0" max="1" value="${a.temperature ?? 0.5}">
        </div>
        <div style="flex:1">
          <label class="field-label">最大 tokens</label>
          <input class="field" data-f="max_tokens" type="number" step="100" min="100" value="${a.max_tokens ?? 1500}">
        </div>
      </div>
      <label class="field-label">Skill（能力说明）</label>
      ${a.skill_loaded ? `<div class="li-sub" style="color:#2e7d32">✓ 已自动加载 skill：<b>${esc(a.skill_loaded.name)}</b>（${a.skill_loaded.files} 个文件：SKILL.md + references）</div>` : ''}
      <textarea class="field" data-f="skill" rows="2" placeholder="填 skill 名称自动加载本地文件夹（如 gongkao-huasheng13）；或直接写附加能力说明">${esc(a.skill || '')}</textarea>
      <label class="field-label">System Prompt（角色设定）</label>
      <textarea class="field" data-f="system_prompt" rows="8">${esc(a.system_prompt || '')}</textarea>
      <div class="action-row" style="margin-top:10px">
        <button class="btn btn-primary" data-ai-save>${ico('save', 15)} 保存</button>
        <button class="btn btn-ghost" data-ai-test>${ico('flask', 15)} 测试</button>
        <button class="btn btn-ghost" data-ai-history>${ico('history', 15)} 历史</button>
      </div>
      <div class="ai-test-result" style="display:none"></div>
    `;
    const agentId = a.id;
    card.querySelector('[data-ai-toggle]').onclick = () => {
      saveAgent(agentId, { enabled: a.enabled ? 0 : 1 }).then(() => renderAiSettings());
    };
    card.querySelector('[data-ai-save]').onclick = async () => {
      const fields = {};
      card.querySelectorAll('[data-f]').forEach((input) => {
        const key = input.dataset.f;
        let val = input.value;
        if (key === 'temperature') val = Number(val);
        if (key === 'max_tokens') val = Number(val);
        fields[key] = val;
      });
      await saveAgent(agentId, fields);
      toast(r && r.promptChanged ? '已保存：prompt/skill 有变化，解析缓存已清空，重新解析将使用新配置' : '已保存（立即生效）');
      renderAiSettings();
    };
    card.querySelector('[data-ai-test]').onclick = async () => {
      const box = card.querySelector('.ai-test-result');
      const fields = {};
      card.querySelectorAll('[data-f]').forEach((input) => {
        const key = input.dataset.f;
        let val = input.value;
        if (key === 'temperature') val = Number(val);
        if (key === 'max_tokens') val = Number(val);
        fields[key] = val;
      });
      // 先保存当前填写内容，再测试
      await saveAgent(agentId, fields);
      box.style.display = 'block';
      box.innerHTML = `${ico('hourglass', 14)} 调用 AI 中…`;
      try {
        const r = await api(`/api/ai/agents/${agentId}/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `（测试）请用一句话介绍你的职责，并说明你准备好了。` }),
        });
        if (r && r.content) {
          box.innerHTML = `<div class="ab-title">${ico('checkCircle', 15)} 调用成功：</div><pre style="white-space:pre-wrap;font-size:13px;line-height:1.6">${esc(r.content)}</pre>`;
        } else {
          box.innerHTML = `<div class="ab-title" style="color:var(--red)">${ico('xCircle', 15)} ${esc(r.error || '调用失败')}</div>`;
        }
      } catch (e) {
        box.innerHTML = `<div class="ab-title" style="color:var(--red)">${ico('xCircle', 15)} ${esc(e.message)}</div>`;
      }
    };
    card.querySelector('[data-ai-models]').onclick = async () => {
      const box = card.querySelector('.ai-models-box');
      const baseUrl = card.querySelector('[data-f="base_url"]').value.trim();
      const apiKey = card.querySelector('[data-f="api_key"]').value.trim();
      const modelInput = card.querySelector('[data-f="model"]');
      box.style.display = 'block';
      box.innerHTML = `${ico('hourglass', 14)} 正在获取模型列表…`;
      const r = await fetchModelList(baseUrl, apiKey);
      if (r.error) {
        box.innerHTML = `<div style="color:var(--red)">${ico('xCircle', 15)} ${esc(r.error)}</div>`;
        return;
      }
      const current = (modelInput.value || '').trim();
      box.innerHTML = `<div style="margin-bottom:6px;opacity:.7">共 ${r.models.length} 个模型，点击选择（记得点保存）：</div><div style="display:flex;flex-wrap:wrap;gap:6px">` +
        r.models.map((m) => `<button class="btn btn-ghost ai-model-chip" style="padding:4px 10px;font-size:12px${m === current ? ';outline:2px solid var(--accent)' : ''}" data-model="${esc(m)}">${esc(m)}</button>`).join('') +
        '</div>';
      box.querySelectorAll('.ai-model-chip').forEach((btn) => {
        btn.onclick = () => {
          modelInput.value = btn.dataset.model;
          box.querySelectorAll('.ai-model-chip').forEach((b) => (b.style.outline = b === btn ? '2px solid var(--accent)' : ''));
          toast(`已选择模型：${btn.dataset.model}（记得点保存）`);
        };
      });
    };
    card.querySelector('[data-ai-history]').onclick = async () => {
      const box = card.querySelector('.ai-test-result');
      box.style.display = 'block';
      const h = await api(`/api/ai/agents/${agentId}/history`);
      if (!h.length) { box.textContent = '暂无历史版本'; return; }
      box.innerHTML = h.map((x) => `
        <div class="ab-title">${ico('history', 15)} ${x.saved_at} · ${esc(x.note || '')}</div>
        <pre style="white-space:pre-wrap;font-size:12px;line-height:1.5;max-height:120px;overflow:auto;background:var(--bg);padding:8px;border-radius:8px">${esc((x.system_prompt || '').slice(0, 300))}</pre>
      `).join('');
    };
    view.appendChild(card);
  }
}

/** 从 OpenAI 兼容网关拉取模型列表（GET {base}/models） */
async function fetchModelList(baseUrl, apiKey) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return { error: '请先填写 Base URL' };
  base = base.replace(/\/chat\/completions$/, '');
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  // App 原生通道（CapacitorHttp）绕 CORS；浏览器环境回退 fetch
  const nativeHttp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  const doGet = async (u) => {
    if (nativeHttp) {
      const r = await nativeHttp.request({ url: u, method: 'GET', headers, connectTimeout: 15000, readTimeout: 30000 });
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.data, text: async () => (typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? '')) };
    }
    return fetch(u, { headers });
  };
  const cands = [`${base}/models`];
  if (!/\/v1$/.test(base)) cands.push(`${base}/v1/models`);
  let lastErr = '';
  for (const u of cands) {
    try {
      const res = await doGet(u);
      if (res.ok) {
        const data = await res.json();
        const models = (Array.isArray(data.data) ? data.data : []).map((m) => m && m.id).filter(Boolean);
        if (models.length) {
          // 智谱 /models 接口不返回视觉模型，但 GLM-4V 系列可直接调用——追加常用视觉模型
          if (/open\.bigmodel\.cn/i.test(base)) {
            const extra = ['GLM-4.1V-Thinking-Flash', 'GLM-4V-Plus', 'GLM-4V-Flash'];
            for (const m of extra) if (!models.includes(m)) models.push(m);
          }
          return { models };
        }
        lastErr = '接口返回了空模型列表';
      } else {
        const t = await res.text().catch(() => '');
        if (res.status === 401 || res.status === 403) return { error: `HTTP ${res.status}：请先填写正确的 API Key` };
        lastErr = `HTTP ${res.status}${t ? '：' + t.slice(0, 150) : ''}`;
      }
    } catch (e) {
      lastErr = '网络错误：' + e.message;
    }
  }
  return { error: lastErr || '获取模型列表失败' };
}

async function saveAgent(id, fields) {
  try {
    return await api(`/api/ai/agents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
  } catch (e) { toast(e.message); throw e; }
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- 导航 ----------
document.addEventListener('click', (e) => {
  const nav = e.target.closest('#bottom-nav .nav-item');
  if (!nav) return;
  const name = nav.dataset.nav;
  if (name === 'home') renderHome();
  else if (name === 'papers') openPaperConfig();
  else if (name === 'wrong') renderWrong();
  else if (name === 'fav') renderFavorites();
});

$('#btn-back').onclick = goBack;

// ---------- 主题切换（Ocean Depths 深浅双模式） ----------
function currentTheme() {
  const manual = document.documentElement.getAttribute('data-theme');
  if (manual) return manual;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function syncThemeBtn() {
  const btn = $('#btn-theme');
  if (!btn) return;
  const dark = currentTheme() === 'dark';
  btn.innerHTML = dark
    ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';
}
$('#btn-theme').onclick = () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  syncThemeBtn();
};
// 跟随系统模式下，系统主题变化自动刷新按钮图标
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!localStorage.getItem('theme')) syncThemeBtn();
});
syncThemeBtn();

// 启动（支持 ?view=ai 直接打开 AI 设置页，便于访问与测试）
if (window.Telemetry) Telemetry.track('app_open', { v: 1 });
const initialView = new URLSearchParams(location.search).get('view');
// 预加载收藏集合（不阻塞首屏；兼容旧纯数组结构）
api('/api/favorites').then((data) => {
  const list = Array.isArray(data) ? data : (data.list || []);
  store.fav = new Set(list.map((f) => f.questionId));
  // 若在刷题页则刷新星标状态
  const btn = $('#q-fav');
  if (btn && store.state.questions.length) {
    const q = store.state.questions[store.state.idx];
    if (q) btn.innerHTML = store.fav.has(q.id) ? `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICO.star}</svg>` : ico('star', 15);
  }
}).catch(() => {});
if (initialView === 'ai') renderAiSettings();
else renderHome();

