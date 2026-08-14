# 自定义题库功能设计文档

日期：2026-08-15
状态：已获用户批准（2026-08-15）
前置备份：git tag `pre-custom-bank`（c930460）+ `backup/practice.db.bak-before-custom-bank-20260815-000737`

## 1. 目标

让用户通过文件导入自有题目，形成独立的"自定义题库"，可像行测/申论一样刷题判分。

核心需求（用户确认）：
- 主界面（首页科目卡区）显示"自定义题库"入口，下方是小分支卡片（每个 = 一个批次）
- 通过文件导入题目：**PDF、Excel 为主，其他格式（TXT/Word）也支持**；PDF 识别调用 AI 设置里的识图转写员（mimo-v2.5-free）
- 软件自动判断并分类每道题的五个字段：**提示（=题干）、材料、选项、答案、解析**
- 无解析显示"无解析"，无答案显示"无答案"
- 大分支（=批次，一次导入一个文件）可改名、合并、拆分（勾选题目拆出）
- 批次和单题都可删除；单题可编辑（提示/选项/答案/解析）
- 自定义题可刷题判分（客观题），可进错题本
- **Web + App 端各自导入**（两端数据不互通）；App 离线模式存 IndexedDB

## 2. 总体架构

**方案 A：前端解析 + 服务端存储（已确认）**

```
文件选择(<input type="file">)
  → 前端解析（vendor 引入 SheetJS / pdf.js）
  → 规则切分 + AI 兜底（现有 AI 网关，识图转写员 mimo-v2.5-free）
  → 结构化题目 JSON
  → Web 端: POST /api/custom/import → practice.db 新表
  → App 端: local-handler.js 镜像 → IndexedDB 新 objectStore
```

- 两端共用同一套前端解析逻辑 `public/lib/custom-parser.js`
- 服务端保持零依赖（vendor 静态库不打进 npm）
- Web 服务端是单用户游客模式，自定义题库无鉴权（与现有题库一致）

## 3. 数据模型

### Web 端（practice.db 新增两张表，server.mjs 建表区）

```sql
CREATE TABLE IF NOT EXISTS custom_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS custom_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES custom_batches(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL DEFAULT '',      -- 提示（题干）
  material TEXT NOT NULL DEFAULT '',    -- 材料（可为空）
  options TEXT NOT NULL DEFAULT '[]',   -- JSON 数组 ["A选项","B选项",...]
  answer TEXT NOT NULL DEFAULT '',      -- 答案原文（如 "A"、"AB"、"正确"）
  answer_index INTEGER NOT NULL DEFAULT -1,  -- 0基判分索引；-1=无答案/不可判
  analysis TEXT NOT NULL DEFAULT '',    -- 解析（空 = 无解析）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cq_batch ON custom_questions(batch_id);
```

### App 端（IndexedDB `kaogong-app` 库新增两个 objectStore）

- `custom_batches`：keyPath `id`，自动递增（`idb-store.js` 注册）
- `custom_questions`：keyPath `id`，自动递增，索引 `batch_id`
- 字段与上表一致

### 判分规则

| 答案形式 | answer_index | 判分 | 显示 |
|---|---|---|---|
| 单个字母 A/B/C/D（或 1-4 数字） | 0-3 | 客观判分，进错题本 | 答案徽标 |
| 多选 AB/CD 等 | -1 | 不判分（按主观题处理） | 显示原文 |
| 无法识别 / 空 | -1 | 不判分 | "无答案" |

- 做对 3 天自动移出错题本的现有逻辑同样适用（`practice_records.subject='自定义'`）
- `checkAnswer` 复用：把自定义题的 options 数组按 answer_index 判分

## 4. 页面结构与交互

```
首页 renderHome 科目卡区 → 「自定义题库」卡片（新卡片，带 icon/描述）
  └─ renderCustomHome：批次卡片列表（名字/题数/无答案·无解析数）+「导入题目」按钮 + 批次管理
       ├─ 导入流程：选文件 → 前端解析 → 预览页（每题显示识别结果，可勾选跳过）→ 填批次名 → 确认导入
       ├─ 批次卡片 ··· 菜单：改名 / 合并（勾选多个批次）/ 拆分（进批次内勾选题目）/ 删除
       └─ 点批次卡 → renderCustomBatch：题目列表（提示摘要 + 选项数 + 答案徽标 + 无解析/无答案标记）
             ├─ 点题 → 题目详情（展示 提示/材料/选项/答案/解析；编辑按钮、删除按钮）
             └─ 「刷题」按钮 → 复用 renderPractice/enterQuiz 做题流程
```

- 自定义题做题：走现有做题态（#view[data-exam]），答案点击判分/长按排除/暂停冻结/滑动切题全部自动生效（因为复用同一套 renderQuestion）
- 题目详情编辑：弹层表单，字段 提示/材料/选项(A-D 输入框)/答案/解析，保存调编辑接口
- 批次的"无解析/无答案"统计：SQL 聚合（Web）/ IndexedDB 游标统计（App）

## 5. 解析引擎（前端 custom-parser.js，规则优先 + AI 兜底）

| 输入 | 处理 |
|---|---|
| Excel 固定列 | 表头别名识别（提示/题干/题目/材料/选项/A/B/C/D/答案/解析），列映射，零 AI |
| Excel 自由格式 | 规则切分（正则识别 `材料：` `A.` `B.` `C.` `D.` `答案：` `解析：`）→ 低置信 AI 兜底 |
| TXT/Word(.docx 解包) | 同上规则切分 + AI 兜底 |
| PDF 有文本层 | pdf.js 提取文本 → 规则切分 + AI 兜底 |
| PDF 扫描版 | pdf.js 渲染每页为 canvas → 图片走识图转写员（mimo-v2.5-free，现有 AI 网关）→ 文本 → 规则切分 |

AI 兜底：新增解析提示词（走现有 AI 网关：Web `/api/ai`，App `ai-local.js`），输入原始文本 → 输出 JSON
`{prompt, material, options[], answer, analysis}`；解析失败/超时则该题标记为"待人工修正"仍可导入。

vendor 静态库（下载到 public/vendor/，服务端零依赖）：
- `public/vendor/xlsx/xlsx.full.min.js`（SheetJS CE 0.20.x）
- `public/vendor/pdfjs/pdf.min.js` + `pdf.worker.min.js`（pdf.js 4.x）

## 6. 接口清单

### Web 服务端（server.mjs 路由区，约 1103-1930 行）

```
POST   /api/custom/import          批量导入（自动建批次；body: {name, questions:[...]}）
GET    /api/custom/batches         批次列表（含 count/无答案数/无解析数）
GET    /api/custom/questions?batch_id=  某批次题目（含分页/搜索可选，先简单全量）
PUT    /api/custom/batch/:id       改名 {name}
POST   /api/custom/batch/merge     合并 {ids:[...], name} → 新批次
POST   /api/custom/batch/split     拆分 {id, question_ids:[...], name} → 新批次
DELETE /api/custom/batch/:id       删批次（级联删题）
PUT    /api/custom/question/:id    编辑单题
DELETE /api/custom/question/:id    删单题
GET    /api/custom/practice?batch_id=&n=  刷题出题（随机 n 题）
POST   /api/custom/check           判分（复用 checkAnswer；body: {question, selected}）
```

### App 离线镜像

- `public/local-handler.js` 路由表 + `public/lib/local-queries.js` 的 `createLocalApi` 增加对应方法，数据落 IndexedDB（`idb-store.js` 新增 store 注册与 CRUD）

## 7. 修改文件清单

新增：
- `public/lib/custom-parser.js`（解析引擎，两端共用）
- `public/vendor/xlsx/`、`public/vendor/pdfjs/`（静态库）
- `docs/design/custom-bank-contract.md`（前后端接口契约，可选）

修改：
- `server.mjs`（建表 + 11 个路由 + 判分复用）
- `public/app.js`（首页卡片、renderCustomHome/renderCustomBatch、导入预览、题目详情/编辑、刷题接入）
- `public/style.css`（新页面样式）
- `public/local-handler.js`、`public/lib/local-queries.js`（App 镜像）
- `public/idb-store.js`（IndexedDB 新 store + CRUD）
- `public/lib/fenbi-tree.js`（如需在树里挂自定义入口，暂不必须）
- `build-app-assets.mjs`（本次不动；后续若要自定义题进 App 离线包再扩展）
- `app/android/app/build.gradle`（**打包时 versionCode 1→2、versionName 1.0→1.1**，保证可覆盖安装）

## 8. 覆盖安装说明（用户关切）

- 签名：继续用 `app/android/kaogong-release.keystore`（alias `kaogong`），不得更换/重新生成
- versionCode 必须递增（当前 1 → 2），否则部分 ROM 拒绝覆盖安装
- 覆盖安装不清数据：IndexedDB（错题本/做题记录/自定义题）、localStorage 全保留；新功能只新增 store，旧数据兼容
- 若用户仍希望"全新安装"，需先卸载（会清空数据）

## 9. 非目标（本次不做）

- Web/App 两端数据同步（各自导入，本地存储）
- 自定义题打进 App 离线包（tiku_app.db）
- 主观题 AI 批改
- 多用户/账号体系
- 自定义题参与智能组卷/随机练习混排（先只在自定义题库内部刷题）
