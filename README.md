# fenbi-crawler —— 粉笔题库爬虫骨架 + 考公刷题 Web 应用

照搬 [`dduutt/fenbi`](https://github.com/dduutt/fenbi)（MIT）的接口逻辑，用 **Node.js 零依赖** 重写（内置 `fetch` + `crypto`，无需 `npm install`）。在采集数据之上构建了完整的前后端刷题应用。

> ⚠️ **版权与合规**：数据版权归粉笔。本骨架仅用于个人学习、自用验证，**请勿商用分发**。爬取会消耗对方服务器资源，请控制频率、谨慎使用。

## 前端 UI（Ocean Depths 主题，已重设计）

- **深蓝青调视觉**：深海蓝 `#1a2332` / 青绿 `#2d8b8b` / 海沫 `#a8dadc` / 奶油 `#f1faee`
- **深浅双模式**：右上角 🌙/☀️ 手动切换（localStorage 记忆），默认跟随系统（`prefers-color-scheme`），防闪烁初始化脚本
- **答题卡质感签名元素**：首页 Hero「学习档案」渐变卡、题库试卷封面卡（顶部青绿条+套数/题数）、刷题页顶部答题进度条、选项字母徽章（选中/正确/错误三态）、底部毛玻璃导航+激活指示点
- 移动端优先（430px 适配）+ 桌面居中（≥720px 三列网格）+ 安全区适配 + `prefers-reduced-motion` 尊重
- 所有颜色/间距走 CSS 变量 token，深浅模式一键切换

## 模块树（粉笔 1:1 复刻）

- 从粉笔官网（fenbi.com/spa/tiku/guide/catalog/xingce）抓取**真实知识点目录树**，存于 `lib/fenbi-tree.mjs`
- 三级结构：**大模块**（政治理论/常识判断/言语理解与表达/数量关系/判断推理/资料分析）→ **子模块**（如判断推理→图形推理/定义判断/类比推理/逻辑判断）→ **知识点**（如图形推理→位置规律/样式规律/属性规律…）
- 每个大模块首个子项为「全部」（该模块全部题混刷）；无知识点细分的子模块点击直接刷题
- 章节（53 种真题章节名）通过 `mapChapterToNode` 映射挂载到粉笔树节点，各节点题量/已做/正确率实时计算
- 说明：粉笔知识点（keypoint）接口已不开放，题目 JSON 也无知识点 ID，故**知识点级过滤到章节粒度**（视觉 1:1，数据为最大可用粒度）

## 主观题题库树（申论/综应/事业编）

- **申论**（公务员·申论）使用**标准五题型树**（2026-08 重构，不再与综应共用）：归纳概括题（问题/做法经验/原因/变化特点）、综合分析题（词句理解/观点评析/现象分析/关系分析）、提出对策题（单一对策/概括+对策）、贯彻执行题（讲话发言/宣传倡议/总结汇报/简报短评/书信回复/方案提纲）、文章写作题、其他 —— 定义见 `lib/fenbi-tree.mjs` `SHENLUN_TREE`，分类器 `classifyShenlun`（`lib/essay-classifier.mjs`）
- **综应/事业编**沿用粉笔**主观题题型树**（从 fenbi.com 抓取）：案例分析题（全部/单一题/综合题）、实务处理题（全部/谈话沟通类/应急应变类/活动组织类）、公文写作题（全部/总结/发言/宣传/其他/权威/启事/材料/文章/方案类）
- **事业编**：主观题章节映射到题型树；客观题（单选/判断/多选/不定项/填空 11.9 万题）归「客观题」大模块按题型分子模块
- **申论/综应**（无章节）：按题干关键词分类到题型树节点（`lib/essay-classifier.mjs` 规则分类器），索引存 practice.db `question_categories` 表（`build-category-index.mjs` 生成），节点题量/已做实时聚合
- `GET /api/practice?group=归纳概括题&sub=概括问题类` 按树节点出题；前端点击节点直接刷题

## 能做什么

1. **登录**（密码 RSA 加密，与粉笔前端一致）
2. **拉取分类列表**（国考 / 各省 / 事业单位……）
3. **拉取某分类下的真题试卷列表**
4. 为每套卷子**创建练习**拿到 exerciseId
5. 尝试拉取**题目 JSON**（接口可能变更，失败会自动跳过）
6. 下载**真题 PDF**

## 环境要求

- Node.js ≥ 18（本机 24 可直接用）

## 使用

### 方式 A：复用浏览器登录态（推荐，不用填密码）

你的浏览器已登录粉笔时，直接把登录 Cookie 给爬虫：

1. 打开粉笔网页版（`fenbi.com`），按 `F12` 打开开发者工具
2. 切到 **Network（网络）** 标签，刷新页面
3. 在请求列表里点任意一条 `tiku.fenbi.com` 的请求 → **Headers（标头）** → 找到 `Cookie:` 一行的完整值，整行复制（从 `Cookie:` 后面开始到行尾）
4. 粘贴到项目根目录新建的 `cookie.txt`（已加入 .gitignore，不会被 git 提交）

```powershell
# 验证 Cookie 是否有效（能打印出分类列表就说明有效）
npm run dry-run

# 采集全部题库（行测 + 申论 + 事业编，含模拟题，约 1.2 万套，很久）
node crawl-all.js

# 分批采集：每批最多 4000 套，已采过的自动跳过（断点续爬）
node crawl-all.js --budget=4000
node crawl-all.js --budget=4000   # 再跑一次，接着采第二批

# 采集完成后：JSON → SQLite 单库入库（约 1 分钟，去重 + 断点续写）
node import-to-sqlite.mjs

# 校验：端到端验证（章节 / 性能 / 答案覆盖率）
node verify-db.mjs
node e2e-check.mjs

# 跳过模拟题分类（国考模拟题/省考模拟题/公基模拟题）
node crawl-all.js --skip-mock

# 只采某个题库 / 每分类限 N 套 / 只看计划
node crawl-all.js --subject=shenlun
node crawl-all.js --limit=5
node crawl-all.js --dry-run
```

### 方式 B：账号密码登录

```powershell
# 1. 先看分类（不登录，预期会 401，用来确认接口可达、需要登录态）
npm run dry-run

# 2. 配置账号（二选一）
#    方式 A：编辑 config.js 填写 phone / password
#    方式 B：环境变量
$env:FENBI_PHONE="你的手机号"; $env:FENBI_PASSWORD="你的密码"

# 3. 修改 config.js 里的 categories（先 dry-run 看有哪些分类名）
#    然后运行：
npm start
```

两种方式共用的覆盖写法：

```powershell
node crawl.js --category=国考,江西 --limit=5
node crawl.js --cookie="粘贴的Cookie字符串"   # 临时指定 Cookie，优先级最高
```

输出结构（`out/` 下按题库 + 粉笔官网分类组织）：

```
out/
├── 公务员·行测/国考/2026年国家公务员录用考试《行测》题（...）.json
├── 公务员·申论/国考/2026年国家公考《申论》题（...）.json
│                          └── 同名 .pdf（给定资料，申论/事业编自动附带）
└── 事业编/山东/2024年3月10日山东省事业单位招聘统考试题（...）.json
```

每个 JSON 是清洗后的结构化数据：`subject / category / name / chapters / questions[]`，每题含 `id / type / content / options / answer / analysis / source / difficulty` 等字段。

## 目录结构

```
fenbi-crawler/
├── config.js        # 账号 / 分类 / 数量限制
├── crawl.js         # 单题库快速验证流程（旧版，轻量）
├── crawl-all.js     # 全量采集器（三题库 / 分片 / 断点续爬）
├── import-to-sqlite.mjs  # JSON → SQLite 入库（去重 / 断点续写）
├── backfill-chapters.mjs # 按章节计数回填题目章节名（入库后跑一次）
├── verify-db.mjs    # 数据库抽样验证
├── e2e-check.mjs    # 端到端刷题场景验证
├── tiku.db          # 生成的题库单文件库（行测+申论+事业编全量）
├── materials.db     # 申论/综应材料库（从真题 PDF 提取"材料1..N"分块，约 2400 块）
├── extract-materials.py  # PDF → materials.db 材料提取（pypdf，597 卷 / 2389 块 / 0 失败）
├── recommend-pdf.mjs     # 用粉笔系统预生成练习直接下载 PDF（绕开创建练习风控）
├── slow-backfill.mjs     # 慢速补采：低频创建练习补缺 PDF（8-15 分钟/套，403 自动冷却）
├── lib/
│   ├── encrypt.js   # 登录密码 RSA 加密（自测：npm run test:encrypt）
│   ├── api.js       # 接口封装（login / subLabels / papers / exercises / questions / pdf）
│   └── extract-cookie.mjs  # 从调试端口浏览器提取登录 Cookie
├── cookie.txt       # 登录态（.gitignore 已排除）
└── package.json
```

## 申论/综应材料系统

- **材料来源**：粉笔真题 PDF（`out/<题库>/<分类>/*.pdf`），`extract-materials.py` 用 pypdf 提取"给定材料…作答要求"区间，按 `材料N` 标题切块写入 `materials.db`（`paperId, title, idx, text`，paperId 按文件名匹配 tiku.db papers 表）。
- **接口**：`GET /api/ai/material?paperId=N` 返回 `{text, blocks, source}`（分块合并全文）；`GET /api/papers/:id/materials` 返回块列表。前端申论/综应刷题页自动加载"📄 给定材料"折叠面板；AI 批改时按题干"给定资料N"引用精确取块。
- **覆盖范围**：国考/山东/江苏/浙江/湖南/湖北/陕西/福建/贵州/重庆/黑龙江/辽宁/青海/甘肃/安徽/北京/西藏/选调生/小模考 + 综应山东等约 597 卷。**缺**：上海/广东/四川/河北/江西/吉林/天津/河南/云南/山西/深圳/广西/海南/新疆/内蒙古/广州/新疆兵团/公安招警等约 540 卷（创建练习接口被风控，`slow-backfill.mjs` 后台低频自动补，下载后重跑 `extract-materials.py` 即入库）。

## 已知限制 / 后续要做的

- **行测/职测题目 JSON 无文本解析**：爬虫用的 `GET /api/{subject}/questions?ids=` 接口只返回题干/选项/答案（`correctAnswer.choice`），**JSON 里没有 `analysis` 字段**（2026-08 实测确认）。网页版"解析"实际来自另一个接口 `GET /api/{subject}/solutions?ids=`（返回 `solution` HTML + `keypoints` 等），**该接口需登录，游客 401**；爬虫当年是游客模式，故 95,867 题 `analysis` 全空。2026-08 已用 4 账号轮换补爬（`fetch-solutions.mjs`，零风控）：**84,867 题已有官方解析**（行测 100% 全覆盖、职测 25.3%、申论 2.3%，综应官方无解析走 AI）。解析已全链路接入：Web 端（`server.mjs`/api/practice、/api/question 返回 `analysis`）+ App 端（`build-app-assets.mjs` 数据包含 `analysis` 列，做题中「查看解析」/交卷页每题直接展示官方解析，AI 解析按钮保留作补充）。
- **申论/综应无官方参考答案**：`correctAnswer` 为 `null`，给定资料在配套 PDF 里。AI 批改需要模型自己生成参考答案 + 评分。
- 登录可能遇到验证码 / 风控，接口参数（`kav/av/hav/version`）如果失效需要按新版前端逆向更新。
- 反爬策略（IP 封禁等）未处理，脚本已内置限速抖动，请勿并发多开。

## SQLite 题库库（tiku.db）

`import-to-sqlite.mjs` 把 `out/` 下全部 JSON 汇总为单文件库（约 1.2 GB，1.15 M 题），供刷题 App 直接读取：

```
papers     试卷：id / subject(题库) / category(省份/国考) / name / questionCount / chapters(JSON)
questions  题目：questionId / paperId / chapter / type / content / options(JSON) / answer / answerIndex
```

- 同一道题出现在多套卷时按 `(paperId, questionId)` 去重保留各自引用
- 行测/职测：`answerIndex` 可直接判分（单选字母转索引）；多选题 answer 是数组（如 `[0,1,3]`），判分在应用层处理
- 申论：`correctAnswer` 为空 → 正好由 App 的 AI 批改生成参考答案

## AI 智能体配置系统（ai-config.db）

五个 AI 角色（行测解析 / 申论批改 / 学习进度顾问 / 识图转写员 / 综应申论文字提取员）独立可配置，浏览器打开 `http://localhost:3000/?view=ai`（或底部导航 🤖 AI）管理：

- **prompt / skill**：随时改，保存立即生效（热更新），变更自动存版本历史可回滚
- **API Key / URL**：每个 AI 独立 base_url + api_key + model，OpenAI 兼容协议（DeepSeek/通义/GLM/OpenAI/本地 Ollama 都行）
- **测试按钮**：保存前先用真实 LLM 试跑
- 数据存 `ai-config.db`（ai_agents + prompt_history 表），tiku.db 保持只读
- 调用接口：`callAgent(agent, userContent)` 实时读库，改完即生效
- **行测 AI 解析已接入刷题界面**：答完题点「🤖 AI 解析本题」即出解析（考点/正确项/错项排除/技巧）
- **含图题识图管线**：图形推理/图表题自动走「视觉模型识图转写 → deepseek 解析」两段式——先由多模态 AI 把图片转成文字描述，再喂给行测解析 AI，无需人工看题即可出解析；识图转写内容可展开查看。当前识图模型 **GLM-4V-Flash**（智谱，免费稳定），含 429 限流自动重试（3 次退避）与 max_tokens 自适应降级（部分模型上限仅 1024）；GLM-4.6V-Flash 实测当前限流频繁，可在 AI 设置页切换
- **性能优化**：推理模型默认带 `reasoning_effort=low`，抑制超长思维链（之前复杂题 40~90s + 输出被截断，现在 5~15s 稳定出解析）；不支持该参数的网关自动回退

五个 AI 角色（行测解析 / 申论批改 / 学习进度顾问 / 识图转写员 / 综应申论文字提取员）独立可配置；识图转写员与综应申论文字提取员为多模态（mimo-v2.5-free），key/url 可单独覆盖。**注意**：AI 设置页的 API Key 输入框为脱敏占位，空值保存不会覆盖已配置的 key（2026-08 修复）。

## 做题记录（服务端落库）

- 判分后自动写入 `practice.db`（可写，独立于只读 tiku.db），**手机/电脑跨设备同步**，也是学习进度 AI 的数据源
- 接口：`POST /api/records`（提交）、`GET /api/records/stats`（总数/正确率/按章节/近7天/每日）、`GET /api/records/wrong`（错题本，联表题目内容）、`DELETE /api/records/wrong`（清空，软删除保留历史）、`GET /api/records/recent`（最近 50 条）
- 错题本已从 localStorage 迁移到服务端；清空错题仅标记 archived，统计历史完整保留
- 表：`practice_records(question_id, paper_id, subject, chapter, question_type, selected, is_correct, cost_ms, archived, created_at)`

## 申论/综应 AI 批改（已接入刷题界面）

- 申论/综应主观题页面：作答框输入答案 → 点「🤖 AI 批改」→ 自动提取题干分值（如 15 分）→ AI 按【总分/评分明细/优点/不足/修改建议/参考思路】格式批改，20~60 秒出结果
- 批改调用真实 LLM（shenlun-grader 智能体），作答自动落库 practice_records（主观题 is_correct=NULL，计入做题数不计正确率）
- **识图导入作答（OCR）**：申论作答区「📷 拍/选答案图片」→ 前端 canvas 压缩（≤1200px/JPEG）→ `POST /api/ai/ocr` 调 GLM-4V-Flash 逐字转写手写/打印答案 → 自动填入作答框（可编辑）→ AI 批改。实测 1.7s 识别 5 行文字含标点
- 材料关联：**已完成**——题干含 [materialid] 标记、材料正文在真题 PDF 中（矢量字形无法 zlib 提取），通过「Chrome headless 渲染 PDF 每页 → GLM-4V-Flash OCR」自动提取，缓存到 practice.db 的 materials 表（paper_id 主键），批改时自动带材料对照要点评分。首次提取约 1~5 分钟（16 页 OCR），之后永久缓存秒回

## 学习进度顾问（AI 学习建议，已接入）

- 首页「📊 学习进度」：统计概览（做题数/正确率/错题）+ 各模块正确率排行 + 「✨ 生成学习建议」
- `POST /api/ai/progress`：自动组装做题数据（总量/各题库/各模块/近7天趋势）→ 调 progress-coach 智能体 → 输出【总体评估/数据亮点/薄弱环节/趋势分析/下一步行动】
- 建议基于真实数据（模块正确率、样本量、时间趋势），具体到模块/题量/频次；实测 13~20 秒返回

## 参考

- 接口逻辑：https://github.com/dduutt/fenbi
- 申论/综应题库数据（Markdown，4886 题，可直接下载）：https://github.com/2421873411a-rgb/gongkao-tiku

