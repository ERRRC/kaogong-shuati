#!/usr/bin/env python3
import argparse
import datetime as dt
import json
from collections import Counter, defaultdict
from pathlib import Path


def read_jsonl(path):
    if not path.exists():
        return []
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def main():
    parser = argparse.ArgumentParser(description="Generate monthly wrong-answers report.")
    parser.add_argument("--user", required=True, help="User key")
    parser.add_argument("--month", default=None, help="YYYY-MM")
    parser.add_argument("--wrong-log", default=None, help="Wrong answers JSONL path")
    parser.add_argument("--answer-log", default=None, help="Answer records JSONL path")
    args = parser.parse_args()

    base_dir = Path(__file__).resolve().parent
    wrong_log_path = Path(args.wrong_log) if args.wrong_log else (base_dir / ".." / "data" / "wrong_answers.jsonl")
    answer_log_path = Path(args.answer_log) if args.answer_log else (base_dir / ".." / "data" / "answer_records.jsonl")

    month = args.month or dt.date.today().strftime("%Y-%m")

    wrong_rows = read_jsonl(wrong_log_path)
    wrong_rows = [r for r in wrong_rows if r.get("user_key") == args.user and str(r.get("date", "")).startswith(month)]

    answer_rows = read_jsonl(answer_log_path)
    answer_rows = [r for r in answer_rows if r.get("user_key") == args.user and str(r.get("date", "")).startswith(month)]

    total_wrong = len(wrong_rows)
    topic_counter = Counter(
        r.get("category") or r.get("topic") or "未分类"
        for r in wrong_rows
    )
    question_counter = Counter(r.get("question_id", "") for r in wrong_rows)

    total_counter = Counter()
    wrong_counter = Counter()
    for r in answer_rows:
        if not r.get("answered", True):
            continue
        cat = r.get("category") or r.get("topic") or "未分类"
        total_counter[cat] += 1
        if not r.get("correct", False):
            wrong_counter[cat] += 1

    lines = [f"# 月度错题报告（{month}）", "", f"用户：{args.user}", "", f"错题总数：{total_wrong}", ""]

    lines.append("## 题型错误率（本月）")
    if total_counter:
        for topic, total in total_counter.most_common():
            wrong = wrong_counter.get(topic, 0)
            rate = (wrong / total * 100) if total else 0
            lines.append(f"- {topic}：{wrong}/{total}（{rate:.1f}%）")
    else:
        lines.append("- 本月还没有答题记录，暂时无法计算错误率哦")

    lines.append("## 题型薄弱点（按错题数）")
    if topic_counter:
        for topic, cnt in topic_counter.most_common():
            lines.append(f"- {topic}：{cnt}")
    else:
        lines.append("- 本月暂无错题记录，继续保持～")

    lines.append("")
    lines.append("## 高频错题（Top 5）")
    if question_counter:
        for qid, cnt in question_counter.most_common(5):
            lines.append(f"- {qid}：{cnt} 次")
    else:
        lines.append("- 本月暂无错题记录，继续保持～")

    lines.append("")
    lines.append("## 建议")
    if topic_counter:
        top_topic = topic_counter.most_common(1)[0][0]
        lines.append(f"- 可以优先复盘“{top_topic}”相关题型，梳理常见陷阱。")
        lines.append("- 也可以针对高频错题整理错因与解题步骤，形成错题卡。")
    else:
        lines.append("- 继续保持刷题节奏，建议每周至少复盘一次。")

    print("\n".join(lines))


if __name__ == "__main__":
    main()
