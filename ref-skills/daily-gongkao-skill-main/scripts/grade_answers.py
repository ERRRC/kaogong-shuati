#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import re
from pathlib import Path


def load_json(path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_bank(data):
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    if isinstance(data.get("questions"), list):
        return data["questions"]

    categories = None
    if isinstance(data.get("categories"), dict):
        categories = data["categories"]
    elif all(isinstance(v, list) for v in data.values()):
        categories = data

    if categories is None:
        return []

    flat = []
    for category, items in categories.items():
        if not isinstance(items, list):
            continue
        for q in items:
            if not isinstance(q, dict):
                continue
            row = dict(q)
            row.setdefault("category", category)
            row.setdefault("topic", category)
            flat.append(row)
    return flat


def load_bank_from_path(path: Path):
    if path.is_dir():
        items = []
        for file_path in sorted(path.glob("*.json")):
            data = load_json(file_path, None)
            if data is None:
                continue
            items.extend(normalize_bank(data))
        return items
    return normalize_bank(load_json(path, []))


def normalize_answer(raw):
    letters = [c for c in str(raw).upper() if c in "ABCD"]
    unique = []
    for c in letters:
        if c not in unique:
            unique.append(c)
    return "".join(sorted(unique, key="ABCD".index))


def parse_answer_mapping(raw):
    pairs = re.findall(r"(\d+)\s*([A-Da-d]+)", raw)
    mapping = {}
    for num, ans in pairs:
        try:
            idx = int(num)
        except ValueError:
            continue
        mapping[idx] = normalize_answer(ans)
    return mapping


def load_answers_mapping(answers_file):
    data = json.loads(Path(answers_file).read_text(encoding="utf-8"))
    if isinstance(data, dict):
        return {k: normalize_answer(v) for k, v in data.items()}
    if isinstance(data, list):
        return [normalize_answer(v) for v in data]
    raise ValueError("answers file must be dict or list")


def append_wrong_log(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def append_answer_log(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def main():
    parser = argparse.ArgumentParser(description="Grade gongkao answers.")
    parser.add_argument("--user", required=True, help="User key")
    parser.add_argument("--answers", default=None, help="Answer string like '1A 2C 3D'")
    parser.add_argument("--answers-file", default=None, help="JSON file: dict of qid->answer or list of answers")
    parser.add_argument("--bank", default=None, help="Question bank JSON path")
    parser.add_argument("--state", default=None, help="State JSON path")
    parser.add_argument("--wrong-log", default=None, help="Wrong answers JSONL path")
    parser.add_argument("--answer-log", default=None, help="Answer records JSONL path")
    parser.add_argument("--format", choices=["text", "json"], default="text", help="Output format")
    parser.add_argument("--no-log-wrong", action="store_true", help="Do not append wrong answers log")
    args = parser.parse_args()

    base_dir = Path(__file__).resolve().parent
    bank_path = Path(args.bank) if args.bank else (base_dir / ".." / "data" / "ocr_question_bank")
    state_path = Path(args.state) if args.state else (base_dir / ".." / "data" / "state.json")
    wrong_log_path = Path(args.wrong_log) if args.wrong_log else (base_dir / ".." / "data" / "wrong_answers.jsonl")
    answer_log_path = Path(args.answer_log) if args.answer_log else (base_dir / ".." / "data" / "answer_records.jsonl")

    if not bank_path.exists():
        raise SystemExit(f"抱歉，未找到题库路径：{bank_path}")

    bank = load_bank_from_path(bank_path)
    if not bank:
        raise SystemExit(f"抱歉，题库为空：{bank_path}")
    question_map = {q["id"]: q for q in bank}

    state = load_json(state_path, {"users": {}})
    user_state = state.get("users", {}).get(args.user, {})
    current_batch = user_state.get("current_batch", [])

    answers_mapping = None
    answers_list = None

    if args.answers_file:
        data = load_answers_mapping(args.answers_file)
        if isinstance(data, dict):
            answers_mapping = data
        else:
            answers_list = data
    elif args.answers:
        answers_mapping = parse_answer_mapping(args.answers)

    if answers_mapping is None:
        if not current_batch:
            raise SystemExit("抱歉，未找到本次题目记录；请提供包含题目 ID 的 --answers-file。")
        if not answers_list:
            raise SystemExit("还没有收到答案哦，请再检查一下。")
        if len(answers_list) > len(current_batch):
            raise SystemExit("你提供的答案数量多于本次题目数量，请检查一下。")
        if len(answers_list) < len(current_batch):
            answers_list = list(answers_list) + [""] * (len(current_batch) - len(answers_list))
        answers_mapping = {qid: normalize_answer(ans) for qid, ans in zip(current_batch, answers_list)}
    elif args.answers:
        if not current_batch:
            raise SystemExit("抱歉，未找到本次题目记录；请提供包含题目 ID 的 --answers-file。")
        if len(answers_mapping) > len(current_batch):
            raise SystemExit("你提供的答案数量多于本次题目数量，请检查一下。")
        answers_mapping = {
            qid: answers_mapping.get(idx, "")
            for idx, qid in enumerate(current_batch, 1)
        }

    results = []
    wrong_records = []
    answer_records = []
    date_str = dt.date.today().isoformat()

    for idx, (qid, user_ans) in enumerate(answers_mapping.items(), 1):
        q = question_map.get(qid)
        if not q:
            continue
        correct_answer = normalize_answer(q.get("answer", ""))
        user_norm = normalize_answer(user_ans)
        answered = bool(user_norm)
        correct = (user_norm == correct_answer) if answered else False
        category = q.get("category") or q.get("topic") or "未分类"
        result = {
            "index": idx,
            "question_id": qid,
            "category": category,
            "topic": category,
            "user_answer": user_ans,
            "correct_answer": correct_answer,
            "correct": correct,
            "answered": answered,
            "explanation": q.get("explanation", "")
        }
        results.append(result)
        answer_records.append({
            "timestamp": dt.datetime.now().isoformat(timespec="seconds"),
            "date": date_str,
            "user_key": args.user,
            "question_id": qid,
            "category": category,
            "topic": category,
            "user_answer": user_ans,
            "correct_answer": correct_answer,
            "correct": correct,
            "answered": answered
        })
        if answered and not correct:
            wrong_records.append({
                "timestamp": dt.datetime.now().isoformat(timespec="seconds"),
                "date": date_str,
                "user_key": args.user,
                "question_id": qid,
                "category": category,
                "topic": category,
                "user_answer": user_ans,
                "correct_answer": correct_answer
            })

    if wrong_records and not args.no_log_wrong:
        append_wrong_log(wrong_log_path, wrong_records)

    if answer_records:
        append_answer_log(answer_log_path, answer_records)

    total = len(results)
    score = sum(1 for r in results if r["correct"])

    if args.format == "json":
        print(json.dumps({
            "user_key": args.user,
            "score": score,
            "total": total,
            "results": results
        }, ensure_ascii=False, indent=2))
        return

    lines = ["【批改结果】", f"得分：{score}/{total}", "辛苦啦！以下是你的答题情况：", ""]
    for r in results:
        if not r.get("answered", True):
            status = "未答"
            user_display = "未作答"
        else:
            status = "正确" if r["correct"] else "错误"
            user_display = r["user_answer"] or "未作答"
        lines.append(f"{r['index']}. {status}（你的答案 {user_display}，正确答案 {r['correct_answer']}）")
        if r.get("explanation"):
            lines.append(f"解析：{r['explanation']}")
        else:
            lines.append("解析：如果需要更详细的讲解，随时告诉我。")
        lines.append("")
    print("\n".join(lines).strip())


if __name__ == "__main__":
    main()
