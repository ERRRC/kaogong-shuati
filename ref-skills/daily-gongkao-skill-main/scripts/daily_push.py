#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import random
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


def load_banks_from_path(path: Path):
    banks = {}
    if path.is_dir():
        for file_path in sorted(path.glob("*.json")):
            data = load_json(file_path, None)
            if data is None:
                continue
            items = normalize_bank(data)
            if not items:
                continue
            paper_id = file_path.stem
            for q in items:
                q.setdefault("paper_id", paper_id)
            banks[paper_id] = items
        return banks
    items = normalize_bank(load_json(path, []))
    if items:
        paper_id = path.stem
        for q in items:
            q.setdefault("paper_id", paper_id)
        banks[paper_id] = items
    return banks


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def classify_question(q):
    cat = q.get("category") or q.get("topic") or "未分类"
    image = q.get("image") or ""
    if image:
        return False, "image", cat
    if "资料分析" in cat:
        return False, "data", cat
    return True, None, cat


def format_questions(date_str, questions, category, paper_id, notice_lines=None):
    lines = [
        f"【每日公考·{date_str}】",
    ]
    if notice_lines:
        lines.extend(notice_lines)
    lines.extend([
        f"试卷：{paper_id or '未命名'}",
        f"题型：{category or '未分类'}",
        f"本次题量：{len(questions)}",
        "请开始作答，题目如下：",
        ""
    ])
    for idx, q in enumerate(questions, 1):
        category = q.get("category") or q.get("topic") or "未分类"
        lines.append(f"{idx}. ({category}) {q['question']}")
        options = q.get("options") or {}
        if isinstance(options, dict):
            for opt in ["A", "B", "C", "D"]:
                if opt in options:
                    lines.append(f"{opt}. {options[opt]}")
        elif isinstance(options, list):
            for opt in options:
                if isinstance(opt, dict) and "key" in opt and "value" in opt:
                    lines.append(f"{opt['key']}. {opt['value']}")
        lines.append("")
    lines.append("请按“1A 2C 3D 4B 5A ...”格式回复答案（多选可多字母，如 1AC；判断题只选 A/B）。")
    lines.append("温馨提示：你也可以指定题型与数量，例如“题型=数量关系 数量=5”。")
    return "\n".join(lines).strip()


def main():
    parser = argparse.ArgumentParser(description="Generate gongkao questions.")
    parser.add_argument("--user", required=True, help="User key")
    parser.add_argument("--count", type=int, default=5, help="Number of questions")
    parser.add_argument("--category", default=None, help="Question category (optional)")
    parser.add_argument("--bank", default=None, help="Question bank JSON path or directory")
    parser.add_argument("--state", default=None, help="State JSON path")
    parser.add_argument("--date", default=None, help="Date YYYY-MM-DD")
    parser.add_argument("--format", choices=["text", "json"], default="text", help="Output format")
    args = parser.parse_args()

    base_dir = Path(__file__).resolve().parent
    bank_path = Path(args.bank) if args.bank else (base_dir / ".." / "data" / "ocr_question_bank")
    state_path = Path(args.state) if args.state else (base_dir / ".." / "data" / "state.json")

    if not bank_path.exists():
        raise SystemExit(f"抱歉，未找到题库路径：{bank_path}")

    banks = load_banks_from_path(bank_path)
    if not banks:
        raise SystemExit(f"抱歉，题库为空：{bank_path}")
    if args.count <= 0:
        raise SystemExit("题量需要是正整数哦，请检查 --count。")
    total_questions = sum(len(v) for v in banks.values())
    if args.category is None and total_questions < args.count:
        raise SystemExit("题库题量暂时不足以满足本次题量，请稍后再试或调小题量。")

    date_str = args.date or dt.date.today().isoformat()

    state = load_json(state_path, {"users": {}})
    users = state.setdefault("users", {})
    user_state = users.setdefault(args.user, {
        "used_question_ids": [],
        "last_push_date": None,
        "current_batch": []
    })

    paper_categories = {}
    all_categories = set()
    category_pool = {}
    for paper_id, questions in banks.items():
        cat_map = {}
        for q in questions:
            supported, _, cat = classify_question(q)
            all_categories.add(cat)
            if not supported:
                continue
            cat_map.setdefault(cat, []).append(q)
            category_pool.setdefault(cat, []).append(q)
        if cat_map:
            paper_categories[paper_id] = cat_map

    if not paper_categories:
        raise SystemExit("题库里暂时没有可用题型，请先完善题库。")

    supported_categories = {c for m in paper_categories.values() for c in m.keys()}
    available_list = "，".join(sorted(supported_categories)) or "无"

    requested_category = args.category
    if requested_category and "资料分析" in requested_category:
        raise SystemExit(f"抱歉，资料分析题目暂不支持。可用题型：{available_list}")
    if requested_category:
        requested_pool = category_pool.get(requested_category, [])
        if not requested_pool:
            raise SystemExit(f"抱歉，当前不支持该题型。可用题型：{available_list}")

    used = set(user_state.get("used_question_ids", []))

    notice_lines = None
    if requested_category:
        selected_category = requested_category
        total_count = len(requested_pool)
        if total_count < args.count:
            selected_paper = "多试卷"
            pool = list(requested_pool)
            random.shuffle(pool)
            questions = pool
            notice_lines = [f"温馨提示：该题型目前仅有 {total_count} 题，已全部为你推送。"]
        else:
            paper_ids = list(paper_categories.keys())
            random.shuffle(paper_ids)
            selected_paper = None
            pool = None
            for paper_id in paper_ids:
                qs = paper_categories[paper_id].get(selected_category)
                if qs and len(qs) >= args.count:
                    selected_paper = paper_id
                    pool = qs
                    break
            if selected_paper is None:
                selected_paper = "多试卷"
                pool = list(requested_pool)

            available = [q for q in pool if q["id"] not in used]
            if len(available) < args.count:
                used = set()
                available = list(pool)
            random.shuffle(available)
            questions = available[: args.count]
    else:
        eligible_papers = [
            paper_id
            for paper_id, cat_map in paper_categories.items()
            if any(len(qs) >= args.count for qs in cat_map.values())
        ]
        if not eligible_papers:
            raise SystemExit(f"抱歉，题库中暂时没有满足数量的题型。可用题型：{available_list}")

        selected_paper = random.choice(sorted(eligible_papers))
        available_cats = [
            cat for cat, qs in paper_categories[selected_paper].items()
            if len(qs) >= args.count
        ]
        selected_category = random.choice(sorted(available_cats))
        pool = paper_categories[selected_paper][selected_category]

        available = [q for q in pool if q["id"] not in used]
        if len(available) < args.count:
            used = set()
            available = list(pool)
        random.shuffle(available)
        questions = available[: args.count]

    batch_ids = [q["id"] for q in questions]
    used.update(batch_ids)
    user_state["used_question_ids"] = list(used)
    user_state["last_push_date"] = date_str
    user_state["current_batch"] = batch_ids
    user_state["last_category"] = selected_category
    user_state["last_paper"] = selected_paper
    user_state["last_count"] = args.count
    save_json(state_path, state)

    message = format_questions(date_str, questions, selected_category, selected_paper, notice_lines)

    if args.format == "json":
        print(json.dumps({
            "date": date_str,
            "user_key": args.user,
            "question_ids": batch_ids,
            "paper_id": selected_paper,
            "message": message
        }, ensure_ascii=False, indent=2))
    else:
        print(message)


if __name__ == "__main__":
    main()
