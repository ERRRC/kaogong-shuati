---
name: daily-gongkao
description: 为 OpenClaw/QClaw 构建并运行“公考刷题”训练流程：用户请求时推送行测选择题、接收并批改答案、记录错题到持久化记忆、生成月度错题报告。适用于需要搭建日常刷题与复盘闭环的聊天式学习助手场景。
---

# Daily Gongkao

## 概述

实现行测刷题、自动批改、错题沉淀与月度报告的完整闭环，通过用户请求按需触发推送。
重要：不得自行生成或改写题目内容给用户，推送题目必须来自题库，且题干内容保持原样不做改动。
重要：不得自行生成或改写月度错题报告内容给用户，月度错题报告内容必须保持原样不做改动。

## 快速开始

- 生成题目并发送给用户（按需触发，每次随机）：

```bash
python scripts/daily_push.py --user wx_zhangsan
```

- 批改用户答案并记录错题：

```bash
python scripts/grade_answers.py --user wx_zhangsan --answers "1A 2C 3D 4B 5A"
```

- 生成月度错题报告：

```bash
python scripts/monthly_report.py --user wx_zhangsan --month 2026-03
```

## 工作流

### 1. 按需触发推送（用户请求时）

- 为用户创建稳定的 `user_key`，优先使用消息平台提供的用户唯一标识；没有唯一标识时，引导用户设置昵称并写入本地映射。
- 当用户在聊天中触发“开始刷题/来 5 题/继续”等意图时，由 Agent 调用 `daily_push.py` 并把输出发送给用户。

### 2. 推送题目

- 使用 `daily_push.py` 根据题库与用户历史记录挑选题目，默认随机一份试卷、随机一种题型推送 5 题；支持指定题型与数量。
- 每次运行都会随机抽题并覆盖 `state.json` 中的 `current_batch`，不再按“同一天复用”限制。
- 在推送文本中包含题目与选项，并要求用户以“1A 2C 3D 4B 5A”格式回复（多选可多字母，如 1AC；判断题只选 A/B）。提示用户可指定题型与数量。
- 当用户指定题型时：
  - 若题型不存在、题量不足，或该题型仅包含资料分析/含图片题目，需提示用户当前不支持，并告知可用题型列表。
  - 建议提示文案：`该题型暂不支持。可用题型：{可用题型列表}。`

### 3. 批改与反馈

- 在用户回复后，调用 `grade_answers.py` 批改并生成解析。
- `grade_answers.py --answers "1A 2C ..."` 会按 `state.json` 中 **当前 `current_batch` 的顺序**映射答案，因此多次推送时默认评分的是**最后一次**推送的题目。
- 在反馈中包含对错、正确答案与解析，并以“名师风格”补充总结性点评：
  - 先给总评（做题状态、速度与准确率印象）。
  - 再逐题点出易错点与方法。
  - 末尾给出 1-2 条可执行的复盘建议。

### 4. 错题沉淀（持久化记忆）

- 将错题写入 `data/wrong_answers.jsonl` 作为持久化错题本。
- 若运行环境提供 OpenClaw 的持久化记忆工具，优先写入该工具，并保留本地文件作为备份。
- 使用字段：`date`、`user_key`、`question_id`、`topic`、`user_answer`、`correct_answer`。
- 同时记录每次答题明细到 `data/answer_records.jsonl`，用于统计题型错误率。

### 5. 月度错题报告

- 使用 `monthly_report.py` 按月汇总错题，生成 Markdown 报告。
- 在报告中包含：错题总数、题型错误率、题型薄弱点、高频错题、复盘建议。
- 可在每月 1 日 09:00 由 Agent 主动生成并推送（或由外部调度调用）。

### 6. OCR 解析与题库导入（MinerU）

- 将 PDF 试卷放入 `data/raw_pdfs/`。
- MinerU 源码安装（示例）：

```bash
git clone https://github.com/opendatalab/MinerU.git
cd MinerU
conda create -n mineru python=3.10
conda activate mineru
pip install uv -i https://mirrors.aliyun.com/pypi/simple
uv pip install -e .[all] -i https://mirrors.aliyun.com/pypi/simple
```

- 如果您的设备满足上表中 GPU 加速的条件，可以使用简单的命令行进行文档解析：
- `-p` 既支持目录，也支持传入单个 PDF 文件进行试卷解析（单文件会输出到指定的 `-o` 目录）：

```bash
mineru -p data/raw_pdfs -o data/ocr_results --source modelscope
```

- 如果您的设备不满足 GPU 加速条件，可以指定后端为 pipeline，以在纯 CPU 环境下运行：

```bash
mineru -p data/raw_pdfs -o data/ocr_results -b pipeline --source modelscope
```


- 将 OCR 结果转换为题库草稿（默认每份试卷一个 JSON）：
- `scripts/ocr_to_question_bank.py --input` 支持多试卷目录或单试卷目录（单试卷目录会生成 1 个题库 JSON，多试卷目录会生成所有试卷的题库 JSON）：

```bash
python scripts/ocr_to_question_bank.py --input data/ocr_results --output data/ocr_question_bank
```

- 在 `data/ocr_question_bank/` 中补全答案与分类后，作为题库数据来源。
- 说明：目录输入默认按试卷分文件输出（更便于管理）。

## 脚本用法（给 Agent 用的执行说明）

### 1) `scripts/daily_push.py`

用途：从题库中抽题并输出推送文本（或 JSON），同时更新 `data/state.json` 的用户状态。

命令：

```bash
python scripts/daily_push.py --user wx_zhangsan
```

常用参数：
- `--user` 必填，用户唯一标识。
- `--count` 题量，默认 5。
- `--category` 指定题型（例如“数量关系”）；若题型不支持会报错并给出可用列表。
- `--bank` 题库路径（目录或单个 JSON 文件）。
- `--state` 状态文件路径。
- `--date` 指定日期（影响标题与当日逻辑），默认今天。
- `--format` 输出格式：`text` 或 `json`（默认 `text`）。

行为要点：
- 每次运行都会重新随机抽题，并覆盖 `state.json` 的 `current_batch`。
- 会跳过“资料分析”和带图片的题目。
- 会尽量避免重复出题；当可用题不足时，会重置并允许重复。
- 当指定题型题量不足 `--count` 时，会把该题型全部推送并附提示。

JSON 输出字段（当 `--format json`）：
- `date`、`user_key`、`question_ids`、`paper_id`、`message`。

### 2) `scripts/grade_answers.py`

用途：批改答案、生成解析，并写入错题与答题记录。

命令（按题号顺序答题）：

```bash
python scripts/grade_answers.py --user wx_zhangsan --answers "1A 2C 3D 4B 5A"
```

命令（按题目 ID 映射答题）：

```bash
python scripts/grade_answers.py --user wx_zhangsan --answers-file data/answers_map.json
```

`answers_map.json` 格式示例：
- 字典：`{"Q001": "A", "Q002": "BD"}`
- 或列表：`["A", "C", "D", "B", "A"]`（要求与 `current_batch` 等长）

常用参数：
- `--user` 必填，用户唯一标识。
- `--answers` 按“题号-答案”格式（会映射到 `current_batch`）。
- `--answers-file` JSON 文件（字典或列表）。
- `--bank` 题库路径（目录或单个 JSON 文件）。
- `--state` 状态文件路径（用于读取 `current_batch`）。
- `--wrong-log` 错题记录 JSONL 路径。
- `--answer-log` 答题明细 JSONL 路径。
- `--format` 输出格式：`text` 或 `json`。
- `--no-log-wrong` 不写入错题本。

行为要点：
- 使用 `--answers` 时，会按 `current_batch` 顺序映射；若当天多次推送，默认批改最后一次推送的题目。
- 使用 `--answers-file` 的字典格式可绕过 `current_batch`，按题目 ID 直接批改。
- 当回答数量不足时，未作答题目会记录为“未答”，但不计入月度统计。

### 3) `scripts/monthly_report.py`

用途：按月汇总错题与错误率，输出 Markdown 报告（打印到 stdout）。

命令：

```bash
python scripts/monthly_report.py --user wx_zhangsan --month 2026-03
```

常用参数：
- `--user` 必填，用户唯一标识。
- `--month` 月份（YYYY-MM），默认当月。
- `--wrong-log` 错题记录 JSONL 路径。
- `--answer-log` 答题明细 JSONL 路径。

### 4) `scripts/ocr_to_question_bank.py`

用途：将 MinerU OCR 输出的 Markdown/TXT 转为题库 JSON（每份试卷一个文件）。

命令：

```bash
python scripts/ocr_to_question_bank.py --input data/ocr_results --output data/ocr_question_bank
```

常用参数：
- `--input` OCR 输出路径（文件或目录）。
- `--output` 输出目录（必须为目录，不能是 .json）。
- `--id-prefix` 题目 ID 前缀（默认 `OCRYYYYMMDD_XX`）。

## 数据与文件

- 题库目录：`data/ocr_question_bank/`
- 状态文件：`data/state.json`
- 错题本：`data/wrong_answers.jsonl`
- 答题明细：`data/answer_records.jsonl`

`data/state.json`（核心字段）：
- `users.{user_key}.current_batch`：最近一次推送的题目 ID 列表。
- `users.{user_key}.last_push_date`：最近推送日期（YYYY-MM-DD）。
- `users.{user_key}.used_question_ids`：该用户已出现过的题目 ID（用于去重）。
- `users.{user_key}.last_category` / `last_paper` / `last_count`：最近一次推送的题型/试卷/题量。

## 题库维护

- 按照现有 JSON 结构新增题目，确保 `id` 唯一。
- 控制题目难度与题型覆盖，优先补齐常识应用（含判断/多选）、言语表达与理解、数量关系、判断推理。
- 题库不足时允许重复抽题；长期运行时确保至少 200 题。

## 资源

### scripts/
- `daily_push.py`：生成题目并更新状态。
- `grade_answers.py`：批改答案并记录错题。
- `monthly_report.py`：生成月度错题报告。
- `ocr_to_question_bank.py`：将 OCR 输出转为题库草稿。

### data/ocr_question_bank/
- OCR 生成的题库文件目录（每份试卷一个 JSON）。
