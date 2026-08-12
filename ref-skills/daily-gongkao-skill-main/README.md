# 每日公考 Skill（OpenClaw / QClaw）

面向公考（行测）刷题场景的聊天式学习技能。用户发起请求时推送题目、自动批改、沉淀错题，并生成月度复盘报告。适用于微信/QQ 等消息平台接入的本地智能代理。

## 亮点

- 按需推送：用户请求时推送题目，不依赖定时任务。
- 自动批改：支持用户按题号回复答案，快速得到对错与解析。
- 错题沉淀：自动记录错题与答题明细，便于复盘。
- 月度报告：按月统计错题与薄弱点，输出 Markdown 报告。
- 题库可扩展：支持 OCR 题库导入，易维护、可持续更新。

## 功能一览

- 题目推送：从题库中随机抽题，支持指定题型与数量。
- 批改与反馈：自动判断正误、给出解析提示。
- 错题本：写入 `data/wrong_answers.jsonl`。
- 答题明细：写入 `data/answer_records.jsonl`。
- 月度报告：按月汇总错题与题型错误率。

> 重要：题目内容必须来自题库，推送题干内容不做改写。

## 目录结构

- `SKILL.md`：技能说明与工作流
- `scripts/daily_push.py`：生成题目并更新状态
- `scripts/grade_answers.py`：批改答案并记录错题
- `scripts/monthly_report.py`：生成月度错题报告
- `scripts/ocr_to_question_bank.py`：OCR 结果转题库
- `data/ocr_question_bank/`：题库目录（JSON）
- `data/state.json`：用户状态（运行后生成）
- `data/wrong_answers.jsonl`：错题本（运行后生成）
- `data/answer_records.jsonl`：答题明细（运行后生成）

## 安装

将本仓库拷贝到 OpenClaw 技能目录中：

```bash
cp -rf daily-gongkao-skill ~/.openclaw/skills/
```

如需更新：

```bash
rm -rf ~/.openclaw/skills/daily-gongkao-skill
cp -rf daily-gongkao-skill ~/.openclaw/skills/
```

## 使用示例

### 1) 推送题目（用户请求时触发）

```bash
python scripts/daily_push.py --user wx_zhangsan
```

指定题型与数量：

```bash
python scripts/daily_push.py --user wx_zhangsan --category 数量关系 --count 5
```

### 2) 批改用户答案

```bash
python scripts/grade_answers.py --user wx_zhangsan --answers "1A 2C 3D 4B 5A"
```

说明：
- `--answers` 会按 `data/state.json` 中当前 `current_batch` 的顺序映射答案。
- 若回答数量不足，会记录“未答”，但不计入月度统计。

### 3) 生成月度报告

```bash
python scripts/monthly_report.py --user wx_zhangsan --month 2026-03
```

## 题库准备

题库文件放在 `data/ocr_question_bank/`，每份试卷一个 JSON。

如需从 OCR 结果快速生成题库草稿：

```bash
python scripts/ocr_to_question_bank.py --input data/ocr_results --output data/ocr_question_bank
```

`--input` 支持目录或单个试卷文件（单文件会生成 1 个题库 JSON）。

## 推荐工作流（给 Agent）

1. 用户请求刷题 -> 调用 `daily_push.py` 并发送输出。
2. 用户回复答案 -> 调用 `grade_answers.py` 并发送批改结果。
3. 定期复盘 -> 调用 `monthly_report.py` 输出报告并发送。

## 注意事项

- 题目内容必须来自题库，不要自行生成题目或改写题干。
- 题库不足时会允许重复抽题；建议长期维护题库数量（至少 200 题）。
- 本项目默认不依赖定时任务，如需定时推送可由外部调度触发脚本。

## 开源协议

请在使用前自行补充许可证信息。
