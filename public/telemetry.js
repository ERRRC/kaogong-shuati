// telemetry.js — 使用统计埋点（零依赖）
// 职责：install_id（设备标识）+ 事件采集 + 本地缓存 + 批量补报。
// 关键设计：
//   1. 独立于 app.js 的 api()：App 离线模式下 api() 会被本地路由拦截，这里直接 fetch 绝对地址；
//   2. 每个事件带"发生时原始时间戳 ts"，服务端按 ts 聚合 —— 补报不影响 DAU/MAU 准确性；
//   3. 失败静默缓存，下次打开/定时补报；无可用地址时直接丢弃（不积压）；
//   4. 只含 install_id + 事件名 + 少量数值，不含题目内容（隐私友好）。
(function () {
  const LS_ID = 't_install_id';
  const LS_URL = 't_url';        // 设置页可覆盖的上报地址
  const LS_Q = 't_queue';
  const MAX_Q = 500;
  const FLUSH_INTERVAL = 30000;  // 30s 定时补报
  const TIMEOUT = 8000;

  // 打包默认上报地址：Web 部署自动用当前站点（同源）；App 离线模式无同源概念，
  // 需在此填花生壳域名（如 'https://xxxxx.vipgz1.idcfengye.com'），留空则只依赖 App 设置页配置。
  const DEFAULT_URL = 'http://9193okww7199.vicp.fun';

  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch {} }

  function genId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function installId() {
    let id = lsGet(LS_ID);
    if (!id) { id = genId(); lsSet(LS_ID, id); }
    return id;
  }

  // 生效地址优先级：设置页覆盖 > 打包默认 > Web 同源
  function serverUrl() {
    const custom = lsGet(LS_URL);
    if (custom) return custom.replace(/\/+$/, '');
    if (DEFAULT_URL) return DEFAULT_URL.replace(/\/+$/, '');
    if (!window.__LOCAL_MODE__) return window.location.origin; // Web 部署：同源即服务端
    return ''; // App 模式且未配置地址：不采集
  }

  function queue() {
    try { return JSON.parse(lsGet(LS_Q) || '[]'); } catch { return []; }
  }
  function saveQueue(q) {
    lsSet(LS_Q, JSON.stringify(q.slice(-MAX_Q)));
  }

  function track(event, data) {
    const url = serverUrl();
    if (!url) return; // 无地址：丢弃，避免无效积压
    const q = queue();
    q.push({ install_id: installId(), event, ts: Date.now(), data: data || {} });
    saveQueue(q);
    flush();
  }

  let flushing = false;
  async function flush() {
    const url = serverUrl();
    if (!url || flushing) return;
    const q = queue();
    if (!q.length) return;
    const sent = q.slice(); // 发送快照：发送期间新入队的事件不会被误删
    flushing = true;
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT) : null;
      const res = await fetch(url + '/api/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: sent }),
        keepalive: true,
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        // 成功或地址错误类：仅移除已发送的前 N 条（4xx 丢弃防积压）
        const now = queue();
        saveQueue(now.slice(sent.length));
        return;
      }
    } catch { /* 网络失败：保留队列，下次补报 */ }
    finally { flushing = false; }
  }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  setInterval(flush, FLUSH_INTERVAL);

  window.Telemetry = {
    track,
    flush,
    installId: () => installId(),
    serverUrl: () => serverUrl() || '',
    setServerUrl: (u) => { if (u && u.trim()) lsSet(LS_URL, u.trim().replace(/\/+$/, '')); else lsDel(LS_URL); },
  };
})();
