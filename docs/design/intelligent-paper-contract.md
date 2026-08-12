# 智能组卷 · 接口契约 + UI 规范（v1 草案）

> 适用项目：考公刷题（fenbi-crawler）· http://localhost:3000
> 文档读者：① 四个题库 AI（只实现「数据源接口」，见 §4.2）；② 前端/网关接入方（我）；③ 项目维护者。
> 核心原则：**UI 只有一份（由主开发统一做），四个题库 AI 只交付「逻辑 + 数据」，严禁各自发明界面。**

---

## 1. 目标与分工

**智能组卷**：用户选好科目、题量、题型、难度偏好后，系统从四个题库分别抽取题目，聚合成一张完整试卷，进入现有做题流程（答题卡 / 交卷 / 解析 / AI 批改全部复用）。

| 角色 | 职责 | 交付物 |
|---|---|---|
| 题库 AI ×4 | 每个 AI 负责**一个题库**的取题逻辑：按参数抽题、保证题面完整（含材料组）、返回统一 JSON | 实现 §4.2 的源接口，自测通过 |
| 组卷网关（server.mjs） | 聚合 4 个源：调源接口 → 合并 → 去重 → 打乱/排序 → 补全材料 → 返回试卷 | 新增 `POST /api/paper/generate` |
| 前端（app.js / style.css） | **唯一 UI**：组卷配置页 / 生成中状态 / 试卷预览 / 一键进入做题 | 新增组卷视图，复用现有设计系统 |

**禁止**：四个 AI 不输出任何 HTML/CSS/图标/页面；只输出 JSON 数据与算法说明。

---

## 2. 总体架构

```
用户（浏览器 SPA）
   │  POST /api/paper/generate
   ▼
组卷网关（server.mjs，本仓库）
   │  GET /v1/questions?subject=…&count=…&…（4 路并发）
   ├──► 题库 A 源（AI-A 实现）
   ├──► 题库 B 源（AI-B 实现）
   ├──► 题库 C 源（AI-C 实现）
   └──► 题库 D 源（AI-D 实现）
   │  合并 → 去重(q.id) → 整组保留(材料题) → 打乱
   ▼
前端做题流程（答题卡/交卷/解析/AI 批改，全部复用现有代码）
```

---

## 3. 核心数据结构：题目对象 Schema（全链路唯一）

**所有源接口返回的每一道题，必须严格符合此结构**（与 `/api/practice` 现有返回、前端 `renderQuestion` 完全兼容）：

```jsonc
{
  "id": "1243521",            // string，全局唯一（本库内唯一即可，网关会跨源去重）
  "paperId": "79512",         // string，来源试卷 ID（组卷卷统一用 "smart-<时间戳>" 也行）
  "chapter": "判断推理-逻辑判断", // string，模块/章节名（显示用）
  "type": 1,                  // number，题型编码：1单选 2多选 3判断 5判断 21申论 24/25/26综合
  "content": "下列……",         // string，题干纯文本
  "contentHtml": "<p>…</p>",  // string，题干富文本（可含 <img>/<math>），无则 ""
  "options": [                // array，选项数组（判断题可返回空，前端自动补“正确/错误”）
    { "key": "A", "text": "……" }
  ],
  "answer": "1",              // string，标准答案：单选="0"，多选="[0,1,3]"，判断="0"
  "answerIndex": 1,           // number，单选/判断题的答案下标；多选可为 null
  "difficulty": 5,            // number，1(最易)~9(最难)，数据源实际分布 1-9
  "material": "",             // string，材料题的材料文本；无材料题必须为 ""（不要省略字段）
  "groupTotal": 3,            // number，该材料题组小题总数；非材料题 = 1
  "groupIndex": 0             // number，本小题在组内序号（0 起）；非材料题 = 0
}
```

**材料题硬性规则（网关会校验，校验不过的源会被记为失败）**：
- 若题目属于材料/申论大题组，**必须返回整组全部小题**（同 `groupTotal` 计数、同 `material`），不得只返回其中一小问；
- 整组共享同一 `material`；组内 `groupIndex` 从 0 连续递增；
- 前端按 `groupIndex/groupTotal` 渲染「第 x/y 小问」，与现有刷题一致。

---

## 4. 接口契约

### 4.1 组卷网关：`POST /api/paper/generate`

**请求体（前端 → 网关）**：

```jsonc
{
  "subject": "公务员·行测",       // 科目，枚举同 /api/subjects 四值之一
  "count": 20,                   // 目标总题量（网关按源均摊，源各自尽量接近 count/4）
  "types": [1, 3],               // 可选，题型白名单（留空 = 不限）
  "difficulty": { "min": 3, "max": 6 },  // 可选，难度区间（1-9；留空 = 不限）
  "chapters": ["言语理解", "判断推理"],  // 可选，模块白名单（留空 = 不限）
  "weak": ["逻辑判断"],           // 可选，薄弱模块提示（智能组卷加权依据，可空）
  "perSource": {}                // 可选，按源覆写参数，形如 { "tikuA": { "count": 10 } }
}
```

**响应（网关 → 前端）**：

```jsonc
// 成功
{
  "ok": true,
  "title": "智能组卷 · 公务员行测 20题",   // 网关生成，前端直接显示
  "questions": [ /* 见 §3，已合并去重打乱 */ ],
  "summary": {
    "total": 20,
    "sourceCounts": { "tikuA": 5, "tikuB": 5, "tikuC": 5, "tikuD": 5 },
    "failedSources": []           // 失败的源列表（如 ["tikuC"]）
  }
}

// 部分成功（仍有题可用）
{ "ok": true, "notice": "题库C暂时无题，已从其他题库补齐", "questions": [...], "summary": {...} }

// 失败
{ "ok": false, "error": "四个题库均未能出题，请稍后重试" }
```

**网关行为约定**：
- 4 路并发请求源接口；单个源超时上限 15s；
- 跨源按 `q.id` 去重（后到者丢弃）；材料题整组去重；
- 合并后按 `subject` 默认模块顺序尽量摊匀打乱（**非纯随机**，同模块不连串 >4 题）；
- 任一台源失败 → 用其他源按比例补齐；全部失败 → `ok:false`。

### 4.2 题库源接口：`GET /v1/questions`（四个 AI 各自实现）

**每个 AI 部署一个 HTTP 服务，实现同一规范**（可用任意语言/框架；本地联调跑在独立端口）：

```
GET /v1/questions?subject=公务员·行测&count=5&types=1,3&difficulty_min=3&difficulty_max=6&chapters=言语理解,判断推理&weak=逻辑判断&seed=abc123
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `subject` | 是 | 科目名（四枚举之一；该源没有此科目数据时返回 `ok:false, error:"该题库暂无此科目"`） |
| `count` | 是 | 期望题量（尽力而为，允许 ±2 浮动） |
| `types` | 否 | 逗号分隔题型编码白名单 |
| `difficulty_min/max` | 否 | 难度区间 1-9 |
| `chapters` | 否 | 逗号分隔模块白名单 |
| `weak` | 否 | 薄弱模块，可提高其抽样权重 |
| `seed` | 否 | 随机种子，便于复现与去重联调 |

**响应**：

```jsonc
// 成功
{ "ok": true, "source": "tikuA", "questions": [ /* §3 schema */ ] }

// 部分成功（带 notice，网关会照单全收）
{ "ok": true, "source": "tikuA", "notice": "仅有4题满足条件", "questions": [...] }

// 失败（error 必须是一句话人话，会透传给用户）
{ "ok": false, "source": "tikuA", "error": "该题库暂无此科目" }
```

**AI 实现要点（务必遵守）**：
1. **先查库/源数据里到底有哪些 `subject`、`type`、`difficulty`、`chapter` 取值**，参数匹配用你库里的真实值，不要凭空枚举；
2. 抽题优先命中 `difficulty_min/max` 区间；区间外宁缺毋滥，用 `notice` 说明；
3. 材料题**整组返回**（见 §3），组题按 `count` 计入组内小题总数；
4. 输出字段名**一个都不能少**：`id/paperId/chapter/type/content/contentHtml/options/answer/answerIndex/difficulty/material/groupTotal/groupIndex`；
5. 自测清单见 §7。

### 4.3 错误与状态约定（全链路统一）

- 成功/部分成功永远带 `ok:true`；失败永远 `ok:false` + `error`（一句话）；
- 网络层错误（404/500/超时）由网关兜底转成 `ok:false` 的源失败项，不抛给前端；
- 前端只认 `ok` 与 `error`/`notice`，其余字段一律忽略。

---

## 5. UI 规范（只读约束，UI 由主开发统一实现）

> 四个题库 AI 看到本节即止——**不要**据此写任何页面。本节约束的是「我」做组卷 UI 时必须遵守的现有设计系统，防止新页面破坏全站风格统一。

### 5.1 设计 Token（现有全局变量，直接用，不新增）

浅色：

```css
--bg:#faf5ff; --bg-soft:#f1eafc; --card:#ffffff; --card-2:#f8f3fe;
--text:#4c1d95; --text-2:#6d5a9e; --text-3:#9b8abb; --muted:#9b8abb;
--primary:#8b5cf6; --primary-strong:#7c3aed; --primary-soft:rgba(139,92,246,.1); --primary-glow:rgba(139,92,246,.26);
--accent:#059669; --border:#ede9fe; --border-strong:#ddd6fe;
--green:#059669; --green-soft:rgba(5,150,105,.1);
--red:#dc2626; --red-soft:rgba(220,38,38,.1);
--amber:#d97706; --amber-soft:rgba(217,119,6,.12);
--radius:12px; --radius-sm:9px; --shadow:0 1px 2px rgba(76,29,149,.05),0 6px 20px rgba(76,29,149,.07);
```

深色（`.dark` / 跟随系统）：

```css
--bg:#17122b; --bg-soft:#1e1836; --card:#221b3f; --card-2:#282052;
--text:#ede9fe; --text-2:#b6a9d8; --text-3:#8b7faf; --muted:#8b7faf;
--primary:#a78bfa; --primary-strong:#c4b5fd; --primary-soft:rgba(167,139,250,.15); --primary-glow:rgba(167,139,250,.3);
--accent:#34d399; --border:#312a56; --border-strong:#453c70;
--green:#34d399; --green-soft:rgba(52,211,153,.15);
--red:#f87171; --red-soft:rgba(248,113,113,.15);
--amber:#fbbf24; --amber-soft:rgba(251,191,36,.15);
/* radius/shadow/topbar-h/nav-h/safe-bottom 与浅色一致（shadow 深色更深） */
```

渐变图标底色（现状已存在，白描边图标 + 柔和阴影）：

```css
.tint-violet  { background: linear-gradient(135deg,#a78bfa,#7c3aed); }
.tint-green   { background: linear-gradient(135deg,#34d399,#059669); }
.tint-orange  { background: linear-gradient(135deg,#fbbf24,#ea580c); }
.tint-blue    { background: linear-gradient(135deg,#60a5fa,#2563eb); }
```

### 5.2 字体

- 标题：Varela Round；正文：Nunito Sans（现有引入，继续用，不换）。

### 5.3 图标：只用 `ico()` 图标库（app.js 顶部 `ICO`，37 个线性描边 SVG）

组卷页面推荐复用（**以下键名均已在 `ICO` 中存在**）：`target`（组卷入口）、`dice`（随机/组卷）、`zap`（智能生成）、`chart`（难度/统计）、`fileText`（题量/清单）、`checkCircle`/`xCircle`（成功/失败）、`trash`（清空）、`clock`（时长）、`star`（收藏）、`grid`（答题卡）、`sparkles`（AI 智能）、`pen`（主观题）、`trendingUp`（学习进度）。
**禁止**：emoji、第三方图标库、新画 SVG 路径（除确有语义需要外）、引用 `ICO` 中不存在的键（`sliders/settings/list/check/x` 等均无）。

### 5.4 组件类白名单（全部已有，直接复用）

```
.card / .card-sub        卡片与子区块
.btn / .btn-primary / .btn-ghost / .btn-block / .btn-sm   按钮
.tag-chapter / .tag-type / .tag-difficulty   题目标签
.li-tip                  提示行（AI 批改/智能提示用）
.empty / .empty-ico      空状态
.sheet-overlay / .sheet / .sheet-head / .sheet-close   底部弹层（配置面板用）
.stat-row / .stat-card   统计块（预览页用）
.option / .opt-key       选项渲染（预览页若展开题目）
.quick-grid / .quick-item   宫格入口（组卷入口卡沿用）
.timer-bar / .q-progress-bar  做题页计时/进度（预览后进入做题完全复用）
```

### 5.5 组卷 UI 页面结构（我实现时的落地模板）

1. **入口**：首页快捷宫格新增「智能组卷」项，`tint-blue` 渐变 + `ico('target')`，label「智能组卷」；
2. **配置弹层**（`sheet-overlay`）：
   - 科目：四枚举单选（默认当前所选科目）；
   - 题量：步进器（10/15/20/25/30/40，默认 20）；
   - 题型：chips 多选（单选/多选/判断，默认全选；申论科目默认 21/综合）；
   - 难度：`min-max` 双端简化版（用「简单/适中/偏难」三档映射 1-3/3-6/6-9，默认适中）；
   - 模块（可选）：chips 多选，留空 = 不限；
   - 生成按钮：`btn btn-primary btn-block` + `ico('zap')`「智能生成」；
3. **生成中**：按钮内联 spinner（现有 `btn` disabled 态），顶部提示「正在从 4 个题库组卷…」；
4. **预览页**（新视图，风格同成绩页）：标题 + 统计条（`stat-row`：总题量/难度区间/来源分布）+ 题目编号列表（点击可 `sheet` 展开看题）+ `btn btn-primary btn-block`「开始做题」；
5. **开始做题**：把 `questions` 灌入现有 `store`（`mode:'quiz'`，与 `/api/practice` 完全同构），答题卡/交卷/解析/AI 批改零改动复用。

### 5.6 禁止事项（防风格回归）

- 不新增 CSS 变量（全量 token 见 §5.1，浅/深两套；如需新变量先确认无对应再议）、不引入新字体、不写任何 `#xxx` 硬编码色（一律用 `var(--…)`）；
- 不用 emoji 当图标（现有库已清干净，新页面不得带回）；
- 不新建与白名单重复语义的类名（如再写一个 `.btn2`）；
- 深色模式必须同时验证（跟随系统 + 手动切换）。

---

## 6. 接入主流程（前端消费）

```js
const res = await api('/api/paper/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(params),
});
if (!res.ok) return toast(res.error);
if (res.notice) toast(res.notice);
enterQuiz(res.questions, params.subject, res.title);  // 占位函数名，见下方说明
```

- **没有 `startQuiz` 函数**。现有入口是 `renderPractice(subject, chapter, paperId, mock, …)`（app.js:561），它内部请求 `/api/practice` 后把题目写入 `store.state.questions/idx/answers/results` 并渲染做题视图。
- **接入方式（我实现时）**：把 `renderPractice` 中「请求 → 写 store → 渲染做题视图」拆出一段公共初始化 `enterQuiz(questions, subject, title)`（同 `mode:'quiz'`，含答题卡/计时/交卷逻辑），组卷成功后直接 `enterQuiz(res.questions, params.subject, res.title)`——不发起第二次网络请求；
- 组卷卷标题显示在答题页顶部（`$('#app-title')`，参照 app.js:567 的 `mockTag` 拼接方式），交卷成绩页同现有逻辑。

---

## 7. 验收清单

**四个题库 AI 各自自测（交付前必须全过）**：
- [ ] `GET /v1/questions` 返回体 JSON 合法，`ok/error/notice` 语义正确；
- [ ] 每道题 14 个字段齐全，`type/difficulty/answer/answerIndex` 类型正确；
- [ ] 参数过滤生效：`difficulty_min/max`、`types`、`chapters` 与源内真实取值一致；
- [ ] 材料题整组返回，`groupTotal/groupIndex/material` 三字段一致；
- [ ] 无满足条件题目时返回 `ok:false + error`（一句话人话）；
- [ ] `count` 与返回题量偏差 ≤2。

**网关 + 前端（我验收）**：
- [ ] `node --check server.mjs` / `node --check app.js` 通过；
- [ ] 4 路并发 + 单源超时/失败降级路径有日志；
- [ ] 组卷全流程（配置 → 生成 → 预览 → 做题 → 交卷 → 解析）桌面/移动、深/浅色截图比对无风格回归；
- [ ] 0 emoji 残留、0 控制台报错。

---

## 8. 实现记录（2026-08-11，主开发回写）

**状态**：网关 + 前端 + 本地离线模式均已落地并通过验收（`npm test` 全绿、API 冒烟、浏览器端到端）。科目支持：公务员·行测、事业编·职测。

### 8.1 考情（组卷模板依据）

**行测（市地/执法为基准）**
- 考试：120 分钟 / 满分 100 / 全单选；市地级 130 题、副省 135 题（数量关系 15）。
- 官方模块序与题量（`server.mjs` 的 `XINGCE_TEMPLATE`）：政治理论 20 → 常识判断 15 → 言语理解与表达 30 → 数量关系 10 → 判断推理 35 → 资料分析 20。
- 判断推理构成：图形 9 / 定义 9 / 类比 9 / 逻辑 8（市地逻辑含"一拖五"材料组，组卷时源内逻辑配额 ≥5 会带 1 组材料题 + 单题补齐）。
- 资料分析为材料组题（每组 5 小题，组内难度/章节有容错），组卷整组抽取、整组入卷。

**职测（联考 A/B/C 类 + 山东；2025 版大纲：90 分钟 / 满分 150，2026 年起改 100）**
- 题库仅 4 类卷型（tiku.db 实测）：联考A类 14 套 / 联考B类 22 套 / 联考C类 22 套 / 山东 15 套（每类均约 100 题/套，山东 90 题/套）。
- 官方模块构成（通行口径 ∩ 题库实测，`server.mjs` 的 `ZHI_CE_TEMPLATES`）：
  - 联考A类（100 题）：常识判断 20 / 言语理解与表达 20 / 数量关系 10 / 判断推理 35 / 资料分析 15；
  - 联考B类（100 题）：常识判断 20 / 言语理解与表达 25 / 数量分析 15（数学运算 5 + 资料分析 10）/ 判断推理 30 / 综合分析 10（篇章阅读，近似归片段阅读）；
  - 联考C类（100 题）：常识判断 20 / 言语理解与表达 25 / 数量分析 10（数学运算 5 + 资料分析 5）/ 判断推理 30 / 综合分析 15（数学方法/策略制定/实验设计，近似归数运+资料）；
  - 山东（90 题）：常识判断 15（含政治理论并入）/ 言语理解与表达 20 / 数量关系 5 / 判断推理 35 / 资料分析 15。
- 职测 B/C 类的资料组题章节名为"数量分析"（非"资料分析"）→ 资料组抽使用多章节匹配 `['%资料%', '%数量分析%']`。
- 职测"四源"= 四类卷型：所选类别为主源，其他类别为兜底（题不足时补齐）；`sourceCounts` 按四卷型统计，`failedSources` 仅报告主源失败。

### 8.2 与契约 v1 草案的差异（以代码为准）

| 契约项 | 实际落地 |
|---|---|
| 四个 AI 题库源（§2/§4.2） | 落地为本地题库四类卷型源：`tikuA`国考 / `tikuB`联考省考 / `tikuC`独立命题(江浙粤鲁京津沪深广) / `tikuD`选调·政法；每模块配额按源均摊（largest remainder），跨源按 `questionId` 去重；源 0 题计入 `failedSources` 并在 `notice` 说明。**不实现** `GET /v1/questions` 单源接口 |
| `summary` 嵌套（§4.1） | 平铺返回：`total / durationMinutes / difficulty / sourceCounts / failedSources / notice` |
| 题量偏差 ≤2（§7） | 普通模块精确等于配额；资料分析整组抽取（标准 5 题，容错 3-6）导致偏差 ≤6，超过时 `notice` 提示 |
| `types` 默认 | 行测默认 `[1]`（官方全单选） |
| 弱项 `weak[]` | 模块配额 +30%（从其余模块按比例扣回），且该模块抽题优先未做过的题（`practice_records` 排除，不足回退） |
| 前端自动检测弱项 | 生成时读取 `/api/records/stats.byChapter`，取"做过 ≥5 题且正确率最低"的模块作为 `weak` 传入（开关可关） |
| 题目 Schema | 每题的 `chapter` 为粉笔原始章节名（各省命名不统一，如"言语理解与表达能力""数理能力"）；组卷响应额外附 `module`（规范模块名），预览页按 `module` 分组 |
| 题目顺序 | **官方模块序连排**（与 2025 国考/省考真题卷面一致：政治理论→常识判断→言语理解与表达→数量关系→判断推理→资料分析）；**模块内按子题型顺序**（模板 `subs` 顺序，如判断推理=图形→定义→类比→逻辑、言语=逻辑填空→片段→语句、政治=新思想→时事…），同题型内随机；资料分析整组（组内按原卷序）；`enrichGroups` 组题不再无条件前置，改为"组内连续 + 按首题原位置"（保证材料组连续且不破坏子题型顺序） |
| 本地离线模式 | `lib/local-queries.mjs` 的 `generatePaper()` 与 `public/local-handler.mjs` 的 `POST /paper/generate` 同构实现（索引抽候选 → 查题 → JS 过滤源/难度/题型）；未做题优先不生效（本地无逐题记录） |

### 8.3 前端页面（§5.5 落地）

- 首页快捷宫格第 6 项「智能组卷」（`qg-orange` + `ico('target')`）→ 配置 sheet；
- 配置 sheet（用户迭代简化版）：**固定官方卷型**——题量/时长/题型/模块按所选科目与卷型固定（行测 130 题/120 分钟；职测按类别 A/B/C 各 100 题、山东 90 题，均 90 分钟）；**可调项**：科目（公务员·行测 / 事业编·职测 可切换）、卷型类别（选中职测时显示：联考A类/联考B类/联考C类/山东，默认联考A类）、难度三档（默认适中 3-6）+ 智能加权开关（默认开，自动检测 `stats.byChapter` 正确率最低模块）；`cfg-banner` 联动显示当前卷型说明；「智能生成」按钮；
- 生成中：按钮内联 spinner + 「正在从 4 个题库组卷…」；
- 预览页：`stat-row`（题量 / 预估时长 / 题源覆盖）+ 模块分布条（官方序配色）+ 逐模块题目列表（点击 → sheet 看完整题干/选项/答案）；底部「重新生成 / 开始做题」；
- 做题复用 `enterQuiz(questions, subject, mode)`（自 `renderPractice` 抽出，`mode:'quiz'`，答题卡/计时/交卷/成绩页全复用）。

---

*文档版本 v1 草案（2026-08-11）。字段与接口名以本仓库 `server.mjs`、`public/app.js` 实际实现为准；若有冲突，以代码为准并回写本档。*
