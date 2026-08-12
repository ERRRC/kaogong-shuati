/**
 * 极简 PDF 文本提取器（零依赖，Node 内置 zlib）
 * 适用于 Chromium/Skia 生成的 PDF（粉笔真题 PDF）：
 *  - Type3/Type0 字体 + ToUnicode CMap（bfchar/bfrange）
 *  - 页面 Resources.Font 映射（/F6 -> 字体对象）
 *  - 文本运算符：<hex> Tj / [(...) (...)] TJ
 *  - 按 Tm 的 y 坐标变化插入换行
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

function inflate(buf) {
  try { return zlib.inflateSync(buf); } catch { return buf; }
}

/** 从对象字节流中按括号计数提取完整字典 `<<...>>` */
function extractDict(buf, start) {
  let depth = 0, i = start;
  while (i < buf.length) {
    const c = buf[i];
    if (c === 0x3c && buf[i + 1] === 0x3c) { depth++; i += 2; continue; }
    if (c === 0x3e && buf[i + 1] === 0x3e) { depth--; i += 2; if (depth === 0) return buf.slice(start, i).toString('latin1'); continue; }
    i++;
  }
  return buf.slice(start, i).toString('latin1');
}

/** 解析对象：num 0 obj <<dict>> [stream ... endstream] */
function parseObjects(buf) {
  const objects = new Map();
  const s = buf.toString('latin1');
  const re = /(\d+)\s+0\s+obj/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const num = Number(m[1]);
    const objStart = m.index + m[0].length;
    // 找 dict 开始
    const dictStart = s.indexOf('<<', objStart);
    if (dictStart < 0) continue;
    const dict = extractDict(buf, dictStart);
    const dictEnd = dictStart + dict.length; // dict 已含 << 与 >>
    // stream?
    const stRe = /stream\r?\n/g;
    stRe.lastIndex = dictEnd;
    const sm = stRe.exec(s);
    let stream = null;
    if (sm && sm.index - dictEnd < 30) {
      const streamStart = sm.index + sm[0].length;
      const e = s.indexOf('endstream', streamStart);
      if (e >= 0) stream = buf.slice(streamStart, e);
    }
    objects.set(num, { dict, stream, dictEnd });
  }
  return objects;
}

/** UTF-16BE hex → 字符串（PDF CMap 目标码是 BE 序） */
function u16be(hexStr) {
  const b = Buffer.from(hexStr, 'hex');
  let out = '';
  for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode((b[i] << 8) | b[i + 1]);
  return out;
}

/** 解析 CMap：bfchar + bfrange */
function parseCmap(text) {
  const map = new Map();
  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = charRe.exec(text)) !== null) {
    const pairs = m[1].match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g);
    if (pairs) for (const p of pairs) {
      const mm = p.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
      const src = parseInt(mm[1], 16);
      map.set(src, u16be(mm[2]));
    }
  }
  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = rangeRe.exec(text)) !== null) {
    const ranges = m[1].match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g);
    if (ranges) for (const r of ranges) {
      const mm = r.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
      if (!mm) continue;
      const lo = parseInt(mm[1], 16);
      const hi = parseInt(mm[2], 16);
      const base = u16be(mm[3]);
      for (let i = 0; i <= hi - lo; i++) map.set(lo + i, base[i] ?? '');
    }
  }
  return map;
}

/** hex 字符码转文本（2 字节/字符码，Identity-H 风格） */
function hexToText(hex, cmap) {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    const code = parseInt(hex.slice(i, i + 4), 16);
    const ch = cmap?.get(code);
    out += ch ?? '';
  }
  return out;
}

/** 提取 PDF 全部文本 */
export function extractPdfText(input) {
  const buf = typeof input === 'string' ? fs.readFileSync(input) : input;
  const objects = parseObjects(buf);

  // 1) 字体对象 → ToUnicode CMap
  const fontCmaps = new Map(); // fontObjNum -> Map<code, char>
  for (const [num, obj] of objects) {
    const tu = obj.dict.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (!tu) continue;
    const cmapObj = objects.get(Number(tu[1]));
    if (!cmapObj || !cmapObj.stream) continue;
    try {
      fontCmaps.set(num, parseCmap(inflate(cmapObj.stream).toString('latin1')));
    } catch { /* 跳过 */ }
  }

  // 2) 页面对象：/Contents + Resources.Font 映射
  const pages = [];
  for (const [, obj] of objects) {
    if (!/\/Type\s*\/Page\b/.test(obj.dict)) continue;
    const fontMap = new Map(); // F6 -> fontObjNum
    const fr = obj.dict.match(/\/Resources[\s\S]*?\/Font\s*<<([\s\S]*?)>>/);
    if (fr) {
      const pairs = fr[1].match(/\/F(\d+)\s+(\d+)\s+0\s+R/g);
      if (pairs) for (const p of pairs) {
        const mm = p.match(/\/F(\d+)\s+(\d+)\s+0\s+R/);
        fontMap.set(Number(mm[1]), Number(mm[2]));
      }
    }
    // Contents 可能继承自父 Page（简化：只取直接引用）
    const contents = [];
    const cr = obj.dict.match(/\/Contents\s*(\d+\s+0\s+R|\[\s*([\s\S]*?)\s*\])/);
    if (cr) {
      if (cr[2]) {
        const ids = cr[2].match(/\d+\s+0\s+R/g);
        if (ids) for (const id of ids) contents.push(Number(id.split(' ')[0]));
      } else {
        contents.push(Number(cr[1].split(' ')[0]));
      }
    }
    pages.push({ fontMap, contents });
  }

  // 3) 遍历内容流提取文本
  const outLines = [];
  for (const page of pages) {
    for (const contentObjNum of page.contents) {
      const obj = objects.get(contentObjNum);
      if (!obj || !obj.stream) continue;
      let content;
      try { content = inflate(obj.stream).toString('latin1'); } catch { continue; }
      if (!/BT|Tj|TJ/.test(content)) continue;
      const btRe = /BT([\s\S]*?)ET/g;
      let m;
      while ((m = btRe.exec(content)) !== null) {
        const block = m[1];
        let cmap = null;
        let lineText = '';
        let lastY = null;
        const flush = () => { if (lineText.trim()) { outLines.push(lineText.trim()); lineText = ''; } };
        const opRe = /(\/F(\d+)\s+[\d.]+\s+Tf)|([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+Tm|<([0-9A-Fa-f]+)>\s*Tj|\[([\s\S]*?)\]\s*TJ/g;
        let om;
        while ((om = opRe.exec(block)) !== null) {
          if (om[2] !== undefined) { // Tf：切换字体
            const f = page.fontMap.get(Number(om[2]));
            cmap = f ? fontCmaps.get(f) : null;
          } else if (om[6] !== undefined) { // Tm：y 变化换行
            const newY = parseFloat(om[6]);
            if (lastY !== null && Math.abs(newY - lastY) > 1.5) flush();
            lastY = newY;
          } else if (om[7] !== undefined) { // <hex> Tj
            lineText += hexToText(om[7], cmap);
          } else if (om[8] !== undefined) { // [...] TJ
            const strs = om[8].match(/<([0-9A-Fa-f]+)>|\(((?:[^()\\]|\\.)*)\)/g) || [];
            for (const st of strs) {
              if (st.startsWith('<')) lineText += hexToText(st.slice(1, -1), cmap);
              else {
                const inner = st.slice(1, -1).replace(/\\([()\\])/g, '$1');
                lineText += inner;
              }
            }
          }
        }
        flush();
      }
    }
  }
  return outLines.join('\n');
}
