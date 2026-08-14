# 实施计划：自定义题库（文件导入 → 批次管理 → 刷题判分）

> 基于设计文档 `docs/superpowers/specs/2026-08-15-custom-bank-design.md`（9+1 节）。
> 前置已完成：设计文档已提交（e76b730）；AI 智能体合并+新增已提交（35be777：essay-ocr 并入 image-reader，新增 custom-question-parser id=6）；数据库备份 `backup/practice.db.bak-before-custom-bank-20260815-000737`；git tag `pre-custom-bank`。
> 目标产物：Web（practice.db）+ App（IndexedDB）双端可用的「自定义题库」。

## 核心决策（实现时遵守）

1. **题目 id**：前端生成 `custom-${randomUUID}`（字母开头，与粉笔数字 questionId 天然隔离，两端一致）；`practice_records.question_id` 直接存它，错题本/收藏夹/重练自动兼容。
2. **字段对齐**：custom_questions 与粉笔 questions 同构，保证 renderQuestion / checkAnswer / judge 零改动复用：
   - `content` = 提示（题干）；`material`（材料题）；`options` = JSON 数组文本 `'["A. xxx","B. xxx"]'`（无选项 `'[]'`）；`answer` = 答案原文（A/B/C/D/AB/正确）；`answer_index` = 0-3（单选可判分）或 -1（无答案/多选不判分）；`analysis` = 解析（空='无解析'）；`type` = 导出时给 `'custom'`。
3. **判分**：answer 识别 A-D → answer_index 0-3 客观判分；多选（AB 等）或无法识别 → answer_index=-1，做题时显示「无答案」不判分。提交 `/api/check` 传 `{questionId, selected}` 即可（checkAnswer 用 answer 字段判定，多选答案原文 'AB' 会落到"真正无答案"分支——**注意**：多选题 checkAnswer 需走 answer 数组分支，故多选时把 options+answer 存成粉笔多选格式：answer 存 JSON 数组文本 `'[0,2]'`，这样 checkAnswer 第一分支直接判分）。
4. **practice_records.subject = '自定义'**；chapter 存批次名（便于按批次统计/删除）。App 端同构。
5. **解析引擎**：Web/App 共用 `public/lib/custom-parser.js`（ESM，无外部依赖，可 import 进 app.js 与 local-handler.js）。
6. **PDF**：文本型 → pdf.js `getTextContent` 逐页抽文本；扫描版 → 页渲染 canvas 转 dataURL → 统一走 `image-reader`（合并后的识图转写员，GLM-4.1V-Thinking-Flash）。
7. **AI 结构化兜底**：自由文本（TXT/Word/自由 Excel 行）分批（≤10 题/批）走 `custom-question-parser` → JSON `{questions:[{prompt,material,options[],answer,analysis}]}`；失败/超时该题标记「待人工修正」仍可导入。
8. **合并命名**：默认「批次A+批次B」（弹窗可改）；**拆分命名**：默认「原批次名-拆分N」。
9. **App 打包**：本次 versionCode 1→2、versionName "1.0"→"1.1"；`app/android/kaogong-release.keystore`（alias `kaogong`）；覆盖安装需签名一致。
10. **vendor**：`public/vendor/xlsx/`（SheetJS full）+ `public/vendor/pdfjs/`（pdf.min.mjs + worker 本地化）；App 端 build-app-assets 拷贝清单需追加新文件。

## 阶段 1：服务端（server.mjs）

改 `server.mjs`：
- 建表（`pdb`，practice.db）：
  - `custom_batches(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`
  - `custom_questions(id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, prompt TEXT NOT NULL, material TEXT DEFAULT '', options TEXT DEFAULT '[]', answer TEXT DEFAULT '', answer_index INTEGER DEFAULT -1, analysis TEXT DEFAULT '')`
  - 索引 `idx_cq_batch ON custom_questions(batch_id)`；批内序号按 `id` 顺序（刷题按 id ASC）。
- 11 个路由（挂在现有 `if (pathname === ...)` 链上，模式与 `/api/practice` 一致，全部 JSON）：
  1. `POST /api/custom/import` — body `{name, questions:[{prompt,material,options(数组),answer,answer_index,analysis}]}`；建批次+批量插题，返回 `{id,name,count}`。
  2. `GET /api/custom/batches` — `[{id,name,count,created_at}]`（LEFT JOIN 计数）。
  3. `GET /api/custom/questions?batch_id=` — 按 id ASC 返回全部题。
  4. `PUT /api/custom/batch/:id` — body `{name}` 改名（校验非空）。
  5. `POST /api/custom/batch/merge` — body `{ids:[..], name?}`；默认名「批次A+批次B」；目标批次名可覆盖（同名提示走前端）；把选中的批次的题并入第一个（id 最小）批次，删其余批次；返回新批次信息。
  6. `POST /api/custom/batch/split` — body `{batch_id, question_ids:[..], name?}`；默认名「原批次名-拆分N」（N=该批次已有拆分数+1）；新建批次并移题；返回新批次。
  7. `DELETE /api/custom/batch/:id` — 删批次+其题目（级联）。
  8. `PUT /api/custom/question/:id` — body 同 import 单题字段，改单题。
  9. `DELETE /api/custom/question/:id` — 删单题。
  10. `GET /api/custom/practice?batch_id=` — 出题：该批全部题（按 id ASC），字段映射成粉笔结构（content=prompt、options JSON 字符串、answer、answerIndex=answer_index、analysis、material、type='custom'），供 enterQuiz 直接刷。
  11. `POST /api/custom/check` — body `{questionId, selected}`；查 custom_questions → `checkAnswer` 复用 → 写 practice_records（subject='自定义'，chapter=批次名）→ 返回与 `/api/check` 相同结构 `{ok,correct,selected,correctText}`。
- 顺手：`checkAnswer` 已支持多选 answer 数组，无需改。
- 验证：`node --check server.mjs`；启动后 curl：import → batches → questions → practice → check（用临时脚本或 Invoke-RestMethod）。

## 阶段 2：解析引擎 + vendor

1. 下载 vendor：
   - `public/vendor/xlsx/xlsx.full.min.js`（SheetJS 官方 cdn.sheetjs.com 版本）
   - `public/vendor/pdfjs/`：`pdf.min.mjs` + `pdf.worker.min.mjs`（cdnjs pdfjs-dist 最新稳定版；worker 需本地化，App/Web 双端离线可用）
2. 新增 `public/lib/custom-parser.js`（ESM，导出纯函数，**不依赖 DOM**，App 与 Web 共用）：
   - `parseTxt(text)` / `parseDocxText(xmlText)`：规则切分（题号 `1.`/`一、`/`第1题`，选项 `A.` `B.` 行，材料段识别，答案行 `答案：A`、解析行 `解析：`）→ `{prompt, material, options[], answer, analysis}[]`。
   - `parseExcel(rows, mode)`：固定列模式（表头含 提示/材料/选项/答案/解析 → 按列）；自由格式（每行一道，规则切分同上）。
   - `normalizeAnswer(answer)`：'A'-'D' → answer_index 0-3；'AB'/'ABCD' 等多选 → 若 options 有 4 个则按字母序映射为索引数组 JSON 文本 `'[0,2]'`（checkAnswer 多选分支可用）；'正确/错误' → options 缺省时 answer_index 置 0/1 并给 options `["正确","错误"]`；无法识别 → -1。
   - `aiStructure(texts, callAi)`：分批（≤10 题）调 `custom-question-parser`，容错 JSON 提取（剥 ```json 围栏、找首个 `{`），失败批标记 `{failed:true}` 返回待人工修正。
   - `splitQuestions(all, pickedIds)`：拆批纯逻辑（供前端拆分用）。
3. 验证：临时 Node 脚本喂 3 种样例文本（单选/材料多选/无答案）断言 parseTxt 输出。

## 阶段 3：Web 前端（app.js + style.css + server 接线）

- `public/app.js`：
  - `renderHome`：subject-grid 前插入「自定义题库」卡片（`renderCustomBank`）。
  - `renderCustomBank()`：批次列表（名称/题数/时间）+「+ 导入题目」按钮；批次数>1 时显示「合并批次」（多选）。
  - `renderImport()`：文件选择（accept `.pdf,.xlsx,.xls,.txt,.docx,.doc`）+ 格式说明；按文件类型分发解析（TXT/Word → parseTxt；Excel → parseExcel 固定列优先，失败转自由格式；PDF → 文本层优先，无文本层页转图走 image-reader）；解析后预览表格（提示/材料/选项/答案/解析，AI 失败题标「待人工修正」可手动补）；「确认导入」→ 命名批次 → `POST /api/custom/import`。
  - `renderCustomBatch(id)`：题目列表（题干摘要+答案+解析）+「开始刷题」（`GET /api/custom/practice` → `enterQuiz(qs,'自定义','custom',null,null,null)`）+「拆分」（勾选题目）+「编辑/删除」单题 + 批改名/删除。
  - 单题编辑弹窗：5 字段 + answer_index 自动重算（normalizeAnswer）。
  - 复用：enterQuiz / renderQuestion / submitAnswer 不动；renderQuestion 的解析展示逻辑对无 answer_index（-1）显示「无答案」、无 analysis 显示「无解析」。
- `public/style.css`：自定义题库卡片/列表/导入预览表格样式（沿用现有卡片风格变量）。
- 验证：浏览器 `http://localhost:3000` 手工流（导入 txt 样例 → 预览 → 导入 → 批次出现 → 刷题判分 → 错题本出现 subject=自定义）。

## 阶段 4：App 离线镜像（IndexedDB + local-api）

- `public/idb-store.js`：`STORES` 追加 `'custom_batches','custom_questions'`；`DEFAULT_VERSION` 1→2（onupgradeneeded 增量建表已通用）。
- `public/lib/local-queries.js`：`createLocalApi` 增加与阶段 1 同名 11 方法（读 custom_batches/custom_questions store，聚合计数；check 写入 records store 用 `custom-${uuid}` questionId、subject='自定义'、chapter=批次名）。
- `public/local-handler.js`：路由表追加 `/api/custom/*` 11 条 → 同名 local api 方法（与 Web 响应结构一致）。
- `public/app.js`：`api()` 已自动分派（App 走 local-handler），导入解析逻辑本身 Web/App 共用（custom-parser.js 无 DOM 依赖；PDF 解析用 `file input` 的 File → pdf.js 在 WebView 可用；image-reader 走 ai-local.js 已有网关）。需确认 app.js 文件选择在 App 端用 `<input type=file>` 的 Capacitor 兼容性（Android WebView 原生 file input 可用，无需插件）。
- 验证：`node --check` + 浏览器 WebView 模拟（或直接打包后雷电模拟器验证，见阶段 5）。

## 阶段 5：联调 + App 打包

1. `build-app-assets.mjs`：拷贝清单追加 `public/lib/custom-parser.js`、`public/vendor/xlsx/`、`public/vendor/pdfjs/`、`public/ai-agents.default.json`（若未在清单）。
2. App assets 同步：重新 build + cap sync（`npx cap sync android`）后确认 `app/android/app/src/main/assets/public/` 含新文件。
3. `app/android/app/build.gradle`：versionCode 1→2、versionName "1.0"→"1.1"。
4. 打包：`.\gradlew.bat assembleRelease`（keystore：`app/android/kaogong-release.keystore`，alias `kaogong`，密码见项目记忆/HANDOFF）。
5. 雷电模拟器验证：导入 TXT 样例 → 批次管理 → 刷题判分 → 错题本；`adb forward` + CDP 断言（参考 HANDOFF 7.3）。
6. git 提交（分阶段提交：服务端 → 解析引擎 → 前端 → App 镜像 → 打包），打 tag `custom-bank-v1.1`。

## 非目标（明确不做）

- 不改粉笔题库数据；自定义题不进 tiku.db 主库。
- 不做批内排序调整（固定按导入顺序）。
- 不做题目级标签/搜索（首版不做）。
- 不做多用户隔离（单用户应用）。
- 不修 test-local-ai.mjs 既有失败「updateAgent 空 key 覆盖旧值」（App 本地版，记录在案，本次不扩范围）。

## 风险与预案

- pdf.js worker 在 file:// 与 WebView 加载：用 `GlobalWorkerOptions.workerSrc` 指向本地 vendor 路径；若 worker 阻塞则降级主线程（`disableWorker`）保解析可用。
- SheetJS 大文件内存：导入前 size 上限提示（默认 ≤20MB）。
- 扫描版 PDF 逐页调 image-reader 慢/限流：串行 + 每页重试 1 次；单页失败该页标记待人工修正。
- checkAnswer 对 '正确/错误' 判断题：normalizeAnswer 已生成 options `["正确","错误"]` + answer_index 0/1，判定走单选分支，正确。
