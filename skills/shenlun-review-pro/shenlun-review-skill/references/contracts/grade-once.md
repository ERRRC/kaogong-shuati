# grade-once 紧凑批改契约

`grade-once` 是普通“批改后解析”的唯一评分入口。调用者只负责完成 OCR、阅读材料并给出必要的语义判断；稳定 ID、题型原型、方法路由、TaskSpec、analysis-result、score-ledger、材料范围和账本校验均由命令内部一次生成。已加载结构化工具时，经 `shenlun_grade_once` 提交 JSON 对象；序列化和引擎调用由工具内部完成。不得生成临时 Python、临时 JSON，不得读取源码、Schema 或命令帮助来试探字段；入口失败只允许根据一次错误列表统一修正一次。`reference_discovery` 可省略、写成状态字符串或只提供部分字段，入口会按本轮是否存在参考答案自动归一化。

MCP 可用时固定调用如下；不得把自然语言嵌入 Python 字符串，也不得再查 `--help`、argparse、源码或 Schema 确认接口：

- 评分：结构化工具 `shenlun_grade_once`，完整评分对象直接作为工具参数。
- 成稿：结构化工具 `shenlun_validate_user_output`，正文和 `output_validation_context` 直接作为工具参数。

若工具未直接显示，先用工具搜索查找 `shenlun_grade_once`。仍未加载或宿主不支持 MCP 时，小红书独立版使用下方安全入口；不得手工评分、临时文件或拼接 shell 输入。

小红书独立版或其他未加载 MCP 的宿主使用兼容入口：

```bash
python3 <skill_dir>/scripts/safe_review_runner.py grade-once
python3 <skill_dir>/scripts/safe_review_runner.py validate-user-output
```

兼容入口和 MCP 共用同一引擎、契约与评分口径。它只接受由宿主进程传入的结构化标准输入；不得用 heredoc Python、`python -c`、`eval/exec`、临时文件、shell 重定向、`echo` 或 `printf` 拼装输入。中文/英文引号、换行、反斜杠、`$()` 和反引号必须保持为 JSON 数据。脚本启动失败、JSON 解析失败和 60 秒超时均算一次失败；第二次失败或同错再现立即停止。

## 通用输入

最小通用输入必须提供：

- `question_text`：完整题干。
- `full_score`：题目满分。
- `material_text`：本题对应的完整材料，不是整卷无关材料。
- `user_answer`：清理 OCR 明显误识别后的完整考生作答。OCR 错误不作为扣分项。
- `points`：材料证据点及考生覆盖映射，至少一项。
- `point_pool_review`：一次说明材料点池已经完成查漏、拆并和背景/例子边界复核。

以下字段可省略，由入口确定性补齐，不需要读取配置或源码：

- `dimension_levels` / `dimensions`：小题已有逐点权重与整体复核时可省略；引擎只为展示生成题型维度，不改变逐点正式分。
- `task_components`、题型原型、方法卡、稳定 ID、账本 ID 和材料范围。
- `reference_available` 与 `reference_discovery`：建议显式填写；省略时按本次参考答案输入推导。若 `source_document_text` 存在答案区标记，仍会闭锁漏提取情形。

可选提供 expected_reference_answer_count：本轮用户明确指定的参考答案份数。若提供，必须等于当前输入中的参考答案数组长度；不一致时停止评分，不能混入历史答案或其他来源。

评分回执中的 `raw_center` 是已经档位、上限和区间约束后的未取整诊断值，`center_value` 是正式中心值，`unadjusted_raw_center` 仅用于开发追溯。`center_value` 与 `raw_center` 的取整差异不得超过 0.5，两者必须与档位区间一致。

## 任务边界

`question_text` 必须是原题完整题干，不能为了命中原型而改写。题型和可评分任务组件以原题为准，不以考生答案的结构为准。

“某主体如何解决/采取了什么办法解决”通常是归纳概括·做法/经验概括；只有题干要求考生提出、制定或建议措施，或明确要求分析原因并提出对策时，才走提出对策分支。不能仅因出现“问题”和“解决”就路由为提出对策。

`task_components` 可选；未提供时由引擎依据原题确定。提出对策题默认只有 `recommendation`；只有题干明确要求梳理问题、分析原因并提出建议/对策时，才使用 `problem_diagnosis` 或 `cause_analysis`。题目只要求对策时，提交 `point_role=problem` 或 `point_role=cause` 的 active required 点会被拒绝。

常用可选字段：`question_id`、`paper_id`、`min_length`、`max_length`、`length_unit`、`confidence_basis`、`reference_answers`。

必须显式提供 `point_pool_review`：

- `status`：`verified` 或 `disputed`。
- `evidence`：说明已如何检查材料遗漏、误拆、误合、重复、背景和例子边界。

引擎不再自动生成“已验证”的点池回执。

参考资料不能覆盖材料证据门槛。每个考生原句和参考答案候选都必须单独回到材料正文核验；参考答案中有、材料中无的词只能排除或标记待核对，不能因为参考答案也写了材料外词语就为考生免除准确性问题。
`reference_answers` 是紧凑参考资料数组。每项可直接写答案字符串，也可写对象：`answer_text`、`label`、`source_note`。历史输入中的 `source_type`、`reliability` 字段仍可保留，但只作追溯记录，不参与路由、点池权重、置信度或评分。参考资料只校准材料点和表达，不替代材料。

提供参考答案时还必须提供 `reference_calibration`：

- `status` 必须为 `verified`，`complete_review` 必须为 `true`。
- `candidates` 至少逐项覆盖每份参考答案中的候选信息。
- 每项填写 `candidate_id`、1 起算的 `answer_index`、参考答案原文 `candidate_text`。`included/merged` 必须填材料原文 `material_evidence`；`excluded` 可以将其置空，但必须写明排除理由且不得映射得分点。
- `disposition` 使用 `included`、`merged` 或 `excluded`。
- `included/merged` 必须填写 `mapped_point_ids`；`excluded` 必须填写具体 `reason`。

这份校准表用于证明参考答案中的材料支持内容没有无声消失；参考答案没有材料依据的内容仍不得进入点池。

引擎会计算候选片段对每份参考答案归一化正文的实际文字覆盖率，最低为 80%。标题、编号和少量连接词可以不进入候选片段，但漏掉整组实质内容后填写 `complete_review=true` 仍会校验失败。

参考答案不按来源分层处理。用户贴出的机构、教师、网友或其他渠道答案，统一按“有参考答案”走 `reference_assisted`；来源名称可以保留在 `label` 或 `source_note` 中，但不得改变其处理权重。若答案正文同时包含官方逐点评分细则，评分细则作为题面提供的明确规则单独核验，不能把普通答案正文当成官方扣分表。

处理整卷、题库或练习文档时，应同时传入 `source_document_text`。如果文档出现“参考答案”“答案解析”“参考作答”“评分参考”或“作答参考”等答案区标记，`reference_discovery.status` 必须为 `found`，并传入本题对应的 `reference_answers` 与 `reference_calibration`。发现答案区却未提取对应答案时，正式评分必须停止。

## points

每点必须提供：

- `point_text`：归纳后的得分功能。
- `material_evidence`：材料中的文字证据。优先填写一段连续原文或由多个连续原文片段组成的数组。数组中的片段是相互独立的证据摘录，各片段只需分别出现在材料中，不要求按材料顺序排列；跨段、跨人物或顺序不确定时必须使用数组。只有表示同一原文中省略中段时，才用省略号把多个片段压成一条字符串，并按材料出现顺序核验。所有片段都必须在材料中找到，不能用分段容错掩盖材料外内容。
- `coverage_status`：`完整覆盖`、`部分覆盖`、`等义表达`、`未覆盖`或`超出材料`。
- `user_quote`：除`未覆盖`外，必须是考生作答中的文字证据。
- `ocr_status`：可选，使用 `clear` 或 `uncertain`。标为 `uncertain` 时必须填写 `ocr_uncertainty_note`，不得据此把该点判为 `未覆盖` 或 `超出材料`；应补充清晰原稿或按部分覆盖/待核对处理。

材料外主张不得冒充材料点；放入 `extra_material_claims`，每项提供 `claim_id`、作答原文 `user_quote`和局部准确性问题 `reason`。它只进入局部准确性诊断，不扩充点池，不改变已覆盖点状态，也不伪造固定单点扣分。参考答案中出现同样词语不产生豁免。

小题逐点定档时还应提供：

- `point_value`：该点在当前点池中的内部相对权重；全部点值之和应等于题目满分。没有官方逐点细则时，不得将它宣称为确定的“漏一点扣 X 分”规则。
- `expansion_level`：`充分展开`、`基本展开`、`简略提及`、`仅列标题`或`未提及`。
- `importance`：`core`、`secondary`或`potential`。
- `point_role`：需要时使用 `fact`、`problem`、`cause`、`measure`、`effect`、`opinion`、`data`或`background`。

match_type 可省略，引擎按覆盖状态生成一致值。部分覆盖和未覆盖应提供具体 loss_reason；完整覆盖的通用得分原因由引擎补齐。critical_qualifiers 只填写会改变该点成立与否的功能性限定，不要把结果、荣誉、背景或普通例证列为必须复述的限定。

## 前置概括词审计

答案出现“执法更规范”“从专项整治到主动帮助”等前置概括词时，可提供 `leading_summary_reviews`。它是同一次得失账本的只读审计视图，不是新得分点，也不能重建点池。每项提供：

- `summary_quote`：前置概括词原文；状态为 `omitted` 时留空。
- `body_quote`：该概括词之后承载实质得分内容的作答原文。
- `point_ids`：后文实际映射的既有得分点。
- `status`：`accurate`、`omitted`、`imprecise` 或 `contradictory`。
- `reason`：判断依据。
- `deduction_owner`：仅 `contradictory` 可用，只能是 `准确有据` 或 `分类组织`。

引擎必须核验 `body_quote` 包含所映射点的用户证据，并返回 `leading_summary_audit`。`accurate`、`omitted`、`imprecise` 三种状态固定 `affects_point_coverage=false`、`score_invariant=true`，不得改变后文覆盖、点值、档位或分数；`imprecise` 只输出“概括词可优化”。只有前置词与后文形成实质相反关系时，才设为 `contradictory` 并触发准确性或组织维度的局部复核；即使如此，也不得自动抹除后文覆盖或伪造固定单点扣分。

变化题中，如果核心“前一种方式→后一种方式”已被后文写出，但部分展开细节缺失，用户可见表述统一为：“核心变化已覆盖，部分展开细节缺失；前置概括词略有偏差，但不影响后文实质得分。”不得简化为“完整覆盖”，也不得因概括词略有偏差直接降低实质点覆盖。

## 小题分支

归纳概括、综合分析和提出对策必须提供 `holistic_review`：

- `evidence`：整体复核依据。
- `overall_quality`：0—4。
- `order_logic_status`：推荐使用 `sound` 或存在严重断裂时使用 `broken`。
- `duplicate_status`：推荐使用 `none` 或确认重复时使用 `confirmed`。
- `structure_required`：题干是否明确要求层次/条理结构。
- `structure_status`：`clear`、`missing`或`not_applicable`。

小题的 `point_value` 有值时走逐点定档；不提供点值时只走维度整体评分。正常小题批改应提供点值，避免退化为普通 AI 式泛化维度评分。

## 应用文分支

贯彻执行必须提供 `application_review`：

- `identity_status`：`accurate`、`partial`、`wrong`。
- `genre_format_status`：`complete`、`partial`、`missing`。
- `purpose_audience_status`：`strong`、`adequate`、`weak`。
- `content_status`：`complete`、`partial`、`missing`。
- `structure_status`：`clear`、`partial`、`unclear`。
- `tone_status`：`appropriate`、`partial`、`wrong`。
- `template_use_status`：`appropriate`、`overgeneralized`、`not_applicable`。
- `evidence`：以上判断的作答证据摘要。

应用文的 `points` 用于检查材料内容和成效是否遗漏，但不逐点相加决定档位。题干明确要求的格式、内容或逻辑要素分别放入 `required_format_elements`、`required_content_elements`、`relation_requirements`，并在 `structure_ledger` 中一次性给出对应状态；不要先空跑再补字段。

## 大作文分支

申发论述必须提供现有 `essay_review` 整体审核对象。重点是中心立意、关系命题、分论点体系、材料转化、论证线和模板风险。`points` 只记录材料支撑及其使用情况，不得填写 `point_value`，不得把作文误转成小题逐点计分。

关系型作文必须让 `judgment_evidence` 中的题干关系引文和作文引文可定位；非关系型作文将 `prompt_relation_quote`、双方引文和关系桥接引文设为 `null`，并将关系状态设为 `not_applicable`。

## 固定执行顺序

### 普通任务预检与最短路径

调用前先在内部一次性检查以下输入是否齐全：完整原题、满分、对应材料、完整作答、题面字数约束、当前题型维度、每个材料证据是否为材料原文连续片段、每个用户证据是否为作答原文连续片段、参考答案发现状态。所有字段准备齐全后直接通过标准输入调用，不得先写中间文件，不得先运行再根据错误逐个补字段。

普通批改禁止读取引擎源码、枚举 Schema、调用多个 `--help`、列脚本目录、搜索内部函数或创建临时构造脚本。以上行为属于开发调试，不属于普通用户批改。

入口失败时，只允许修改第一次完整错误列表明确指出的路径，统一修正后重试一次；不得预防性改动其他已通过字段。第二次仍失败必须停止并报告门禁问题，不得继续试错、换字段、拆链路或改走旧命令。普通运行不向用户展示中间调试动作。

普通批改只执行：

1. OCR、定位题号和本题材料范围。
2. 一次建立当前题型所需的证据对象。
3. 调用一次 `grade-once`。
4. 根据返回结果生成“批改后解析”。
5. `grade-once` 返回 `selected_method_guides`（中文方法名、步骤、边界）与 `output_validation_context`。直接用这些中文方法写“方法”小节或自然方法说明，不再搜索方法卡文件；将完整最终回复连同该上下文一次性提交 `validate-user-output`。若回复含技能生成的完整参考答案，同时传入该答案正文 `reference_answer_text`，最终校验会按题面上下限完成字数核验，不得另跑 `check-word-count`。只发送返回的 `approved_text`，不得校验后追加内容。方法说明不要求固定标题、编号、冒号或 Markdown 形态，但必须出现方法名称和可复用操作步骤。

批改方法由同一次入口合并加载：解析路由负责“题干怎么拆、同类题怎么做”，批改路由负责“如何核对考生作答”。输出只展示中文方法名称和操作步骤，不展示方法卡 ID。调用方不得因缺少方法讲解再次搜索方法库。

用户可见批改必须把同一次评分结果转译成教学顺序：题干责任→方法使用→逐句/逐条证据→主要失分与修复→档位和建议分。不得先报分再补解释，也不得在逐条点评之前重新扫描材料或另建一套点池。

禁止在这条链路中读取引擎源码、枚举 Schema、调用多个 `--help`、创建临时构造脚本，或逐个补齐内部 ID。完整审计和状态写回才允许展开底层命令。

二稿比较时，两稿必须由同一套点定义、点值和材料证据评分。`grade-once` 返回稳定的 `point_pool_fingerprint`；`compare-drafts` 只接受指纹相同的两份结果。

逐点评分的 `holistic_review` 只用于整体定档、结构门禁和高档上限，不得单独把同一档内的中心分压到点分 raw_center 以下；如果 raw_center 更高，最终中心值不得反向降低。

用户要求重新批改或更换参考答案时，必须重新调用 grade-once 生成新的评分回执；旧报告、旧评分结果或手工改写的 Markdown 不能作为本轮正式分数依据。

## 逐句与逐段诊断

逐句批改不是逐句机械扣分。小题或应用文默认由引擎根据同一次 point ledger 自动生成 `sentence_audit`：把考生原句映射到既有得分点、覆盖状态、得失理由和修改动作。它不重新分析材料、不新增得分点，也不改变已经完成的评分；人工提供同名字段只用于校准自动视图。

大作文默认由引擎根据同一次 `essay_review` 的分论点审计、关系判断和材料转化证据，结合 point ledger 自动生成 `paragraph_audit`。它只把既有整体判断投影到每一段，不另设段落分数。用户可见批改默认按段落展开：段落功能、总论点关系、论据使用、事实—分析—观点转化、题干关系展开和修改动作必须来自同一次 `essay_review`；不把普通句式差异当作独立扣分项，也不得为逐段展示再次扫描材料或重新定档。
