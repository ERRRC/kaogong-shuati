# 智能组卷功能设计文档

> 版本：v1.0（2026-08）
> 适用范围：考公刷题 App（`fenbi-crawler/`，零依赖 Node.js + SQLite）
> 目标模块：公务员·行测 / 公务员·申论 / 事业编·职测 / 事业编·综应（四个模块分别添加）

---

## 1. 背景与目标

### 1.1 现状

- 题库：`tiku.db`（只读）2455 套试卷 / 96477 题；`practice.db` 持有 `question_categories` 知识点索引（subject → category 大模块 → sub 子模块）、`practice_records` 做题记录（含 `is_correct`、`chapter`）、`favorites` 收藏。
- 现有刷题入口：随机练习（`/api/practice`）、专项练习（知识点树 → `/api/practice?group=&sub=`）、整套刷卷（按试卷 ID）。**无任何组卷代码。**
- AI 智能体：`lib/ai-agents.mjs`，`ai-config.db` 热配置，OpenAI 兼容 `/chat/completions` 调用，已有"学习进度顾问"读取 `/api/records/stats` 生成学习建议的成功范式。

### 1.2 需求（已与用户确认）

1. **题型不可手动选取**——四个模块的题型在真实考试中固定，组卷按官方卷型结构内置模板。
2. **双模式**：手动规则组卷（选题量档位/难度/是否排除已做）+ AI 智能组卷（AI 读学情自动推荐配置）。
3. **即用即走**：生成的试卷不落库，直接进入刷题流程（与随机练习一致），可判分、交卷、进错题本。
4. 四个模块分别提供入口。

### 1.3 非目标（本期不做）

- 组卷结果保存/历史回顾（`custom_papers` 表本期不建）。
- 自定义题型/模块顺序（官方题序固定）。
- 多用户隔离（维持单用户游客模式）。

---

## 2. 官方卷型结构调研（组卷模板依据）

调研时间 2026-08，来源：中公教育（offcn.com）国考 2025/2026 考试解读、2026 事业单位联考大纲转载。

### 2.1 公务员·行测（国考，120 分钟 / 100 分）

2025 年起新增"政治理论"模块（从常识判断分离），总题量副省 135 / 市地 130 / 行政执法 130，唯一差异在数量关系。

| 模块（题序） | 副省级 | 市地/执法 | 本地题库（question_categories）存量 |
|---|---|---|---|
| 政治理论 | 20 | 20 | 1221 |
| 常识判断 | 15 | 15 | 7771 |
| 言语理解与表达 | 30 | 30 | 11638 |
| 数量关系 | 15 | **10** | 6053 |
| 判断推理 | 35 | 35 | 13195 |
| 资料分析 | 20 | 20 | 6453 |
| **合计** | **135** | **130** | 5.9 万+ |

### 2.2 公务员·申论（国考，180 分钟 / 100 分）

官方题型 5 题：归纳概括、综合分析、提出对策、贯彻执行（应用文）、文章写作。

本地树为综应风格分组，映射关系（弱对应，做成模板内映射文案，抽题仍以本地 category 为准）：

| 官方题型 | 本地 category | 存量 |
|---|---|---|
| 归纳概括 / 综合分析 | 案例分析题（单一题 / 综合题） | 1880 |
| 贯彻执行（应用文） | 公文写作题 | 1361 |
| 提出对策（近似） | 实务处理题 | 202 |
| 文章写作 | 无显式节点（公文写作→文章类弱对应） | — |

> 说明：申论/综应抽题以本地 `question_categories.category` 为准（保证抽得到），官方题型名仅作模板展示文案。

### 2.3 事业编·职测（联考 A 类，90 分钟 / 150 分）

| 模块（题序） | 官方题量 | 本地题库存量 |
|---|---|---|
| 常识判断 | 20 | 865 |
| 言语理解与表达 | 20 | 982 |
| 数量关系 | 10（数学运算 5 + 数字推理 5） | 492 |
| 判断推理 | 30 | 1451 |
| 资料分析 | 15 | 803 |
| **合计** | **95** | 4681 |

⚠️ 风险点：本地 `数量关系` 子树只有"数学运算"，**无"数字推理"节点**（官方职测每年 5 题）——组卷引擎需按大组兜底，抽不到数字推理时补数学运算。

### 2.4 事业编·综应（联考 A 类，120 分钟 / 150 分）

官方 4 题：材料分析（归纳概括+提出对策）、沟通协调、应用文写作。

| 官方题型 | 本地 category | 存量 |
|---|---|---|
| 材料分析 | 案例分析题 | 1441 |
| 沟通协调 | 实务处理题（谈话沟通/应急应变/活动组织） | 168 |
| 应用文写作 | 公文写作题 | 899 |

### 2.5 信息来源

- https://www.offcn.com/gjgwy/2025/1130/119140.html（2026 国考行测：总题量 135/130/130、政治理论 20）
- https://www.offcn.com/gjgwy/2025/1130/119142.html（2026 行测执法卷：130 题、六大模块）
- https://www.offcn.com/gjgwy/2025/1130/119149.html（申论五题型）
- https://www.offcn.com/gjgwy/kmhz/（考试时间：行测 120 分、申论 180 分）
- https://www.offcn.com/sydw/2025/1226/1095355.html（2026 联考大纲转载）

> 说明：行测模块细分题量（常识 15/言语 30/判断 35/资料 20）由"总题量 + 政治 20 + 三卷仅数量不同"反推；职测/综应逐模块数字为行业通行考情。模板按比例分配、**不写死绝对数**，用户可通过"总题量档位"调整，因此推算误差不影响可用性。

---

## 3. 总体架构

```
┌─ public/（前端 SPA）────────────────────────────┐
│ 科目页 renderSubject → "智能组卷"入口            │
│ renderQuizCompose(subject)                       │
│   ├─ 手动模式：档位/难度/排除已做 → POST compose │
│   └─ AI 模式：POST ai-plan → 展示推荐 → 确认生成 │
│ 生成结果注入 store.state → renderQuiz() 刷题      │
└──────────────┬───────────────────────────────────┘
               │ fetch /api/quiz/*
┌──────────────▼───────────────────────────────────┐
│ server.mjs（后端）                                │
│  PAPER_TEMPLATES（四模块固定卷型模板）            │
│  POST /api/quiz/compose → composeQuiz()           │
│     ├─ 配额计算（档位缩放、四舍五入、尾差补齐）   │
│     ├─ 分组抽取（复用 question_categories 索引）  │
│     │    ├─ 条件：sub + difficulty + 排除已做     │
│     │    └─ 兜底：放宽难度 → 放宽排除 → 大组补齐  │
│     └─ 整卷按官方题序 + enrichGroups 归组返回     │
│  POST /api/quiz/ai-plan → aiPlan()                │
│     ├─ paper-builder 智能体（lib/ai-agents.mjs）  │
│     ├─ JSON 严格校验（白名单）                    │
│     └─ 失败/超时 → 规则降级（薄弱模块加权）       │
└──────────────┬───────────────────────────────────┘
┌──────────────▼───────────────────────────────────┐
│ tiku.db（只读题库）  practice.db（索引+学情）     │
└──────────────────────────────────────────────────┘
```

设计原则：

- **零依赖**：沿用 `node:sqlite`，不引入新包。
- **复用优先**：抽样逻辑复用 `randomQuestions`（server.mjs:311）的取样防空洞与 questionId 去重思想；归组复用 `enrichGroups`（server.mjs:376）；输出复用 `toQuestion`（server.mjs:359）；前端刷题复用现有判分/交卷/错题上报全链路。
- **题库存量优先**：模板的"题型模块"直接使用本地 `question_categories.category`（保证抽得到题），官方题型名仅作展示文案。
- **AI 可降级**：AI 是"推荐层"不是"必经层"，任何失败都回落到规则算法。

---

## 4. 后端设计（server.mjs）

### 4.1 卷型模板 `PAPER_TEMPLATES`

```js
// 四模块固定卷型（题型模块 + 官方比例 + 展示文案），题型不可手动选
const PAPER_TEMPLATES = {
  '公务员·行测': {
    label: '国考行测（市地级 130 题）',
    // 官方标准总题量，档位以此为基准缩放
    standardTotal: 130,
    order: ['政治理论', '常识判断', '言语理解与表达', '数量关系', '判断推理', '资料分析'],
    groups: {
      '政治理论':            { count: 20, sub: null,        display: '政治理论' },
      '常识判断':            { count: 15, sub: null,        display: '常识判断' },
      '言语理解与表达':      { count: 30, sub: null,        display: '言语理解与表达' },
      '数量关系':            { count: 10, sub: null,        display: '数量关系' },
      '判断推理':            { count: 35, sub: null,        display: '判断推理' },
      '资料分析':            { count: 20, sub: null,        display: '资料分析' },
    },
    variants: { '副省 135 题': { standardTotal: 135, groups: { '数量关系': { count: 15 } } } }, // 可选变体，本期可只做默认
    timing: '120 分钟',
  },
  '公务员·申论': {
    label: '国考申论（5 题）',
    standardTotal: 5,
    order: ['案例分析题', '实务处理题', '公文写作题'],
    groups: {
      '案例分析题': { count: 2, sub: null, display: '归纳概括 · 综合分析（案例分析）' },
      '实务处理题': { count: 1, sub: null, display: '提出对策（实务处理）' },
      '公文写作题': { count: 2, sub: null, display: '贯彻执行 · 应用文（公文写作）' },
    },
    timing: '180 分钟',
  },
  '事业编·职测': {
    label: '联考 A 类职测（95 题）',
    standardTotal: 95,
    order: ['常识判断', '言语理解与表达', '数量关系', '判断推理', '资料分析'],
    groups: {
      '常识判断':       { count: 20, sub: null, display: '常识判断' },
      '言语理解与表达': { count: 20, sub: null, display: '言语理解与表达' },
      '数量关系':       { count: 10, sub: null, display: '数量关系（含数字推理，缺题时兜底数学运算）' },
      '判断推理':       { count: 30, sub: null, display: '判断推理' },
      '资料分析':       { count: 15, sub: null, display: '资料分析' },
    },
    timing: '90 分钟',
  },
  '事业编·综应': {
    label: '联考 A 类综应（4 题）',
    standardTotal: 4,
    order: ['案例分析题', '实务处理题', '公文写作题'],
    groups: {
      '案例分析题': { count: 2, sub: null, display: '材料分析（案例分析）' },
      '实务处理题': { count: 1, sub: null, display: '沟通协调（实务处理）' },
      '公文写作题': { count: 1, sub: null, display: '应用文写作（公文写作）' },
    },
    timing: '120 分钟',
  },
};
```

要点：

- `standardTotal` 为官方标准题量；用户选"档位"：`standard`（标准卷）/ `half`（半套，≈50%）/ `custom`（自定义总数）。
- 题量分配 = 官方比例 × 目标总数，**四舍五入**；因舍入产生的尾差在**题量最大的模块**上补齐（保证总数精确）。
- `sub: null` 表示按大模块（category）抽题不分子模块；AI 推荐可下发 `sub` 覆盖（如"数量关系·数学运算"）。
- 申论/综应模板用本地 category 作抽题键，`display` 字段展示官方题型名。

### 4.2 `POST /api/quiz/compose` — 手动组卷

请求：

```json
{
  "subject": "公务员·行测",
  "level": "standard",            // standard | half | custom
  "total": 130,                   // level=custom 时必填，1~500
  "difficulty": "any",            // any | easy | medium | hard（映射 difficulty<=2 / 3 / >=4，可调）
  "excludeDone": true,            // 排除已做过的题（默认 true）
  "mock": null,                   // 可选：'0' 真题 / '1' 模拟题 / null 不限（沿用现有 mockCond 语义）
  "groups": null                  // 可选 AI/高级覆盖：[{category, sub?, count}]，校验后使用
}
```

处理流程 `composeQuiz(req)`：

1. **模板解析**：`PAPER_TEMPLATES[subject]` 不存在 → 400；计算各 category 目标题量（档位缩放 + 尾差补齐）。
2. **配额校验**：每 category 先查存量（`question_categories` 中 category+subject 且 EXISTS tiku.questions）；目标 > 存量时**按存量截断**并在响应 `warnings` 中提示（如"实务处理题仅 168 题，已按存量出题"）。
3. **分组抽取**（核心函数 `pickByCategory(subject, category, sub, n, opts)`）：

```js
function pickByCategory(subject, category, sub, n, { difficulty, excludeDone, mock }) {
  const conds = ['qc.category = ?', 'qc.subject = ?', 'EXISTS (SELECT 1 FROM tiku.questions q WHERE q.questionId = qc.question_id)'];
  const params = [category, subject];
  if (sub && sub !== '全部') { conds.push('qc.sub = ?'); params.push(sub); }
  if (difficulty !== 'any') {
    conds.push(`q.difficulty ${difficulty === 'easy' ? '<= 2' : difficulty === 'hard' ? '>= 4' : '= 3'}`);
    // 注意：difficulty 条件需联 tiku.questions，走 q 表而非 qc 表
  }
  if (excludeDone) conds.push('NOT EXISTS (SELECT 1 FROM practice_records pr WHERE pr.question_id = qc.question_id AND pr.archived = 0)');
  if (mock === '0' || mock === '1') conds.push(`EXISTS (SELECT 1 FROM tiku.papers p JOIN tiku.questions tq ON tq.paperId = p.id WHERE tq.questionId = qc.question_id AND p.name LIKE ${mock === '0' ? "'%真题%'" : "'%模拟%'"} )`);
  // 实际实现按 randomQuestions 的取样策略防空洞：先 LIMIT n*4 取样再打乱取 n，questionId 去重
  return ids;
}
```

   抽取优先级（同 category 内）：`sub 精确匹配 + 难度 + 排除已做` → 抽不满时**逐级放宽**：
   1. 放宽难度（any）；
   2. 放宽排除已做；
   3. 放宽 sub（回落到 category 大组）；
   4. 仍不足 → 该组按可得数量出，记入 `warnings`。
   每级放宽都是**先查后抽**（`SELECT COUNT(*)` 预检），避免无效 SQL 往返。

4. **整卷组装**：按 `template.order` 的官方题序拼接各组题目；行测/职测直接平铺，申论/综应对结果整体过 `enrichGroups(qs, subject)`（材料题自动归组，组内连续）。
5. **响应**：

```json
{
  "ok": true,
  "subject": "公务员·行测",
  "template": "国考行测（市地级 130 题）",
  "level": "standard",
  "difficulty": "any",
  "total": 130,
  "groups": [ { "category": "政治理论", "count": 20, "actual": 20 } ],
  "warnings": ["数量关系 目标 10 题，实际出 10 题（数字推理无题源，已补数学运算）"],
  "questions": [ /* toQuestion 输出结构，官方题序 */ ]
}
```

> `groups` 覆盖（`groups` 参数）仅供 AI 模式复用同一端点：AI 推荐配置 → 前端调 compose 带 `groups`，配额计算直接用 groups 的 count 而非模板缩放。

### 4.3 `POST /api/quiz/ai-plan` — AI 推荐组卷配置

请求：

```json
{ "subject": "公务员·行测", "level": "standard" }
```

处理流程 `aiPlan(subject, level)`：

1. 拉学情：`/api/records/stats` 同款 SQL（`byChapter` 各模块正确率/做题量 + 近 7 天趋势），只取该 subject 数据；无记录时直接返回规则版（见第 3 步）。
2. 调 `paper-builder` 智能体：`callAgent(agent, userContent)`，userContent 为学情 JSON + 模板 JSON + 存量 JSON，要求返回**纯 JSON**：
   ```json
   {
     "reason": "判断推理正确率仅 42%（共做 86 题），建议加大题量并下调难度；政治理论未做过，建议补基础题。",
     "difficulty": "medium",
     "excludeDone": true,
     "groups": [ { "category": "判断推理", "sub": null, "count": 45 },
                 { "category": "政治理论", "sub": "时事政治", "count": 25 },
                 { "category": "言语理解与表达", "sub": null, "count": 30 },
                 { "category": "常识判断", "sub": null, "count": 15 },
                 { "category": "数量关系", "sub": null, "count": 10 },
                 { "category": "资料分析", "sub": null, "count": 20 } ]
   }
   ```
3. **严格校验**（`validateAiPlan(plan, template)`）：
   - 必须是合法 JSON（解析失败 → 降级）；`groups` 每项 category 必须在模板 order 内、sub 必须在题库真实存在（白名单校验，防注入）；
   - 各 count 求和与目标总数偏差 > 10% → 按比例归一化；
   - 每 category count 超过存量 → 截断 + warning；
   - AI 未覆盖的 category → 用模板比例补。
4. **降级策略**（AI 失败/超时/校验不过，或用户无学习记录）：
   - `rulePlan(subject, level)`：官方模板比例 × 学情加权——薄弱模块（正确率 < 50% 且做题量 >= 10）题量上浮 20%，从未做过的模块保底 10%；无记录时 = 纯官方模板比例。降级响应附 `ai: "unavailable"` 与原因，前端提示"AI 暂不可用，已用规则推荐"。

响应：

```json
{
  "ok": true,
  "ai": true,                    // 或 "unavailable" + reason
  "reason": "…推荐理由（AI 生成或规则文案）",
  "level": "standard",
  "difficulty": "medium",
  "excludeDone": true,
  "groups": [ { "category": "判断推理", "sub": null, "count": 45 } ],
  "total": 130
}
```

> 前端拿到该响应后，把 `difficulty/excludeDone/groups` 回填 compose 请求，**compose 是唯一出题入口**，AI 与手动共用，逻辑单一。

---

## 5. AI 智能体设计（lib/ai-agents.mjs）

### 5.1 新增角色 `paper-builder`

在 `DEFAULT_AGENTS` 数组追加（参照现有 `progress-coach` 写法，`initAiConfig` 启动时自动建行，可热更新）：

```js
{
  id: 'paper-builder',
  role: 'paper-builder',
  name: '智能组卷顾问',
  description: '基于学习进度与薄弱模块，生成行测/申论/职测/综应的个性化组卷方案',
  system_prompt: `你是考公刷题 App 的智能组卷顾问。用户会给你：①该科目的官方卷型模板（题型模块与比例）；②题库各模块存量；③用户学习统计（各模块做题量与正确率）。
你的任务：为一份新练习卷设计"组卷配置"，必须遵守：
1. 题型模块只能从模板中出现，不可新增/删除模块，也不可改变官方题序；
2. 总题量 = 用户要求的 targetTotal，各模块题量之和必须精确等于它；
3. 优先加权：正确率低于 50% 且做题量 >= 10 的模块多配题、可下调难度；从未做过的模块保底少量基础题；已熟练模块（正确率 >= 80% 且做题量 >= 30）适当减量；
4. 每模块题量不得超过题库存量；
5. 只输出一个 JSON 对象，不要输出任何其他文字，格式：{"reason":"中文推荐理由","difficulty":"any|easy|medium|hard","excludeDone":true,"groups":[{"category":"模块名","sub":"子模块名或null","count":数字}]}`,
  skill: 'quiz-plan',
  base_url: '', api_key: '', model: '', // 沿用默认网关配置（同其他智能体）
  temperature: 0.3, max_tokens: 1024, enabled: true, reasoning_effort: 'low',
}
```

### 5.2 安全与降级

- `groups[].category` / `sub` 全量白名单校验（模板 order + 题库真实节点），非法值直接丢弃并降级对应项。
- 120s 超时、网络失败、非 JSON 输出 → `rulePlan` 降级，前端可见提示。
- 与现有智能体共用 `opencode.ai/zen` 网关与 api_key，不在客户端暴露 key。

---

## 6. 前端设计（public/app.js + index.html + style.css）

### 6.1 入口

- `renderSubject(subject)`（app.js:319）顶部新增"智能组卷"入口卡片（图标 + 文案"按考试标准题型组一套卷，AI 可结合你的错题情况推荐"），四个模块科目页共用同一组件，无需为每模块写独立代码。

### 6.2 组卷视图 `renderQuizCompose(subject)`

1. **模式 Tab**：`手动组卷` / `AI 智能组卷`（默认 AI，有学习记录时优先展示推荐）。
2. **手动模式表单**：
   - 题量档位：`标准卷（如 130 题）` / `半套` / `自定义总数（输入 1–500）`；
   - 难度：不限 / 简单 / 中等 / 困难；
   - 排除已做：开关（默认开）；
   - 卷型说明卡：按 `PAPER_TEMPLATES` 展示官方结构（模块 + 题量，**只读**），申论/综应显示官方题型映射文案。
3. **AI 模式**：进入即调 `POST /api/quiz/ai-plan`；加载态展示 spinner；返回后展示推荐卡片——各模块题量分配条形图（纯 CSS 宽度条）+ 推荐理由文本 + "按此生成"按钮；降级时灰显"AI 暂不可用，已用规则推荐"。
4. **生成**：调 `POST /api/quiz/compose`（手动带表单参数；AI 带 ai-plan 返回的 groups/difficulty/excludeDone）→ 成功后进入刷题（见 6.3）；`warnings` 以 toast 展示。
5. 页面均适配深色模式（沿用现有 CSS 变量）与移动端（≤430px 表单单列）。

### 6.3 刷题复用（关键改动最小化）

新增 `renderQuiz(subject, questions, title)`：**复制 `renderPractice`（app.js:561）中初始化段**（塞 `store.state.questions/idx/results/answers/mode/subject`、`stopTimer/startTimer`、`renderQuestion()`），但不发 `/api/practice` 请求——题目由 compose 接口直接给出。判分 `judge()`、`submitAnswer`、交卷、错题上报（`recordAnswer`）全链路零改动，即用即走。

> 现有 `renderPractice` 保持不动，避免回归整套刷卷/随机练习。

---

## 7. 本地离线模式（public/local-handler.mjs）

- App 支持 `window.__LOCAL_API_PROMISE__` 离线模式（sqljs-engine.mjs 本地查询）。`api()`（app.js:12）对新增端点会自动走本地 handler，因此需同步实现：
  - `/api/quiz/compose`：用 sqljs 在本地 tiku 副本上执行同款 SQL（`question_categories` 索引在 practice.db，需确认本地模式已含该表；若未含，退化为按 `chapter` 匹配 category 名）。
  - `/api/quiz/ai-plan`：**不调 AI**，直接返回 `rulePlan` 降级结果（离线无网络）。
- 离线模式不强制本期完成：先做 compose，ai-plan 降级兜底即可。

---

## 8. 测试计划（npm test 扩展）

| 测试 | 内容 | 归属 |
|---|---|---|
| 模板可抽取性校验 | 四模板每 category 存量 >= 官方题量（按标准档），不足项列出（预期：申论实务处理 202 题 < 标准档时允许半套档达标） | `verify-db.mjs` 扩展 |
| compose 冒烟 | 起 server 调 `POST /api/quiz/compose` ×4 科目：standard / half / custom / difficulty / excludeDone 各组合，断言：total 精确、题序符合模板 order、无重复 questionId、排除已做生效（用 `practice_records` 造数据验证） | `e2e-check.mjs` 扩展或新 `test-compose.mjs` |
| groups 覆盖 | 带 `groups` 参数调用，校验 count 归一化与 category 白名单 | 同上 |
| ai-plan 校验器 | 单测 `validateAiPlan`：合法 JSON / 非法 category / count 超存量 / 总和偏差 → 各分支行为 | 新 `test-aiplan.mjs`（纯函数，不调外部 AI） |
| 本地 handler | 离线 compose 返回与在线一致（题目 id 集合一致） | e2e 扩展 |
| 回归 | `npm test` 原有 verify-db + e2e-check 全绿 | — |

---

## 9. 边界情况与风险

| 风险 | 应对 |
|---|---|
| 职测"数字推理"无题源（官方每年 5 题） | 抽取时 sub 精确匹配失败 → 放宽到大组"数量关系"补数学运算，warning 提示 |
| 申论实务处理仅 202 题、综应实务处理 168 题，标准档 + 排除已做可能不足 | 存量截断 + 逐级放宽（先难度→再排除已做）；AI plan 校验同样截断 |
| 政治理论（职测仅 88 题）档位缩放后可能不足 | 同上兜底 |
| 主观题（申论/综应）无标准答案 | 与现有刷题一致：`answerIndex=-1` 不判分，交卷走 AI 批改，组卷不额外处理 |
| 同一 questionId 跨卷重复 | 抽取复用 `randomQuestions` 的 questionId 去重 |
| 排除已做使组卷变慢 | 每级放宽前先 `COUNT(*)` 预检，仅一次 NOT EXISTS 联表 |
| 本地离线无 question_categories | 退化按 chapter 名匹配，文档标注 |
| 真题/模拟过滤（mock）在 `papers.name` 上的匹配不可靠 | 本期默认 `mock: null` 不限；接口保留参数，后续按粉笔 exerciseId 语义精修 |

---

## 10. 实施里程碑

1. **M1 后端组卷引擎**：`PAPER_TEMPLATES` + `pickByCategory` + `composeQuiz` + `/api/quiz/compose` 路由 + verify-db 模板校验 + compose 冒烟测试。
2. **M2 AI 推荐层**：`paper-builder` 智能体 + `aiPlan` + `validateAiPlan` + `rulePlan` 降级 + `test-aiplan.mjs`。
3. **M3 前端**：科目页入口卡片 + `renderQuizCompose`（手动/AI 双模式 UI）+ `renderQuiz` 刷题复用 + 深色/移动端适配 + 本地 handler 同步。
4. **M4 收尾**：npm test 全绿、README/交付说明更新、四科目真机截图核验。

---

## 附录 A：与现有代码的复用/改动清单

| 文件 | 改动 | 说明 |
|---|---|---|
| `server.mjs` | 新增模板常量 + 2 个路由 + `pickByCategory`/`composeQuiz`/`aiPlan`/`rulePlan`/`validateAiPlan` | 复用 `randomQuestions` 取样策略、`enrichGroups`、`toQuestion`、`mockCond`、`/api/records/stats` 的 SQL 模式 |
| `lib/ai-agents.mjs` | `DEFAULT_AGENTS` 追加 `paper-builder` | 复用 `callAgent`/`initAiConfig`，ai-config.db 自动建行可热更新 |
| `public/app.js` | `renderQuizCompose` + `renderQuiz` + 入口卡片渲染 | `renderPractice` 不动 |
| `public/index.html` / `style.css` | 组卷视图容器/表单/条形图/深色变量 | 沿用现有设计体系 |
| `public/local-handler.mjs` | compose 本地实现；ai-plan 降级 | 离线可用 |
| `verify-db.mjs` / `e2e-check.mjs`（或新测试文件） | 模板校验 + compose/ai-plan 测试 | npm test 覆盖 |
| `package.json` | （无依赖变更） | 零依赖保持 |

## 附录 B：未决事项（需用户确认）

1. 行测模板默认取"市地级 130 题"，是否需要在 UI 提供"副省 135 题"切换（数量关系 10→15）？
2. 申论/综应的组卷题量档位：标准档按官方 5 题 / 4 题（题太少，半套=2 题可能没有区分度），是否需要"加量档"（如标准×2）？
3. 排除已做默认开启，是否与"整套刷卷"行为保持一致（默认包含已做）？
