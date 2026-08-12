# 智能组卷性能优化（2026-08-11）

## 1. 一句话总结

智能组卷（`POST /api/paper/generate`）慢的根因是抽题 SQL 的 `ORDER BY RANDOM()`（SQLite 强制全量物化排序 + 相关子查询逐行扫描），已通过**内存抽题池**（只读题库静态索引一次性载入 + JS 过滤 + Fisher-Yates 洗牌）根治：行测 20 题 4017ms → ~144ms，130 题 7898ms → ~165ms（约 30-50 倍）。**组卷逻辑（题量、模块、源、难度、弱项加权、材料组）语义与 SQL 版完全等价，无功能变更。**

## 2. 问题现象（优化前实测）

| 场景 | 优化前 | 优化后 |
|---|---|---|
| 行测默认 20 题 | 4017ms | ~144ms |
| 行测全真 130 题 | 7898ms | ~165ms |
| 行测 10 题 easy | 2816ms | ~23ms |
| 职测整卷（A/B/C/山东，90-104 题） | （未测，同类瓶颈） | 12-20ms |
| 弱项加权 30 题 | — | ~151ms |

## 3. 根因分析

`pickSingle`（单题抽题）每条 SQL 形如：

```sql
SELECT qc.question_id FROM question_categories qc
JOIN tiku.questions q ON q.questionId = qc.question_id
JOIN tiku.papers p ON p.id = q.paperId
WHERE ... AND NOT EXISTS (SELECT 1 FROM q_material_map mm WHERE ...)
ORDER BY RANDOM() LIMIT ?
```

- `ORDER BY RANDOM()` 使 SQLite **强制物化全部候选行并全量排序**（无法利用索引提前终止），且候选行上的 `NOT EXISTS` 相关子查询逐行执行；
- 实测单次该 SQL **~560ms**（去掉 RANDOM 仅 2ms）；
- 一次默认行测组卷 ≈ **44 次** pickSingle 调用（6 模块 × 4 源 × 子知识点）+ pickGroups + 模块补齐 → 数秒。

## 4. 修复内容（server.mjs 新增/改动）

### 4.1 新增：内存抽题池 `getPaperPool()`（模块级，懒加载 + 启动后 `setImmediate` 预热）

一次性载入只读静态索引（预热实测 ~720ms，仅一次）：

| 索引 | 内容 | 规模 |
|---|---|---|
| `byKey` | `(subject,category,sub)` → 题行 `{qid,diff,type,pcat,psub,chapter}`（JOIN questions+papers） | 69 分类 / 5.4 万行 |
| `groups` | `material_id` → `{subject, members[]}`（按卷序 q.id 升序；实测 material_id 全局唯一、无跨 subject 复用） | 2021 组 |
| `materialSetBySubject` | subject → 材料组题 Set（抽单题时排除） | 9568 题 |
| `paperCat` | question_id → papers.category（取代原逐题 paperCatCache） | 5.6 万 |

### 4.2 改写（签名与语义不变，调用点零改动）

- `pickSingle`：内存过滤（难度闭区间+NULL 排除 / `psub===subject` / 题型 IN / `srcMatch` / 材料组排除）→ Fisher-Yates 洗牌 → weak 时未做优先、不足回退全量；
- `pickGroups`：`GROUP BY HAVING size∈[min,max]` → 内存按组计数（`chapterLike` 的 `%x%` → `includes('x')`，支持数组多章节）；
- `groupQuestionIds`：组内题按卷序返回；
- `paperCategoryOf`：`paperCat.get(qid)` + 单查 fallback；
- 新增 `srcMatch(pcat, srcId)`：与 PAPER_SOURCES / ZHI_CE_SOURCES 的 cond 逐一等价（tikuA 子串 / tikuB-C Set / tikuD 精确 `选调|政法干警` / zcA-zcC、sd 精确 `=` / 无 id 兜底恒 true）；
- 新增 `practiceDoneQids()`：**动态数据**（practice_records）每次组卷实时查询，绝不缓存。

## 5. 验证结果（修复后实测）

- 行测 20/40/130/10 题：144/52/165/23ms；职测 A/B/C/山东：12-20ms；弱项加权 151ms；count=1/130/0 边界正常；
- 质量：题数达标、无重复 questionId、材料组完整（≥3 题）、6 模块覆盖、同参数两次组卷 0 重合（随机性保留）；
- hard 档组内题难度可低于档位下限——**原有行为**（整组入卷不按难度过滤，与旧 SQL 版 groupQuestionIds 一致），非回归；
- 职测 `count` 参数无效（按官方卷型固定题量）——原有设计，非本次改动。

## 6. 注意事项（给其他模块 AI）

1. **内存池依赖只读题库不变**：若运行中直接改 tiku.db / question_categories / q_material_map（如重爬库），需重启服务重新预热；重建 tiku.db 后**无需**重建索引——池是顺序扫描载入，天然免疫"漏建索引导致组卷变慢"问题；
2. **绝不把 practice_records（做题统计）放进池**：动态数据每次组卷实时查（`practiceDoneQids`）；
3. `LIAOKAO_SET` / `DULI_SET`（L467-468）与 PAPER_SOURCES.cond 是同一字面量，改动源列表时**两处必须同步**，否则 srcMatch 与 SQL 语义漂移；
4. `srcMatch` 的 tikuD 必须保持精确匹配 `('选调','政法干警')`（原 SQL `IN` 语义），不要改成 `includes('政法')`；
5. 改动文件：`server.mjs`（备份 `server.mjs.bak-组卷优化前-20260811-150306`，确认稳定后可删）；
6. 组卷接口返回结构未变：`{ total, questions:[{id,module,groupId,groupTotal,...}], sourceCounts, ... }`。

## 7. 本次改动文件清单

- `server.mjs`：新增 getPaperPool/srcMatch/practiceDoneQids + 改写 pickSingle/pickGroups/groupQuestionIds/paperCategoryOf（删除 paperCatCache）
- 备份：`server.mjs.bak-组卷优化前-20260811-150306`
