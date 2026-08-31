// 自定义题库解析引擎单测：normalizeAnswer / parseTxt / extractJson / dedupeQuestions / aiStructure
// 运行：node --test test-custom-parser.mjs（或 npm run test:local）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAnswer,
  parseTxt,
  extractJson,
  dedupeQuestions,
  aiStructure,
  parseImages,
  customImagesHtml,
  customQuestionHtml,
  computeFigureCrops,
} from './public/lib/custom-parser.js';

test('normalizeAnswer：单选 A-D 映射 answer_index', () => {
  const r = normalizeAnswer('B', ['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁']);
  assert.equal(r.answer, 'B');
  assert.equal(r.answer_index, 1);
  assert.equal(r.options.length, 4);
});

test('normalizeAnswer：剥前缀与括号', () => {
  assert.equal(normalizeAnswer('答案：C', []).answer, 'C');
  assert.equal(normalizeAnswer('【答案】D', []).answer, 'D');
  assert.equal(normalizeAnswer('（B）', []).answer, 'B');
  assert.equal(normalizeAnswer('参考答案：A', []).answer_index, 0);
});

test('normalizeAnswer：多选 AB → JSON 索引数组', () => {
  const r = normalizeAnswer('AB', ['A. 1', 'B. 2', 'C. 3', 'D. 4']);
  assert.equal(r.answer, '[0,1]');
  assert.equal(r.answer_index, -1);
});

test('normalizeAnswer：判断题自动补选项', () => {
  const r1 = normalizeAnswer('正确', []);
  assert.deepEqual(r1.options, ['正确', '错误']);
  assert.equal(r1.answer_index, 0);
  const r2 = normalizeAnswer('错误', []);
  assert.equal(r2.answer_index, 1);
});

test('normalizeAnswer：空/无法识别 → -1', () => {
  assert.equal(normalizeAnswer('', []).answer_index, -1);
  assert.equal(normalizeAnswer('不太确定', []).answer_index, -1);
});

test('parseTxt：标准单选块（题干/选项/答案/解析）', () => {
  const qs = parseTxt(`1. 我国现行宪法是哪一年颁布的？
A. 1949年
B. 1954年
C. 1978年
D. 1982年
答案：D
解析：现行宪法是1982年颁布的。`);
  assert.equal(qs.length, 1);
  const q = qs[0];
  assert.match(q.prompt, /我国现行宪法/);
  assert.equal(q.options.length, 4);
  assert.equal(q.answer, 'D');
  assert.equal(q.answer_index, 3);
  assert.match(q.analysis, /1982年/);
});

test('parseTxt：同行多选项拆分（A. x B. y C. z）', () => {
  const qs = parseTxt(`1. 以下哪个是城市？
A. 北京  B. 泰山  C. 黄山  D. 华山
答案：A`);
  const q = qs[0];
  assert.equal(q.options.length, 4);
  assert.match(q.options[0], /^A\. 北京/);
  assert.match(q.options[3], /^D\. 华山/);
});

test('parseTxt：材料题（材料标记 → 材料字段）', () => {
  const qs = parseTxt(`材料一：某市推进垃圾分类。
根据材料，下列说法正确的是？
A. 甲
B. 乙
答案：B
解析：略。`);
  const q = qs[0];
  assert.match(q.material, /垃圾分类/);
  assert.match(q.prompt, /根据材料/);
});

test('parseTxt：判断题（答案：正确）', () => {
  const qs = parseTxt(`2. 地球是太阳系中离太阳最近的行星。
答案：错误
解析：水星最近。`);
  const q = qs[0];
  assert.equal(q.options.length, 2);
  assert.equal(q.answer_index, 1);
});

test('parseTxt：多题切分', () => {
  const qs = parseTxt(`1. 第一题？
A. 1 B. 2 C. 3 D. 4
答案：A
2. 第二题？
A. 甲 B. 乙 C. 丙 D. 丁
答案：B`);
  assert.equal(qs.length, 2);
});

test('extractJson：剥 ```json 围栏', () => {
  const r = extractJson('```json\n{"questions":[{"prompt":"P"}]}\n```');
  assert.deepEqual(r, [{ prompt: 'P' }]);
});

test('extractJson：裸数组与嵌套 questions（优先提取内层数组）', () => {
  assert.deepEqual(extractJson('[{"a":1}]'), [{ a: 1 }]);
  // {"questions":[...]} 对象 → 提取内层数组（aiStructure 依赖此行为）
  assert.deepEqual(extractJson('好的，结果如下：{"questions":[{"prompt":"X"}]}'), [{ prompt: 'X' }]);
});

test('extractJson：垃圾输入 → null', () => {
  assert.equal(extractJson('我不是 JSON'), null);
  assert.equal(extractJson(''), null);
});

test('dedupeQuestions：按题干指纹去重，保留解析更全版本', () => {
  const qs = dedupeQuestions([
    { prompt: '重复题？', answer: '', analysis: '' },
    { prompt: '重复题？', answer: 'A', analysis: '有解析' },
  ]);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].analysis, '有解析');
});

test('aiStructure：AI 返回有效 JSON → 结构化+规范化', async () => {
  const callAi = async () => JSON.stringify({
    questions: [
      { prompt: 'AI 题？', options: ['甲', '乙'], answer: 'A', analysis: 'AI 解析' },
    ],
  });
  const out = await aiStructure(['AI 题？'], callAi);
  assert.equal(out.length, 1);
  assert.equal(out[0].answer_index, 0);
  assert.equal(out[0].failed, false);
});

test('aiStructure：AI 输出乱码 → failed 标记保留原文', async () => {
  const callAi = async () => '完全不是 JSON 的输出';
  const out = await aiStructure(['原文题目'], callAi);
  assert.equal(out.length, 1);
  assert.equal(out[0].failed, true);
  assert.equal(out[0].prompt, '原文题目');
});

test('aiStructure：AI 抛错 → failed 标记', async () => {
  const callAi = async () => { throw new Error('网络失败'); };
  const out = await aiStructure(['题目'], callAi);
  assert.equal(out.length, 1);
  assert.equal(out[0].failed, true);
});

// ---------- 2026-08-19：真实样张（粉笔 App「背题」截图 OCR 文本）----------

test('parseTxt：粉笔背题截图（页签/题型/统计噪音 剔除 + 正确答案）', () => {
  const qs = parseTxt(`专项智能练习（政治理论）-背题 1/10
单选题
延安整风运动是中国共产党在领导敌后抗战的同时在全党范围内开展的一场深入的马克思主义教育运动。下列有关表述，不正确的是（）。
A 《关于若干历史问题的决议》是延安整风运动的重要成果
B 延安整风运动是中国共产党历史上第一次大规模的整风运动
C 延安整风运动期间召开的党的八大将毛泽东思想确立为全党的指导思想
D 延安整风运动中，整顿“三风”的主要内容是整顿学风、整顿党风、整顿文风
正确答案：C 你的答案：B
1秒 49% D 答题时间 全站正确率 易错项
解析 本题考查毛中特。
A项正确，1945年……
B项正确，……第一次全党范围……整风运动。
C项错误，……是党的七大……
D项正确，……整顿“三风”。
本题为选非题，故正确答案为C。`);
  assert.equal(qs.length, 1);
  const q = qs[0];
  assert.match(q.prompt, /延安整风运动/);
  assert.ok(!/背题/.test(q.prompt) && !/单选题/.test(q.prompt), '页签/题型标签不得进题干');
  assert.equal(q.options.length, 4);
  assert.equal(q.options[0], 'A. 《关于若干历史问题的决议》是延安整风运动的重要成果');
  assert.equal(q.answer, 'C');
  assert.equal(q.answer_index, 2);
  assert.ok(!/答题时间/.test(q.analysis), '统计噪音行不得进解析');
  assert.match(q.analysis, /本题考查毛中特/);
  assert.match(q.analysis, /本题为选非题/);
  assert.match(q.analysis, /A项正确/); // 解析逐条 A/B/C/D 项保留
});

test('parseTxt：选项无标点（OCR 常见 "A xxx" 字母+空格）', () => {
  const qs = parseTxt(`题干？
A 甲
B 乙
C 丙
D 丁
答案：B`);
  assert.equal(qs[0].options.length, 4);
  assert.equal(qs[0].options[1], 'B. 乙');
  assert.equal(qs[0].answer_index, 1);
});

test('parseTxt：题干内嵌选项（…正确的是（　）A. x B. y）拆题干+选项', () => {
  const qs = parseTxt(`1. 下列属于古代丝绸之路重要节点城市的是（　）A. 西安 B. 敦煌 C. 喀什 D. 广州
答案：ABCD
解析：均为丝路节点。`);
  const q = qs[0];
  assert.match(q.prompt, /古代丝绸之路/);
  assert.ok(!/A\. 西安/.test(q.prompt), '内嵌选项应拆出正文，不留题干');
  assert.equal(q.options.length, 4);
  assert.equal(q.options[0], 'A. 西安');
  assert.equal(q.options[3], 'D. 广州');
  assert.deepEqual(JSON.parse(q.answer), [0, 1, 2, 3]); // ABCD 全选
});

test('parseTxt：背题页签切多题 + 题型标签兼作新题边界', () => {
  const qs = parseTxt(`专项智能练习（言语理解）-背题 1/10
单选题
第一题题干？
A. 甲 B. 乙 C. 丙 D. 丁
正确答案：B 你的答案：C
解析：第一题解析。
专项智能练习（言语理解）-背题 2/10
单选题
第二题题干？
A. 一 B. 二 C. 三 D. 四
正确答案：D
解析：第二题解析。`);
  assert.equal(qs.length, 2);
  assert.match(qs[0].prompt, /第一题/);
  assert.equal(qs[0].answer_index, 1);
  assert.match(qs[1].prompt, /第二题/);
  assert.equal(qs[1].answer_index, 3);
});

test('parseTxt：多选题 答案：A、B → JSON 索引数组', () => {
  const qs = parseTxt(`1. 下列属于公民基本权利的有？
A. 平等权 B. 言论自由 C. 受教育权 D. 纳税义务
正确答案：A、B
解析：纳税是义务。`);
  const q = qs[0];
  assert.deepEqual(JSON.parse(q.answer), [0, 1]);
  assert.equal(q.answer_index, -1);
});

test('parseTxt：答案写法变体（答案为/标准答案/【答案】/参考答案）', () => {
  for (const [line, want] of [['答案为 A', 0], ['标准答案：B', 1], ['【答案】C', 2], ['参考答案 D', 3]]) {
    const qs = parseTxt(`题干？
A. 甲 B. 乙 C. 丙 D. 丁
${line}`);
    assert.equal(qs[0].answer_index, want, line);
  }
});

test('parseTxt：解析语气行（A 项 正确）不作为选项', () => {
  const qs = parseTxt(`题干？
A. 甲 B. 乙 C. 丙 D. 丁
答案：A
A项 正确，因为……`);
  const q = qs[0];
  assert.equal(q.options.length, 4, 'A项解析行不得追加为第 5 选项');
  assert.match(q.analysis, /A项 正确/);
});

test('normalizeAnswer：正确答案/标准答案前缀 + 尾随你的答案', () => {
  assert.equal(normalizeAnswer('正确答案：C 你的答案：B', []).answer_index, 2);
  assert.equal(normalizeAnswer('正确答案为C', []).answer_index, 2);
  assert.equal(normalizeAnswer('标准答案：D', []).answer_index, 3);
  assert.equal(normalizeAnswer('（答案：B）', []).answer_index, 1);
  assert.equal(normalizeAnswer('答案：AB', []).answer, '[0,1]');
  assert.deepEqual(JSON.parse(normalizeAnswer('答案：A、B', []).answer), [0, 1]);
});

// ---------- 图片题（images 字段 / 渲染 HTML 拼装） ----------

test('parseImages：兼容 JSON 字符串/数组/空值/非法值', () => {
  assert.deepEqual(parseImages(undefined), []);
  assert.deepEqual(parseImages(''), []);
  assert.deepEqual(parseImages('not-json'), []);
  assert.deepEqual(parseImages([{ role: 'stem' }]), [{ role: 'stem' }]);
  assert.deepEqual(parseImages('[]'), []);
  assert.deepEqual(parseImages('[{"role":"material"}]'), [{ role: 'material' }]);
});

test('customImagesHtml：按角色过滤、跳过缺 dataUrl 项', () => {
  const imgs = [
    { role: 'stem', dataUrl: 'data:image/jpeg;base64,AAA' },
    { role: 'material', dataUrl: 'data:image/jpeg;base64,BBB' },
    { role: 'stem' }, // 缺 dataUrl → 跳过
    { dataUrl: 'data:image/jpeg;base64,CCC' }, // 缺 role → 跳过
  ];
  const stem = customImagesHtml(imgs, 'stem');
  assert.match(stem, /<img src="data:image\/jpeg;base64,AAA"/);
  assert.doesNotMatch(stem, /BBB|CCC/);
  assert.match(customImagesHtml(imgs, 'material'), /base64,BBB/);
  assert.equal(customImagesHtml(imgs, 'material').match(/<img/g).length, 1);
  assert.equal(customImagesHtml([], 'stem'), '');
  assert.equal(customImagesHtml(null, 'stem'), '');
});

test('customQuestionHtml：题干+题干图 / 材料+材料图 / HTML 转义', () => {
  const q = {
    prompt: '根据图形规律，填入问号处最合适的一项是：',
    material: '材料 <含> & 符号',
    images: [
      { role: 'stem', dataUrl: 'data:image/jpeg;base64,STEM' },
      { role: 'material', dataUrl: 'data:image/jpeg;base64,MAT' },
    ],
  };
  const h = customQuestionHtml(q);
  assert.match(h.contentHtml, /填入问号处最合适的一项是：/);
  assert.match(h.contentHtml, /<img src="data:image\/jpeg;base64,STEM"/);
  assert.doesNotMatch(h.contentHtml, /MAT/);
  assert.match(h.materialHtml, /材料 &lt;含&gt; &amp; 符号/);
  assert.match(h.materialHtml, /<img src="data:image\/jpeg;base64,MAT"/);
  assert.doesNotMatch(h.materialHtml, /STEM/);
});

test('customQuestionHtml：无材料/无图片的边界', () => {
  const h = customQuestionHtml({ prompt: '仅题干', material: '', images: [] });
  assert.equal(h.contentHtml, '仅题干');
  assert.equal(h.materialHtml, '');
  const h2 = customQuestionHtml({});
  assert.equal(h2.contentHtml, '');
  assert.equal(h2.materialHtml, '');
});

test('customQuestionHtml：纯图材料（无材料文本）也保留材料图', () => {
  const h = customQuestionHtml({ prompt: '根据图表回答问题', material: '', images: [{ role: 'material', dataUrl: 'data:image/png;base64,CHART' }] });
  assert.equal(h.contentHtml, '根据图表回答问题');
  assert.match(h.materialHtml, /<img src="data:image\/png;base64,CHART"/);
});

test('customQuestionHtml：纯图形题（空题干）→ 题干图仍渲染', () => {
  const h = customQuestionHtml({ prompt: '（图形见题）', images: [{ role: 'stem', dataUrl: 'data:image/png;base64,FIG' }] });
  assert.match(h.contentHtml, /（图形见题）/);
  assert.match(h.contentHtml, /<img src="data:image\/png;base64,FIG"/);
});

// ---------- 2026-08-21：真实 PDF（行测判断推理 600题）回归修复 ----------

test('parseTxt：章节解析区标题（第 X 季 · 解析区）不污染前一题解析', () => {
  // 「第 48 季 · 解析区」紧跟在题目区最后一题后面：不得并入题目块，每季末题解析应正常回填
  const qs = parseTxt(`39. 命题结构题干？
A. 甲  B. 乙  C. 丙  D. 丁
40. 组合排序推理题干？
A. 1 B. 2 C. 3 D. 4
第   48   季   ·   解析区
39.   答案： B
红领巾解析
命题结构解析……因此答案为 B 。
40.   答案： D
红领巾解析
组合排序推理解析……因此答案为 D 。`);
  const q40 = qs.find((q) => /组合排序推理题干/.test(q.prompt || ''));
  assert.ok(q40, '第 40 题应被解析出');
  assert.equal(q40.answer, 'D');
  assert.ok(!/第\s*48\s*季/.test(q40.analysis || ''), '第 40 题解析不得含季标题');
  assert.match(q40.analysis, /组合排序推理解析/);
  const q39 = qs.find((q) => /命题结构题干/.test(q.prompt || ''));
  assert.equal(q39.answer, 'B');
  assert.ok(!/第\s*48\s*季/.test(q39.analysis || ''));
  assert.match(q39.analysis, /命题结构解析/);
});

test('parseTxt：第终极季 / 中文序号季解析区标题同样丢弃', () => {
  const qs = parseTxt(`40. 图形题题干
A. A  B. B  C. C  D. D
第 终极 季 · 解析区
40.   答案： C
红领巾解析
对称性……因此答案为 C 。`);
  const q = qs[0];
  assert.equal(q.answer, 'C');
  assert.ok(!/第\s*终极\s*季/.test(q.analysis || ''));
  assert.match(q.analysis, /对称性/);
});

test('computeFigureCrops：合并单字母占位选项行（A.AB.BC.CD.D）命中图形题裁剪', () => {
  // 图形题版面：题干行 → 大空白(图区) → 合并占位选项行（pdf.js 同基线 item 拼接成 A.AB.BC.CD.D）
  const rows = [
    { y: 700, text: '1.从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：<br>' },
    { y: 530, text: 'A.AB.BC.CD.D' },
  ];
  const marks = computeFigureCrops(rows);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].num, 1);
  assert.ok(marks[0].crop, '题干行与占位选项行之间的大空白应判为图区');
  assert.ok(marks[0].crop.yTop > marks[0].crop.yBottom, '图区基线自上而下');
});

test('computeFigureCrops：竖排 A/B/C/D 行仍命中（回归，不破坏旧行为）', () => {
  const rows = [
    { y: 700, text: '1.从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：<br>' },
    { y: 530, text: 'A.A' },
    { y: 510, text: 'B.B' },
    { y: 490, text: 'C.C' },
    { y: 470, text: 'D.D' },
  ];
  const marks = computeFigureCrops(rows);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].num, 1);
  assert.ok(marks[0].crop);
});

test('computeFigureCrops：两行折行选项块（A..B.. / C..D..）也并块命中', () => {
  const rows = [
    { y: 700, text: '8.从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：<br>' },
    { y: 400, text: 'A.①②④，③⑤⑥  B.①②⑥，③④⑤' },
    { y: 380, text: 'C.①③④，②⑤⑥  D.①③⑤，②④⑥' },
  ];
  const marks = computeFigureCrops(rows);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].num, 8);
  assert.ok(marks[0].crop, '折行选项块整体应构成选项区，其上大空白为图区');
});

test('computeFigureCrops：纯文字题无大空白 → crop=null（不误判图形）', () => {
  const rows = [
    { y: 700, text: '1.快递爆仓是指快递公司突然间收到太多快件，来不及分拣。<br>' },
    { y: 690, text: '根据上述定义，以下符合快递爆仓的是：' },
    { y: 660, text: 'A.备战双十一期间，某电器公司改装了仓库货架' },
    { y: 645, text: 'B.反扑的疫情使得居民无法按时取走快递' },
    { y: 630, text: 'C.某电商平台提前租赁临时仓库' },
    { y: 615, text: 'D.全运会期间安检强度加大，快递大量积压' },
  ];
  const marks = computeFigureCrops(rows);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].crop, null);
});

test('computeFigureCrops：解析区（无题干行）返回空数组，调用方整页跳过', () => {
  const rows = [
    { y: 700, text: '1.   答案： C' },
    { y: 620, text: '红领巾解析' },
    { y: 600, text: '观察题干……因此答案为 C 。' },
  ];
  const marks = computeFigureCrops(rows);
  assert.equal(marks.length, 0);
});
