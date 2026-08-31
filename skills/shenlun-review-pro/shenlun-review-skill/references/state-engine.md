# 状态引擎

本文件定义申论复盘的状态持久化模型、写回规则和读取策略。与行测复盘引擎独立，不共享状态文件。

## 权威源

**SQLite 是运行时权威源。** Markdown 状态文件降级为导出格式和旧数据迁移来源。

- 运行时数据库路径：`<当前工作目录>/申论复盘引擎/shenlun-review.sqlite3`
- 发布包不附带数据库文件；数据库在首次写入时由 `scripts/review_engine.py` 自动创建。
- SQL schema 见 `scripts/state-schema.sql`。

## 状态表

| 表 | 用途 | 写入时机 |
|---|---|---|
| materials | 经核对材料的元数据 | 材料文字通过完整性核对后 |
| tasks | 题目与分析结果 | 分析完成后 |
| material_points | 原子要点 | 分析完成后 |
| answers | 用户作答 | 每次评分完成 |
| point_mappings | 要点覆盖映射 | 每次评分完成 |
| scores | 评分结果 | 每次评分完成 |
| dimension_scores | 分项评分 | 每次评分完成 |
| revisions | 二稿对比 | 二稿对比完成 |
| method_usage | 方法卡使用记录 | 评分引用方法卡时 |
| ability_events | 能力事件 | 每次评分完成（轻量追加） |
| calibrations | 评分校准 | 有新参考答案或教师点评时 |
| metadata | 键值元数据 | 迁移哈希等 |

## 四层学习状态

申论与行测使用同一系列的学习逻辑，但数据完全独立：

1. **作答记录（事实层）**：`answers` + `scores` + `revisions`。
2. **作答问题卡（事件层）**：由 `point_ledgers` + `structure_ledgers` + `dimension_scores` 派生的可读视图，不另造一份与账本冲突的事实源。
3. **能力档案（聚合层）**：由 `ability_events` 按“题型＋维度”聚合。
4. **申论学习者画像（汇总层）**：按需从上述真实记录生成，不作为底层事实源。

“作答问题卡”是申论版错因卡。一份作答可以产生多张问题卡；不得把整份作答粗暴归成一个“选错原因”。

## 状态路径解析

进入状态读写前，先确定数据库路径：

1. 优先使用调用方指定的 `--state-db` 参数。
2. 默认：`<当前工作目录>/申论复盘引擎/shenlun-review.sqlite3`
3. 不存在则由引擎自动创建（含全部表和外键）。

**禁止**向 skill 安装目录或 `.claude/skills/` 写入状态文件。

## 写回规则

### 自动写回

评分完成后自动执行（通过 `scripts/review_engine.py write-state`）：

1. 写入材料记录（materials 表，按 `material_hash` 去重）
2. 写入任务与分析结果（tasks + material_points 表）；如 `task_id` 已存在但 `material_hash`/`question_type`/`task_instruction` 不一致，退出码 3 回滚
3. 写入作答记录（answers 表，按复合键去重）
4. 写入评分结果（scores + dimension_scores + point_mappings 表）；只有 `validation_receipt.passed = true` 才写库
5. 写入方法卡使用记录（method_usage 表，`UNIQUE(score_id, method_card_id)` 防重复）
6. 追加能力事件（ability_events 表）
7. 以得失账本生成本次“作答问题卡”视图：完整覆盖不成卡；部分覆盖、未覆盖、材料外内容、必需结构缺失或维度层级≤2时成卡
8. 二稿比较时回填对应问题卡状态：未改善 / 部分改善 / 已改善 / 退步 / 表面换词

全部使用参数化查询和事务。失败回滚。

### 写回输入要求

`write-state` 的输入必须符合 `references/contracts/state-write-input.schema.json`，包含 analysis-result 关键元数据 + scoring-result 完整产物 + user_answer/task metadata + **atomic_points**。

**字段统一**：输入字段为 `atomic_points`（与 `analysis-result.schema.json` 一致）。`write-state` 内部写入 SQLite 的 `material_points` 表，但调用方**不得**手工生成 `material_points`，也不得传入 `material_points` 字段。`analysis-result` + `scoring-result` 普通对象合并后可直接送入 `write-state`，无需重命名字段。

**write-state 不得**：
- 从 `point_coverage[0].user_quote` 冒充完整 `user_answer`
- 从 `analysis_id` 冒充 `material_hash`
- 伪造 `atomic_points` stub 作为正常成功路径
- 用缺失字段继续写库

如果缺少 `task_id` / `question_type` / `task_instruction` / `material_hash` / `user_answer` / `atomic_points` 等必需字段，`write-state` 返回退出码 2 并明确列出缺失字段，不写库。

### 写回验证

写入后重新读取验证。只有实际写入成功后才能返回"已写回"。

写回回执只能列出已经实际写入并验证存在的记录 ID。只读环境、盲测环境或写入失败时，必须写"未写回"及原因；不得声称"已保存/已更新"。

### 去重策略

去重只在"同一题、同一版本、同一答案、同一完整评分语义"范围内发生：

- **材料**：按 `material_hash` 去重。
- **任务**：`analysis_id` 在 `tasks` 表中 `UNIQUE`，同一 `analysis_id` 只能对应一个 `task_id` 和 `material_hash`。
- **作答**：`answer_id = hash(task_id + analysis_id + answer_version + user_answer)`。
- **评分**：`score_id = hash(task_id + material_hash + analysis_id + answer_version + user_answer + dimensions + diagnostic_total + raw_center + center_value + interval + confidence + point_coverage含user_quote)`。维度等级、覆盖状态、置信度或 user_quote 不同时，即使总分相同也写成不同记录。
- **要点**：`atomic_points`（输入字段）对应 SQLite `material_points` 表，复合键 `point_key = task_id + "/" + point_id`，`UNIQUE(task_id, point_id)`。同一 task+point 已存在时必须逐字段完全一致才能复用，否则退出码 3 回滚。
- **超出材料**：独立的 `extra_claims` 表，不伪装为 `material_point`。
- **方法卡使用**：`method_usage` 表 `UNIQUE(score_id, method_card_id)` 防止重复行；输入 `method_card_ids` 中的重复 ID 被去重。
- **迁移**：旧 Markdown 按文件内容哈希去重。

### 旧数据库兼容

当前统一内核数据库为 v4；打开已有数据库时必须先核验 `metadata.schema_version`。v3 到 v4 只允许显式迁移并创建备份，不得静默改写旧库。关键表或列缺失时退出码4，不使用 `CREATE TABLE IF NOT EXISTS` 掩盖残缺。

v3 历史库的严格校验原则仍为：

1. 无 `metadata` 表 → 退出码 4，结构化 JSON，提示备份并删除后重建。
2. `metadata.schema_version` 不严格等于 `'3'`（包括 `'2'`、`'1'`、null）→ 无条件退出码 4，**不**因某列碰巧存在而放行。
3. 版本为 `'3'` 后，继续核验所有关键表（metadata/materials/tasks/material_points/answers/scores/dimension_scores/point_mappings/extra_claims/method_usage/ability_events）和关键列（scores 的 weight_policy/weight_source_note/full_score，point_mappings 的 score_id，extra_claims 的 score_id/claim_id，material_points 的 point_key 等）。
4. 缺任意关键表或关键列 → 退出码 4，明确报告缺失项，**不**使用 `CREATE TABLE IF NOT EXISTS` 掩盖残缺。
5. 不进行自动迁移；只给出备份和重新建库提示。

校验在正式写入前完成，不会把结构问题拖到 INSERT 阶段。

## Markdown 迁移

`scripts/review_engine.py migrate-state`：

- 不删除或改写旧 Markdown 文件。
- 仅导入字段完整、可确认身份的记录。
- 使用内容哈希防止重复导入。
- 无法确认的记录写入迁移问题报告。
- 迁移完成后 SQLite 为权威源。
- Markdown 继续作为只读历史和导出格式。

## 旧 Markdown 状态层（只读历史）

以下 Markdown 目录在迁移后仍保留，但不作为运行时权威源：

| 层 | 目录 | 状态 |
|---|---|---|
| 材料层 | `材料记录/` | 只读历史/导出 |
| 事件层 | `作答记录/` | 只读历史/导出 |
| 能力层 | `能力档案/` | 只读历史/导出 |
| 校准层 | `评分校准/` | 只读历史/导出 |
| 汇总层 | `学习者画像.md` | 从 SQLite 按需生成 |

## 学情报告

学情报告从 SQLite 读取真实记录并导出（`scripts/review_engine.py export-report`）：

- 没有真实记录时明确说明"暂无记录"，不得生成虚假统计。
- 支持导出为 JSON / Markdown / HTML。
- HTML 使用 `assets/report-template.html` + `assets/report.css`，无 JavaScript，转义用户输入。
- 作答问题卡、能力档案和画像使用 `export-learning-state --format json|markdown|html` 从 SQLite 即时生成。JSON 须符合 `references/contracts/learning-state.schema.json`。
- Markdown/HTML 是导出产物，可删除并重建；不得反向覆盖 SQLite 事实。

### 画像刷新门禁

申论学习者画像仅在以下任一条件满足时刷新：

- 用户明确要求学情报告或画像；
- 距上次刷新累计3–5份新作答；
- 一轮题型训练结束。

每次批改只追加作答记录、问题卡和能力事件，不重写整份画像。画像中的题型弱项、高频问题和趋势必须能回查到真实 `score_id` / `answer_id`。

## 当前边界

已启用作答问题卡、能力档案和申论学习者画像。仍不含自动出题、考我、到期复习和间隔重复调度；这些不得借用行测题库实现。
