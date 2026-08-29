/**
 * 申论/综应材料提取模块：Chrome headless 渲染 PDF 每页 → 截图 → GLM OCR → 材料文本
 * 适用：粉笔真题 PDF（材料正文为矢量字形，无法 zlib 提取，必须栅格化）
 * 依赖：本机 Chrome（自动以调试端口启动），GLM-4V-Flash 视觉模型
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9229;

// 密钥从环境变量或根目录 .env.local（gitignore，不入库）读取，勿硬编码回本文件
try {
  for (const line of fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* 无 .env.local 则仅用环境变量 */ }

const OCR_KEY = process.env.GLM_API_KEY || '';
const OCR_BASE = 'https://open.bigmodel.cn/api/paas/v4/';
const OCR_MODEL = 'glm-4v-flash';
// 备用视觉（opencode 网关 MiMo V2.5 Free；GLM 限流/慢时兜底）
const MIMO_KEY = process.env.MIMO_API_KEY || '';
const MIMO_BASE = 'https://opencode.ai/zen/v1';
const MIMO_MODEL = 'mimo-v2.5';

let chromeProc = null;
let wsCache = null;

/** 确保 headless Chrome 以调试端口运行 */
function ensureChrome() {
  if (wsCache) return;
  chromeProc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=' + process.cwd() + '\\.chrome-ocr',
    '--disable-extensions',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore', detached: true });
  chromeProc.unref();
}

/** 简单 CDP 客户端 */
async function cdp(method, params = {}) {
  if (!wsCache) {
    // 等待端口就绪
    let ok = false;
    for (let i = 0; i < 20; i++) {
      try { await fetch(`http://127.0.0.1:${CDP_PORT}/json`); ok = true; break; } catch { await new Promise((r) => setTimeout(r, 300)); }
    }
    if (!ok) throw new Error('Chrome 调试端口未就绪');
    const pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    const page = pages.find((p) => p.type === 'page');
    wsCache = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { wsCache.onopen = res; wsCache.onerror = rej; });
    wsCache.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && cdp.cbs.has(m.id)) {
        const { resolve, reject } = cdp.cbs.get(m.id);
        cdp.cbs.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
    cdp.cbs = new Map();
    await cdp('Page.enable');
    await cdp('Runtime.enable');
  }
  return new Promise((resolve, reject) => {
    const id = ++cdp.id;
    cdp.cbs.set(id, { resolve, reject });
    wsCache.send(JSON.stringify({ id, method, params }));
  });
}
cdp.id = 0;
cdp.cbs = new Map();

/** 渲染 PDF 指定页 → PNG base64 */
async function pdfPageToBase64(pdfPath, pageNum) {
  ensureChrome();
  await cdp('Emulation.setDeviceMetricsOverride', { width: 795, height: 1123, deviceScaleFactor: 2, mobile: false });
  const url = 'file:///' + pdfPath.replace(/\\/g, '/').replace(/ /g, '%20').replace(/#/g, '%23') + `#page=${pageNum}`;
  await cdp('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 3500)); // 等 PDF 渲染
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  return shot.data;
}

/** GLM OCR 一张图 → 文本 */
async function ocrImage(b64) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(OCR_BASE + 'chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OCR_KEY}` },
        body: JSON.stringify({
          model: OCR_MODEL,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '这是一张考公申论/综应试卷页面的图片。请逐字准确转写页面中的所有文字内容（标题、给定材料正文、材料编号、标点、段落），保持原文顺序，不要遗漏，不要添加解释。' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
            ],
          }],
          max_tokens: 1024, stream: false,
        }),
      });
      if (r.status === 429 || r.status >= 500) {
        if (attempt < 3) await new Promise((res) => setTimeout(res, attempt * 5000));
        continue;
      }
      const d = await r.json();
      const c = d.choices?.[0]?.message?.content;
      if (c) return c;
      return '';
    } catch (e) {
      if (attempt < 3) await new Promise((res) => setTimeout(res, attempt * 5000));
    }
  }
  return '';
}

/** 提取一套 PDF 的材料文本（逐页 OCR 拼接） */
export async function extractMaterialFromPdf(pdfPath, maxPages = 20) {
  ensureChrome();
  const out = [];
  let emptyPages = 0;
  for (let p = 1; p <= maxPages; p++) {
    let b64;
    try { b64 = await pdfPageToBase64(pdfPath, p); } catch { break; }
    const text = await ocrImage(b64);
    out.push(text);
    if (!text.trim()) { emptyPages++; if (emptyPages >= 3) break; }
    else emptyPages = 0;
    await new Promise((r) => setTimeout(r, 1200)); // 限流间隔
  }
  // 合并，过滤明显噪音行
  return out.filter((t) => t.trim()).join('\n\n');
}
