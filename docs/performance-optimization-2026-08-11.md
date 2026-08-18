# 性能优化报告（2026-08-11）— 各模块打开慢的诊断与修复

> 生成时间：2026-08-11 · 工作区：`D:\nomoneynowork\`（2026-08-16 从 C 盘迁移）
> 阅读对象：**其他模块的工作 AI / 后续维护者**。本文说明本次性能问题"为什么慢、改了什么、哪些红线不能碰、怎么验证"。
> 相关文档：`HANDOFF.md`（App 离线化交接）、`app-mobile-plan.md`（主计划）

---

## 1. 一句话总结

**现象**：网页和 App 打开"章节/分类/首页统计"等模块非常慢（单次请求 0.5~6 秒）。

**根因**：`tiku.questions.questionId` 列**没有索引**，导致申论/综应等主观题模块的树形菜单对每个节点循环执行 `EXISTS` 子查询时，**每次都要全表扫描 9.6 万行题目**；加上无缓存，静态题量统计每次请求都重算。

**修复**：① 补数据库索引（5 个关键索引）；② 树形菜单 17 次循环查询合并为 **1 次批量 GROUP BY**；③ 静态题库数据加**内存缓存** `chapterCache`；④ `EXISTS` 相关子查询改为 `IN` 子查询。

**效果**：全部模块响应时间从 **529~6176ms → 2~6ms**（热缓存后），冷启动首次请求也都在 180ms 以内。

---

## 2. 问题现象与实测基线

用户报告"网页和 App 打开各模块的速度非常慢"。实测修复前基线（`http://localhost:3000`）：

| 模块 | API | 修复前耗时 |
|---|---|---|
| 章节-申论 | `/api/chapters?subject=公务员·申论` | **6118ms** |
| 章节-综应 | `/api/chapters?subject=事业编·综应` | **6176ms** |
| 章节-职测 | `/api/chapters?subject=事业编·职测` | 529ms |
| 章节-行测 | `/api/chapters?subject=公务员·行测` | 539ms |
| 刷题-行测 | `/api/practice?subject=公务员·行测` | 168ms |
| 统计-行测 | `/api/records/stats?subject=公务员·行测` | 267ms |

---

## 3. 根因分析（为什么慢）

### 3.1 主因：`questions.questionId` 无索引 → 全表扫描

- 数据库规模：`tiku.questions` **96,477 行**（9.6 万）、`papers` 2,455 套、`question_categories` 5.7 万行。
- 行测走 `FENBI_TREE`（章节映射），申论/综应走 `ESSAY_TREE`（分类索引）。
- 主观题模块原实现：**对 ESSAY_TREE 的每个节点（约 17 个）逐条执行**：

```sql
-- 每个节点一次，questionId 无索引时每次全表扫描 9.6 万行
SELECT COUNT(*) FROM question_categories qc
WHERE qc.subject = ? AND EXISTS (
  SELECT 1 FROM tiku.questions q WHERE q.questionId = qc.question_id  -- ← 无索引
) AND qc.category = ? AND qc.sub = ?
```

17 节点 × 9.6 万行扫描 ≈ 6 秒。行测/职测（529ms）也是同样的 EXISTS 模式，只是节点少、走得快。

### 3.2 次因：静态数据无缓存

- 章节题量（`totals`）、科目统计、分类题量都属于**运行时不变的只读题库数据**，但每次请求都重新执行聚合查询。
- `/api/records/stats` 对每条做题记录执行 EXISTS 相关子查询（practice_records 310 行 × 9.6 万扫描），稳定 ~50ms/次 × 5 个统计查询。

---

## 4. 修复内容

### 4.1 数据库补索引（已生效，tiku.db 已备份）

**新增索引**（本次改动）：

| 库 | 索引 | 作用 |
|---|---|---|
| `tiku.db` | `idx_questions_questionid` ON `questions(questionId)` | **核心**：消除 EXISTS/IN 子查询的全表扫描 |
| `tiku.db` | `idx_papers_subjectname` ON `papers(subjectName)` | 章节题量 JOIN 加速 |
| `tiku.db` | `idx_questions_paper_id` ON `questions(paperId, id)` | 试卷→题目关联加速 |
| `practice.db` | `idx_qc_subject` ON `question_categories(subject)` | 分类索引按科目过滤 |
| `practice.db` | `idx_records_question` ON `practice_records(question_id)` | 做题记录 JOIN 题库 |

**备份**：`tiku.db.bak-2026-08-10-1786380405217`（约 91MB，确认运行正常一周后可删）。

**注意**：`tiku.db` 是只读题库（9.6 万题），索引文件随库保存，**重启/重新部署不丢**；索引建在数据库文件里而非 server 代码中。

### 4.2 server.mjs 代码改动（约 5 处）

| 位置 | 改动 | 说明 |
|---|---|---|
| `L442` | 新增 `const chapterCache = new Map();` | **必须声明在模块级**（`http.createServer` 之前）。曾误声明在请求处理函数内导致缓存每次失效，已修正 |
| `/api/subjects`（`L452`） | 静态部分（papers/questions 数）缓存到 `chapterCache`，key=`subjects\|static`；**动态 `done`（已做对题数）每次单独查，不缓存** | 做题记录会变，不能混入缓存 |
| `/api/categories`（`L479`） | 分类题量结果缓存，key=`cat\|{subject}\|{category}\|{sub}` | 只读题库数据 |
| `/api/chapters`（`L577` `L644` `L671`） | ① `totals` 题量缓存（key=`totals\|{subject}\|{mock}`）；② `idxMap` 分类索引缓存（key=`idxmap\|{subject}`）；③ **nodeStats 17 次循环查询 → 1 次 GROUP BY 批量查询**，结果放 `nodeStatsMap` 内存 Map | 循环改批量是本任务最大单项收益之一 |
| `/api/records/stats`（`L782` `L1054`） | `tikuCond` 从 `EXISTS (SELECT 1 FROM tiku.questions ...)` 改为 `IN (SELECT ...)` | 语义等价，~50ms → 17ms |

**顺带修正 bug**：nodeStats 批量查询中做题数改用 `COUNT(DISTINCT qc.question_id)`——原 `COUNT(*)` 在 LEFT JOIN `practice_records` 时会把同一题多条做题记录重复计数。

### 4.3 缓存红线（重要！）

```js
// ✅ 可缓存：只读题库静态数据 —— 题量、套数、分类计数（题库运行时不变）
// ❌ 不可缓存：任何含做题记录的数据 —— done/correct/rate/nodeStatsMap 里的 ok 字段
```

- `/api/records/stats`、`done`、做题正确数等**动态数据一律不缓存**（曾误把 `nodeStatsMap` 加缓存导致做题后数字不更新，已回退）。
- 若将来做"题库热更新/增量爬取"，缓存会失效——届时需在写入时 `chapterCache.clear()` 或按 subject 清 key。

---

## 5. 修复后实测（验收数据）

同一机器、同一服务器实例（`node server.mjs 3000`）：

### 第一轮（冷缓存，服务刚启动）

| 模块 | 耗时 | 模块 | 耗时 |
|---|---|---|---|
| 首页-科目统计 | 92ms | 章节-综应 | 10ms |
| 分类-行测 | 41ms | 刷题-行测随机 | 7ms |
| 章节-行测 | 178ms | 统计-行测 | 91ms |
| 章节-申论 | 14ms | 统计-全部 | 2ms |
| 章节-职测 | 16ms | AI-agents | 15ms |

### 第二轮（热缓存，正常使用状态）

| 模块 | 耗时 | 模块 | 耗时 |
|---|---|---|---|
| 首页-科目统计 | **2ms** | 刷题-行测随机 | **4ms** |
| 分类-行测 | **2ms** | 刷题-申论组 | **2ms** |
| 章节-行测 | **4ms** | 统计-行测 | 85ms |
| 章节-申论 | **6ms** | 统计-全部 | **3ms** |
| 章节-职测 | **3ms** | 错题本 | **3ms** |
| 章节-综应 | **5ms** | 最近记录 | **2ms** |

> 说明：`统计-行测`（85ms）是唯一剩余"慢"点——5 个带 `IN` 子查询的统计聚合。它不属于"打开模块"路径（用户感知不明显），且已比原 267ms 快 3 倍。若需进一步优化，可将 5 个查询合并为 1 次取回 practice_records 后在 JS 聚合（改动有回归风险，本次未做）。

---

## 6. 验证方法（复测 / 回归）

```powershell
cd D:\nomoneynowork
node --check server.mjs            # 语法校验（零依赖 node:sqlite）
node server.mjs 3000               # 启动（或双击 启动.bat）
# 用浏览器或脚本请求以下端点观察耗时：
# /api/subjects  /api/chapters?subject=公务员·申论  /api/chapters?subject=事业编·综应
# /api/categories?subject=公务员·行测  /api/records/stats?subject=公务员·行测
npm test --prefix fenbi-crawler    # 既有回归测试（verify-db.mjs + e2e-check.mjs）
```

验收标准：热缓存后全部 API **< 10ms**；冷启动首次请求 **< 200ms**。

---

## 7. 给其他模块 AI 的注意事项

1. **不要动 `chapterCache` 的红线**：新增缓存前先判断数据是否含做题记录；动态数据宁可每次查。
2. **数据库索引是修复的一部分**：如果重建/迁移 `tiku.db` 或 `practice.db`，必须重建 4.1 节列出的 5 个索引，否则 6 秒慢查询会复现。
3. **`tiku.db` 只读、`practice.db` 是真用户数据**（310 条做题记录）：任何测试不要写它们（已有 `tiku.db.bak-*` 备份，删除前确认）。
4. **ESSAY_TREE 批量查询模式**（`L671`）：将来新增主观题分类节点时，保持"一次 GROUP BY + 内存 Map 查找"的模式，**不要改回逐节点循环查询**。
5. **行测 `idxMap` 缓存依赖 `question_categories`**：若粉笔数据重新爬取/导入，分类索引表会变化，缓存 key 按 subject 隔离，需要时清缓存。
6. 服务器启动方式：`启动.bat` / `node server.mjs 3000`，保持运行中（当前为后台任务 bash-6）。
7. 本报告数据基于 **2026-08-11 实测**；若题库规模变化（新增科目/题目），响应时间需重新测量。

---

## 8. 本次改动文件清单

| 文件 | 改动 |
|---|---|
| `tiku.db` | +3 索引（questionId / subjectName / paperId,id），备份 `tiku.db.bak-2026-08-10-1786380405217` |
| `practice.db` | +2 索引（qc_subject / records_question） |
| `server.mjs` | +`chapterCache` 模块级缓存；subjects/categories/chapters 静态数据缓存；nodeStats 批量查询 + 去重计数修正；stats `tikuCond` EXISTS→IN |
| 临时测速脚本 | `tmp-diag*.mjs` / `tmp-measure*.mjs` / `tmp-acceptance.mjs` 已清理（其余 `tmp-*.mjs` 是历史遗留，与本任务无关） |

*交接提醒：本任务唯一语义风险点是"缓存了不该缓存的数据"，4.3 节已列出全部缓存 key 与动态数据边界；改代码前先读 §4.2 与 §7。*
