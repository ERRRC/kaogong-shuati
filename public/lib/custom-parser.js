// custom-parser.js — 自定义题库解析引擎（Web / App 共用，ESM，无 DOM 依赖）
// 输入：TXT/Word 文本、Excel 表格、AI 结构化结果
// 输出统一：{ prompt, material, options[], answer, answer_index, analysis }

/** 规范化答案 → { answer, answer_index, options }（options 可能被补充，如判断题） */
export function normalizeAnswer(rawAnswer, rawOptions = []) {
  let answer = String(rawAnswer ?? '').trim();
  const options = Array.isArray(rawOptions) ? rawOptions.slice() : [];
  let answer_index = -1;
  if (!answer) return { answer: '', answer_index: -1, options };
  // 括号包裹答案：(A) / （B）
  answer = answer.replace(/^[（(]\s*([A-Ha-h])\s*[)）]$/, '$1');
  // 剥常见前缀（答案：/ 【答案】/ 参考答案 等）
  let m = answer.match(/^(?:【?\s*答案\s*】?|参考答案)\s*[:：]?\s*(.+)$/);
  if (m) answer = m[1].trim();
  // 判断题：正确/错误（无选项时补 ["正确","错误"]）
  if (/^(正确|对)$/.test(answer)) {
    if (options.length === 0) options.push('正确', '错误');
    answer_index = 0;
  } else if (/^(错误|错)$/.test(answer)) {
    if (options.length === 0) options.push('正确', '错误');
    answer_index = 1;
  } else if (/^[A-Da-d]$/.test(answer)) {
    // 单选
    answer_index = answer.toUpperCase().charCodeAt(0) - 65;
  } else {
    // 多选 AB / ABC / ABD：转索引数组 JSON（checkAnswer 多选分支判分），answer_index=-1
    m = answer.toUpperCase().match(/^[A-D]{2,4}$/);
    if (m) {
      answer = JSON.stringify([...answer.toUpperCase()].map((ch) => ch.charCodeAt(0) - 65));
      answer_index = -1;
    }
  }
  return { answer, answer_index, options };
}

const OPT_RE = /^(?:[（(]?([A-Ha-h])[)）]?[.、．:：]\s*)(.+)$/;

/** 规则切分一段文本（按题号/选项/答案/解析/材料），返回结构化题目数组 */
export function parseTxt(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trimEnd());
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (cur) cur.raw.push(''); continue; }
    // 题号边界：1. / 1、 / （1） / 第1题
    if (/^(?:第\s*)?\d{1,3}[.、．)）]\s*/.test(t) || /^第\s*\d{1,3}\s*题/.test(t)) {
      cur = { raw: [t] };
      blocks.push(cur);
    } else if (cur) {
      cur.raw.push(t);
    } else {
      cur = { raw: [t] };
      blocks.push(cur);
    }
  }
  return blocks.map((b) => parseBlock(b.raw)).filter((q) => q.prompt || q.material || q.options.length);
}

/** 解析单题块（行数组） */
function parseBlock(lines) {
  const prompt = [];
  const material = [];
  const options = [];
  let answer = '';
  let analysis = '';
  let inMaterial = false;
  let started = false; // 是否已进入题干主体（跳过题号行前缀）
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // 题号行前缀剥离（1. xxx → xxx；1. 整体行保留除题号外内容）
    let tt = t;
    const noRe = tt.match(/^(?:第\s*)?\d{1,3}[.、．)）]\s*(.*)$/);
    if (noRe) { tt = noRe[1].trim(); if (!tt) continue; }
    // 答案行
    const am = tt.match(/^(?:【?\s*答案\s*】?|参考答案)[:：]?\s*(.*)$/);
    if (am) { answer = am[1].trim(); continue; }
    // 解析行（含续行）
    const am2 = tt.match(/^【?\s*解析\s*】?[:：]?\s*(.*)$/);
    if (am2) { analysis = (analysis ? analysis + '\n' : '') + am2[1].trim(); continue; }
    if (analysis) { analysis += '\n' + tt; continue; } // 解析续行
    // 材料标记行：材料 / 材料一 / 【材料】（后续陈述句续行为材料，遇到问句/引导词即终止）
    if (/^(?:【?\s*材料\s*】?[一二三四五六七八九十]?\s*[:：]?\s*)(.*)$/.test(tt) && options.length === 0) {
      const mm = tt.match(/^(?:【?\s*材料\s*】?[一二三四五六七八九十]?\s*[:：]?\s*)(.*)$/);
      inMaterial = true;
      if (mm[1].trim()) material.push(mm[1].trim());
      continue;
    }
    if (inMaterial && options.length === 0) {
      // 问句/引导词（根据材料…、问：）视为题干，终止材料
      if (/^(?:根据材料|结合材料|请根据|根据上述|阅读材料)|[？?]$/.test(tt)) {
        inMaterial = false;
      } else {
        material.push(tt);
        continue;
      }
    }
    // 选项行
    const om = tt.match(OPT_RE);
    if (om) {
      const letter = om[1].toUpperCase();
      // 选项必须从 A 开始（防题干误判，如 "C. 的说法错误"）
      if (options.length === 0 && letter !== 'A') { prompt.push(tt); continue; }
      // 同行多选项拆分（常见粘贴格式：如 "A. 1949年 B. 1954年 C. 1978年 D. 1982年"）
      const marks = tt.match(/[（(]?[A-Ha-h][)）]?[.、．:：]/g);
      if (marks && marks.length >= 2) {
        const parts = tt.split(/[（(]?([A-Ha-h])[)）]?[.、．:：]\s*/);
        let prefix = String(parts.shift() || '').trim();
        for (let i = 0; i + 1 < parts.length; i += 2) {
          const L = String(parts[i] || '').toUpperCase();
          const C = (prefix ? prefix + ' ' : '') + String(parts[i + 1] || '').trim();
          if (L && C) options.push(`${L}. ${C}`);
          prefix = '';
        }
        continue;
      }
      options.push(tt);
      continue;
    }
    if (options.length) { analysis = (analysis ? analysis + '\n' : '') + tt; continue; } // 选项后的杂行 → 解析
    prompt.push(tt);
  }
  const promptText = prompt.join('\n').trim();
  const materialText = material.join('\n').trim();
  const { answer: na, answer_index, options: no } = normalizeAnswer(answer, options);
  return { prompt: promptText, material: materialText, options: no, answer: na, answer_index, analysis: analysis.trim() };
}

/**
 * Excel 解析：jsonRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
 * 固定列模式：表头行包含 提示/题干/材料/选项/答案/解析（或 选项A~D）
 * 自由格式：无表头 → 返回 { freeText } 由 aiStructure 处理
 */
export function parseExcel(jsonRows) {
  if (!Array.isArray(jsonRows) || jsonRows.length === 0) return { questions: [] };
  const rows = jsonRows.map((r) => (Array.isArray(r) ? r : []).map((c) => String(c ?? '').trim()));
  // 找表头行
  let headerIdx = -1;
  const headerCols = {};
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cols = {};
    rows[i].forEach((c, j) => {
      const k = c.replace(/[ *]/g, '');
      if (/^提示$|^题干$|^题目$/.test(k)) cols.prompt = j;
      else if (/^材料$/.test(k)) cols.material = j;
      else if (/^选项$/.test(k)) cols.options = j;
      else if (/^选项[A-H]$/.test(k)) cols[`opt${k.slice(2)}`] = j;
      else if (/^答案$/.test(k)) cols.answer = j;
      else if (/^解析$/.test(k)) cols.analysis = j;
    });
    if (cols.prompt != null || cols.options != null) { headerIdx = i; Object.assign(headerCols, cols); break; }
  }
  if (headerIdx >= 0) {
    const questions = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r.some((c) => c)) continue;
      const prompt = headerCols.prompt != null ? (r[headerCols.prompt] || '') : '';
      const material = headerCols.material != null ? (r[headerCols.material] || '') : '';
      let options = [];
      if (headerCols.options != null) {
        // 单格多选项：按换行/分号切分
        options = String(r[headerCols.options] || '').split(/[\n;；]/).map((s) => s.trim()).filter(Boolean);
        options = options.filter((s) => OPT_RE.test(s)).map((s) => { const m = s.match(OPT_RE); return `${m[1]}. ${m[2]}`; });
        if (options.length === 0) options = String(r[headerCols.options] || '').split(/\s{2,}/).filter(Boolean);
      } else {
        // 选项A~D 分列
        for (const k of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
          if (headerCols[`opt${k}`] != null) {
            const v = String(r[headerCols[`opt${k}`]] || '').trim();
            if (v) options.push(`${k}. ${v}`);
          }
        }
      }
      const answer = headerCols.answer != null ? (r[headerCols.answer] || '') : '';
      const analysis = headerCols.analysis != null ? (r[headerCols.analysis] || '') : '';
      if (!prompt && options.length === 0) continue;
      const { answer: na, answer_index, options: no } = normalizeAnswer(answer, options);
      questions.push({ prompt, material, options: no, answer: na, answer_index, analysis });
    }
    return { questions, fixedCols: true };
  }
  // 自由格式：所有行文本 → 交给规则切分 + AI 兜底
  const freeText = rows.map((r) => r.filter(Boolean).join(' ')).filter(Boolean).join('\n');
  return { questions: parseTxt(freeText), fixedCols: false, freeText };
}

/**
 * AI 结构化兜底：分批（≤10 题）调用 custom-question-parser
 * callAi 签名：async (prompt) => string（返回 AI 原始输出）
 * 返回 [{ prompt, material, options, answer, answer_index, analysis, failed? }]
 */
export async function aiStructure(texts, callAi, batchSize = 10) {
  const results = [];
  const batches = [];
  for (let i = 0; i < texts.length; i += batchSize) batches.push(texts.slice(i, i + batchSize));
  for (const batch of batches) {
    const input = batch.map((t, i) => `题目${i + 1}：\n${t}`).join('\n\n');
    let qs = [];
    let failed = false;
    try {
      const out = await callAi(input);
      qs = extractJson(out);
      if (!Array.isArray(qs)) { qs = []; failed = true; }
    } catch (e) { failed = true; }
    if (qs.length === 0) {
      results.push(...batch.map((t) => ({ prompt: t, material: '', options: [], answer: '', answer_index: -1, analysis: '', failed: true })));
      continue;
    }
    for (const q of qs) {
      const { answer, answer_index, options } = normalizeAnswer(q?.answer, Array.isArray(q?.options) ? q.options : []);
      results.push({
        prompt: String(q?.prompt ?? '').trim() || '',
        material: String(q?.material ?? '').trim() || '',
        options,
        answer,
        answer_index,
        analysis: String(q?.analysis ?? '').trim() || '',
        failed,
      });
    }
  }
  return results;
}

/** 从 AI 输出中提取 JSON 数组/对象（剥 ```json 围栏，括号平衡扫描截取完整片段） */export function extractJson(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cand = (fence ? fence[1] : s).trim();
  for (const startCh of ['[', '{']) {
    const start = cand.indexOf(startCh);
    if (start < 0) continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < cand.length; i++) {
      const c = cand[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) {
          if ((startCh === '[' && c === ']') || (startCh === '{' && c === '}')) end = i + 1;
          break;
        }
      }
    }
    if (end > start) {
      try { return JSON.parse(cand.slice(start, end)); } catch { /* 尝试下一候选 */ }
    }
  }
  return null;
}

/** 题目去重（PDF 常见"题目页 + 答案解析页"重复）：按题干指纹去重，保留答案/解析更全的版本 */
export function dedupeQuestions(qs) {
  const seen = new Map();
  const score = (q) => (q.answer ? 2 : 0) + (q.analysis ? 1 : 0) + (q.material ? 0.5 : 0);
  for (const q of qs) {
    const key = String(q.prompt || '').replace(/\s+/g, '');
    if (!key) { seen.set(Symbol(), q); continue; } // 无题干（封面等）不参与去重
    const prev = seen.get(key);
    if (!prev || score(q) > score(prev)) seen.set(key, q);
  }
  return [...seen.values()];
}

/** docx 文本抽取（浏览器 DecompressionStream 解 zip 的 document.xml） */
export async function docxToText(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  // docx zip 结构：找 document.xml（可能是 word/document.xml）
  const entries = await zipEntries(buf);
  const entry = entries.find((e) => /^word\/document\.xml$/.test(e.name));
  if (!entry) throw new Error('未找到 word/document.xml');
  let xml = entry.decoded;
  // 段落：</w:p> 为换行；<w:tab/> 为制表
  xml = xml.replace(/<w:tab\s*\/>/g, '\t').replace(/<\/w:p>/g, '\n');
  // 去所有标签
  xml = xml.replace(/<[^>]+>/g, '');
  // 实体还原
  return xml
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 极简 zip 中央目录解析（仅支持 store/deflate，用于 docx/技能包；失败抛错） */
export async function zipEntries(buf) {
  // 找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = dv.getUint16(eocd + 10, true);
  const cdStart = dv.getUint32(eocd + 16, true);
  const entries = [];
  let off = cdStart;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    // 本地头取数据
    const lh = localOff;
    const lNameLen = dv.getUint16(lh + 26, true);
    const lExtraLen = dv.getUint16(lh + 28, true);
    const dataStart = lh + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let decoded;
    if (method === 0) decoded = new TextDecoder().decode(raw);
    else if (method === 8) decoded = await inflateRaw(raw);
    else { off = off + 46 + nameLen + extraLen + commentLen; continue; }
    entries.push({ name, decoded });
    off = off + 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** deflate-raw 解压（浏览器/WebView 均有 DecompressionStream） */
export async function inflateRaw(uint8) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([uint8]).stream().pipeThrough(ds);
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return new TextDecoder().decode(out);
}
