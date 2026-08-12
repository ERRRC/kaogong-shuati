// 核实 3 个端口当前登录的账号
import fs from 'node:fs';
const P = 'app=web&kav=128&av=128&hav=128&version=3.0.0.0';
for (const port of ['9222', '9223', '9224']) {
  try {
    const tabs = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
    const page = tabs.find((t) => t.type === 'page' && t.url.includes('fenbi')) || tabs[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let msgId = 0;
    const pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    const { result } = await send('Network.getCookies', { urls: ['https://fenbi.com', 'https://tiku.fenbi.com', 'https://login.fenbi.com'] });
    const cookies = result?.cookies || [];
    const sess = cookies.find((c) => c.name === 'sess')?.value || '';
    // 用 cookie 探测账号
    let acc = '未登录';
    if (sess) {
      try {
        const ck = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        const r = await fetch(`https://login.fenbi.com/api/users/info?${P}`, { headers: { Cookie: ck } });
        if (r.status === 200) {
          const j = await r.json();
          acc = `${j.userId} (${j.nickname || ''})`;
        } else acc = `HTTP ${r.status}`;
      } catch { acc = '探测失败'; }
    }
    console.log(`${port}: ${page.url.split('/').slice(2).join('/').slice(0, 60)} | sess=${sess ? '有' : '无'} | 账号=${acc}`);
    ws.close();
  } catch (e) { console.log(`${port}: ERR ${e.message}`); }
}
