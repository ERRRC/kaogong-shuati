// custom-parser.js — 自定义题库解析引擎（Web / App 共用，ESM，无 DOM 依赖）
// 输入：TXT/Word 文本、Excel 表格、AI 结构化结果
// 输出统一：{ prompt, material, options[], answer, answer_index, analysis }

/** 规范化答案 → { answer, answer_index, options }（options 可能被补充，如判断题） */
export function normalizeAnswer(rawAnswer, rawOptions = []) {
  let answer = String(rawAnswer ?? '').trim();
  const options = Array.isArray(rawOptions) ? rawOptions.slice() : [];
  let answer_index = -1;
  if (!answer) return { answer: '', answer_index: -1, options };
  // 括号包裹答案：(A) / （B）/（答案：B）
  answer = answer.replace(/^[（(]\s*(?:答案\s*[:：]?\s*)?([^)）]{1,12})\s*[)）]$/, '$1');
  // 剥常见前缀（答案：/【答案】/参考答案/正确答案/标准答案/本题答案/答案为/答案是）
  let m = answer.match(/^(?:[【\[]?\s*(?:(?:正确|参考|标准|本题)?答案)\s*[】\]]?)\s*[:：=是为]?\s*(.+)$/);
  if (m) answer = m[1].trim();
  // 剥尾随「你的答案：…」（如「正确答案：C 你的答案：B」，那是用户作答非标准答案）
  answer = answer.replace(/\s*你的答案\s*[:：]?\s*.*$/, '');
  // 判断题：正确/错误（无选项时补 ["正确","错误"]）
  if (/^(正确|对|√)$/.test(answer)) {
    if (options.length === 0) options.push('正确', '错误');
    answer_index = 0;
  } else if (/^(错误|错|×)$/.test(answer)) {
    if (options.length === 0) options.push('正确', '错误');
    answer_index = 1;
  } else {
    // 单选/多选：剥分隔符（A、B / AB / A B）后按字母判定；多选转索引数组 JSON
    const clean = answer.toUpperCase().replace(/[、,，&＆\s]+/g, '');
    if (/^[A-H]$/.test(clean)) {
      // 单选
      answer_index = clean.charCodeAt(0) - 65;
    } else if (/^[A-H]{2,4}$/.test(clean)) {
      // 多选（checkAnswer 多选分支判分），answer_index=-1
      answer = JSON.stringify([...clean].map((ch) => ch.charCodeAt(0) - 65));
      answer_index = -1;
    }
  }
  return { answer, answer_index, options };
}

// 选项行（需标点分隔）——Excel 单元格等结构化文本用；parseBlock 另有宽松版
const OPT_RE = /^(?:[（(]?([A-Ha-h])[)）]?[.、．:：]\s*)(.+)$/;

// 行首选项（宽松：字母后跟标点/括号/空白都算，兼容 OCR 无标点如 "A xxx"）
const OPT_LINE_RE = /^[（(]?([A-Ha-h])[)）]?[.、．:：)）\s]\s*(.+)$/;

// 题型标签（行级）：进题前丢弃、重复出现时兼作新题边界。如「单选题」「多项选择题」「不定项选择题（10 题）」
const TYPE_LABEL_RE = /^(?:[【\[]?\s*)?(?:单项|多项|不定项)?(选择|单选|多选|判断|不定项|简答|论述)题?(?:[（(]\s*\d+\s*(?:题)?\s*[)）])?$/;

/** 从行首提取「正确答案：C / 答案：A / 参考答案：B / 答案为 D / 第1题·答案：D」这类答复，返回答案字母原文；非答案行返回 null */
function matchAnswerLine(t) {
  // 标准前缀（答案/正确答案/参考答案…），可选「第X题 ·」前缀（答案解析区常见「第1题 · 答案：D」）
  const m = t.match(/^[（(]?\s*(?:第\s*\d{1,4}\s*题\s*[·.、]?\s*)?(?:[【\[]?\s*(?:(?:正确|参考|标准|本题)?答案)\s*[】\]]?)\s*[:：=是为]?\s*[（(]?([A-Ha-h](?:[、,，&＆\s]*[A-Ha-h]){0,3}|正确|错误|对|错|√|×)\s*[)）]?(?:\s+[A-Ha-h][.、．:：]|[^A-Za-z0-9]|$)/);
  if (m) return m[1];
  // 答案字母 + 正确选项同行（答案解析区格式：「C   C. 别无二致完整」）
  const m2 = t.match(/^[（(]?\s*([A-Ha-h])\s+[A-Ha-h][.、．:：]\s*/);
  return m2 ? m2[1].toUpperCase() : null;
}

/** 噪音行（页签/题型/进度/统计/用户作答/分隔线）——不进入题干也不进入解析 */
function isNoiseLine(t) {
  if (/^[-—=_*·~・\s]{4,}$/.test(t)) return true;                              // 分隔线
  if (/^(?:第\s*)?\d{1,3}\s*页\s*\/\s*\d{1,3}(?:\s*页)?$/.test(t)) return true; // 页码
  if (/-?\s*背题\s*\d+\s*\/\s*\d+/.test(t)) return true;                        // 粉笔背题页签「xx-背题 1/10」
  if (TYPE_LABEL_RE.test(t)) return true;                                       // 题型标签（单选题/多选题…）
  if (t.length < 40 && /(答题时间|全站正确率|易错项)/.test(t)) return true;       // 答题统计条
  if (/^你的答案[:：]?\s*\S/.test(t)) return true;                              // 用户作答行（非标准答案）
  return false;
}

/** 同行多选项拆分：「A. 甲  B. 乙  C. 丙  D. 丁」→ { lead 前置文字, parts:[{letter,text}] } */
export function splitInlineOptions(tt) {
  const re = /[（(]?([A-Ha-h])[)）]?[.、．:：]\s*/g;
  const marks = [];
  let mm;
  while ((mm = re.exec(tt))) marks.push({ letter: mm[1].toUpperCase(), index: mm.index, end: re.lastIndex });
  if (marks.length < 2) return null;
  const parts = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].end;
    const end = i + 1 < marks.length ? marks[i + 1].index : tt.length;
    const text = tt.slice(start, end).replace(/\s{2,}/g, ' ').trim();
    if (text) parts.push({ letter: marks[i].letter, text });
  }
  return { lead: tt.slice(0, marks[0].index), parts };
}

/** 解析区：按题号行切块，每块提取答案 + 解析（题目+解析分离结构：薛睿/张弓言语等）
 * 块内答案来自 matchAnswerLine（第X题·答案：D / C C.选项 等）或解析正文（选 C / 答案为 C） */
function parseAnswerSection(lines) {
  const blocks = [];
  let cur = null;
  const start = (t) => { cur = { raw: [t] }; blocks.push(cur); };
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (cur) cur.raw.push(''); continue; }
    const byNum = /^(?:第\s*)?\d{1,3}[.、．)）](?:\s|$)/.test(t) || /^第\s*\d{1,3}\s*题/.test(t);
    if (byNum) start(t);
    else if (cur) cur.raw.push(t);
    else start(t);
  }
  return blocks.map((b) => {
    const q = parseBlock(b.raw);
    let answer = q.answer;
    // 解析正文里提取答案（「故选 C」「答案为 C」「答案：C」…）
    if (!answer && q.analysis) {
      const am = q.analysis.match(/(?:故选|因此选|故答案(?:为|是)?|答案为|答案是|正确答案为|正确答案是|答案(?:为|是)?)\s*[（(]?\s*([A-Ha-h])\s*[)）]?/);
      if (am) answer = am[1].toUpperCase();
    }
    return { answer, answer_index: answer ? answer.charCodeAt(0) - 65 : -1, analysis: q.analysis };
  }).filter((q) => q.answer);
}

/** 规则切分一段文本（按题号/页签/题型标签/选项/答案/解析/材料），返回结构化题目数组 */
export function parseTxt(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trimEnd());
  // 题目+解析分离结构（薛睿「全部解析」/ 张弓言语「第二部分答案与解析」）：取最后一个匹配（目录里也可能出现标题）
  const SEC_RE = /^(?:第[一二三四五六七八九十\d]*\s*部分\s*)?(?:答案与解析|全部解析|参考答案与解析|解析答案|题目解析)\s*[（(]?\s*(?:共\s*)?\d*\s*(?:题)?\s*[)）]?$/;
  let secIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const tl = lines[i].trim();
    if (SEC_RE.test(tl) && tl.length < 40) secIdx = i;
  }
  const headLines = secIdx >= 0 ? lines.slice(0, secIdx) : lines;
  const tailLines = secIdx >= 0 ? lines.slice(secIdx) : [];

  const blocks = [];
  let cur = null;
  // 切块时记录题号（解析区「题目区+解析区分区排版」错位修复用）：
  // byNum「1.」「第1题」→ 真实题号；其他边界（题型/分析标题/答案行/材料）num=null，合并时走原逻辑
  const start = (t, num) => { cur = { raw: [t], num: Number.isFinite(num) ? num : null }; blocks.push(cur); };
  for (const line of headLines) {
    const t = line.trim();
    if (!t) { if (cur) cur.raw.push(''); continue; }
    // 题号边界：1. / 1、 / （1） / 第1题（题号后须跟空格或行尾，防「98.2」小数公式误判）
    const byNum = /^(?:第\s*)?\d{1,3}[.、．)）](?:\s|$)/.test(t) || /^第\s*\d{1,3}\s*题/.test(t);
    // 粉笔背题页签「xx-背题 1/10」→ 新题边界
    const byPass = /-?\s*背题\s*\d+\s*\/\s*\d+/.test(t);
    // 已积累内容后再出现题型标签 → 视为新题（如「单选题」重复出现作为分题）
    const byType = cur && cur.raw.some((l) => l.trim()) && TYPE_LABEL_RE.test(t);
    // 答案解析区标题（「解析与总结」「答案解析」「答案与解析」…）→ 新块边界
    const byAnalysisTitle = cur && cur.raw.some((l) => l.trim()) && /^(?:[【\[]?\s*)?(?:答案与解析|答案解析|解析与答案|解析与总结|答案及解析|试题解析)\s*[】\]]?$/.test(t);
    // 答案行（「正确答案：C」「【答案】B」「第1题 · 答案：D」）→ 新块边界：只要当前块已有内容即开新块，
    // 兼容「题目+答案解析集中排版」的 PDF（答案区与题目区分离，后置回填）
    // 限制为「第X题」开头的答案行，避免解析正文中「故答案为 D」「正确答案为 C」被误切成独立答案块污染 ansSeq
    const byAnswer = cur && cur.raw.some((l) => l.trim()) && /^第\s*\d{1,4}\s*题/.test(t) && matchAnswerLine(t);
    // 材料标记行（材料一/材料二…）→ 新块边界（材料与题目/解析分区排版时独立成材料块）
    const byMaterial = /^(?:[【\[]?\s*材料\s*[一二三四五六七八九十]*\s*[】\]]?\s*[:：]?\s*)/.test(t);
    // 图表标题行（「第120题折线图」）→ 丢弃：不切块不进内容（它是上一题的图表说明，误当题号会污染选项/答案位）
    if (/^第\s*\d{1,3}\s*题\s*(?:折线图|条形图|柱状图|饼图|图形|图表|表格|示意图)/.test(t)) {
      if (cur) cur.raw.push('');
      continue;
    }
    // 章节解析区标题（「第 48 季 · 解析区」「第终极季·解析区」）→ 直接丢弃：它是题目区/解析区之间的分隔
    // 若非丢弃会被并进上一题块，污染每季最后一题的解析（如「第40题」解析变成只有一行季标题）
    if (/^第\s*(?:\d{1,3}|[一二三四五六七八九十百千零]+|[终极]+)\s*季\s*[·・.、]?\s*(?:解析区|答案解析|答案与解析)\s*$/.test(t)) continue;
    if (byNum || byPass || byType) {
      const nm = byNum ? parseInt((t.match(/^\d{1,3}/) || [''])[0], 10) : null;
      start(t, Number.isFinite(nm) ? nm : null);
    }
    else if (byAnalysisTitle) start(t, null);
    else if (byMaterial) start(t, null);
    else if (byAnswer) start(t, null);
    else if (cur) cur.raw.push(t);
    else start(t, null);
  }
  const parsed = blocks.map((b) => ({ ...parseBlock(b.raw), num: b.num }));
  // —— 后处理：独立答案块（答案解析区）合并/回填 ——
  const isJudgement = (o) => o.length === 2 && o[0] === '正确' && o[1] === '错误'; // 判断题自动补的选项
  const out = [];
  for (const q of parsed) {
    // 独立答案块：有答案且无显式题目选项（判断题的自动补选项「正确/错误」也算）
    const isAnswerBlock = !!q.answer && (q.options.length === 0 || isJudgement(q.options));
    if (isAnswerBlock && out.length) {
      const prev = out[out.length - 1];
      // 「题目+答案交替」合并条件：前一块是未完成题目块（无答案无解析）。再加题号匹配
      // （B 型「题目区+解析区分区」答案块 num 与前题 num 不等 → 不合并 → 全部进 ansSeq 按顺序回填）
      const prevOk = prev.prompt && !prev.analysis && !prev.answer;
      const numMatch = q.num == null || prev.num == null ? true : q.num === prev.num;
      if (prevOk && numMatch) {
        // 答案紧跟题目（常规排版）：合并进前一个题目块（判断题：答案块带自动补选项）
        prev.answer = q.answer; prev.answer_index = q.answer_index;
        if (!prev.options.length && q.options.length) prev.options = q.options;
        if (q.prompt && !q.analysis) q.analysis = q.prompt; // 答案块多余内容（如「A项 正确…」）→ 解析
        if (q.analysis) prev.analysis = prev.analysis ? prev.analysis + '\n' + q.analysis : q.analysis;
      } else {
        out.push(q);
      }
    } else {
      out.push(q);
    }
  }
  // 材料回填：最近的材料块 → 后续 material 为空的题目块（材料与题目分页/分区排版）
  // 泄漏防护：题号题自带的内联 [ 材料 ]（如本题库 15 季判断推理每题重复内联材料）只属于该题本身，
  //   不得向前泄漏给下一题号题。独立材料块（无题号）设置的共享材料仍可正常回填给后续题。
  let lastMaterial = '';
  let ownerNum = null; // null=独立材料块设置；number=被某题号题自带材料占据
  for (const q of out) {
    if (q.material) {
      lastMaterial = q.material;
      ownerNum = (q.num != null) ? q.num : null;
      continue;
    }
    if (q.options.length) {
      // 仅当材料来自独立材料块（ownerNum==null）时才回填；题号题自带材料不外溢
      if (lastMaterial && ownerNum == null) q.material = lastMaterial;
    }
  }
  // 答案序列回填：题目区题目 ← 独立答案块 / 解析区答案（按顺序）
  // 答案数量充足（≥题目数）时不跳过任何题目；只有答案不足时才跳过「相邻且指纹相同」的重复
  // （如 PDF 打印重复题号 119 两次但答案只有一份；同题干图形推理题相邻时答案充足不受影响）
  const _ansSeqRaw = out.filter((q) => !q.options.length && q.answer);
  const ansSeq = _ansSeqRaw.concat(parseAnswerSection(tailLines));
  const qCount = out.filter((q) => q.options.length).length;
  const skipAdjDup = ansSeq.length < qCount;
  let ai = 0;
  let lastPk = null;
  for (const q of out) {
    if (!q.options.length) continue;
    const pk = String(q.prompt || '').replace(/\s+/g, '') + '||' + (q.options || []).map((o) => String(o).replace(/\s+/g, '')).join('|');
    const isAdjDup = skipAdjDup && lastPk === pk;
    lastPk = pk;
    if (isAdjDup) continue; // 答案不足时的相邻完全重复：跳过（最终由 dedupeQuestions 去重）
    if (ai < ansSeq.length) {
      if (!q.answer) { q.answer = ansSeq[ai].answer; q.answer_index = ansSeq[ai].answer_index; }
      if (!q.analysis && ansSeq[ai].analysis) q.analysis = ansSeq[ai].analysis;
      ai++; // 无论题目是否已有答案都消耗一个答案位（答案按题号顺序对齐）
    }
  }
  // 题目判定：题干 + (材料|选项|答案|解析)；纯材料块/纯标题块不产出伪题
  return out.filter((q) => q.prompt && (q.material || q.options.length || q.answer || q.analysis));
}

/** —— PDF 题图定位（纯函数，Web/App 渲染裁剪共用）——
 * 输入行：{ y: PDF 用户空间基线 y（向上增大）, text: 行文本 }
 * 输出：按文档顺序每个「题干行」一个条目 { crop, num }；crop=null 表示该题无图区，num=题干行首题号（无题号 null）。
 * 原理：题干行与其下方选项块之间出现大段空白（≥gapMin）即认为中间有图形，
 * 裁剪区取空白两侧文本行基线之间。实测版面：图形题空白 ≈120-165，纯文字题 ≤24。
 * 返回空数组表示本页无「题干+选项」结构（解析区/目录页），调用方整页跳过以保持题目对齐。 */
export function computeFigureCrops(rows, opts = {}) {
  const gapMin = opts.gapMin ?? 60;
  const maxSpan = opts.maxSpan ?? 620;
  const optGap = opts.optGap ?? 150;
  const rs = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && Number.isFinite(r.y) && String(r.text ?? '').trim())
    .sort((a, b) => b.y - a.y); // 页面自上而下（y 大在上）
  if (rs.length < 2) return [];
  const QNUM_RE = /^(?:第\s*)?\d{1,3}\s*[.、．)）]/;
  // 行内选项字母（含同行多选项「A. x B. y C. z D. w」与占位「A.AB.BC.CD.D」）
  const optLetters = (s) => [...String(s ?? '').matchAll(/[（(]?([A-Ha-h])[)）]?[.、．:：]/g)].map((m) => m[1].toUpperCase());
  const OPT_A_RE = /^[（(]?A[)）]?[.、．:：]/;
  // 选项块收集：自 A 行起（行内可携带多个字母），向下并入以「顺延字母」开头的行（竖排/两行折行都可），至少凑齐 A+B+C
  const blocks = [];
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i];
    const t = String(r.text || '').trim();
    if (!OPT_A_RE.test(t)) continue;
    const letters = optLetters(t);
    if (!letters.length || letters[0] !== 'A') continue;
    let botY = r.y;
    let expect = letters.length; // 已收集字母数 → 下个期望字母（65+expect）
    for (let j = i + 1; j < rs.length; j++) {
      const q = rs[j];
      if (r.y - q.y > optGap) break; // 超出竖排范围
      const l2 = optLetters(String(q.text || '').trim());
      if (l2.length) {
        if (l2[0].charCodeAt(0) !== 65 + expect) break; // 选项行但字母断档 → 停止
        letters.push(...l2);
        expect = letters.length;
        botY = Math.min(botY, q.y);
      } else if (letters.length >= 3) {
        break; // 已凑齐 A+B+C 后遇非选项行 → 停止（防解析台词并入选项块）
      }
      // 非选项行且尚未凑齐 3 个字母：继续向下找（如 A 行与 B 行间夹一张图/空行）
    }
    if (letters.length >= 3) blocks.push({ topY: r.y, botY });
  }
  if (!blocks.length) return [];
  // 题干行 ↔ 自上而下最近且未消费的下方选项块 配对
  const out = [];
  let pending = null;
  let bi = 0;
  for (const r of rs) {
    while (bi < blocks.length && blocks[bi].topY > r.y) bi++; // 跳过已越过起点的块
    if (QNUM_RE.test(r.text.trim())) pending = r;
    if (pending && bi < blocks.length && blocks[bi].topY < pending.y && pending.y - blocks[bi].topY <= maxSpan) {
      const blk = blocks[bi++];
      const inner = rs.filter((x) => x.y < pending.y - 1e-6 && x.y > blk.topY + 1e-6).map((x) => x.y);
      const seq = [pending.y, ...inner, blk.topY]; // 递减
      let mg = -1, up = seq[0], dn = seq[seq.length - 1];
      for (let k = 0; k + 1 < seq.length; k++) {
        const g = seq[k] - seq[k + 1];
        if (g > mg) { mg = g; up = seq[k]; dn = seq[k + 1]; }
      }
      const nm = pending.text.trim().match(/^\d{1,3}/);
      out.push({ crop: mg >= gapMin ? { yTop: up, yBottom: dn } : null, num: nm ? parseInt(nm[0], 10) : null });
      pending = null;
    }
  }
  return out;
}

/** 材料图附加：material 为空的题目连续段 ← 材料图队列（图段/文字段交替的 PDF，如资料分析材料表格截图）。
 * 泄漏防护：单张材料图最多服务 serveLimit 道 material 为空的题（一篇资料分析材料 ≤5 小题），
 * 超出部分消耗下一张材料图或放弃，避免把一张无关截图糊到几十道题上 */
export function attachMaterialImages(qs, materialImgs, serveLimit = 6) {
  if (!Array.isArray(materialImgs) || !materialImgs.length) return;
  let imgIdx = 0;
  let inEmpty = false;
  let served = 0;
  for (const q of qs) {
    if (!q.material && q.options.length) {
      if (imgIdx < materialImgs.length && served < serveLimit) {
        inEmpty = true;
        served++;
        if (!q.images || !q.images.length) q.images = [{ role: 'material', dataUrl: materialImgs[imgIdx] }];
      } else if (inEmpty && imgIdx < materialImgs.length && served >= serveLimit) {
        imgIdx++; served = 0; // 同一段超长：消耗下一张材料图（没有则后续题保持无图）
      }
    } else if (q.material && inEmpty) {
      imgIdx++; served = 0; // 空段结束（遇到有文字材料的题）→ 下一空段用下一张材料图
      inEmpty = false;
    }
  }
}

/** 去 PDF 提取文本的中文字距空格：答 案 → 答案；2 0 2 2 → 2022；保留表格列分隔的多空格
 * 注意：合并仅限「空格/制表」不含换行（换行是行结构，跨行中文不得粘连） */
export function deChineseSpace(t) {
  let s = String(t ?? '');
  s = s.replace(/<br\s*\/?\s*>/gi, '\n');                                        // HTML <br> → 换行（网页导出的 PDF 常见）
  s = s.replace(/<\/?[a-z][^>]*>/gi, '');                                        // 其他 HTML 标签剥除
  for (let i = 0; i < 4; i++) s = s.replace(/(\d) (?=\d)/g, '$1');              // 数字串：2 0 2 2 → 2022
  s = s.replace(/([\u4e00-\u9fff]) (?=[\u4e00-\u9fff])/g, '$1');                // 中文单空格：答 案 → 答案
  s = s.replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '$1');           // 中文连续空格：年 国 考 → 年国考（不动换行）
  s = s.replace(/([\u4e00-\u9fff0-9%]) (?=[\u4e00-\u9fff0-9%])/g, '$1');       // 中/数/% 单空格：1 月 → 1月
  return s;
}

/** 解析单题块（行数组） */
function parseBlock(lines) {
  const prompt = [];
  const material = [];
  const options = [];
  let answer = '';
  let analysis = '';
  let inMaterial = false;
  let analysisStarted = false; // 解析已开始：后续整行都归解析正文（含 A 项逐条续行）
  const addAnalysis = (txt) => { analysis = analysis ? analysis + '\n' + txt : txt; };
  // 材料/题干分离：把累积的「材料+题干（ask）」整段按末尾 ask 终止符（？/:）定位，
  // 在其前面最近的句号处切分。鲁棒处理 PDF 把 ask 跨行截断的情况
  // （如「…一定错」/「误？」、「…则可以推」/「出：」），旧逐行终止逻辑会误判。
  const splitMaterialAsk = () => {
    const joined = material.join('\n').trim();
    if (!joined) return;
    const last = joined[joined.length - 1];
    const isAskEnd = last === '？' || last === '?' || last === '：' || last === ':';
    if (!isAskEnd) return; // 材料末尾无 ask 终止符（如「已知：…（1）（2）」直接接选项）→ 整体留作材料
    let p = -1;
    for (let i = joined.length - 1; i >= 0; i--) {
      const c = joined[i];
      if (c === '？' || c === '?' || c === '：' || c === ':') { p = i; break; }
    }
    if (p < 0) return;
    let d = -1;
    for (let i = p - 1; i >= 0; i--) {
      if (joined[i] === '。' || joined[i] === '.') { d = i; break; }
    }
    const mat = d >= 0 ? joined.slice(0, d + 1) : '';
    const pro = joined.slice(d + 1);
    material.length = 0;
    if (mat.trim()) material.push(mat.trim());
    if (pro.trim()) prompt.push(pro.trim());
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // 题号行前缀剥离（1. xxx → xxx；1. 整体行保留除题号外内容；题号后须跟空格/行尾防小数误判）
    let tt = t;
    const noRe = tt.match(/^(?:第\s*)?\d{1,3}[.、．)）](?:\s|$)([\s\S]*)$/);
    if (noRe) { tt = noRe[1].trim(); if (!tt) continue; }
    // 组卷前缀剥离（「国考组卷 1 · 第1题」→ 空；组卷题的卷内序号不是题干）
    tt = tt.replace(/^(?:国考|联考|省考|事业单位)?\s*组卷\s*\d*\s*[·.]?\s*第\s*\d+\s*题\s*/i, '');
    if (!tt.trim()) continue;
    // 答案行（正确答案：C / 答案：A / 【答案】B / 答案为 D），解析区出现的答案行也提取
    const aw = matchAnswerLine(tt);
    if (aw && !answer) { answer = aw; continue; }
    if (analysisStarted) { addAnalysis(tt); continue; }
    // 噪音行（页签/题型/统计/你的答案/分隔）——不进题干、不进解析
    if (isNoiseLine(tt)) continue;
    // 解析行（可带「解析＋正文」同行；后续行为续行；支持「【陈怀安解析】【粉笔解析】」带人名/机构前缀）
    const am = tt.match(/^(?:[【\[]?\s*(?:(?:试题)?解析(?:答案)?|[^】\]]{0,12}解析)\s*[】\]]?)\s*[:：]?\s*(.*)$/);
    if (am) { analysisStarted = true; const rest = am[1].trim(); if (rest) addAnalysis(rest); continue; }
    // 考点/总结标记行（「【考点】…」「【总结】…」→ 解析正文；答案解析集中排版的 PDF 常见）
    const km = tt.match(/^(?:[【\[]?\s*(?:考点|总结)\s*[】\]]?)\s*[:：]?\s*(.*)$/);
    if (km) { analysisStarted = true; const rest = km[1].trim(); if (rest) addAnalysis(rest); continue; }
    // 显式题干/题目标签
    const stm = tt.match(/^(?:[【\[]?\s*(?:题干|题目|试题)\s*[】\]]?)\s*[:：]?\s*(.*)$/);
    if (stm) { inMaterial = false; const rest = stm[1].trim(); if (rest) prompt.push(rest); continue; }
    // 显式选项标签（选项 / 【选项】）→ 后续即选项区
    if (/^(?:[【\[]?\s*选项\s*[】\]]?|选项[:：])/.test(tt)) { inMaterial = false; continue; }
    // 材料标记行（材料 / 材料一 / 【材料】；仅选项未开始时视为材料；】在序号后，勿把【材料一】的】当内容）
    const mat = tt.match(/^(?:[【\[]?\s*材料\s*[一二三四五六七八九十]*\s*[】\]]?\s*[:：]?\s*)(.*)$/);
    if (mat && options.length === 0) {
      inMaterial = true;
      const rest = mat[1].trim();
      if (rest) material.push(rest);
      continue;
    }
    if (inMaterial && options.length === 0) {
      // 累积材料直到出现选项行；出现选项时再做「材料 / 题干（ask）」分离（见 splitMaterialAsk）。
      // 不再逐行判断终止符 —— 题干 ask 常被 PDF 换行截断（「…一定错」/「误？」、「…则可以推」/「出：」），
      // 逐行判断会把 ask 残片误当题干、真 ask 漏进材料，甚至整题丢失。
      if (/^[A-Ha-h][.、．:：)]/.test(tt)) {
        splitMaterialAsk();
        inMaterial = false;
        // 不 continue：落到下方 OPT_LINE_RE 继续解析本行选项
      } else {
        material.push(tt);
        continue;
      }
    }
    // 选项行
    const om = tt.match(OPT_LINE_RE);
    if (om) {
      const letter = om[1].toUpperCase();
      const body = om[2].trim();
      inMaterial = false;
      if (!body) { prompt.push(tt); continue; }
      // 选项必须从 A 开始（防题干/解析误判，如 "C. 的说法错误"）
      if (options.length === 0 && letter !== 'A') { prompt.push(tt); continue; }
      // 解析语气行保护：正文以「项…」（AI 解析「A项 正确…」）起且已有选项 → 归解析
      if (options.length > 0 && /^项[，。\s:：]/.test(body)) { addAnalysis(tt); analysisStarted = true; continue; }
      // 同行多选项拆分（A. x B. y C. z D. w；无前缀或前缀为题干）
      const spl = splitInlineOptions(tt);
      if (spl) {
        const lead = String(spl.lead || '').trim();
        if (lead && options.length === 0 &&
            (lead.length >= 8 || /[？?。，；：:]$|（\s*）|\(\s*\)/.test(lead))) {
          prompt.push(lead); // 前缀是题干（如「正确的是（　）A. x B. y」）
        }
        for (const o of spl.parts) if (o.text) options.push(`${o.letter}. ${o.text}`);
        continue;
      }
      options.push(`${letter}. ${body}`);
      continue;
    }
    // 纯字母选项行（图形题选项占位，如「A」「B」「C  D」——选项文字在图上，无文本）
    const bare = tt.match(/^[（(]?([A-Ha-h])[)）]?[.、．:：]?\s*$/);
    if (bare) {
      if (inMaterial) { splitMaterialAsk(); inMaterial = false; }
      if (options.length === 0 && bare[1].toUpperCase() !== 'A') { prompt.push(tt); continue; }
      options.push(`${bare[1].toUpperCase()}. `);
      continue;
    }
    const bareMulti = tt.match(/^([A-Ha-h])(?:\s+[A-Ha-h]){1,3}$/);
    if (bareMulti) {
      if (inMaterial) { splitMaterialAsk(); inMaterial = false; }
      for (const L of tt.match(/[A-Ha-h]/g).map((c) => c.toUpperCase())) options.push(`${L}. `);
      continue;
    }
    // 题干行内嵌选项：…正确的是（　）A. x B. y C. z D. w（未到选项区时按首个标记拆题干+选项）
    if (options.length === 0) {
      const spl = splitInlineOptions(tt);
      if (spl && spl.parts.length >= 2 && spl.parts[0].letter === 'A') {
        const lead = String(spl.lead || '').trim();
        if (lead) prompt.push(lead);
        for (const o of spl.parts) if (o.text) options.push(`${o.letter}. ${o.text}`);
        continue;
      }
    }
    // 选项后的杂行 → 解析
    if (options.length) { addAnalysis(tt); continue; }
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
        category: String(q?.category ?? '').trim() || '',
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

/** 题目去重（PDF 常见"题目页 + 答案解析页"重复）：按「题干+选项」指纹去重，保留答案/解析更全的版本
 * 指纹含选项：图形推理题题干相同但选项不同（A. A B. B…），不得误去重
 * 图形题（占位选项如「A. A」「B. B」或空选项）指纹不含题干：同一图形题题干+选项完全重复时，保留不同答案的版本（避免误吞）
 *   - 实际是：图形题指纹 = options + answer（题干不参与），相同图形题不同答案 → 全部保留
 *   - 常规题指纹含题干，保留原行为 */
export function dedupeQuestions(qs) {
  const seen = new Map();
  const score = (q) => (q.answer ? 2 : 0) + (q.analysis ? 1 : 0) + (q.material ? 0.5 : 0);
  // 图形题检测：选项全部是单字母占位（如「A. A」「B. B」「C. 」），常见于判断推理图形推理 PDF
  const isFigureQ = (q) => Array.isArray(q.options) && q.options.length > 0 && q.options.every((o) => /^[A-H]\.\s*[A-H]?\s*$/.test(String(o).trim()));
  for (const q of qs) {
    if (isFigureQ(q)) { seen.set(Symbol(), q); continue; } // 图形题不去重：题干/选项指纹全相同但图不同，保留全部
    const optKey = (q.options || []).map((o) => String(o).replace(/\s+/g, '')).join('|');
    const key = String(q.prompt || '').replace(/\s+/g, '') + '||' + optKey;
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

/** 解析存储的 images JSON（兼容旧数据/空值/已解析数组） */
export function parseImages(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
}

/** 按角色过滤图片并生成 <img> 标签串（dataURL 直接内联，渲染层 sanitizeHtml 放行 data:image） */
export function customImagesHtml(images, role) {
  return parseImages(images)
    .filter((im) => im && im.role === role && im.dataUrl)
    .map((im) => `<img src="${im.dataUrl}" alt="题目图片">`)
    .join('');
}

/** HTML 转义（题目文本进入 contentHtml/materialHtml 前；与 app.js esc 同语义，供 Node 端复用） */
export function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 自定义题 → 展示用 HTML（Web/App 出题与详情共用）：题干文本+题干图 / 材料文本+材料图（纯图材料也保留） */
export function customQuestionHtml(q) {
  const matText = escHtml(q?.material);
  const matImgs = customImagesHtml(q?.images, 'material');
  return {
    contentHtml: escHtml(q?.prompt) + customImagesHtml(q?.images, 'stem'),
    materialHtml: (matText || matImgs) ? matText + matImgs : '',
  };
}

/** deflate-raw 解压（浏览器/WebView 均有 DecompressionStream） */
export async function inflateRaw(uint8) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([uint8]).stream().pipeThrough(ds);
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return new TextDecoder().decode(out);
}
