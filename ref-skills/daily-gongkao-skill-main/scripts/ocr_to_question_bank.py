#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import re
from pathlib import Path
from typing import List, Dict, Iterable, Tuple


CHAPTER_RE = re.compile(r"^[一二三四五六七八九十⼀-⼏]+[\.、]\s*([^：:]+)")
ANSWER_RE = re.compile(r"^正确答案[:：]\s*([A-Da-d]+)")
MY_ANSWER_RE = re.compile(r"^你的答案[:：]")
IMAGE_RE = re.compile(r"^!\[\]\((.+)\)")
JUDGEMENT_RE = re.compile(r"判断题")
INLINE_QNO_RE = re.compile(r"(?:^|(?<=[\u4e00-\u9fffA-Za-z]))\s*(\d{1,3})\.(?!\d)\s*(?=[\u4e00-\u9fffA-Za-z（(])")


def normalize_answer(raw: str) -> str:
    letters = [c for c in str(raw).upper() if c in "ABCD"]
    unique = []
    for c in letters:
        if c not in unique:
            unique.append(c)
    return "".join(unique)


def extract_category(line: str) -> str | None:
    line = line.strip().lstrip("#").strip()
    if not line:
        return None
    m = CHAPTER_RE.match(line)
    if not m:
        return None
    label = m.group(1).strip()
    label = label.split("：")[0].split(":")[0].strip()
    label = re.sub(r"\s+", " ", label).strip()
    if not label:
        return None
    return label


def clean_option_line(line: str) -> str:
    cleaned = line.strip()
    cleaned = cleaned.strip("$")
    cleaned = cleaned.replace("\\mathrm", "")
    cleaned = cleaned.replace("@", " ")
    cleaned = re.sub(r"[{}]", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def parse_options_from_line(line: str) -> List[Tuple[str, str]]:
    options: List[Tuple[str, str]] = []
    cleaned = clean_option_line(line)

    m = re.match(r"^([A-D])[\.、．:：]\s*(.+)$", cleaned)
    if m:
        options.append((m.group(1), m.group(2).strip()))
        # 尝试解析同一行里的其他选项
        rest = cleaned[m.end():]
        for k, v in re.findall(r"([A-D])[\.、．:：]\s*([^A-D]{1,200})", rest):
            options.append((k, v.strip()))
        return options

    for k, v in re.findall(r"([A-D])[\.、．:：]\s*([^A-D]{1,200})", cleaned):
        options.append((k, v.strip()))

    return options


def normalize_question_line(line: str) -> Tuple[int, str] | None:
    m = INLINE_QNO_RE.search(line)
    if not m:
        return None
    num = int(m.group(1))
    text = INLINE_QNO_RE.sub("", line).strip()
    # 清理夹杂的答案行残留
    text = re.sub(r"正确答案[:：].*", "", text).strip()
    text = re.sub(r"你的答案[:：].*", "", text).strip()
    return num, text


def iter_input_files(root: Path) -> List[Path]:
    if root.is_file():
        return [root]
    files = list(root.rglob("*.md")) + list(root.rglob("*.txt"))
    return sorted(set(files))


def parse_markdown_questions(text: str) -> List[Dict]:
    questions: List[Dict] = []
    current: Dict | None = None
    current_category = "未分类"
    options_started = False
    text = text.replace("\r\n", "\n")
    lines = [line.strip() for line in text.splitlines() if line.strip()]

    for raw_line in lines:
        img_match = IMAGE_RE.match(raw_line)
        if img_match:
            img_path = img_match.group(1).strip()
            if current is not None and not current.get("image"):
                current["image"] = img_path
            continue
        if raw_line in {"扫描二维码 下载「粉笔」APP", "就用粉笔"}:
            continue

        cat = extract_category(raw_line)
        if cat:
            current_category = cat
            continue

        ans_match = ANSWER_RE.match(raw_line)
        if ans_match and current is not None:
            current["answer"] = normalize_answer(ans_match.group(1))
            continue

        if MY_ANSWER_RE.match(raw_line):
            continue

        q_start = normalize_question_line(raw_line)
        if q_start:
            if current:
                questions.append(current)
            _, qtext = q_start
            current = {
                "question": qtext,
                "options": {},
                "answer": "",
                "category": current_category,
                "image": ""
            }
            options_started = False
            continue

        if current is None:
            continue

        opts = parse_options_from_line(raw_line)
        if opts:
            options_started = True
            for k, v in opts:
                if k not in current["options"] and v:
                    current["options"][k] = v
            continue

        if not options_started:
            current["question"] = (current["question"] + " " + raw_line).strip()

    if current:
        questions.append(current)

    # 过滤无效题目
    cleaned = []
    for q in questions:
        if not q.get("question"):
            continue
        if len(q.get("options", {})) < 2 and JUDGEMENT_RE.search(q.get("question", "")):
            # 判断题默认补齐选项
            q["options"] = {"A": "正确", "B": "错误"}
        if len(q.get("options", {})) < 2:
            continue
        if "image" not in q:
            q["image"] = ""
        cleaned.append(q)
    return cleaned


def build_question_bank(questions: List[Dict], note: str) -> Dict:
    categories: Dict[str, List[Dict]] = {}
    for q in questions:
        category = q.pop("category", "未分类")
        categories.setdefault(category, []).append(q)
    return {
        "schema_version": 1,
        "question_format": "text",
        "categories": categories,
        "notes": note
    }


def assign_ids(questions: List[Dict], prefix: str):
    for idx, q in enumerate(questions, 1):
        q["id"] = f"{prefix}{idx:03d}"


def main():
    parser = argparse.ArgumentParser(description="Build question bank files from MinerU OCR markdown outputs.")
    parser.add_argument("--input", default="data/ocr_results", help="OCR output file or directory")
    parser.add_argument("--output", default="data/ocr_question_bank", help="Output directory (one JSON per paper)")
    parser.add_argument("--id-prefix", default=None, help="ID prefix (default OCRYYYYMMDD_XX)")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        raise SystemExit(f"Input path not found: {input_path}")

    output_path = Path(args.output)
    files = iter_input_files(input_path)
    if not files:
        raise SystemExit("No markdown or text files found in input path.")

    date_prefix = f"OCR{dt.date.today().strftime('%Y%m%d')}"

    if output_path.suffix == ".json":
        raise SystemExit("--output must be a directory path, not a .json file.")

    output_path.mkdir(parents=True, exist_ok=True)
    for i, path in enumerate(files, 1):
        text = path.read_text(encoding="utf-8", errors="ignore")
        questions = parse_markdown_questions(text)
        if not questions:
            print(f"已跳过（未解析到题目）：{path}")
            continue
        prefix = args.id_prefix or f"{date_prefix}_{i:02d}"
        assign_ids(questions, prefix)
        note = "OCR draft; please review and fill correct answers before merging." if not any(q.get("answer") for q in questions) else "OCR draft; please review and verify answers before merging."
        bank = build_question_bank(questions, note)
        out_file = output_path / f"{path.stem}_question_bank.json"
        out_file.write_text(json.dumps(bank, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"已保存：{out_file}（题目数：{sum(len(v) for v in bank['categories'].values())}）")


if __name__ == "__main__":
    main()
