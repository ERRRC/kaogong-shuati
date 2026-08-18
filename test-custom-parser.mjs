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
