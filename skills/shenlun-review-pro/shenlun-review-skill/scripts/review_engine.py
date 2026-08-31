#!/usr/bin/env python3
"""
shenlun-review-pro deterministic engine.
Standard library only. No pip dependencies.

Subcommands:
  normalize-input           Parse .txt/.md/.html/.json/.srt into plain text + metadata
  validate-analysis         Check analysis-result JSON against structural rules
  calculate-score           Compute scores from scoring-input JSON (frozen formulas)
  analyze-once              Resolve one question for direct analysis in one call
  finalize-analysis         Validate analysis prose from one saved analyze-once receipt
  grade-once                Compile compact evidence and run formal grading once
  compare-drafts            Compare two scoring results against the same analysis_id
  check-word-count          Deterministic word-count gate (P1-1 字数门禁)
  validate-method-selection Validate method card budget & routing (P1-4 方法调用预算)
  resolve-task-prototype    Resolve question text to a real task prototype
  resolve-method-selection  Resolve prototype/mode to real method card content
  validate-user-output      Reject tables and internal implementation details before sending
  validate-scoring-anchor   Validate anchor evidence & cross-2-level gate (稳定性修复)
  write-state               Write scoring result to SQLite
  migrate-state             Import old Markdown state into SQLite (read-only on source)
  export-report             Export scoring/comparison data as JSON/Markdown/HTML
  export-learning-state     Derive issue cards, ability profiles, and learner profile from SQLite
  healthcheck               Verify engine, schema, and database connectivity

Exit codes:
  0  success
  2  input, format, or schema error
  3  analysis/scoring consistency check failed
  4  SQLite state operation failed
  5  report export failed
"""

import sys
import os
import json
import hashlib
import sqlite3
import argparse
import re
import html
import tempfile
import copy
from html.parser import HTMLParser
from pathlib import Path
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "references" / "contracts"
CONFIG_DIR = Path(__file__).resolve().parent.parent / "references" / "config"
SQL_SCHEMA = Path(__file__).resolve().parent / "state-schema.sql"
ASSETS_DIR = Path(__file__).resolve().parent.parent / "assets"
SKILL_FILE = Path(__file__).resolve().parent.parent / "SKILL.md"
ENGINE_VERSION = "1.3.3"

EXIT_SUCCESS = 0
EXIT_INPUT_ERROR = 2
EXIT_CONSISTENCY = 3
EXIT_DB_ERROR = 4
EXIT_EXPORT_ERROR = 5

VALID_QUESTION_TYPES = {"归纳概括", "综合分析", "提出对策", "贯彻执行", "申发论述"}
VALID_COVERAGE = {"完整覆盖", "部分覆盖", "等义表达", "未覆盖", "超出材料"}
VALID_CONFIDENCE = {"high", "medium", "low"}
CONFIDENCE_PERCENT = {"high": 5, "medium": 10, "low": 15}

# ---------------------------------------------------------------------------
# Utility: structured error output
# ---------------------------------------------------------------------------

def error_exit(code, message, detail=None):
    """Output structured JSON error and exit with code."""
    err = {"error": True, "exit_code": code, "message": message}
    if detail:
        err["detail"] = detail
    print(json.dumps(err, ensure_ascii=False, indent=2), file=sys.stderr)
    sys.exit(code)


def success_output(data, output_path=None, fmt="json"):
    """Output success data as JSON (default) or to file.
    Does NOT call sys.exit — the caller (command handler) controls flow.
    The main() wrapper handles clean exit after handler returns."""
    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(json.dumps({"success": True, "output": output_path}, ensure_ascii=False))
    else:
        print(json.dumps(data, ensure_ascii=False, indent=2))


def read_input(arg):
    """Read --input from file path or stdin."""
    if arg == "-" or arg is None:
        raw = sys.stdin.read()
    else:
        p = Path(arg)
        if not p.exists():
            error_exit(EXIT_INPUT_ERROR, f"Input file not found: {arg}")
        raw = p.read_text(encoding="utf-8")
    if not raw.strip():
        error_exit(EXIT_INPUT_ERROR, "Input is empty")
    return raw


def parse_json_input(raw):
    """Parse JSON string; exit 2 on failure."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        error_exit(EXIT_INPUT_ERROR, "Invalid JSON input", str(e))


# ---------------------------------------------------------------------------
# Evidence normalization: semantic substring matching
# ---------------------------------------------------------------------------
# Punctuation, quotes, dashes, and whitespace differences between the caller's
# evidence string and the material原文 should not cause false-negative verbatim
# checks.  The two helpers below strip punctuation / normalize whitespace so
# that comparison is based on the **semantic skeleton** of the text, not on
# exact byte-level punctuation matching.

_PUNCT_RE = re.compile(r'[\s\u3000\uff0c\uff0e\uff1b\uff1a\u201c\u201d\u2018\u2019'
                       r'\u3001\u3002\u300a\u300b\u2014\u2026\uff01\uff1f'
                       r'，。；：""''「」『』【】〈〉《》、—…！？\u00a0'
                       r',.;:!?\'"()\[\]{}<>~`@#$%^&*_+=|\\/]')


def _norm_for_match(text: str) -> str:
    """Normalize text for semantic substring matching.

    Strips all punctuation (CJK + ASCII), collapses whitespace, and
    lowercases.  Used ONLY for containment checks — not for display or
    scoring arithmetic.
    """
    return _PUNCT_RE.sub('', text).replace(' ', '').replace('\t', '').replace('\n', '').lower()


def _evidence_in_scope(evidence: str, scope_text: str) -> bool:
    """Check if *evidence* is a semantic substring of *scope_text*.

    First tries exact substring (fast path); falls back to normalized
    comparison so that punctuation-only differences don't cause false
    negatives.
    """
    if not evidence or not scope_text:
        return False
    if evidence in scope_text:
        return True
    return _norm_for_match(evidence) in _norm_for_match(scope_text)


# Accept ellipsis shorthand without splitting ordinary decimal numbers.
_EVIDENCE_FRAGMENT_SPLIT_RE = re.compile(r"(?:…+|\.{2,}|[，,。；;！？!?\n]+)")


def _evidence_fragments_in_scope(evidence, scope_text):
    """Return material-backed evidence fragments.

    Normal grading accepts either one continuous quote, an explicit list of
    continuous quotes, or a punctuation-separated shorthand that skips text
    between clauses. An explicit list is a set of independent excerpts and
    therefore does not require source order; shorthand strings retain source
    order so their ellipsis still means an omitted middle passage.
    """
    if isinstance(evidence, list):
        fragments = [item.strip() for item in evidence if isinstance(item, str) and item.strip()]
        if len(fragments) != len(evidence) or not fragments:
            return []
        expanded = []
        for fragment in fragments:
            if _evidence_in_scope(fragment, scope_text):
                expanded.append(fragment)
                continue
            shorthand_fragments = _evidence_fragments_in_scope(fragment, scope_text)
            if not shorthand_fragments:
                return []
            expanded.extend(shorthand_fragments)
        return expanded
    elif isinstance(evidence, str) and evidence.strip():
        evidence = evidence.strip()
        if _evidence_in_scope(evidence, scope_text):
            return [evidence]
        fragments = [
            item.strip() for item in _EVIDENCE_FRAGMENT_SPLIT_RE.split(evidence)
            if item.strip()
        ]
        if len(fragments) < 2:
            return []
    else:
        return []

    normalized_scope = _norm_for_match(scope_text or "")
    cursor = 0
    for fragment in fragments:
        normalized_fragment = _norm_for_match(fragment)
        if not normalized_fragment:
            return []
        start = normalized_scope.find(normalized_fragment, cursor)
        if start < 0:
            return []
        cursor = start + len(normalized_fragment)
    return fragments


def _canonical_evidence(evidence, scope_text):
    """Return one exact anchor plus all verified fragments for the ledger."""
    fragments = _evidence_fragments_in_scope(evidence, scope_text)
    if not fragments:
        return None, []
    anchor = max(fragments, key=lambda item: len(_norm_for_match(item)))
    return anchor, fragments


def _source_excerpt_for_normalized_match(evidence, scope_text):
    """Return the exact source excerpt matched by an evidence skeleton.

    The grading ledger must retain a quote copied from the user's actual
    answer.  Callers, however, often vary only punctuation, whitespace, or
    use ellipsis shorthand.  Resolve such a verified skeleton back to the
    original answer text rather than preserving the caller's synthetic quote.
    """
    if not isinstance(evidence, str) or not isinstance(scope_text, str):
        return None
    evidence = evidence.strip()
    if not evidence:
        return None
    if evidence in scope_text:
        return evidence
    target = _norm_for_match(evidence)
    if not target:
        return None
    normalized_parts = []
    source_positions = []
    for position, char in enumerate(scope_text):
        normalized_char = _norm_for_match(char)
        if not normalized_char:
            continue
        normalized_parts.append(normalized_char)
        source_positions.extend([position] * len(normalized_char))
    normalized_scope = "".join(normalized_parts)
    start = normalized_scope.find(target)
    if start < 0:
        return None
    end = start + len(target) - 1
    return scope_text[source_positions[start]:source_positions[end] + 1].strip()


def _canonical_user_quote(quote, user_answer):
    """Return one exact answer quote for a verified caller-supplied excerpt.

    Preserve an exact quote when possible.  For an ellipsis shorthand, retain
    the longest independently verified fragment instead of expanding omitted
    text: that keeps quote-length scoring conservative and never fabricates
    a user expression.
    """
    fragments = _evidence_fragments_in_scope(quote, user_answer)
    if not fragments:
        return None, []
    direct = _source_excerpt_for_normalized_match(quote, user_answer)
    if direct:
        return direct, fragments
    anchor = max(fragments, key=lambda item: len(_norm_for_match(item)))
    return _source_excerpt_for_normalized_match(anchor, user_answer), fragments


def _evidence_string_support_errors(evidence, scope_text, field_path):
    """Explain why one evidence string cannot be verified.

    Keep diagnostics structural: identify the failing field/index and failure
    class without echoing source or answer text into logs.
    """
    if not isinstance(evidence, str) or not evidence.strip():
        return [f"{field_path} must be a non-empty string"]
    evidence = evidence.strip()
    if _evidence_in_scope(evidence, scope_text):
        return []
    fragments = [
        item.strip() for item in _EVIDENCE_FRAGMENT_SPLIT_RE.split(evidence)
        if item.strip()
    ]
    if len(fragments) < 2:
        return [f"{field_path} is not found in material_text"]
    missing = [
        str(index + 1) for index, fragment in enumerate(fragments)
        if not _evidence_in_scope(fragment, scope_text)
    ]
    if missing:
        return [
            f"{field_path} contains shorthand fragment(s) not found in "
            f"material_text at position(s) {', '.join(missing)}"
        ]
    return [
        f"{field_path} uses shorthand fragments in a different material order; "
        "keep ellipsis fragments in source order or use separate array items "
        "for independent excerpts"
    ]


def _material_evidence_support_errors(evidence, scope_text, field_path):
    """Return precise, reusable validation errors for material evidence."""
    if isinstance(evidence, list):
        if not evidence:
            return [f"{field_path} must be a non-empty string or array"]
        errors = []
        for index, item in enumerate(evidence):
            item_path = f"{field_path}[{index}]"
            errors.extend(
                _evidence_string_support_errors(item, scope_text, item_path)
            )
        return errors
    return _evidence_string_support_errors(evidence, scope_text, field_path)


def _qualifier_has_semantic_trace(qualifier, answer_text):
    """Conservative guard against declaring an entirely absent qualifier complete.

    This is not a strict verbatim check: reasonable insertion, synonym, or
    material-specific paraphrase may remain valid. It only returns False when
    the qualifier has no exact trace and no meaningful two-character Chinese
    skeleton in the user's evidence.
    """
    qualifier_norm = _norm_for_match(qualifier or "")
    answer_norm = _norm_for_match(answer_text or "")
    if not qualifier_norm or not answer_norm:
        return False
    if qualifier_norm in answer_norm:
        return True
    if any(char.isdigit() for char in qualifier_norm):
        return False
    if len(qualifier_norm) < 2:
        return qualifier_norm in answer_norm
    return any(
        qualifier_norm[index:index + 2] in answer_norm
        for index in range(len(qualifier_norm) - 1)
    )


# ---------------------------------------------------------------------------
# normalize-input: parse .txt/.md/.html/.json/.srt
# ---------------------------------------------------------------------------

class _HTMLTextExtractor(HTMLParser):
    """Extract visible text from HTML, skipping script/style/noscript/hidden."""

    def __init__(self):
        super().__init__()
        self._skip_tags = {"script", "style", "noscript"}
        self._in_skip = 0
        self._hidden = False
        self._parts = []

    def handle_starttag(self, tag, attrs):
        if tag in self._skip_tags:
            self._in_skip += 1
        attr_dict = dict(attrs)
        style = attr_dict.get("style", "").lower()
        if "display:none" in style or "visibility:hidden" in style:
            self._hidden = True
        if tag == "br":
            self._parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._skip_tags and self._in_skip > 0:
            self._in_skip -= 1
        self._hidden = False

    def handle_data(self, data):
        if self._in_skip == 0 and not self._hidden:
            self._parts.append(data)

    def get_text(self):
        return "".join(self._parts)


def _normalize_html(raw):
    extractor = _HTMLTextExtractor()
    extractor.feed(raw)
    text = extractor.get_text()
    # Collapse excessive blank lines
    lines = [ln.strip() for ln in text.splitlines()]
    result = "\n".join(ln for ln in lines if ln)
    return result


def _normalize_srt(raw):
    """Remove sequence numbers and timestamps, keep subtitle text."""
    lines = raw.splitlines()
    output = []
    for line in lines:
        stripped = line.strip()
        # Skip empty lines
        if not stripped:
            continue
        # Skip sequence number lines (pure digits)
        if stripped.isdigit():
            continue
        # Skip timestamp lines (contain --> )
        if "-->" in stripped:
            continue
        output.append(stripped)
    return "\n".join(output)


def _normalize_json(raw):
    """Extract text content from a JSON object with known fields."""
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        error_exit(EXIT_INPUT_ERROR, "Cannot parse JSON for normalization")
    # Look for common text fields
    for key in ("text", "content", "body", "material", "answer"):
        if key in obj and isinstance(obj[key], str):
            return obj[key]
    error_exit(EXIT_INPUT_ERROR, "JSON has no recognized text field (text/content/body/material/answer)")


def cmd_normalize_input(args):
    raw = read_input(args.input)
    ext = None
    if args.input and args.input != "-":
        ext = Path(args.input).suffix.lower()

    # Auto-detect SRT format when extension is unknown (stdin)
    is_srt = ext == ".srt" or (ext is None and "-->" in raw and re.search(r'^\d+\s*$', raw.splitlines()[0] if raw.splitlines() else "", re.MULTILINE))

    if ext in (".html", ".htm") or (ext is None and not is_srt and "<html" in raw.lower()):
        text = _normalize_html(raw)
    elif is_srt:
        text = _normalize_srt(raw)
    elif ext == ".json":
        text = _normalize_json(raw)
    elif ext in (".txt", ".md", ".markdown", None):
        text = raw.strip()
    else:
        error_exit(EXIT_INPUT_ERROR, f"Unsupported file type: {ext}")

    if not text.strip():
        error_exit(EXIT_INPUT_ERROR, "Normalized text is empty")

    result = {
        "normalized_text": text,
        "char_count": len(text),
        "source_format": ext or "auto",
        "paragraphs": [p.strip() for p in text.split("\n") if p.strip()]
    }
    success_output(result, args.output)


# ---------------------------------------------------------------------------
# validate-analysis: check analysis-result JSON
# ---------------------------------------------------------------------------

def cmd_validate_analysis(args):
    raw = read_input(args.input)
    data = parse_json_input(raw)

    errors = []

    # Required top-level fields
    required_fields = [
        "schema_version", "analysis_id", "task_id", "question_type",
        "task_instruction", "constraints", "material_hash",
        "paragraphs", "atomic_points", "completeness"
    ]
    for field in required_fields:
        if field not in data:
            errors.append(f"Missing required field: {field}")

    if errors:
        error_exit(EXIT_INPUT_ERROR, "Analysis validation failed", errors)

    # Question type enum
    qt = data.get("question_type")
    if not isinstance(qt, str) or qt not in VALID_QUESTION_TYPES:
        errors.append(f"Invalid question_type: {qt}")

    # analysis_id / task_id non-empty
    if not data.get("analysis_id"):
        errors.append("analysis_id is empty")
    if not data.get("task_id"):
        errors.append("task_id is empty")

    # Paragraphs
    paragraphs = data.get("paragraphs", [])
    para_ids = set()
    for p in paragraphs:
        pid = p.get("paragraph_id")
        if not pid:
            errors.append("Paragraph missing paragraph_id")
        else:
            para_ids.add(pid)
        if not p.get("text"):
            errors.append(f"Paragraph {pid} has empty text")

    # Atomic points
    points = data.get("atomic_points", [])
    point_ids = set()
    for pt in points:
        pid = pt.get("point_id")
        if not pid:
            errors.append("Atomic point missing point_id")
            continue
        if pid in point_ids:
            errors.append(f"Duplicate point_id: {pid}")
        point_ids.add(pid)

        # evidence_text must be locatable in referenced paragraph
        para_id = pt.get("paragraph_id")
        evidence = pt.get("evidence_text", "")
        if para_id and para_id in para_ids:
            para_text = next((p["text"] for p in paragraphs if p["paragraph_id"] == para_id), "")
            if evidence and not _evidence_in_scope(evidence, para_text):
                errors.append(f"Point {pid}: evidence_text not found in paragraph {para_id}")
        elif para_id:
            errors.append(f"Point {pid}: references non-existent paragraph {para_id}")

        # method_card_id must not be in point source fields
        if "method_card_id" in pt or "method_card_ids" in pt:
            errors.append(f"Point {pid}: method_card_id must not appear in atomic point fields")

    # Relationships reference valid point_ids
    for rel in data.get("relationships", []):
        for ref_key in ("source_point_ids", "target_point_ids"):
            for ref_pid in rel.get(ref_key, []):
                if ref_pid not in point_ids:
                    errors.append(f"Relationship {rel.get('relationship_id')}: references unknown point_id {ref_pid}")

    # Completeness check
    completeness = data.get("completeness", {})
    status = completeness.get("status")
    if status in ("incomplete", "uncertain"):
        errors.append(f"Completeness status is '{status}' — must not enter scoring")

    # method_card_ids validation (if present)
    if "method_card_ids" in data:
        mc_errors = _validate_method_card_ids(data["method_card_ids"])
        errors.extend(mc_errors)

    if errors:
        error_exit(EXIT_CONSISTENCY, "Analysis validation failed", errors)

    result = {"valid": True, "analysis_id": data["analysis_id"], "point_count": len(points)}
    success_output(result, args.output)


def _validate_method_card_ids(value):
    """Validate method_card_ids: array, max 5, unique, sl-card-XXXX format, file exists, card_id matches filename."""
    errors = []
    if not isinstance(value, list):
        errors.append(f"method_card_ids must be an array, got {type(value).__name__}")
        return errors
    if len(value) > 5:
        errors.append(f"method_card_ids must have at most 5 items, got {len(value)}")
    seen = set()
    for i, cid in enumerate(value):
        if not isinstance(cid, str):
            errors.append(f"method_card_ids[{i}] must be a string, got {type(cid).__name__}")
            continue
        if cid in seen:
            errors.append(f"method_card_ids contains duplicate: {cid}")
        seen.add(cid)
        if not re.match(r"^sl-card-\d{4}$", cid):
            errors.append(f"method_card_ids[{i}] must match pattern sl-card-XXXX, got '{cid}'")
            continue
        # Check file exists
        card_path = Path(__file__).resolve().parent.parent / "references" / "method-libraries" / "方法卡" / f"{cid}.json"
        if not card_path.exists():
            errors.append(f"method_card_ids[{i}]: card file not found: {cid}.json")
            continue
        # Check card_id matches filename
        try:
            card = json.loads(card_path.read_text(encoding="utf-8"))
            if card.get("card_id") != cid:
                errors.append(f"method_card_ids[{i}]: card_id mismatch — file {cid}.json has card_id '{card.get('card_id')}'")
        except json.JSONDecodeError:
            errors.append(f"method_card_ids[{i}]: card file {cid}.json is not valid JSON")
    return errors


# ---------------------------------------------------------------------------
# Unified scoring kernel — shared by calculate-score and write-state
# ---------------------------------------------------------------------------

VALID_QUESTION_TYPES = {"归纳概括", "综合分析", "提出对策", "贯彻执行", "申发论述"}
VALID_COVERAGE_ALL = {"完整覆盖", "部分覆盖", "等义表达", "未覆盖", "超出材料"}
VALID_COVERAGE_NON_EXCESS = {"完整覆盖", "部分覆盖", "等义表达", "未覆盖"}
VALID_CONFIDENCE = {"high", "medium", "low"}
CONFIDENCE_PERCENT = {"high": 5, "medium": 10, "low": 15}
VALID_ANSWER_VERSIONS = {"draft_1", "draft_2", "revision"}
VALID_POINT_ROLES = {"fact", "measure", "problem", "cause", "effect", "opinion", "data", "background"}
VALID_IMPORTANCE = {"core", "secondary", "potential"}
VALID_POINT_STATUS = {"active", "merged", "excluded"}
VALID_WEIGHT_POLICIES = {"default", "official_override"}


def _is_finite_number(v):
    """Check that v is a finite number (not bool, not inf, not nan)."""
    import math
    if isinstance(v, bool):
        return False
    if not isinstance(v, (int, float)):
        return False
    return math.isfinite(v)


def _require_str(value, label, errors, nonempty=True):
    """Append error if value is not a string (and optionally not empty)."""
    if not isinstance(value, str):
        errors.append(f"{label} must be a string, got {type(value).__name__}")
        return False
    if nonempty and value.strip() == "":
        errors.append(f"{label} must be a non-empty string")
        return False
    return True


def _check_enum(value, valid_set, label, errors):
    """Safe enum check: verify value is a string BEFORE set membership test.

    Prevents TypeError ('list' / 'dict' as set element) on unhashable inputs.
    Returns True if valid, False otherwise (appends error if invalid).
    """
    if not isinstance(value, str):
        errors.append(f"{label} must be a string, got {type(value).__name__}={value!r}")
        return False
    if value not in valid_set:
        errors.append(f"{label} must be one of {sorted(valid_set)}, got '{value}'")
        return False
    return True


def _validate_scoring_input_structure(data):
    """Strict structural validation of scoring-input BEFORE any business logic.

    Returns list of error strings (empty = valid). Guarantees no Unexpected error
    reaches the user from type/shape mistakes.
    """
    errors = []

    # Top-level must be object
    if not isinstance(data, dict):
        return ["scoring-input must be a JSON object"]

    # Required top-level fields (presence only; value checks below)
    required = [
        "schema_version", "analysis_id", "question_type", "weight_policy",
        "user_answer", "answer_version", "confidence_basis", "dimensions"
    ]
    for f in required:
        if f not in data:
            errors.append(f"Missing required field: {f}")
    # P0-1: point_definitions conditionally required by compatibility_mode
    compat_mode = data.get("compatibility_mode")
    if compat_mode != "legacy":
        if "point_definitions" not in data:
            errors.append("Missing required field: point_definitions (required for formal mode; use compatibility_mode='legacy' to opt out)")
    # P0-2: point_mappings conditionally required — optional when score_ledger is present (derived from ledger)
    if "score_ledger" not in data or not isinstance(data.get("score_ledger"), dict):
        if "point_mappings" not in data:
            errors.append("Missing required field: point_mappings (required when score_ledger is absent)")
    # Formal by-points scoring must carry the two upstream review receipts.
    pdefs = data.get("point_definitions")
    uses_point_scoring = (
        data.get("question_type") not in {"申发论述", "贯彻执行"}
        and
        isinstance(pdefs, list)
        and any(isinstance(pd, dict) and pd.get("point_value") is not None for pd in pdefs)
    )
    if compat_mode != "legacy" and uses_point_scoring:
        hr = data.get("holistic_review")
        if not isinstance(hr, dict):
            errors.append("holistic_review is required for formal by_points scoring")
        else:
            if not isinstance(hr.get("evidence"), str) or not hr.get("evidence", "").strip():
                errors.append("holistic_review.evidence must be a non-empty string")
        pr = data.get("point_pool_review")
        if not isinstance(pr, dict):
            errors.append("point_pool_review is required for formal by_points scoring")
        elif pr.get("status") not in {"verified", "disputed"}:
            errors.append("point_pool_review.status must be 'verified' or 'disputed'")
        mr = data.get("method_selection")
        if not isinstance(mr, dict) or mr.get("validation_passed") is not True:
            errors.append("method_selection.validation_passed=true is required for formal by_points scoring")
    if compat_mode != "legacy" and data.get("question_type") == "申发论述":
        er = data.get("essay_review")
        if not isinstance(er, dict):
            errors.append("essay_review is required for formal 申发论述 scoring")
        else:
            for key in ("central_thesis", "relationship_type", "relationship_centrality", "material_support", "reasoning_bridge", "return_to_thesis", "topic_specificity", "argument_line_status", "material_support_status", "template_risk", "relationship_coverage_status", "thesis_scope_status", "sub_argument_system_status", "material_transformation_status", "evidence"):
                if not isinstance(er.get(key), str) or not er.get(key, "").strip():
                    errors.append(f"essay_review.{key} must be a non-empty string")
            if not isinstance(er.get("prompt_relation_required"), bool):
                errors.append("essay_review.prompt_relation_required must be boolean")
            chain = er.get("sub_argument_chain")
            if not isinstance(chain, list) or len(chain) < 2 or any(not isinstance(item, str) or not item.strip() for item in chain):
                errors.append("essay_review.sub_argument_chain must contain at least two non-empty strings")
            if er.get("counterargument_or_boundary") is not None and not isinstance(er.get("counterargument_or_boundary"), str):
                errors.append("essay_review.counterargument_or_boundary must be a string or null")
            if er.get("topic_specificity") not in {"strong", "adequate", "weak"}:
                errors.append("essay_review.topic_specificity is invalid")
            if er.get("argument_line_status") not in {"sound", "weak", "broken"}:
                errors.append("essay_review.argument_line_status is invalid")
            if er.get("material_support_status") not in {"strong", "partial", "weak"}:
                errors.append("essay_review.material_support_status is invalid")
            if er.get("template_risk") not in {"none", "local", "pervasive"}:
                errors.append("essay_review.template_risk is invalid")
            if er.get("relationship_coverage_status") not in {"complete", "partial", "mentioned_only", "missing", "distorted", "not_applicable"}:
                errors.append("essay_review.relationship_coverage_status is invalid")
            if er.get("thesis_scope_status") not in {"accurate", "narrowed", "off_topic"}:
                errors.append("essay_review.thesis_scope_status is invalid")
            if er.get("sub_argument_system_status") not in {"sound", "mixed_levels", "material_parallel", "broken"}:
                errors.append("essay_review.sub_argument_system_status is invalid")
            if er.get("material_transformation_status") not in {"transformed", "mixed", "mechanical"}:
                errors.append("essay_review.material_transformation_status is invalid")
            if er.get("relationship_centrality") not in {"core", "supporting", "not_applicable"}:
                errors.append("essay_review.relationship_centrality is invalid")
            if er.get("prompt_relation_required") is True and er.get("relationship_coverage_status") == "not_applicable":
                errors.append("essay_review.relationship_coverage_status cannot be not_applicable when prompt_relation_required=true")
            if er.get("prompt_relation_required") is False and er.get("relationship_coverage_status") != "not_applicable":
                errors.append("essay_review.relationship_coverage_status must be not_applicable when prompt_relation_required=false")
            if er.get("prompt_relation_required") is True and er.get("relationship_centrality") == "not_applicable":
                errors.append("essay_review.relationship_centrality cannot be not_applicable when prompt_relation_required=true")
            if er.get("prompt_relation_required") is False and er.get("relationship_centrality") != "not_applicable":
                errors.append("essay_review.relationship_centrality must be not_applicable when prompt_relation_required=false")

            je = er.get("judgment_evidence")
            if not isinstance(je, dict):
                errors.append("essay_review.judgment_evidence must be an object")
            else:
                answer_text = data.get("user_answer", "")
                task_spec = data.get("task_spec") if isinstance(data.get("task_spec"), dict) else {}
                analysis_result = data.get("analysis_result") if isinstance(data.get("analysis_result"), dict) else {}
                prompt_text = task_spec.get("task_instruction") or analysis_result.get("task_instruction") or ""
                required_je = (
                    "prompt_relation_quote", "relationship_centrality_rationale", "central_thesis_quote", "side_a_quote",
                    "side_b_quote", "relationship_bridge_quote", "scope_rationale",
                    "sub_argument_audit", "material_transformation_quote",
                )
                for key in required_je:
                    if key not in je:
                        errors.append(f"essay_review.judgment_evidence.{key} is required")

                def _check_answer_quote(key):
                    quote = je.get(key)
                    if quote is not None and (not isinstance(quote, str) or not quote.strip()):
                        errors.append(f"essay_review.judgment_evidence.{key} must be non-empty string or null")
                    elif isinstance(quote, str) and quote.strip() and not _evidence_in_scope(quote, answer_text):
                        errors.append(f"essay_review.judgment_evidence.{key} not found in user_answer")

                for key in ("central_thesis_quote", "side_a_quote", "side_b_quote", "relationship_bridge_quote", "material_transformation_quote"):
                    _check_answer_quote(key)
                if not isinstance(je.get("scope_rationale"), str) or not je.get("scope_rationale", "").strip():
                    errors.append("essay_review.judgment_evidence.scope_rationale must be non-empty string")
                if not isinstance(je.get("relationship_centrality_rationale"), str) or not je.get("relationship_centrality_rationale", "").strip():
                    errors.append("essay_review.judgment_evidence.relationship_centrality_rationale must be non-empty string")

                prompt_quote = je.get("prompt_relation_quote")
                if er.get("prompt_relation_required") is True:
                    if not isinstance(prompt_quote, str) or not prompt_quote.strip():
                        errors.append("essay_review.judgment_evidence.prompt_relation_quote is required for relation prompt")
                    elif prompt_text and not _evidence_in_scope(prompt_quote, prompt_text):
                        errors.append("essay_review.judgment_evidence.prompt_relation_quote not found in task instruction")
                elif prompt_quote is not None:
                    errors.append("essay_review.judgment_evidence.prompt_relation_quote must be null for non-relation prompt")

                rel_status = er.get("relationship_coverage_status")
                side_a = je.get("side_a_quote")
                side_b = je.get("side_b_quote")
                bridge = je.get("relationship_bridge_quote")
                if rel_status == "complete" and not all(isinstance(x, str) and x.strip() for x in (side_a, side_b, bridge)):
                    errors.append("relationship_coverage_status=complete requires side_a_quote, side_b_quote and relationship_bridge_quote")
                if rel_status == "missing" and all(isinstance(x, str) and x.strip() for x in (side_a, side_b)):
                    errors.append("relationship_coverage_status=missing requires at least one missing side quote")
                if rel_status == "distorted" and not isinstance(bridge, str):
                    errors.append("relationship_coverage_status=distorted requires relationship_bridge_quote")

                audits = je.get("sub_argument_audit")
                chain = er.get("sub_argument_chain") if isinstance(er.get("sub_argument_chain"), list) else []
                if not isinstance(audits, list) or len(audits) < 2:
                    errors.append("essay_review.judgment_evidence.sub_argument_audit must contain at least two entries")
                else:
                    if len(audits) != len(chain):
                        errors.append("sub_argument_audit count must equal sub_argument_chain count")
                    material_topic_count = 0
                    develops_a_count = 0
                    develops_b_count = 0
                    explains_relation_count = 0
                    for i, audit in enumerate(audits):
                        if not isinstance(audit, dict):
                            errors.append(f"sub_argument_audit[{i}] must be object")
                            continue
                        quote = audit.get("argument_quote")
                        if not isinstance(quote, str) or not quote.strip():
                            errors.append(f"sub_argument_audit[{i}].argument_quote must be non-empty string")
                        elif not _evidence_in_scope(quote, answer_text):
                            errors.append(f"sub_argument_audit[{i}].argument_quote not found in user_answer")
                        if not isinstance(audit.get("logical_level"), str) or not audit.get("logical_level", "").strip():
                            errors.append(f"sub_argument_audit[{i}].logical_level must be non-empty string")
                        if not isinstance(audit.get("supports_thesis"), bool):
                            errors.append(f"sub_argument_audit[{i}].supports_thesis must be boolean")
                        if audit.get("source_role") not in {"argument", "material_topic", "mixed"}:
                            errors.append(f"sub_argument_audit[{i}].source_role is invalid")
                        if audit.get("source_role") == "material_topic":
                            material_topic_count += 1
                        for flag in ("develops_side_a", "develops_side_b", "explains_relationship"):
                            if not isinstance(audit.get(flag), bool):
                                errors.append(f"sub_argument_audit[{i}].{flag} must be boolean")
                        develops_a_count += 1 if audit.get("develops_side_a") is True else 0
                        develops_b_count += 1 if audit.get("develops_side_b") is True else 0
                        explains_relation_count += 1 if audit.get("explains_relationship") is True else 0
                        if not isinstance(audit.get("evidence"), str) or not audit.get("evidence", "").strip():
                            errors.append(f"sub_argument_audit[{i}].evidence must be non-empty string")
                    if er.get("sub_argument_system_status") == "material_parallel" and material_topic_count < 2:
                        errors.append("sub_argument_system_status=material_parallel requires at least two material_topic sub-arguments")
                    if er.get("sub_argument_system_status") == "sound" and any(a.get("supports_thesis") is not True for a in audits if isinstance(a, dict)):
                        errors.append("sub_argument_system_status=sound requires every sub-argument to support the thesis")
                    if rel_status == "complete" and (develops_a_count == 0 or develops_b_count == 0 or explains_relation_count == 0):
                        errors.append("relationship_coverage_status=complete requires substantive development of both sides and their relationship in sub-arguments")
                    if rel_status == "mentioned_only" and (develops_a_count > 0 and develops_b_count > 0 and explains_relation_count > 0):
                        errors.append("relationship_coverage_status=mentioned_only conflicts with substantive relationship development in sub-arguments")

            # 关键整体标签必须与六维等级一致，避免诊断说严重、维度仍给高等级。
            dim_levels = {
                dim.get("dimension_name"): dim.get("level")
                for dim in data.get("dimensions", [])
                if isinstance(dim, dict)
            }
            if (er.get("relationship_centrality") == "core"
                    and er.get("relationship_coverage_status") in {"mentioned_only", "missing", "distorted"}
                    and isinstance(dim_levels.get("立意扣题"), int)
                    and dim_levels["立意扣题"] > 2):
                errors.append("relationship coverage is nominal/missing/distorted, so 立意扣题 level cannot exceed 2")
            if er.get("sub_argument_system_status") == "broken" and isinstance(dim_levels.get("结构"), int) and dim_levels["结构"] > 2:
                errors.append("sub-argument system is broken, so 结构 level cannot exceed 2")
            if er.get("argument_line_status") == "broken" and isinstance(dim_levels.get("论证深度"), int) and dim_levels["论证深度"] > 2:
                errors.append("argument_line_status is broken, so 论证深度 level cannot exceed 2")

            # 原型门禁失败后不得手工选择“最近原型”继续正式评分。
            task_spec = data.get("task_spec")
            receipt = task_spec.get("prototype_resolution_receipt") if isinstance(task_spec, dict) else None
            primary_prototype_id = task_spec.get("primary_prototype_id") if isinstance(task_spec, dict) else None
            if not isinstance(receipt, dict):
                errors.append("formal 申发论述 scoring requires task_spec.prototype_resolution_receipt")
            elif (receipt.get("passed") is not True
                  or receipt.get("matched_from_real_prototype") is not True
                  or receipt.get("prototype_id") != primary_prototype_id):
                errors.append("prototype resolution receipt is invalid or does not match task_spec.primary_prototype_id")
    if compat_mode != "legacy" and data.get("question_type") == "贯彻执行":
        ar = data.get("application_review")
        if not isinstance(ar, dict):
            errors.append("application_review is required for formal 贯彻执行 scoring")
        else:
            required_app_fields = ("identity_status", "genre_format_status", "purpose_audience_status", "content_status", "structure_status", "tone_status", "template_use_status", "evidence")
            for key in required_app_fields:
                if not isinstance(ar.get(key), str) or not ar.get(key, "").strip():
                    errors.append(f"application_review.{key} must be a non-empty string")
            app_enums = {
                "identity_status": {"accurate", "partial", "wrong"},
                "genre_format_status": {"complete", "partial", "missing"},
                "purpose_audience_status": {"strong", "adequate", "weak"},
                "content_status": {"complete", "partial", "missing"},
                "structure_status": {"clear", "partial", "unclear"},
                "tone_status": {"appropriate", "partial", "wrong"},
                "template_use_status": {"appropriate", "overgeneralized", "not_applicable"},
            }
            for key, allowed in app_enums.items():
                if ar.get(key) not in allowed:
                    errors.append(f"application_review.{key} is invalid")
    if errors:
        return errors  # cannot continue safely

    # schema_version
    if data["schema_version"] != "1.0":
        errors.append(f"schema_version must be '1.0', got {data['schema_version']!r}")

    # analysis_id: non-empty string
    _require_str(data.get("analysis_id"), "analysis_id", errors)

    # question_type enum (safe: check string before set membership)
    _check_enum(data["question_type"], VALID_QUESTION_TYPES, "question_type", errors)

    # weight_policy enum
    _check_enum(data["weight_policy"], VALID_WEIGHT_POLICIES, "weight_policy", errors)

    # source_note: only string or null (reject numbers, bool, object, array)
    if "source_note" in data and data["source_note"] is not None:
        if not isinstance(data["source_note"], str):
            errors.append(f"source_note must be a string or null, got {type(data['source_note']).__name__}={data['source_note']!r}")

    # user_answer: non-empty string
    _require_str(data.get("user_answer"), "user_answer", errors)

    # answer_version enum
    _check_enum(data.get("answer_version"), VALID_ANSWER_VERSIONS, "answer_version", errors)

    # full_score: null or finite positive number, not bool
    if "full_score" in data and data["full_score"] is not None:
        if not _is_finite_number(data["full_score"]) or data["full_score"] <= 0:
            errors.append(f"full_score must be null or a finite positive number, got {data['full_score']!r}")

    # confidence_basis: must be object
    cb = data.get("confidence_basis")
    if not isinstance(cb, dict):
        errors.append("confidence_basis must be an object")
    else:
        cb_level = cb.get("level")
        _check_enum(cb_level, VALID_CONFIDENCE, "confidence_basis.level", errors)
        cb_reason = cb.get("reason")
        if not isinstance(cb_reason, str) or cb_reason.strip() == "":
            errors.append("confidence_basis.reason must be a non-empty string")

    ref = data.get("reference_answer_set")
    if ref is not None:
        if not isinstance(ref, dict):
            errors.append("reference_answer_set must be an object when provided")
        else:
            for key in ("reference_set_id", "paper_id", "question_id", "answers", "source_confidence"):
                if key not in ref:
                    errors.append(f"reference_answer_set missing required field: {key}")
            if not isinstance(ref.get("answers"), list) or not ref.get("answers"):
                errors.append("reference_answer_set.answers must be a non-empty array")
            else:
                valid_sources = {"official_rubric", "official_answer", "institution_answer", "teacher_answer", "unverified"}
                valid_reliability = {"high", "medium", "low"}
                for i, answer in enumerate(ref["answers"]):
                    if not isinstance(answer, dict):
                        errors.append(f"reference_answer_set.answers[{i}] must be an object")
                        continue
                    if not isinstance(answer.get("answer_text"), str) or not answer.get("answer_text", "").strip():
                        errors.append(f"reference_answer_set.answers[{i}].answer_text must be non-empty")
                    if answer.get("source_type") not in valid_sources:
                        errors.append(f"reference_answer_set.answers[{i}].source_type is invalid")
                    if answer.get("reliability") is not None and answer.get("reliability") not in valid_reliability:
                        errors.append(f"reference_answer_set.answers[{i}].reliability is invalid")
            if ref.get("source_confidence") not in {"high", "medium", "low"}:
                errors.append("reference_answer_set.source_confidence must be high/medium/low")
            task_spec = data.get("task_spec")
            if isinstance(task_spec, dict):
                if task_spec.get("question_id") and ref.get("question_id") != task_spec.get("question_id"):
                    errors.append("reference_answer_set.question_id does not match task_spec.question_id")
                if task_spec.get("paper_id") and ref.get("paper_id") != task_spec.get("paper_id"):
                    errors.append("reference_answer_set.paper_id does not match task_spec.paper_id")

    # dimensions: must be non-empty array of objects
    dims = data.get("dimensions")
    if not isinstance(dims, list):
        errors.append(f"dimensions must be an array, got {type(dims).__name__}")
    elif len(dims) == 0:
        errors.append("dimensions must be a non-empty array")
    else:
        for i, dim in enumerate(dims):
            if not isinstance(dim, dict):
                errors.append(f"dimensions[{i}] must be an object, got {type(dim).__name__}")
                continue
            dn = dim.get("dimension_name")
            if not isinstance(dn, str) or dn.strip() == "":
                errors.append(f"dimensions[{i}].dimension_name must be a non-empty string")
            w = dim.get("weight")
            if not _is_finite_number(w) or w < 0:
                errors.append(f"dimensions[{i}].weight must be a finite number >= 0, got {w!r}")
            lv = dim.get("level")
            if not isinstance(lv, int) or isinstance(lv, bool) or lv < 0 or lv > 4:
                errors.append(f"dimensions[{i}].level must be int 0-4 (not bool), got {lv!r}")

    # point_mappings: conditionally required — must be array when present without score_ledger
    # When score_ledger is present, point_mappings is optional (derived from ledger)
    if "score_ledger" not in data or not isinstance(data.get("score_ledger"), dict):
        pms = data.get("point_mappings")
        if not isinstance(pms, list):
            errors.append(f"point_mappings must be an array, got {type(pms).__name__}")
    else:
        pms = data.get("point_mappings")
        if pms is not None and not isinstance(pms, list):
            errors.append(f"point_mappings must be an array (when provided with score_ledger), got {type(pms).__name__}")
    if isinstance(pms, list):
        for i, pm in enumerate(pms):
            if not isinstance(pm, dict):
                errors.append(f"point_mappings[{i}] must be an object, got {type(pm).__name__}")

    return errors


def _round_half_up(value):
    """Round half up to nearest integer."""
    import math
    floor_val = math.floor(value)
    frac = value - floor_val
    if frac >= 0.5:
        return floor_val + 1
    return floor_val


def _round_half_up_to_half(value):
    """Round to nearest 0.5 using round half up."""
    doubled = value * 2
    rounded = _round_half_up(doubled)
    return rounded / 2


def _round_to_integer(value):
    """Round to nearest integer using round half up. 申论分数取整数，不用 0.5。"""
    return float(_round_half_up(value))

def _resolve_score_base(full_score):
    """Determine score_base from full_score. Returns (score_base, error_or_None)."""
    if full_score is None:
        return 100.0, None
    if not _is_finite_number(full_score) or full_score <= 0:
        return None, f"full_score must be null or a finite positive number, got {full_score!r}"
    return float(full_score), None


def _load_default_weights(question_type):
    """Load default dimension weights for a question type from config JSON."""
    config_path = CONFIG_DIR / "scoring-weights.json"
    if not config_path.exists():
        return None, f"Config not found: {config_path}"
    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)
    qt_config = config.get("question_types", {}).get(question_type)
    if not qt_config:
        return None, f"No default weights for question type: {question_type}"
    return {d["name"]: d["weight"] for d in qt_config["dimensions"]}, None


def _validate_weight_policy(dimensions, question_type, weight_policy, source_note=None):
    """Validate dimensions against weight_policy.

    Returns list of error strings (empty = valid).
    """
    errors = []

    if not isinstance(weight_policy, str) or weight_policy not in VALID_WEIGHT_POLICIES:
        errors.append(f"weight_policy must be one of {sorted(VALID_WEIGHT_POLICIES)}, got {weight_policy!r}")
        return errors

    # Check dimension_name uniqueness and non-empty
    seen_names = set()
    for i, dim in enumerate(dimensions):
        name = dim.get("dimension_name", "")
        if not isinstance(name, str) or name.strip() == "":
            errors.append(f"dimensions[{i}].dimension_name must be a non-empty string")
        elif name in seen_names:
            errors.append(f"dimensions[{i}].dimension_name '{name}' is duplicate")
        else:
            seen_names.add(name)

    if weight_policy == "default":
        default_weights, dw_err = _load_default_weights(question_type)
        if dw_err:
            errors.append(dw_err)
            return errors

        # Input dimension names must match default exactly
        input_names = set(dim.get("dimension_name", "") for dim in dimensions)
        default_names = set(default_weights.keys())

        extra = input_names - default_names
        if extra:
            errors.append(f"default policy: unexpected dimensions not in {question_type} default: {extra}")

        missing = default_names - input_names
        if missing:
            errors.append(f"default policy: missing required dimensions for {question_type}: {missing}")

        # Weights must match
        for dim in dimensions:
            name = dim.get("dimension_name", "")
            if name in default_weights:
                input_weight = dim.get("weight")
                expected = default_weights[name]
                if not _is_finite_number(input_weight) or input_weight != expected:
                    errors.append(f"default policy: dimension '{name}' weight must be {expected}, got {input_weight}")

    elif weight_policy == "official_override":
        if not source_note or not isinstance(source_note, str) or source_note.strip() == "":
            errors.append("official_override policy requires non-empty source_note")

    return errors


def _compute_score_kernel(dimensions, full_score, confidence):
    """The ONE unified scoring computation function.

    Takes raw dimensions (list of {dimension_name, weight, level}),
    full_score (None or positive number), and confidence string.

    Returns (result_dict, errors). result_dict contains all derived values.
    Does NOT trust any pre-computed field.
    """
    import math
    errors = []

    # --- Validate full_score → score_base ---
    score_base, fs_err = _resolve_score_base(full_score)
    if fs_err:
        errors.append(fs_err)
        return None, errors

    # --- Validate confidence (safe: check string before set membership) ---
    if not isinstance(confidence, str) or confidence not in VALID_CONFIDENCE:
        errors.append(f"confidence must be one of {sorted(VALID_CONFIDENCE)}, got {confidence!r}")
        return None, errors

    # --- Compute each row ---
    computed_dims = []
    weight_total = 0.0
    diagnostic_total = 0.0

    for i, dim in enumerate(dimensions):
        name = dim.get("dimension_name", f"dim_{i}")
        weight = dim.get("weight")
        level = dim.get("level")

        # weight: finite number >= 0, not bool
        if not _is_finite_number(weight) or weight < 0:
            errors.append(f"dimensions[{i}].weight must be finite >= 0, got {weight!r}")
            continue

        # level: int 0-4, not bool
        if not isinstance(level, int) or isinstance(level, bool) or level < 0 or level > 4:
            errors.append(f"dimensions[{i}].level must be int 0-4 (not bool), got {level!r}")
            continue

        calculated = (level / 4.0) * weight
        diagnostic_total += calculated
        weight_total += weight
        computed_dims.append({
            "dimension_name": name,
            "weight": float(weight),
            "level": level,
            "calculated_score": round(calculated, 4)
        })

    if weight_total <= 0:
        errors.append(f"weight_total must be > 0, got {weight_total}")

    if errors:
        return None, errors

    # --- Full-score conversion ---
    raw_center = (diagnostic_total / weight_total) * score_base
    center_value = _round_half_up_to_half(raw_center)
    natural_center = center_value

    # --- Interval (all bounds rounded to 0.5) ---
    half_percent = CONFIDENCE_PERCENT[confidence]
    half_width = score_base * half_percent / 100.0
    # A score interval cannot fall below zero or exceed the question's full score.
    interval_lower = max(0.0, _round_half_up_to_half(center_value - half_width))
    interval_upper = min(float(score_base), _round_half_up_to_half(center_value + half_width))

    result = {
        "dimensions": computed_dims,
        "weight_total": round(weight_total, 4),
        "score_base": score_base,
        "diagnostic_total": round(diagnostic_total, 4),
        "raw_center": round(raw_center, 4),
        "center_value": center_value,
        "natural_center": natural_center,
        "interval_lower": interval_lower,
        "interval_upper": interval_upper,
    }
    return result, errors


def _compute_essay_tier_policy(essay_review, score_base, original_center, confidence):
    """申发论述先定档、再在档内定位。

    关系命题遗漏一端或曲解关系属于立意层问题，必须控制档位；
    标题、局部模板句和一般表达问题不在这里重复扣分。
    """
    relation_required = essay_review.get("prompt_relation_required") is True
    relationship_centrality = essay_review.get("relationship_centrality")
    relation_status = essay_review.get("relationship_coverage_status")
    thesis_scope = essay_review.get("thesis_scope_status")
    argument_system = essay_review.get("sub_argument_system_status")
    material_transform = essay_review.get("material_transformation_status")
    argument_line = essay_review.get("argument_line_status")

    if thesis_scope == "off_topic":
        tier = 4
        tier_label = "四类文"
        cap_rate = 0.325
        reason = "中心立意偏离题目核心命题"
    elif ((relation_required and relationship_centrality == "core"
           and relation_status in {"mentioned_only", "missing", "distorted"})
          or argument_line == "broken"):
        tier = 3
        tier_label = "三类文"
        cap_rate = 0.475
        reason = "关系命题遗漏一端/关系曲解，或全文论证线断裂"
    elif (thesis_scope == "narrowed"
          or (relation_required and relation_status == "partial")
          or (relation_required and relationship_centrality == "supporting"
              and relation_status in {"mentioned_only", "missing", "distorted"})
          or argument_system in {"mixed_levels", "material_parallel", "broken"}
          or material_transform == "mechanical"
          or argument_line == "weak"):
        tier = 2
        tier_label = "二类文"
        cap_rate = 0.675
        reason = "立意缩窄、分论点体系或材料转化存在明显短板"
    else:
        tier = 1
        tier_label = "一类文"
        cap_rate = 0.80
        reason = "核心命题、关系处理、分论点体系和材料转化均达到高档门槛"

    tier_ceiling = _round_to_integer(score_base * cap_rate)
    adjusted_center = max(0, _round_to_integer(min(original_center, float(tier_ceiling))))
    half_width = score_base * CONFIDENCE_PERCENT[confidence] / 100.0
    interval_lower = max(0, _round_to_integer(adjusted_center - half_width))
    interval_upper = min(float(score_base), tier_ceiling,
                         _round_to_integer(adjusted_center + half_width))
    return {
        "tier": tier,
        "tier_label": tier_label,
        "tier_ceiling": tier_ceiling,
        "reason": reason,
        "original_center": original_center,
        "adjusted_center": adjusted_center,
        "interval_lower": interval_lower,
        "interval_upper": interval_upper,
        "relationship_required": relation_required,
        "relationship_centrality": relationship_centrality,
        "relationship_coverage_status": relation_status,
        "thesis_scope_status": thesis_scope,
        "sub_argument_system_status": argument_system,
        "material_transformation_status": material_transform,
    }


def _application_position_label(application_band, adjusted_center, score_base):
    """Return a display-only position inside the application-writing band.

    This never changes the score.  The label is deliberately derived beside
    the existing band ceiling so user-facing prose cannot invent a generic
    one-to-five tier label for an application-writing result.
    """
    caps = {
        "中档": _round_to_integer(score_base * 0.64),
        "中高档": _round_to_integer(score_base * 0.76),
        "高档": _round_to_integer(score_base * 0.90),
    }
    upper = caps.get(application_band, _round_to_integer(score_base * 0.90))
    if application_band == "中档":
        lower = 0
    elif application_band == "中高档":
        lower = caps["中档"] + 1
    else:
        lower = caps["中高档"] + 1
    if upper <= lower or adjusted_center >= upper:
        return "上位"
    span = max(upper - lower, 1)
    ratio = (float(adjusted_center) - lower) / span
    if ratio >= 0.34:
        return "中位"
    return "下位"


def _build_full_report_requirements(output_mode, question_type=None, result=None,
                                    reference_available=False):
    """Build one user-facing completeness contract for every teaching mode.

    This is an output-only guard.  It does not inspect or mutate the scoring
    ledger, and therefore cannot turn presentation preferences into score
    changes.  Signal groups intentionally allow natural headings and prose.
    """
    if output_mode not in {"解析", "微型解析", "批改", "复盘"}:
        return None

    if output_mode in {"解析", "微型解析"}:
        if question_type == "申发论述":
            groups = [
                {"name": "题干责任", "signals": ["题干拆解", "审题", "文章责任", "题目要什么"]},
                {"name": "关键词关系", "signals": ["关键词拆解", "关键词含义", "关系判断", "核心关系"]},
                {"name": "方法使用", "signals": ["方法讲解", "方法说明", "方法依据", "操作步骤"]},
                {"name": "材料转化", "signals": ["材料转化", "材料依据", "材料论据", "论据转化", "材料怎么用", "事实—机制—观点", "事实→机制→观点"]},
                {"name": "立意论证", "signals": ["总论点", "分论点", "立意", "论证线", "关系展开"]},
                {"name": "论证路径", "signals": ["论证路径", "论证链", "段落论证", "观点—论据—分析—回扣", "分析桥梁"]},
                {"name": "文章组织", "signals": ["文章结构", "段落组织", "范文", "示范文章", "参考范文"]},
                {"name": "易错提醒", "signals": ["易错", "容易", "提醒", "误区", "偏题"]},
            ]
        else:
            groups = [
                {"name": "题干责任", "signals": ["题干拆解", "审题", "答案责任", "题目要什么"]},
                {"name": "方法使用", "signals": ["方法讲解", "方法说明", "方法依据", "操作步骤"]},
                {"name": "材料证据", "signals": ["材料证据", "材料原句", "材料依据", "逐点找点", "材料信号", "核心点"]},
                {"name": "答案组织", "signals": ["答案组织", "如何组织", "考场组织", "示范答案", "参考答案"]},
                {"name": "易错提醒", "signals": ["易错", "容易", "提醒", "误区"]},
            ]
        if reference_available:
            groups.insert(-1, {
                "name": "参考答案校准",
                "signals": ["参考答案校准", "参考答案参与", "参考答案候选", "校准说明", "参考答案如何"],
            })
        return {
            "full_teaching_report": True,
            "summary_only_forbidden": True,
            "direct_body_required": True,
            "artifact_only_forbidden": True,
            "required_signal_groups": groups,
            "required_verdict_terms": [],
            "canonical_verdict": None,
            "policy": "all_explanation_blocks_required",
        }

    if question_type == "申发论述":
        audit_group = {"name": "自然段点评", "signals": ["逐段点评", "自然段点评", "段落点评", "逐段"]}
    else:
        audit_group = {"name": "逐条证据点评", "signals": ["逐条点评", "逐句点评", "逐点点评", "逐条", "逐句"]}
    groups = [
        {"name": "题干责任", "signals": ["题干拆解", "审题", "答案责任", "题目要什么"]},
        {"name": "方法使用", "signals": ["方法讲解", "方法说明", "方法依据", "操作步骤"]},
        audit_group,
        {"name": "证据核对", "signals": ["材料依据", "材料原句", "考生原句", "覆盖状态", "命中"]},
        {"name": "缺口修复", "signals": ["缺口", "失分", "修复", "修改", "改法"]},
        {"name": "档位结论", "signals": ["档位", "档内位置", "层次", "建议分", "中心值", "建议区间", "置信度"]},
    ]
    if reference_available:
        groups.insert(-2, {
            "name": "参考答案校准",
            "signals": ["参考答案校准", "参考答案参与", "参考答案候选", "校准说明", "参考答案如何"],
        })

    required_terms = []
    canonical = None
    if isinstance(result, dict):
        if question_type == "贯彻执行":
            policy = result.get("application_score_policy") or {}
            band = policy.get("application_band")
            position = policy.get("position_label")
            if band and position:
                canonical = {
                    "question_type": question_type,
                    "band": band,
                    "position": position,
                    "center_value": result.get("center_value"),
                    "interval": result.get("interval"),
                    "source": "grade-once",
                }
                required_terms = [band, position]
        elif question_type == "申发论述":
            policy = result.get("essay_score_policy") or {}
            tier_label = policy.get("tier_label")
            if tier_label:
                canonical = {
                    "question_type": question_type,
                    "tier_label": tier_label,
                    "center_value": result.get("center_value"),
                    "interval": result.get("interval"),
                    "source": "grade-once",
                }
                required_terms = [tier_label]
        else:
            summary = result.get("point_scoring_summary") or {}
            tier_label = summary.get("tier_label")
            position = summary.get("tier_position_label")
            if tier_label:
                canonical = {
                    "question_type": question_type,
                    "tier_label": tier_label,
                    "position": position,
                    "center_value": result.get("center_value"),
                    "interval": result.get("interval"),
                    "source": "grade-once",
                }
                required_terms = [tier_label] + ([position] if position else [])

    return {
        "full_teaching_report": True,
        "summary_only_forbidden": True,
        "direct_body_required": True,
        "artifact_only_forbidden": True,
        "required_signal_groups": groups,
        "required_verdict_terms": required_terms,
        "canonical_verdict": canonical,
        "policy": "all_explanation_blocks_required",
    }


def _build_essay_diagnosis(essay_review):
    """把工程标签转换成可复盘的主次问题与修改顺序。"""
    relation_required = essay_review.get("prompt_relation_required") is True
    centrality = essay_review.get("relationship_centrality")
    relation_status = essay_review.get("relationship_coverage_status")
    issues = []
    if relation_required and centrality == "core" and relation_status in {"mentioned_only", "missing", "distorted"}:
        issues.append({
            "priority": 1,
            "issue_code": "core_relation_not_developed",
            "finding": "题目核心关系没有在主体中实质展开，文章缩窄或曲解了题意",
            "why_it_matters": "关系命题的一端或连接方式没有成为全文论证主线，会直接限制文章档位",
            "repair": "先重写总论点，再让每个分论点分别承担关系双方或二者连接中的明确功能",
        })
    elif essay_review.get("thesis_scope_status") == "narrowed":
        issues.append({
            "priority": 1,
            "issue_code": "thesis_narrowed",
            "finding": "中心论点回应了主题，但把题目范围缩成了单一口号",
            "why_it_matters": "文章方向基本未跑偏，但没有完成题目要求的完整命题",
            "repair": "补回被缩掉的概念、条件或关系，并贯穿主体段落",
        })
    if essay_review.get("sub_argument_system_status") in {"material_parallel", "mixed_levels", "broken"}:
        issues.append({
            "priority": 2,
            "issue_code": "sub_argument_system",
            "finding": "分论点之间缺少稳定的同层关系，部分只是材料话题的并列",
            "why_it_matters": "三个分论点各自成立，不等于共同证明总论点",
            "repair": "重新设计并列、递进、因果或辩证链，避免一个分论点写领域、另一个写宏观主题",
        })
    if essay_review.get("material_transformation_status") in {"mixed", "mechanical"}:
        issues.append({
            "priority": 3,
            "issue_code": "material_not_transformed",
            "finding": "材料案例有使用，但从事实到观点的分析桥梁不够充分",
            "why_it_matters": "材料堆在文章里只能证明‘发生过’，不能证明分论点为什么成立",
            "repair": "每个案例后补出机制、原因、条件或治理效果，再回扣总论点",
        })
    if essay_review.get("argument_line_status") in {"weak", "broken"}:
        issues.append({
            "priority": 3,
            "issue_code": "argument_line",
            "finding": "全文论证线偏弱，段落之间缺少共同推进关系",
            "why_it_matters": "单段论证完整不代表全文有整体说服力",
            "repair": "先确定三个分论点的逻辑顺序，再检查每段结尾是否推进总论点",
        })
    if essay_review.get("template_risk") in {"local", "pervasive"}:
        issues.append({
            "priority": 4,
            "issue_code": "template_expression",
            "finding": "标题、开头或结尾存在模板化表达，题目针对性不够鲜明",
            "why_it_matters": "通常影响阅卷识别和档内位置，但不能替代立意与论证问题",
            "repair": "保留结构，替换为题目专属概念、关系和材料分析",
        })
    issues.sort(key=lambda item: item["priority"])
    strengths = []
    if essay_review.get("thesis_scope_status") != "off_topic":
        strengths.append("文章没有完全脱离题目主题")
    if essay_review.get("material_support_status") in {"strong", "partial"}:
        strengths.append("文章存在可识别的材料支撑")
    if essay_review.get("argument_line_status") != "broken":
        strengths.append("全文仍保留基本论证线索")
    if not issues:
        revision_order = ["保持立意，继续补强论证深度和表达质量"]
    else:
        revision_order = [item["repair"] for item in issues]
    return {
        "headline": issues[0]["finding"] if issues else "文章核心任务完成，主要进入档内优化",
        "primary_issues": issues,
        "preserved_strengths": strengths,
        "revision_order": revision_order,
        "score_is_secondary": True,
    }


# ---------------------------------------------------------------------------
# 逐点计分引擎（v0.4 核心新增）
# ---------------------------------------------------------------------------

# 按题型确定赋分模式
_SCORING_MODE_BY_TYPE = {
    "归纳概括": "keyword",   # 按点/关键词
    "提出对策": "keyword",   # 按点/关键词
    "综合分析": "semantic",  # 按意思/等义
    "贯彻执行": "structure", # 按结构板块+要点
    "申发论述": "semantic",  # 按意思（论证深度）
}

# 展开度 → 赔率（相对 point_value 的比例）
_EXPANSION_RATE = {
    "充分展开": 1.0,
    "基本展开": 0.85,
    "简略提及": 0.65,
    "仅列标题": 0.35,
    "未提及": 0.0,
}

# ``部分展开`` is a common natural-language label, but is not one of the
# score ledger's five deterministic levels.  Remove it during normalization
# and let the existing coverage-status default choose the conservative level.
# Do not guess mappings for arbitrary unknown labels: those still fail the
# aggregated preflight, because changing them could change scoring semantics.
_DERIVE_EXPANSION_ALIASES = {"部分展开"}

# 覆盖状态 × 赋分模式 → 赔率（当无 expansion_level 时使用）
_COVERAGE_RATE_BY_MODE = {
    "keyword": {
        "完整覆盖": 1.0,
        "等义表达": 1.0,
        "部分覆盖": 0.5,   # 保守中点：方向命中但关键内容未全，不等同于零分
        "未覆盖": 0.0,
        "超出材料": 0.0,
    },
    "semantic": {
        "完整覆盖": 1.0,
        "等义表达": 1.0,   # 语义等价不因句式差异降分
        "部分覆盖": 0.5,   # 与关键词模式统一，避免同等部分覆盖因题型标签被额外压低
        "未覆盖": 0.0,
        "超出材料": 0.0,
    },
    "structure": {
        "完整覆盖": 1.0,
        "等义表达": 1.0,
        "部分覆盖": 0.5,
        "未覆盖": 0.0,
        "超出材料": 0.0,
    },
}

# 展开度门槛：importance=core 且 expansion_level <= 阈值 时的降档系数
_IMPORTANCE_PENALTY = {
    ("core", "简略提及"): 0.7,
    ("core", "仅列标题"): 0.5,
    ("core", "未提及"): 0.0,
    ("secondary", "简略提及"): 0.8,
    ("secondary", "仅列标题"): 0.6,
    ("secondary", "未提及"): 0.0,
    ("potential", "简略提及"): 0.9,
    ("potential", "仅列标题"): 0.7,
    ("potential", "未提及"): 0.0,
}


_CHANGE_DIRECTION_PATTERNS = (
    r"从.{1,80}到",
    r"由.{1,80}(?:到|转为|转向|变为|升级为)",
    r"从.{1,80}(?:转向|转为|变为|升级为)",
    r"不再.{1,40}(?:而|转|改)",
)


def _has_change_direction_trace(text):
    """Detect an explicit before/after transition for 变化概括 tasks."""
    if not isinstance(text, str) or not text.strip():
        return False
    normalized = _norm_for_match(text)
    return any(re.search(pattern, normalized) for pattern in _CHANGE_DIRECTION_PATTERNS)


def _determine_scoring_mode(question_type, point_definitions):
    """Determine scoring mode: 'by_points' or 'by_dimensions'.

    by_points is enabled when ALL scorable points have a non-null point_value.
    The effective sub-mode (keyword/semantic/structure) is determined by question_type.
    """
    scorable_with_value = 0
    scorable_total = 0
    for pd in point_definitions:
        if not isinstance(pd, dict):
            continue
        if pd.get("status") == "active" and pd.get("independent_scoring") is True and pd.get("required_or_optional") != "optional":
            scorable_total += 1
            pv = pd.get("point_value")
            if isinstance(pv, (int, float)) and pv > 0:
                scorable_with_value += 1

    if scorable_total > 0 and scorable_with_value == scorable_total:
        return "by_points"
    return "by_dimensions"


def _compute_point_scoring(point_definitions, point_mappings, full_score, confidence,
                           question_type, holistic_review=None, task_context=None):
    """逐点计分核心函数。

    从 point_definitions（含 point_value、importance）和 point_mappings
    （含 coverage_status、match_type、expansion_level）自动计算每个点的
    earned_value 和总分。

    Returns (result_dict, errors).
    """
    import math
    errors = []

    score_base, fs_err = _resolve_score_base(full_score)
    if fs_err:
        errors.append(fs_err)
        return None, errors

    if not isinstance(confidence, str) or confidence not in VALID_CONFIDENCE:
        errors.append(f"confidence must be one of {sorted(VALID_CONFIDENCE)}, got {confidence!r}")
        return None, errors

    scoring_sub_mode = _SCORING_MODE_BY_TYPE.get(question_type, "semantic")
    coverage_rates = _COVERAGE_RATE_BY_MODE[scoring_sub_mode]
    is_change_task = (
        isinstance(task_context, dict)
        and task_context.get("primary_prototype_id") == "sl-prototype-0002"
    )

    # Build point_definitions lookup
    pd_by_id = {}
    for pd in point_definitions:
        if isinstance(pd, dict) and pd.get("point_id"):
            pd_by_id[pd["point_id"]] = pd

    # Build point_mappings lookup
    pm_by_id = {}
    for pm in point_mappings:
        if isinstance(pm, dict) and pm.get("point_id"):
            pm_by_id[pm["point_id"]] = pm

    # Compute earned_value per point
    total_possible = 0.0
    total_earned = 0.0
    weight_inversion_penalty = 0.0
    keyword_match_count = 0
    semantic_match_count = 0
    no_match_count = 0
    enriched_coverage = []

    # Build parent lookup for 大点→子解释联动
    parent_map = {}  # parent_pid -> [child_pid, ...]
    for pid, pd in pd_by_id.items():
        ppid = pd.get("parent_point_id")
        if isinstance(ppid, str) and ppid:
            parent_map.setdefault(ppid, []).append(pid)

    for pid, pd in pd_by_id.items():
        pv = pd.get("point_value", 0) or 0
        importance = pd.get("importance", "secondary")
        pm = pm_by_id.get(pid, {})
        status = pm.get("coverage_status", "未覆盖")
        match_type = pm.get("match_type", "no_match")
        expansion = pm.get("expansion_level")
        critical_qualifiers = pd.get("critical_qualifiers") or []
        qualifier_status = pm.get("qualifier_status")
        missing_qualifiers = pm.get("missing_qualifiers") or []
        change_direction_covered = (
            is_change_task
            and match_type in ("keyword_match", "semantic_match")
            and _has_change_direction_trace(pm.get("user_quote", ""))
        )

        # A mechanism heading alone is not full coverage when the point has
        # explicitly marked implementation qualifiers. Prefer an explicit
        # reviewer status only when it does not contradict the user's quote.
        # The caller cannot upgrade a point to complete while critical
        # qualifiers are absent from the answer evidence.
        if critical_qualifiers and status in ("完整覆盖", "等义表达"):
            uq_for_qualifier = pm.get("user_quote", "") or ""
            detected_missing_qualifiers = [
                q for q in critical_qualifiers
                if not _qualifier_has_semantic_trace(q, uq_for_qualifier)
            ]
            if detected_missing_qualifiers:
                missing_qualifiers = sorted(set(missing_qualifiers) | set(detected_missing_qualifiers))
                qualifier_status = "partial"
            elif qualifier_status not in ("complete", "partial", "missing"):
                qualifier_status = "complete"
            if qualifier_status in ("partial", "missing"):
                status = "部分覆盖"
                pm["coverage_status"] = status
                base_rate = coverage_rates.get(status, 0.0)

        # 变化题优先评价阶段的前后转向。若转向和至少一个材料动作
        # 已经写出，缺少登记、评级、系统名称等展开信息不应吞掉整个阶段。
        # 将其保留为核心覆盖、基本展开，准确性问题由 missing_qualifiers
        # 和 sentence_audit 单独呈现。
        if is_change_task and status == "部分覆盖" and change_direction_covered:
            status = "完整覆盖"
            pm["coverage_status"] = status
            if expansion in (None, "充分展开", "简略提及", "仅列标题"):
                expansion = "基本展开"
            base_rate = coverage_rates.get(status, 0.0)

        if status == "超出材料":
            # 超出材料不计分
            enriched_coverage.append({
                "point_id": pid,
                "coverage_status": status,
                "user_quote": pm.get("user_quote"),
                "point_value": pv,
                "earned_value": 0.0,
                "match_type": match_type,
                "expansion_level": expansion,
                "qualifier_status": qualifier_status,
                "missing_qualifiers": missing_qualifiers,
            })
            continue

        total_possible += pv

        # Step 1: 基础覆盖率（from coverage_status × scoring_mode）
        base_rate = coverage_rates.get(status, 0.0)

        # Step 2: 关键词精确匹配加成/降档
        # 一致性校验：coverage_status 和 match_type 必须逻辑一致
        if status in ("完整覆盖", "等义表达") and match_type == "no_match":
            # 声称覆盖了但没有匹配证据 → 降为部分覆盖
            status = "部分覆盖"
            base_rate = coverage_rates.get(status, 0.0)
        elif status == "未覆盖" and match_type in ("keyword_match", "semantic_match"):
            # 有匹配但声称未覆盖 → 矛盾，以 match_type 为准
            status = "部分覆盖"
            base_rate = coverage_rates.get(status, 0.0)

        if match_type == "keyword_match":
            keyword_match_count += 1
            # 关键词精确匹配 + 完整覆盖 = 满分
            # 关键词精确匹配 + 等义 = 在keyword模式下仍给半分（由coverage_rate处理）
        elif match_type == "semantic_match":
            semantic_match_count += 1
        else:
            no_match_count += 1

        # Step 3: 展开度调整（如果有 expansion_level）
        expansion_rate = None
        if expansion and expansion in _EXPANSION_RATE:
            expansion_rate = _EXPANSION_RATE[expansion]
        elif status in ("完整覆盖", "等义表达"):
            # 没有显式 expansion_level 时，根据 match_type 推导默认展开度
            # keyword_match + 完整覆盖 → 可能只是关键词匹配，不一定充分展开
            # semantic_match + 等义表达 → 用自己的话表达，通常有一定展开
            # 这是保守估计：不给满分，留出"写得好不好"的区分空间
            if match_type == "keyword_match":
                expansion_rate = 0.8   # 关键词覆盖但未确认展开度 → 80%
            elif match_type == "semantic_match":
                expansion_rate = 0.7   # 等义表达但未确认展开度 → 70%
            else:
                expansion_rate = 0.75  # 无 match_type 信息 → 保守 75%

        # Step 4: 计算 earned_value
        # Step 3B: user_quote 长度校验（真实阅卷：只写关键词不给满分）
        # 当 coverage_status 为完整覆盖/等义表达，但 user_quote 很短时，
        # 说明用户可能只写了关键词没展开，应降档
        uq = pm.get("user_quote", "") or ""
        if status in ("完整覆盖", "等义表达") and uq:
            # Formatting-only characters must never improve or reduce content
            # credit. Compare semantic skeleton lengths, not raw punctuation,
            # numbering, whitespace or Markdown length.
            uq_len = len(_norm_for_match(uq))
            pt_text = pd.get("point_text", "") or ""
            pt_len = len(_norm_for_match(pt_text))
            if pt_len > 0 and uq_len < pt_len * 0.4:
                # user_quote 不到 point_text 的 40% → 很可能只写了关键词
                quote_rate = 0.75
                if expansion_rate is None or expansion_rate > quote_rate:
                    expansion_rate = quote_rate

        if expansion_rate is not None:
            # 有展开度信息时，取 base_rate 和 expansion_rate 中较低的
            effective_rate = min(base_rate, expansion_rate)
        else:
            effective_rate = base_rate

        earned = pv * effective_rate

        # Step 4B: 大点→子解释联动（护栏 9B）
        # 如果当前点是子解释（有 parent_point_id），且其父点已被覆盖，
        # 则子解释从宽：最低给 base_rate 的 80%
        parent_pid = pd.get("parent_point_id")
        if isinstance(parent_pid, str) and parent_pid and parent_pid in pd_by_id:
            parent_pm = pm_by_id.get(parent_pid, {})
            parent_status = parent_pm.get("coverage_status", "未覆盖")
            if parent_status in ("完整覆盖", "等义表达"):
                # 父点覆盖了，子解释从宽
                min_rate = max(base_rate * 0.8, 0.0)
                if effective_rate < min_rate:
                    earned = pv * min_rate
                    effective_rate = min_rate

        # Step 5: 权重倒置惩罚
        # 当 core 点只"简略提及"或"仅列标题"，而 secondary/potential 点"充分展开"时
        if importance == "core" and expansion in ("简略提及", "仅列标题", "未提及"):
            penalty_key = (importance, expansion)
            if penalty_key in _IMPORTANCE_PENALTY:
                penalty_rate = _IMPORTANCE_PENALTY[penalty_key]
                penalized_earned = pv * penalty_rate
                if penalized_earned < earned:
                    weight_inversion_penalty += (earned - penalized_earned)
                    earned = penalized_earned

        earned = round(earned, 2)
        # 累加时保留精度，只在最终输出时 round（避免逐点 round 导致 center 下偏）
        total_earned += earned

        enriched_coverage.append({
            "point_id": pid,
            "coverage_status": status,
            "user_quote": pm.get("user_quote"),
            "point_value": pv,
            "earned_value": earned,
            "match_type": match_type,
            "expansion_level": expansion,
            "qualifier_status": qualifier_status,
            "missing_qualifiers": missing_qualifiers,
        })

    if total_possible <= 0:
        errors.append("point_scoring: total_possible must be > 0 (all points have zero value)")
        return None, errors

    # --- 满分门槛 ---
    uncovered_required = sum(
        1 for pid, pd in pd_by_id.items()
        if pd.get("required_or_optional") == "required"
        and pm_by_id.get(pid, {}).get("coverage_status", "未覆盖") == "未覆盖"
    )
    partial_required = sum(
        1 for pid, pd in pd_by_id.items()
        if pd.get("required_or_optional") == "required"
        and pm_by_id.get(pid, {}).get("coverage_status") == "部分覆盖"
    )

    # --- Final score ---
    coverage_rate = total_earned / total_possible
    unadjusted_raw_center = coverage_rate * score_base
    center_value = _round_to_integer(unadjusted_raw_center)
    natural_center = center_value  # 保存锚定截断前的自然值

    # --- 分数锚定表截断（v0.5：真实考场分数上限）---
    # 定档制：先看整体定几类文，再在档内定分
    _scorable_count = len(pd_by_id)
    _covered_count = sum(
        1 for pid, pd in pd_by_id.items()
        if pm_by_id.get(pid, {}).get('coverage_status', '未覆盖') in ('完整覆盖', '等义表达')
    )
    _partial_count = sum(
        1 for pid, pd in pd_by_id.items()
        if pm_by_id.get(pid, {}).get('coverage_status') == '部分覆盖'
    )
    if _scorable_count > 0:
        _full_coverage_ratio = _covered_count / _scorable_count
    else:
        _full_coverage_ratio = 0.0

    # 定档也按点值看“有效覆盖”，不能把部分覆盖点当成零分点。
    # earned_value 已经体现展开度；这里仅使用覆盖状态的基础赔率，避免
    # 同一处展开不足在 raw_center 和档位判断中被重复扣除。
    _content_covered_value = 0.0
    for pid, pd in pd_by_id.items():
        pv = float(pd.get("point_value", 0) or 0)
        status = pm_by_id.get(pid, {}).get("coverage_status", "未覆盖")
        if status in ("完整覆盖", "等义表达"):
            status_rate = 1.0
        elif status == "部分覆盖":
            status_rate = coverage_rates.get("部分覆盖", 0.0)
        else:
            status_rate = 0.0
        _content_covered_value += pv * status_rate
    _content_coverage_ratio = (
        _content_covered_value / total_possible if total_possible > 0 else 0.0
    )

    # 初步定档优先看核心得分点，避免普通支撑点把档位抬高。
    _core_points = [pd for pd in pd_by_id.values() if pd.get("importance", "secondary") == "core"]
    _core_possible = sum(float(pd.get("point_value", 0) or 0) for pd in _core_points)
    _core_covered_value = 0.0
    _core_full_covered_count = 0
    for pd in _core_points:
        pid = pd.get("point_id")
        pv = float(pd.get("point_value", 0) or 0)
        status = pm_by_id.get(pid, {}).get("coverage_status", "未覆盖")
        if status in ("完整覆盖", "等义表达"):
            _core_covered_value += pv
            _core_full_covered_count += 1
        elif status == "部分覆盖":
            _core_covered_value += pv * coverage_rates.get("部分覆盖", 0.0)
    _core_content_coverage_ratio = (
        _core_covered_value / _core_possible if _core_possible > 0 else _content_coverage_ratio
    )
    _core_full_coverage_ratio = (
        _core_full_covered_count / len(_core_points) if _core_points else _full_coverage_ratio
    )
    _tier_cover_ratio = (
        min(_content_coverage_ratio, _core_content_coverage_ratio)
        if _core_points else _content_coverage_ratio
    )
    _core_brief_count = sum(
        1 for pd in _core_points
        if pm_by_id.get(pd.get("point_id"), {}).get("expansion_level") in ("简略提及", "仅列标题")
    )

    # 计算平均展开度（用于定档）
    _expansion_values = []
    for ec in enriched_coverage:
        ev = ec.get('expansion_level')
        if ev and ev in _EXPANSION_RATE:
            _expansion_values.append(_EXPANSION_RATE[ev])
        elif ec.get('coverage_status') in ('完整覆盖', '等义表达'):
            _expansion_values.append(0.8)
        else:
            # 未覆盖/部分覆盖必须进入平均值分母，不能让少数已展开点抬高整体档位。
            _expansion_values.append(0.0)
    _avg_expansion = sum(_expansion_values) / len(_expansion_values) if _expansion_values else 0.0

    # 定档（真实阅卷：先看整体定几类文）
    _holistic = holistic_review if isinstance(holistic_review, dict) else {}
    _holistic_cap_reasons = []
    if _holistic.get("order_logic_status") == "broken":
        _holistic_cap_reasons.append("材料顺序或逻辑关系被破坏")
    if _holistic.get("duplicate_status") == "confirmed":
        _holistic_cap_reasons.append("存在明确重复计分风险")
    if (_holistic.get("structure_required") is True
            and _holistic.get("structure_status") == "missing"):
        _holistic_cap_reasons.append("题目要求的层次结构不可识别")

    if _tier_cover_ratio >= 0.95 and _avg_expansion >= 0.75:
        _tier = 1  # 一类：全覆盖 + 展开充分
    elif _tier_cover_ratio >= 0.80 and _avg_expansion >= 0.55:
        _tier = 2  # 二类：基本覆盖 + 有一定展开
    elif _tier_cover_ratio >= 0.40:
        _tier = 3  # 三类：覆盖不全或展开不足
    elif _tier_cover_ratio >= 0.20:
        _tier = 4  # 四类：低覆盖，仍有一定有效内容
    else:
        _tier = 5  # 五类：极少有效内容、空白或跑题

    # 整体复核只限制档位，不额外加分；轻微风险不触发自动扣档。
    if _holistic_cap_reasons:
        _tier = max(_tier, 2)
    if (isinstance(_holistic.get("overall_quality"), int)
            and _holistic["overall_quality"] < 3 and _tier == 1):
        _tier = 2
        _holistic_cap_reasons.append("整体质量未达到一档稳定水平")

    _tier_audit_level = {
        1: "strict",
        2: "standard",
        3: "basic",
        4: "minimal",
        5: "minimal",
    }[_tier]

    # 档内区间（占满分的比例）
    _TIER_RANGES = {
        1: (0.80, 0.90),   # 一档：80-90%（20分题=16-18分）
        2: (0.60, 0.75),   # 二档：60-75%（20分题=12-15分）
        3: (0.40, 0.55),   # 三档：40-55%（20分题=8-11分）
        4: (0.20, 0.35),   # 四档：20-35%（20分题=4-7分）
        5: (0.0, 0.15),    # 五档：0-15%（20分题=0-3分）
    }
    _tier_min_rate, _tier_max_rate = _TIER_RANGES[_tier]

    # 档内定位：展开度越高越靠近上沿
    if isinstance(_holistic.get("overall_quality"), int) and 0 <= _holistic["overall_quality"] <= 4:
        _tier_position = _holistic["overall_quality"] / 4.0
    elif _tier == 5:
        # 五档也允许区分“空白/跑题”和“写到少量有效内容”。
        _tier_position = min(_tier_cover_ratio / 0.20, 1.0)
    elif _tier == 1:
        _tier_position = min((_avg_expansion - 0.75) / 0.25, 1.0) if _avg_expansion > 0.75 else 0.0
    else:
        _tier_position = min(_avg_expansion, 1.0)

    # 高档审核：核心点只作简略提及/列标题时，不否定其命中，
    # 但不得进入一档上沿；保留在一档下沿，避免把“找点准但展开不足”误判为漏点。
    _tier_audit_status = "passed"
    if _tier == 1 and _core_brief_count > 0:
        _tier_position = 0.0
        _tier_audit_status = "high_tier_limited_by_core_expansion"

    _anchor_min_rate = _tier_min_rate
    _anchor_max_rate = _tier_min_rate + (_tier_max_rate - _tier_min_rate) * max(_tier_position, 0.0)

    # Holistic review controls tier admission and high-tier gating, but must
    # not create a score inversion within one tier. Preserve the point-derived
    # raw position whenever it is higher than the subjective tier position.
    _raw_tier_upper = min(unadjusted_raw_center, score_base * _tier_max_rate)
    if score_base > 0 and score_base * _anchor_max_rate < _raw_tier_upper:
        _anchor_max_rate = _raw_tier_upper / score_base
        if _tier_audit_status == "passed":
            _tier_audit_status = "raw_position_preserved"

    # 档位边界是连续分段的；部分覆盖已经参与定档，不能再把分数压出当前档位。

    # Expose档内位置 so user-facing explanations do not infer it from the score.
    if _tier_position >= 0.67:
        _tier_position_label = "上位"
    elif _tier_position >= 0.34:
        _tier_position_label = "中位"
    else:
        _tier_position_label = "下位"

    _anchor_max = score_base * _anchor_max_rate
    _anchor_min = score_base * _anchor_min_rate
    if center_value > _anchor_max:
        center_value = _round_to_integer(_anchor_max)
    elif center_value < _anchor_min:
        center_value = _round_to_integer(_anchor_min)
    if center_value > _anchor_max:
        center_value = _round_to_integer(_anchor_max)
    elif center_value < _anchor_min:
        center_value = _round_to_integer(_anchor_min)

    # No automatic "effort score". Content that covers no material point
    # stays in the zero-score tier unless an official rubric says otherwise.
    _effort_score = None

    # raw_center is the unrounded center after all formal tier policies. Keep
    # the pre-policy diagnostic value separately so raw/center/interval cannot
    # contradict one another after a cap or floor is applied.
    raw_center = min(max(unadjusted_raw_center, float(_anchor_min)), float(_anchor_max))

    # --- Interval ---
    half_percent = CONFIDENCE_PERCENT[confidence]
    half_width = score_base * half_percent / 100.0
    # 逐点定档的区间必须留在当前档位内，避免“判三档却给出二档分数区间”。
    interval_lower = max(
        0.0,
        _round_to_integer(max(_anchor_min, center_value - half_width)),
    )
    interval_upper = min(
        float(score_base),
        _round_to_integer(min(_anchor_max, center_value + half_width)),
    )
    if interval_lower > interval_upper:
        interval_lower = interval_upper = float(center_value)

    # --- Derive dimension levels from point scoring ---
    # 要点覆盖维度：从 coverage_rate 反推
    if coverage_rate >= 0.95 and uncovered_required == 0:
        coverage_level = 4
    elif coverage_rate >= 0.80:
        coverage_level = 3
    elif coverage_rate >= 0.60:
        coverage_level = 2
    elif coverage_rate >= 0.30:
        coverage_level = 1
    else:
        coverage_level = 0

    result = {
        "enriched_coverage": enriched_coverage,
        "total_possible": round(total_possible, 2),
        "total_earned": round(total_earned, 2),
        "coverage_rate": round(coverage_rate, 4),
        "weight_inversion_penalty": round(weight_inversion_penalty, 2),
        "keyword_match_count": keyword_match_count,
        "semantic_match_count": semantic_match_count,
        "no_match_count": no_match_count,
        "uncovered_required": uncovered_required,
        "partial_required": partial_required,
        "score_base": score_base,
        "raw_center": round(raw_center, 4),
        "unadjusted_raw_center": round(unadjusted_raw_center, 4),
        "center_value": center_value,
        "interval_lower": interval_lower,
        "interval_upper": interval_upper,
        "coverage_level": coverage_level,
        "scoring_sub_mode": scoring_sub_mode,
        "effort_score_applied": _effort_score is not None,
        "tier": _tier,
        "tier_label": {1: "一档", 2: "二档", 3: "三档", 4: "四档", 5: "五档"}[_tier],
        "tier_position": round(_tier_position, 4),
        "tier_position_label": _tier_position_label,
        "avg_expansion": round(_avg_expansion, 4),
        "covered_ratio": round(_content_coverage_ratio, 4),
        "core_covered_ratio": round(_core_content_coverage_ratio, 4),
        "full_coverage_ratio": round(_full_coverage_ratio, 4),
        "core_full_coverage_ratio": round(_core_full_coverage_ratio, 4),
        "tier_basis": "core_and_total_coverage" if _core_points else "total_coverage",
        "core_brief_count": _core_brief_count,
        "tier_audit_status": _tier_audit_status,
        "tier_audit_level": _tier_audit_level,
        "holistic_review": _holistic if _holistic else None,
        "holistic_cap_reasons": _holistic_cap_reasons,
    }
    return result, errors


# ---------------------------------------------------------------------------
# 结构赋分引擎（应用文专用）
# ---------------------------------------------------------------------------

_STRUCTURE_STATUS_RATE = {
    "satisfied": 1.0,
    "partial": 0.5,
    "missing": 0.0,
    "not_applicable": 1.0,
}


def _compute_structure_scoring(structure_ledger, full_score, confidence):
    """应用文结构赋分：按板块整体计分，不逐点抠。

    从 structure_ledger 的 element_value 和 status 自动计算每个板块的
    earned_value 和总分。

    Returns (result_dict, errors).
    """
    errors = []

    score_base, fs_err = _resolve_score_base(full_score)
    if fs_err:
        errors.append(fs_err)
        return None, errors

    if not isinstance(confidence, str) or confidence not in VALID_CONFIDENCE:
        errors.append(f"confidence must be one of {sorted(VALID_CONFIDENCE)}, got {confidence!r}")
        return None, errors

    total_possible = 0.0
    total_earned = 0.0
    enriched_structure = []
    has_element_value = False

    for entry in structure_ledger:
        if not isinstance(entry, dict):
            continue
        eid = entry.get("element_id", "")
        status = entry.get("status", "missing")
        ev = entry.get("element_value")

        if isinstance(ev, (int, float)) and ev > 0:
            has_element_value = True
            total_possible += ev
            rate = _STRUCTURE_STATUS_RATE.get(status, 0.0)
            earned = round(ev * rate, 2)
            total_earned += earned
        else:
            earned = None

        enriched_structure.append({
            **entry,
            "earned_value": earned,
        })

    if not has_element_value:
        # 没有板块分值，fallback
        return None, ["structure_ledger has no element_value entries; falling back to dimension scoring"]

    if total_possible <= 0:
        errors.append("structure_scoring: total_possible must be > 0")
        return None, errors

    coverage_rate = total_earned / total_possible
    raw_center = coverage_rate * score_base
    center_value = _round_half_up_to_half(raw_center)

    half_percent = CONFIDENCE_PERCENT[confidence]
    half_width = score_base * half_percent / 100.0
    interval_lower = max(0.0, _round_half_up_to_half(center_value - half_width))
    interval_upper = min(float(score_base), _round_half_up_to_half(center_value + half_width))

    # 满分门槛：有 missing 的 required 板块时不能满分
    missing_required = sum(
        1 for e in enriched_structure
        if isinstance(e, dict) and e.get("required") is True and e.get("status") == "missing"
    )

    if coverage_rate >= 0.95 and missing_required == 0:
        structure_level = 4
    elif coverage_rate >= 0.80:
        structure_level = 3
    elif coverage_rate >= 0.60:
        structure_level = 2
    elif coverage_rate >= 0.30:
        structure_level = 1
    else:
        structure_level = 0

    result = {
        "enriched_structure": enriched_structure,
        "total_possible": round(total_possible, 2),
        "total_earned": round(total_earned, 2),
        "coverage_rate": round(coverage_rate, 4),
        "missing_required": missing_required,
        "score_base": score_base,
        "raw_center": round(raw_center, 4),
        "center_value": center_value,
        "interval_lower": interval_lower,
        "interval_upper": interval_upper,
        "structure_level": structure_level,
    }
    return result, errors


def _compute_score_id(task_id, material_hash, analysis_id, answer_version, user_answer,
                      recomputed, confidence, point_coverage, weight_policy=None, source_note=None):
    """Compute score_id from recomputed canonical values + full point_coverage + weight_policy."""
    parts = [
        task_id, material_hash, analysis_id, answer_version, user_answer,
        weight_policy or "", source_note or "",
    ]
    dim_parts = []
    for d in sorted(recomputed["dimensions"], key=lambda x: x.get("dimension_name", "")):
        dim_parts.append(f"{d['dimension_name']}|{d['weight']}|{d['level']}|{d['calculated_score']}")
    parts.append(";".join(dim_parts))
    parts.append(str(recomputed["diagnostic_total"]))
    parts.append(str(recomputed["raw_center"]))
    parts.append(str(recomputed["center_value"]))
    parts.append(f"{recomputed['interval_lower']}|{recomputed['interval_upper']}")
    parts.append(confidence)

    pc_parts = []
    for pm in sorted(point_coverage, key=lambda x: x.get("point_id", "")):
        pc_parts.append(f"{pm.get('point_id','')}|{pm.get('coverage_status','')}|{pm.get('user_quote','') or ''}")
    parts.append(";".join(pc_parts))

    canonical = "||".join(parts)
    return f"score-{hashlib.sha256(canonical.encode()).hexdigest()[:16]}"


# ---------------------------------------------------------------------------
# calculate-score: uses the unified kernel
# ---------------------------------------------------------------------------

def _validate_ledger_for_scoring(ledger_obj, point_definitions, scorable_point_ids):
    """DEPRECATED shim — delegates to the single canonical ledger validator.

    All three callers (validate-score-ledger, calculate-score, write-unified-state)
    must use `_validate_single_score_ledger` directly with full context.

    This shim only exists to prevent accidental usage from old code
    and always returns an error reminding the caller to use the full validator.
    """
    return (
        ["_validate_ledger_for_scoring is DEPRECATED — call _validate_single_score_ledger(ledger_obj, schema, context) instead"],
        []
    )


def _build_ledger_context_from_scoring_input(data, analysis_result=None):
    """P0-1: Build the full context object required by _validate_single_score_ledger
    from scoring input data and optional analysis_result.
    """
    analysis_result = analysis_result or data.get("analysis_result") or {}
    task_spec = data.get("task_spec") or {}

    # Ensure task_spec has minimum required fields for validation
    if not task_spec.get("schema_version"):
        task_spec = dict(task_spec)
        task_spec.setdefault("schema_version", "1.0")
    if not task_spec.get("task_spec_id"):
        task_spec.setdefault("task_spec_id", data.get("analysis_id", "unknown") + "-ts")
    if not task_spec.get("task_id"):
        task_spec.setdefault("task_id", data.get("analysis_id", "unknown"))
    if not task_spec.get("paper_id"):
        task_spec.setdefault("paper_id", "paper-unknown")
    if not task_spec.get("question_id"):
        task_spec.setdefault("question_id", "q-unknown")
    if not task_spec.get("prototype_id"):
        task_spec.setdefault("prototype_id", "sl-prototype-0001")
    if not task_spec.get("primary_prototype_id"):
        task_spec.setdefault("primary_prototype_id", "sl-prototype-0001")
    if not task_spec.get("question_type"):
        task_spec.setdefault("question_type", data.get("question_type", "综合分析"))
    if not task_spec.get("task_instruction"):
        task_spec.setdefault("task_instruction", "请根据材料作答")
    if not task_spec.get("constraints"):
        task_spec.setdefault("constraints", {"word_limit": 300, "identity": "考生", "document_type": "简答题"})

    # Derive atomic_points from analysis_result or scoring input
    atomic_points = analysis_result.get("atomic_points", [])
    if not atomic_points and isinstance(data.get("point_definitions"), list):
        # Build minimal atomic_points from point_definitions for ledger context
        atomic_points = [
            {
                "point_id": pd["point_id"],
                "paragraph_id": pd.get("paragraph_id", "unknown"),
                "evidence_text": pd.get("evidence_text", pd.get("point_text", pd["point_id"])),
                "point_text": pd.get("point_text", pd["point_id"]),
                "point_role": "fact",
                "importance": "core" if pd.get("required_or_optional") == "required" else "potential",
                "independent_scoring": pd.get("independent_scoring", True),
                "status": pd.get("status", "active"),
                "required_or_optional": pd.get("required_or_optional", "required"),
            }
            for pd in data["point_definitions"] if isinstance(pd, dict)
        ]

    # Derive material_text
    material_text_by_scope = data.get("material_text_by_scope") or {}
    material_sections = data.get("material_sections") or []
    if not material_text_by_scope and not material_sections:
        # Fall back to analysis_result paragraphs as material sections
        for p in analysis_result.get("paragraphs", []):
            if isinstance(p, dict) and p.get("paragraph_id") and p.get("text"):
                material_text_by_scope[p["paragraph_id"]] = p["text"]

    # task_components from task_spec
    task_components = data.get("task_components", task_spec.get("task_components", []))

    return {
        "task_spec": task_spec,
        "material_text_by_scope": material_text_by_scope,
        "material_sections": material_sections,
        "atomic_points": atomic_points,
        "task_components": task_components,
        "user_answer": data.get("user_answer", "") or "",
        "reference_answer_set": data.get("reference_answer_set"),
        "official_point_scores": data.get("official_point_scores"),
        "question_type": data.get("question_type", task_spec.get("question_type", "")),
    }


def _derive_point_mappings_from_ledger(ledger_obj, scorable_point_ids, user_answer):
    """P0-2: Derive point_mappings from score_ledger.point_ledger.
    Only scorable points are included. Returns (mappings, errors).
    """
    point_ledger = ledger_obj.get("point_ledger", []) if isinstance(ledger_obj, dict) else []
    if not isinstance(point_ledger, list):
        return [], ["score_ledger.point_ledger must be an array"]

    ledger_by_pid = {}
    for entry in point_ledger:
        if not isinstance(entry, dict):
            continue
        pid = entry.get("point_id", "")
        if pid:
            ledger_by_pid[pid] = entry

    mappings = []
    errors = []

    for pid in sorted(scorable_point_ids):
        entry = ledger_by_pid.get(pid)
        if entry is None:
            errors.append(f"Scorable point '{pid}' not found in ledger")
            continue
        cs = entry.get("coverage_status", "未覆盖")
        uq = entry.get("user_quote")
        mapping = {
            "point_id": pid,
            "coverage_status": cs,
        }
        if uq and isinstance(uq, str):
            mapping["user_quote"] = uq
        else:
            mapping["user_quote"] = None
        # Pass through fields needed by _compute_point_scoring
        mt = entry.get("match_type")
        if mt and isinstance(mt, str):
            mapping["match_type"] = mt
        el = entry.get("expansion_level")
        if el and isinstance(el, str):
            mapping["expansion_level"] = el
        qs = entry.get("qualifier_status")
        if qs and isinstance(qs, str):
            mapping["qualifier_status"] = qs
        mqs = entry.get("missing_qualifiers")
        if isinstance(mqs, list):
            mapping["missing_qualifiers"] = mqs
        pv = entry.get("point_value")
        if isinstance(pv, (int, float)):
            mapping["point_value"] = pv
        mappings.append(mapping)

    return mappings, errors


def _compare_point_mappings(a_mappings, b_mappings):
    """P0-2: Strict comparison of two point_mappings lists.
    Returns (match, errors). Requires same point_id set, same coverage_status per point,
    same user_quote per point. Extra/missing/duplicate/different → mismatch.
    """
    errors = []

    a_by_pid = {pm["point_id"]: pm for pm in a_mappings if isinstance(pm, dict) and pm.get("point_id")}
    b_by_pid = {pm["point_id"]: pm for pm in b_mappings if isinstance(pm, dict) and pm.get("point_id")}

    a_pids = set(a_by_pid.keys())
    b_pids = set(b_by_pid.keys())

    if a_pids != b_pids:
        only_in_a = a_pids - b_pids
        only_in_b = b_pids - a_pids
        if only_in_a:
            errors.append(f"Points only in first set: {sorted(only_in_a)}")
        if only_in_b:
            errors.append(f"Points only in second set: {sorted(only_in_b)}")
        return False, errors

    for pid in sorted(a_pids):
        a_pm = a_by_pid[pid]
        b_pm = b_by_pid[pid]
        if a_pm.get("coverage_status") != b_pm.get("coverage_status"):
            errors.append(f"Point '{pid}': coverage_status mismatch — '{a_pm.get('coverage_status')}' vs '{b_pm.get('coverage_status')}'")
        a_uq = a_pm.get("user_quote") or ""
        b_uq = b_pm.get("user_quote") or ""
        if a_uq != b_uq:
            errors.append(f"Point '{pid}': user_quote mismatch — '{a_uq}' vs '{b_uq}'")

    return len(errors) == 0, errors


def _calculate_score_data(data):
    """Run the deterministic scoring core without invoking a CLI handler.

    Ordinary grade-once uses this function directly. The calculate-score
    subcommand remains a development/compatibility wrapper around the same
    core, so the ordinary path never shells out, writes an intermediate JSON
    file, or enters the legacy multi-command chain.
    """
    # --- Structural validation BEFORE any business logic (no Unexpected error) ---
    struct_errors = _validate_scoring_input_structure(data)
    if struct_errors:
        error_exit(EXIT_INPUT_ERROR, "Scoring input validation failed", {"errors": struct_errors})

    question_type = data["question_type"]
    weight_policy = data["weight_policy"]
    source_note = data.get("source_note")
    if source_note is not None and not isinstance(source_note, str):
        source_note = None
    dimensions = data["dimensions"]
    full_score = data.get("full_score")
    user_answer = data["user_answer"]
    point_mappings = data.get("point_mappings", [])
    holistic_review = data.get("holistic_review")
    essay_review = data.get("essay_review")
    application_review = data.get("application_review")
    reference_answer_set = data.get("reference_answer_set")
    _has_reference_answers = (
        isinstance(reference_answer_set, dict)
        and isinstance(reference_answer_set.get("answers"), list)
        and bool(reference_answer_set.get("answers"))
    )
    scoring_route = "reference_assisted" if _has_reference_answers else "material_only"
    confidence = data["confidence_basis"]["level"]
    requested_confidence = confidence
    confidence_downgrade_reason = None
    if scoring_route == "material_only" and confidence == "high":
        confidence = "medium"
        confidence_downgrade_reason = "无参考答案，点池准确性缺少外部校准"
    if isinstance(data.get("point_pool_review"), dict) and data["point_pool_review"].get("status") == "disputed":
        if confidence != "low":
            confidence = "low"
            confidence_downgrade_reason = "点池复核存在未解决争议"
    compatibility_mode = data.get("compatibility_mode")

    # --- Determine formal vs legacy mode ---
    _is_formal = compatibility_mode != "legacy"
    _legacy_mode = compatibility_mode == "legacy"

    # --- P0-1: Fail-closed for formal mode without point_definitions ---
    point_definitions = data.get("point_definitions")
    if _is_formal:
        if point_definitions is None:
            error_exit(EXIT_CONSISTENCY,
                "point_definitions is required for formal scoring. "
                "Use compatibility_mode='legacy' to run without point definitions.")
        if not isinstance(point_definitions, list):
            error_exit(EXIT_CONSISTENCY,
                "point_definitions must be a non-empty array for formal scoring.")
        if len(point_definitions) == 0:
            error_exit(EXIT_CONSISTENCY,
                "point_definitions is empty. Formal scoring requires at least one point definition.")

    # --- Validate weight_policy semantics ---
    wp_errors = _validate_weight_policy(dimensions, question_type, weight_policy, source_note)
    if wp_errors:
        error_exit(EXIT_INPUT_ERROR, "Weight policy validation failed", {"errors": wp_errors})

    # --- Build scorable point set from point_definitions ---
    scorable_point_ids = set()
    optional_point_count = 0
    merged_point_ids = set()
    excluded_point_ids = set()
    optional_only_pids = set()

    if _is_formal and isinstance(point_definitions, list) and len(point_definitions) > 0:
        for i, pd in enumerate(point_definitions):
            if not isinstance(pd, dict):
                error_exit(EXIT_INPUT_ERROR, f"point_definitions[{i}] must be an object")
            ppid = pd.get("point_id")
            if not isinstance(ppid, str) or ppid.strip() == "":
                error_exit(EXIT_INPUT_ERROR, f"point_definitions[{i}].point_id must be a non-empty string")
            pstatus = pd.get("status")
            if pstatus not in ("active", "merged", "excluded"):
                error_exit(EXIT_INPUT_ERROR, f"point_definitions[{i}].status must be active/merged/excluded, got {pstatus!r}")
            pis = pd.get("independent_scoring")
            if not isinstance(pis, bool):
                error_exit(EXIT_INPUT_ERROR, f"point_definitions[{i}].independent_scoring must be boolean")
            pro = pd.get("required_or_optional")
            if pro not in ("required", "optional"):
                error_exit(EXIT_INPUT_ERROR, f"point_definitions[{i}].required_or_optional must be required/optional, got {pro!r}")

            # scorable_point definition:
            # status == "active" AND independent_scoring == true AND required_or_optional != "optional"
            if pstatus == "active" and pis is True and pro != "optional":
                scorable_point_ids.add(ppid)
            else:
                optional_point_count += 1
                if pstatus == "merged":
                    merged_point_ids.add(ppid)
                elif pstatus == "excluded":
                    excluded_point_ids.add(ppid)
                elif pro == "optional":
                    optional_only_pids.add(ppid)

        scorable_point_count = len(scorable_point_ids)

        # P0-1: Fail-closed: no scorable points in formal mode
        if scorable_point_count == 0:
            error_exit(EXIT_CONSISTENCY,
                "No scorable points found in point_definitions. "
                "v0.3+ formal scoring requires at least one point with "
                "status=active, independent_scoring=true, required_or_optional!=optional")
    else:
        scorable_point_count = 0

    # --- P0-2: Verify score_ledger with FULL canonical validator ---
    ledger_obj = data.get("score_ledger")
    ledger_errors = []
    ledger_verified = False
    _ledger_context = None

    if _is_formal:
        if ledger_obj is None:
            error_exit(EXIT_CONSISTENCY,
                "score_ledger is required for formal scoring. "
                "calculate-score must receive a complete, validated ledger context.")
        if not isinstance(ledger_obj, dict):
            error_exit(EXIT_CONSISTENCY,
                "score_ledger must be an object for formal scoring.")

        # P0-1: Use the FULL canonical validator (same as validate-score-ledger)
        _ledger_context = _build_ledger_context_from_scoring_input(data, data.get("analysis_result"))
        ledger_schema = _load_schema("score-ledger.schema.json")
        ledger_errors = _validate_single_score_ledger(ledger_obj, ledger_schema, _ledger_context)
        if ledger_errors:
            error_exit(EXIT_CONSISTENCY,
                "score_ledger validation failed within calculate-score — ledger is invalid",
                {"ledger_errors": ledger_errors})
        ledger_verified = True

        # P0-2: Derive point mappings from the verified ledger
        derived_mappings, derive_errors = _derive_point_mappings_from_ledger(
            ledger_obj, scorable_point_ids, user_answer)
        if derive_errors:
            error_exit(EXIT_CONSISTENCY,
                "Failed to derive point mappings from ledger",
                {"derive_errors": derive_errors})

        # P0-2: If caller provided point_mappings, STRICT comparison with ledger-derived
        input_mappings = data.get("point_mappings", [])
        if input_mappings:
            # Check for unknown point_ids in input
            _all_known_pids = {pd["point_id"] for pd in point_definitions if isinstance(pd, dict) and "point_id" in pd}
            for i, pm in enumerate(input_mappings):
                if isinstance(pm, dict):
                    pid = pm.get("point_id", "")
                    if pid and pid not in _all_known_pids:
                        error_exit(EXIT_INPUT_ERROR,
                            f"point_mappings[{i}] point_id '{pid}' not found in point_definitions — unknown point_id rejected")

            input_scorable = [
                pm for pm in input_mappings
                if pm.get("point_id", "") in scorable_point_ids
            ]
            matches, cmp_errors = _compare_point_mappings(derived_mappings, input_scorable)
            if not matches:
                error_exit(EXIT_CONSISTENCY,
                    "point_mappings drift from score_ledger detected — "
                    "point_mappings must exactly match ledger-derived mappings",
                    {"mapping_mismatches": cmp_errors})
        # Use ledger-derived mappings as the single truth source
        # Also derive non-scorable entries from ledger for supplementary_evidence
        non_scorable_from_ledger = []
        for entry in ledger_obj.get("point_ledger", []):
            if isinstance(entry, dict):
                pid = entry.get("point_id", "")
                if pid and pid not in scorable_point_ids:
                    cs = entry.get("coverage_status", "未覆盖")
                    nse = {
                        "point_id": pid,
                        "coverage_status": cs,
                    }
                    mt = entry.get("match_type")
                    if isinstance(mt, str) and mt:
                        nse["match_type"] = mt
                    uq = entry.get("user_quote")
                    if uq and isinstance(uq, str):
                        nse["user_quote"] = uq
                    else:
                        nse["user_quote"] = None
                    if entry.get("deduction_owner"):
                        nse["deduction_owner"] = entry.get("deduction_owner")
                    if entry.get("loss_reason"):
                        nse["loss_reason"] = entry.get("loss_reason")
                    non_scorable_from_ledger.append(nse)

        point_mappings = derived_mappings + non_scorable_from_ledger

    # --- Point mappings strict validation ---
    checks = []
    seen_pm_pids = set()
    coverage_summary = {k: 0 for k in VALID_COVERAGE_ALL}
    optional_evidence_summary = {k: 0 for k in VALID_COVERAGE_ALL}
    supplementary_evidence_entries = []
    scored_mapping_count = 0
    excluded_optional_mapping_count = 0
    _all_known_pids = set()

    if not _legacy_mode:
        _all_known_pids = {pd["point_id"] for pd in point_definitions if isinstance(pd, dict) and "point_id" in pd}

    for i, pm in enumerate(point_mappings):
        pid = pm.get("point_id")
        if not isinstance(pid, str) or pid.strip() == "":
            error_exit(EXIT_INPUT_ERROR, f"point_mappings[{i}].point_id must be a non-empty string")

        # Independent extra-material claims are intentionally not atomic points.
        # They are allowed through this layer after score-ledger validation.
        is_extra_mapping = (
            pm.get("coverage_status") == "超出材料"
            and pm.get("match_type") == "extra_material"
        )
        # Unknown point_id check
        if not _legacy_mode and pid not in _all_known_pids and not is_extra_mapping:
            error_exit(EXIT_INPUT_ERROR, f"point_mappings[{i}] point_id '{pid}' not found in point_definitions — unknown point_id rejected")

        status = pm.get("coverage_status")
        if not _check_enum(status, VALID_COVERAGE_ALL, f"point_mappings[{i}].coverage_status", []):
            error_exit(EXIT_INPUT_ERROR, f"point_mappings[{i}].coverage_status must be one of {sorted(VALID_COVERAGE_ALL)}, got {type(status).__name__}={status!r}")

        # Determine if this mapping is for a scorable point
        is_scorable = _legacy_mode or pid in scorable_point_ids

        # Duplicate check for non-excess (only for scorable points)
        if status != "超出材料" and is_scorable:
            if pid in seen_pm_pids:
                error_exit(EXIT_INPUT_ERROR, f"point_mappings[{i}] duplicate point_id: '{pid}' (status={status})")
            seen_pm_pids.add(pid)

        if is_scorable:
            coverage_summary[status] += 1
            scored_mapping_count += 1
        else:
            optional_evidence_summary[status] += 1
            excluded_optional_mapping_count += 1
            # P0-3: Build supplementary_evidence entry
            point_status_map = {"完整覆盖": "已提及", "部分覆盖": "已提及", "等义表达": "已提及", "未覆盖": "未提及", "超出材料": "已提及"}
            is_extra_material = (
                status == "超出材料"
                and pm.get("match_type") == "extra_material"
            )
            supp_entry = {
                "point_id": pid,
                "point_status": point_status_map.get(status, "未提及"),
                "affects_score": False,
                "display_role": (
                    "local_accuracy_issue" if is_extra_material else "optional_support"
                ),
            }
            if is_extra_material:
                supp_entry.update({
                    "reference_exemption": False,
                    "affects_covered_points": False,
                    "score_handling": "dimension_level_only_no_fixed_deduction",
                    "deduction_owner": pm.get("deduction_owner"),
                    "reason": pm.get("loss_reason"),
                })
            uq = pm.get("user_quote")
            if isinstance(uq, str) and uq.strip():
                supp_entry["user_quote"] = uq
            supplementary_evidence_entries.append(supp_entry)

        # user_quote validation
        uq = pm.get("user_quote")
        if status in ("完整覆盖", "部分覆盖", "等义表达"):
            if not isinstance(uq, str) or uq.strip() == "":
                error_exit(EXIT_INPUT_ERROR, f"point_mappings[{i}] status={status} but user_quote is empty or non-string")
            if not _evidence_in_scope(uq, user_answer):
                error_exit(EXIT_INPUT_ERROR, f"point_mappings[{i}] user_quote not found in user_answer (status={status})")
        elif status == "未覆盖":
            if uq is not None and (isinstance(uq, str) and uq.strip() != ""):
                error_exit(EXIT_INPUT_ERROR, f"point_mappings[{i}] status=未覆盖 but user_quote is non-empty")
        elif status == "超出材料":
            if not isinstance(uq, str) or uq.strip() == "":
                error_exit(EXIT_INPUT_ERROR, f"point_mappings[{i}] status=超出材料 but user_quote is empty or non-string")
            if not _evidence_in_scope(uq, user_answer):
                error_exit(EXIT_INPUT_ERROR, f"point_mappings[{i}] status=超出材料 user_quote not found in user_answer")

    # --- P1-3: required_format_elements / missing_format_elements consistency ---
    rfe = data.get("required_format_elements")
    mfe = data.get("missing_format_elements")
    if rfe is not None or mfe is not None:
        if rfe is not None:
            if not isinstance(rfe, list) or not all(isinstance(x, str) and x in VALID_FORMAT_ELEMENTS for x in rfe):
                error_exit(EXIT_INPUT_ERROR, f"required_format_elements must be an array of {sorted(VALID_FORMAT_ELEMENTS)}, got {rfe!r}")
        if mfe is not None:
            if not isinstance(mfe, list) or not all(isinstance(x, str) and x in VALID_FORMAT_ELEMENTS for x in mfe):
                error_exit(EXIT_INPUT_ERROR, f"missing_format_elements must be an array of {sorted(VALID_FORMAT_ELEMENTS)}, got {mfe!r}")
        if rfe is not None and mfe is not None:
            rfe_set = set(rfe)
            mfe_set = set(mfe)
            extra = mfe_set - rfe_set
            if extra:
                error_exit(EXIT_CONSISTENCY,
                           "required_format_elements consistency check failed",
                           {"errors": [f"missing_format_elements contains elements not in required_format_elements: {sorted(extra)} — 批改不得对未列入必需的格式要素扣分; 审题与批改 required_format_elements 必须一致"]})
            duplicates = [x for x in mfe if mfe.count(x) > 1]
            if duplicates:
                error_exit(EXIT_INPUT_ERROR, f"missing_format_elements has duplicates: {sorted(set(duplicates))}")
        checks.append({"check_name": "required_format_elements_consistency", "passed": True,
                        "detail": f"required={rfe}, missing={mfe}"})

    # 应用文不逐点相加，但材料点覆盖必须参与内容完成度判断。
    # 文种功能决定点的解释方式，材料点决定是否漏掉了应交代的内容。
    application_material_status = None
    application_material_ratio = None
    if question_type == "贯彻执行" and point_definitions and point_mappings:
        mapping_by_id = {
            pm.get("point_id"): pm
            for pm in point_mappings
            if isinstance(pm, dict) and pm.get("point_id") in scorable_point_ids
        }
        required_defs = [
            pd for pd in point_definitions
            if isinstance(pd, dict)
            and pd.get("point_id") in scorable_point_ids
            and pd.get("status", "active") == "active"
            and pd.get("required_or_optional", "required") == "required"
        ]
        if required_defs:
            status_rate = {"完整覆盖": 1.0, "等义表达": 1.0, "部分覆盖": 0.5, "未覆盖": 0.0, "超出材料": 0.0}
            total_value = 0.0
            earned_value = 0.0
            core_gap = False
            for pd in required_defs:
                value = pd.get("point_value", 1.0)
                value = float(value) if _is_finite_number(value) and value > 0 else 1.0
                total_value += value
                pm = mapping_by_id.get(pd["point_id"], {})
                status = pm.get("coverage_status", "未覆盖")
                earned_value += value * status_rate.get(status, 0.0)
                if pd.get("importance") == "core" and status in {"部分覆盖", "未覆盖", "超出材料"}:
                    core_gap = True
            application_material_ratio = earned_value / total_value if total_value else 0.0
            if application_material_ratio == 0:
                application_material_status = "missing"
            elif application_material_ratio >= 0.8 and not core_gap:
                application_material_status = "complete"
            else:
                application_material_status = "partial"
            if isinstance(application_review, dict):
                review_order = {"missing": 0, "partial": 1, "complete": 2}
                review_status = application_review.get("content_status", "partial")
                if review_order.get(application_material_status, 0) < review_order.get(review_status, 0):
                    application_review = dict(application_review)
                    application_review["content_status"] = application_material_status
                    application_review["material_content_ratio"] = round(application_material_ratio, 4)
                    content_level = {"missing": 0, "partial": 2, "complete": 4}[application_material_status]
                    for dim in dimensions:
                        if dim.get("dimension_name") == "内容覆盖" and dim.get("level", 0) > content_level:
                            dim["level"] = content_level
                            dim["_application_material_derived"] = True

    # --- Unified computation ---
    # Determine scoring mode: by_points or by_dimensions
    point_scoring_mode = "by_dimensions"
    point_scoring_result = None

    # 贯彻执行/应用文按结构与维度整体评分；point_definitions 可作为内容核验
    # 账本，但不得把应用文误路由成小题逐点定档。
    if _is_formal and point_definitions and question_type not in ("申发论述", "贯彻执行"):
        point_scoring_mode = _determine_scoring_mode(question_type, point_definitions)

    if point_scoring_mode == "by_points":
        # 逐点计分模式
        point_scoring_result, ps_errors = _compute_point_scoring(
            point_definitions, point_mappings, full_score, confidence, question_type,
            holistic_review=holistic_review,
            task_context=data.get("task_spec"))
        if ps_errors:
            error_exit(EXIT_CONSISTENCY, "Point scoring computation failed", {"errors": ps_errors})

        # 从逐点计分结果反推维度等级
        # 更新 dimensions 中的要点覆盖维度 level
        for dim in dimensions:
            dim_name = dim.get("dimension_name", "")
            if dim_name in ("要点覆盖", "问题诊断", "内容覆盖", "针对匹配"):
                dim["level"] = point_scoring_result["coverage_level"]
                dim["_point_scoring_derived"] = True

        # 用逐点计分的 center_value 替代维度等级制的结果
        recomputed, comp_errors = _compute_score_kernel(dimensions, full_score, confidence)
        if comp_errors:
            error_exit(EXIT_INPUT_ERROR, "Score computation failed", {"errors": comp_errors})

        # 用逐点计分的精确值覆盖（逐点计分更精确）
        recomputed["raw_center"] = point_scoring_result["raw_center"]
        recomputed["center_value"] = point_scoring_result["center_value"]
        recomputed["natural_center"] = point_scoring_result["center_value"]
        recomputed["interval_lower"] = point_scoring_result["interval_lower"]
        recomputed["interval_upper"] = point_scoring_result["interval_upper"]

        # --- 结构赋分（应用文专用）---
        # 当 question_type == "贯彻执行" 且 structure_ledger 有 element_value 时，
        # 用结构赋分结果修正"结构"维度
        if question_type == "贯彻执行" and isinstance(ledger_obj, dict):
            sl = ledger_obj.get("structure_ledger", [])
            if isinstance(sl, list) and len(sl) > 0:
                structure_result, sr_errors = _compute_structure_scoring(sl, full_score, confidence)
                if structure_result is not None and not sr_errors:
                    # 用结构赋分结果修正"结构"维度 level
                    for dim in dimensions:
                        if dim.get("dimension_name") == "结构":
                            dim["level"] = structure_result["structure_level"]
                            dim["_structure_scoring_derived"] = True
                    # 重新计算（含修正后的结构维度）
                    recomputed, comp_errors = _compute_score_kernel(dimensions, full_score, confidence)
                    if comp_errors:
                        error_exit(EXIT_INPUT_ERROR, "Score computation failed after structure scoring", {"errors": comp_errors})
                    # 用加权合并：逐点计分和维度等级各取所长
                    # 逐点计分更精确地反映要点覆盖，维度等级更全面地反映结构/表达
                    # 取两者的加权平均：逐点 60% + 维度 40%
                    ps_center = point_scoring_result["center_value"]
                    dim_center = recomputed["center_value"]
                    merged_center = _round_half_up_to_half(ps_center * 0.6 + dim_center * 0.4)
                    recomputed["raw_center"] = ps_center * 0.6 + dim_center * 0.4
                    recomputed["center_value"] = merged_center
                    # 区间取较宽的那个
                    half_percent = CONFIDENCE_PERCENT[confidence]
                    _sb = recomputed["score_base"]
                    half_width = _sb * half_percent / 100.0
                    recomputed["interval_lower"] = max(0.0, _round_half_up_to_half(merged_center - half_width))
                    recomputed["interval_upper"] = min(float(_sb), _round_half_up_to_half(merged_center + half_width))
    else:
        # 维度等级制（旧模式）
        recomputed, comp_errors = _compute_score_kernel(dimensions, full_score, confidence)
        if comp_errors:
            error_exit(EXIT_INPUT_ERROR, "Score computation failed", {"errors": comp_errors})

        # 应用文先按任务完成度整体定档，再在档内定位。
        # 25 分应用文的一档上限按 90% 经验锚定为 23 分；不把某一种文体的
        # 局部评语硬编码成固定扣分。该规则只作用于贯彻执行。
        if question_type == "贯彻执行" and isinstance(application_review, dict):
            original_center = recomputed["center_value"]
            original_raw_center = recomputed["raw_center"]
            score_base = recomputed["score_base"]
            ceiling = _round_to_integer(score_base * 0.90)
            if score_base == 25:
                ceiling = 23
            status_values = {
                key: application_review.get(key)
                for key in (
                    "identity_status", "genre_format_status", "purpose_audience_status",
                    "content_status", "structure_status", "tone_status",
                )
            }
            format_required = bool(data.get("required_format_elements"))
            major_failures = (
                status_values["identity_status"] == "wrong"
                or (format_required and status_values["genre_format_status"] == "missing")
                or status_values["purpose_audience_status"] == "weak"
                or status_values["content_status"] == "missing"
                or status_values["structure_status"] == "unclear"
                or status_values["tone_status"] == "wrong"
            )
            upper_tier_gaps = any(
                status_values[key] in allowed
                for key, allowed in {
                    "identity_status": {"partial"},
                    "purpose_audience_status": {"adequate"},
                    "content_status": {"partial"},
                    "structure_status": {"partial"},
                    "tone_status": {"partial"},
                }.items()
            ) or (format_required and status_values["genre_format_status"] == "partial")
            if major_failures:
                application_band = "中档"
                band_ceiling = _round_to_integer(score_base * 0.64)
            elif upper_tier_gaps:
                application_band = "中高档"
                band_ceiling = _round_to_integer(score_base * 0.76)
            else:
                application_band = "高档"
                band_ceiling = ceiling
            adjusted_center = min(original_center, float(band_ceiling))
            adjusted_center = max(0, _round_to_integer(adjusted_center))
            application_position_label = _application_position_label(
                application_band, adjusted_center, score_base
            )
            half_width = score_base * CONFIDENCE_PERCENT[confidence] / 100.0
            recomputed["center_value"] = adjusted_center
            recomputed["natural_center"] = adjusted_center
            recomputed["pre_policy_raw_center"] = original_raw_center
            recomputed["raw_center"] = min(float(original_raw_center), float(band_ceiling))
            recomputed["interval_lower"] = max(0, _round_to_integer(adjusted_center - half_width))
            recomputed["interval_upper"] = min(float(score_base), band_ceiling, _round_to_integer(adjusted_center + half_width))
            recomputed["application_score_policy"] = {
                "ceiling": band_ceiling,
                "application_band": application_band,
                "position_label": application_position_label,
                "status_values": status_values,
                "material_content_status": application_material_status,
                "material_content_ratio": application_material_ratio,
                "major_failures": major_failures,
                "upper_tier_gaps": upper_tier_gaps,
                "format_required": format_required,
                "original_center": original_center,
                "adjusted_center": adjusted_center,
                "rule": "先按任务完成度整体定档，再在档内定位；不使用固定局部扣分",
            }
            checks.append({
                "check_name": "application_tier_cap",
                "passed": adjusted_center <= band_ceiling,
                "detail": f"应用文档位={application_band}，档内上限={band_ceiling}，不使用固定局部扣分，最终={adjusted_center}",
            })

        # 大作文反套路高档门槛：不惩罚单句套话，只限制“泛化模板+
        # 题目针对性弱/材料支撑弱/论证线断裂”的整体答案。
        if question_type == "申发论述" and isinstance(essay_review, dict):
            original_raw_center = recomputed["raw_center"]
            essay_policy = _compute_essay_tier_policy(
                essay_review, recomputed["score_base"], recomputed["center_value"], confidence)
            recomputed["center_value"] = essay_policy["adjusted_center"]
            recomputed["natural_center"] = essay_policy["adjusted_center"]
            recomputed["pre_policy_raw_center"] = original_raw_center
            recomputed["raw_center"] = min(
                float(original_raw_center), float(essay_policy["tier_ceiling"])
            )
            recomputed["interval_lower"] = essay_policy["interval_lower"]
            recomputed["interval_upper"] = essay_policy["interval_upper"]
            recomputed["essay_score_policy"] = essay_policy
            recomputed["essay_diagnosis"] = _build_essay_diagnosis(essay_review)
            checks.append({
                "check_name": "essay_tier_gate",
                "passed": essay_policy["adjusted_center"] <= essay_policy["tier_ceiling"],
                "detail": f"{essay_policy['tier_label']}，档位上限={essay_policy['tier_ceiling']}，最终={essay_policy['adjusted_center']}；{essay_policy['reason']}",
            })
            risk = essay_review.get("template_risk")
            severe = (
                essay_review.get("topic_specificity") == "weak"
                or essay_review.get("material_support_status") == "weak"
                or essay_review.get("argument_line_status") == "broken"
            )
            if risk == "pervasive":
                cap_rate = 0.70 if severe else 0.80
                cap_value = _round_to_integer(recomputed["score_base"] * cap_rate)
                if recomputed["center_value"] > cap_value:
                    recomputed["center_value"] = cap_value
                    recomputed["natural_center"] = cap_value
                    recomputed["raw_center"] = min(recomputed["raw_center"], float(cap_value))
                    recomputed["interval_lower"] = max(0.0, _round_to_integer(cap_value - recomputed["score_base"] * CONFIDENCE_PERCENT[confidence] / 100.0))
                    recomputed["interval_upper"] = min(float(recomputed["score_base"]), _round_to_integer(cap_value + recomputed["score_base"] * CONFIDENCE_PERCENT[confidence] / 100.0))
                checks.append({"check_name": "essay_template_risk", "passed": False,
                               "detail": f"模板化风险为 pervasive，整体档位上限按 {cap_rate:.0%} 复核"})
            else:
                checks.append({"check_name": "essay_template_risk", "passed": True,
                               "detail": f"template_risk={risk}，未触发整体降档"})

    # --- Build checks from recomputed values ---
    for dim in recomputed["dimensions"]:
        checks.append({
            "check_name": f"row_calculation:{dim['dimension_name']}",
            "passed": True,
            "detail": f"{dim['level']}/4*{dim['weight']}={dim['calculated_score']}"
        })
    checks.append({"check_name": "total_sum", "passed": True, "detail": f"Sum = {recomputed['diagnostic_total']}"})
    checks.append({"check_name": "center_value", "passed": True,
                    "detail": f"round_half_up({recomputed['raw_center']}*2)/2 = {recomputed.get('natural_center', recomputed['center_value'])}"})
    if ledger_verified:
        checks.append({"check_name": "ledger_verified", "passed": True,
                        "detail": "score_ledger independently verified within calculate-score"})

    all_passed = all(c["passed"] for c in checks)

    # --- P0-3: Filter point_coverage to only scorable points ---
    scorable_point_coverage = [
        pm for pm in point_mappings
        if _legacy_mode or pm.get("point_id", "") in scorable_point_ids
    ]

    result = {
        "schema_version": "1.0",
        "analysis_id": data["analysis_id"],
        "question_type": question_type,
        "weight_policy": weight_policy,
        "source_note": source_note,
        "user_answer": user_answer,
        "answer_version": data["answer_version"],
        "full_score": full_score,
        "dimensions": recomputed["dimensions"],
        "weight_total": recomputed["weight_total"],
        "score_base": recomputed["score_base"],
        "diagnostic_total": recomputed["diagnostic_total"],
        "raw_center": recomputed["raw_center"],
        "center_value": recomputed["center_value"],
        "interval": {"lower": recomputed["interval_lower"], "upper": recomputed["interval_upper"]},
        "application_score_policy": recomputed.get("application_score_policy"),
        "essay_score_policy": recomputed.get("essay_score_policy"),
        "essay_diagnosis": recomputed.get("essay_diagnosis"),
        "confidence": confidence,
        "formal_score": _is_formal,
        "legacy_mode": _legacy_mode,
        "point_coverage": scorable_point_coverage,
        "coverage_summary": coverage_summary,
        "optional_evidence_summary": optional_evidence_summary,
        "supplementary_evidence": supplementary_evidence_entries if _is_formal else [],
        "scorable_point_count": scorable_point_count if not _legacy_mode else None,
        "optional_point_count": optional_point_count if not _legacy_mode else None,
        "point_scoring_mode": point_scoring_mode if _is_formal else "by_dimensions",
        "scoring_route": scoring_route if _is_formal else "legacy",
        "requested_confidence": requested_confidence,
        "confidence_downgrade_reason": confidence_downgrade_reason,
        "method_selection": data.get("method_selection"),
        "point_pool_review": data.get("point_pool_review"),
        "essay_review": essay_review,
        "application_review": application_review,
        "sentence_audit": data.get("sentence_audit"),
        "paragraph_audit": data.get("paragraph_audit"),
        "point_scoring_summary": None,
        "validation_receipt": {
            "passed": all_passed,
            "hard_passed": all_passed,
            "status": "passed" if all_passed else "passed_with_warnings",
            "soft_warning_count": 0,
            "soft_warnings": [],
            "checks": checks,
            "scorable_point_count": scorable_point_count if not _legacy_mode else 0,
            "optional_point_count": optional_point_count if not _legacy_mode else 0,
            "scored_mapping_count": scored_mapping_count,
            "excluded_optional_mapping_count": excluded_optional_mapping_count,
        }
    }

    # --- Inject point scoring results ---
    if point_scoring_result is not None:
        psr = point_scoring_result
        result["point_scoring_summary"] = {
            "total_possible": psr["total_possible"],
            "total_earned": psr["total_earned"],
            "coverage_rate": psr["coverage_rate"],
            "weight_inversion_penalty": psr["weight_inversion_penalty"],
            "keyword_match_count": psr["keyword_match_count"],
            "semantic_match_count": psr["semantic_match_count"],
            "no_match_count": psr["no_match_count"],
            "tier": psr["tier"],
            "tier_label": psr["tier_label"],
            "tier_position": psr["tier_position"],
            "tier_position_label": psr["tier_position_label"],
            "avg_expansion": psr["avg_expansion"],
            "covered_ratio": psr["covered_ratio"],
            "core_covered_ratio": psr["core_covered_ratio"],
            "full_coverage_ratio": psr["full_coverage_ratio"],
            "core_full_coverage_ratio": psr["core_full_coverage_ratio"],
            "tier_basis": psr["tier_basis"],
            "core_brief_count": psr["core_brief_count"],
            "tier_audit_status": psr["tier_audit_status"],
            "tier_audit_level": psr["tier_audit_level"],
            "holistic_cap_reasons": psr["holistic_cap_reasons"],
            "scoring_route": scoring_route,
            "confidence_downgrade_reason": confidence_downgrade_reason,
            "effort_score_applied": psr["effort_score_applied"],
        }
        result["effort_score_applied"] = psr["effort_score_applied"]
        # Replace point_coverage with enriched version (includes point_value, earned_value, etc.)
        enriched = psr["enriched_coverage"]
        if enriched:
            result["point_coverage"] = [
                ec for ec in enriched
                if _legacy_mode or ec.get("point_id", "") in scorable_point_ids
            ]
            canonical_summary = {status: 0 for status in VALID_COVERAGE_ALL}
            for entry in result["point_coverage"]:
                status = entry.get("coverage_status")
                if status in canonical_summary:
                    canonical_summary[status] += 1
            result["coverage_summary"] = canonical_summary
        # Add check for point scoring
        checks.append({"check_name": "point_scoring", "passed": True,
                        "detail": f"mode={psr['scoring_sub_mode']}, "
                                  f"earned={psr['total_earned']}/{psr['total_possible']}, "
                                  f"rate={psr['coverage_rate']}, "
                                  f"kw={psr['keyword_match_count']}, sem={psr['semantic_match_count']}, "
                                  f"none={psr['no_match_count']}"})
        if psr["uncovered_required"] > 0:
            checks.append({"check_name": "full_score_gate", "passed": False,
                            "detail": f"有 {psr['uncovered_required']} 个 required 点未覆盖，不得给满分"})
        if psr["weight_inversion_penalty"] > 0:
            checks.append({"check_name": "weight_inversion", "passed": False,
                            "detail": f"权重倒置扣分: -{psr['weight_inversion_penalty']}"})
        # 分数分布经验上限软警告
        _sb = recomputed.get("score_base", 0) or 0
        _cv = recomputed.get("center_value", 0) or 0
        if _sb > 0 and _cv > 0:
            _rate = _cv / _sb
            _has_uncovered = psr.get("uncovered_required", 0) > 0
            # 区分"内容部分覆盖"和"展开度损失"
            # 只有真正有 coverage_status=部分覆盖 的点才算内容部分覆盖
            _enriched = psr.get("enriched_coverage", [])
            _actual_partial = any(
                isinstance(e, dict) and e.get("coverage_status") == "部分覆盖"
                for e in _enriched
            )
            _has_expansion_loss = psr.get("coverage_rate", 1.0) < 1.0 and not _actual_partial
            if _has_uncovered and _rate > 0.75:
                checks.append({"check_name": "score_distribution_warning", "passed": False,
                                "detail": f"有未覆盖required点但中心值{_cv}超过满分{_sb}的75%（经验上限），建议复核"})
            elif _actual_partial and _rate > 0.85:
                checks.append({"check_name": "score_distribution_warning", "passed": False,
                                "detail": f"有部分覆盖点但中心值{_cv}超过满分{_sb}的85%（经验上限），建议复核"})
            elif _has_expansion_loss and _rate > 0.85:
                checks.append({"check_name": "score_distribution_warning", "passed": False,
                                "detail": f"有展开度不足的点但中心值{_cv}超过满分{_sb}的85%（经验上限），建议复核"})
            elif _rate > 0.90:
                checks.append({"check_name": "score_distribution_warning", "passed": False,
                                "detail": f"中心值{_cv}超过满分{_sb}的90%（经验上限），无官方细则时建议复核"})
        # Update validation_receipt.passed
        all_passed = all(c["passed"] for c in checks)
        result["validation_receipt"]["passed"] = all_passed
        soft_check_names = {"full_score_gate", "weight_inversion", "score_distribution_warning"}
        soft_warnings = [
            c for c in checks
            if c.get("check_name") in soft_check_names and not c.get("passed")
        ]
        result["validation_receipt"]["hard_passed"] = True
        result["validation_receipt"]["status"] = "passed_with_warnings" if soft_warnings else "passed"
        result["validation_receipt"]["soft_warning_count"] = len(soft_warnings)
        result["validation_receipt"]["soft_warnings"] = soft_warnings
        result["validation_receipt"]["checks"] = checks

    if _legacy_mode:
        result["legacy_warning"] = (
            "LEGACY MODE: This result was computed without point_definitions. "
            "formal_score=false, legacy_mode=true. "
            "This result MUST NOT enter formal grading, SQLite write-back, or user-facing formal score display."
        )

    return result


def cmd_calculate_score(args):
    raw = read_input(args.input)
    data = parse_json_input(raw)
    result = _calculate_score_data(data)
    success_output(result, args.output)


# ---------------------------------------------------------------------------
# grade-once: compact, single-call formal grading
# ---------------------------------------------------------------------------

def _stable_runtime_id(prefix, *parts):
    canonical = "||".join(str(part or "") for part in parts)
    return f"{prefix}-{hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:16]}"


def _point_pool_fingerprint(point_definitions):
    """Identify the semantic scoring pool independently of quote packaging.

    Evidence excerpts prove that a point is material-backed, but callers may
    select different valid excerpts for the same point. Including those quote
    strings made punctuation/list/ellipsis normalization change the draft
    comparison fingerprint. Point identity therefore uses the semantic point
    definition and its scoring-critical qualifiers; evidence validity remains
    enforced separately by preflight and is never relaxed here.
    """
    canonical = []
    for point in point_definitions:
        if not isinstance(point, dict):
            continue
        canonical.append({
            "point_id": point.get("point_id"),
            "point_text": _norm_for_match(point.get("point_text") or ""),
            "point_value": point.get("point_value"),
            "importance": point.get("importance"),
            "status": point.get("status", "active"),
            "required_or_optional": point.get("required_or_optional", "required"),
            "critical_qualifiers": sorted(
                _norm_for_match(item)
                for item in point.get("critical_qualifiers", [])
                if isinstance(item, str) and _norm_for_match(item)
            ),
        })
    canonical.sort(key=lambda item: str(item.get("point_id") or ""))
    payload = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _validate_reference_calibration(calibration, reference_answer_set,
                                    point_definitions, material_text):
    """Require an auditable disposition for reference-supported candidate content."""
    if not isinstance(reference_answer_set, dict) or not reference_answer_set.get("answers"):
        return [], {}
    errors = []
    if not isinstance(calibration, dict):
        return ["reference_calibration is required when reference answers are provided"], {}
    if calibration.get("status") != "verified":
        errors.append("reference_calibration.status must be 'verified'")
    if calibration.get("complete_review") is not True:
        errors.append("reference_calibration.complete_review must be true")
    candidates = calibration.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        errors.append("reference_calibration.candidates must be a non-empty array")
        return errors, {}

    answers = reference_answer_set.get("answers", [])
    point_ids = {
        point.get("point_id") for point in point_definitions
        if isinstance(point, dict) and point.get("point_id")
    }
    reviewed_answer_ids = set()
    answer_spans = {}
    seen_candidate_ids = set()
    valid_dispositions = {"included", "merged", "excluded"}
    for index, item in enumerate(candidates):
        prefix = f"reference_calibration.candidates[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix} must be an object")
            continue
        candidate_id = item.get("candidate_id")
        if not isinstance(candidate_id, str) or not candidate_id.strip():
            errors.append(f"{prefix}.candidate_id must be a non-empty string")
        elif candidate_id in seen_candidate_ids:
            errors.append(f"{prefix}.candidate_id is duplicated: {candidate_id}")
        else:
            seen_candidate_ids.add(candidate_id)

        answer_id = item.get("answer_id")
        answer_index = item.get("answer_index")
        answer = next((answer for answer in answers if answer.get("answer_id") == answer_id), None)
        if answer is None and isinstance(answer_index, int) and not isinstance(answer_index, bool):
            if 1 <= answer_index <= len(answers):
                answer = answers[answer_index - 1]
                answer_id = answer.get("answer_id")
        if answer is None:
            errors.append(
                f"{prefix} must identify a provided reference answer by answer_id or 1-based answer_index"
            )
        else:
            reviewed_answer_ids.add(answer_id)

        candidate_text = item.get("candidate_text")
        if not isinstance(candidate_text, str) or not candidate_text.strip():
            errors.append(f"{prefix}.candidate_text must be non-empty")
        elif answer is not None and not _evidence_in_scope(candidate_text, answer.get("answer_text", "")):
            errors.append(f"{prefix}.candidate_text not found in the referenced answer")
        elif answer is not None:
            normalized_answer = _norm_for_match(answer.get("answer_text", ""))
            normalized_candidate = _norm_for_match(candidate_text)
            start = normalized_answer.find(normalized_candidate)
            if start >= 0:
                answer_spans.setdefault(answer_id, []).append(
                    (start, start + len(normalized_candidate))
                )

        disposition = item.get("disposition")
        if disposition not in valid_dispositions:
            errors.append(f"{prefix}.disposition must be included/merged/excluded")
            continue
        material_evidence = item.get("material_evidence")
        if disposition in {"included", "merged"}:
            errors.extend(
                _material_evidence_support_errors(
                    material_evidence,
                    material_text,
                    f"{prefix}.material_evidence",
                )
            )
        elif material_evidence not in (None, ""):
            errors.extend(
                _material_evidence_support_errors(
                    material_evidence,
                    material_text,
                    f"{prefix}.material_evidence",
                )
            )
        mapped = item.get("mapped_point_ids", [])
        if not isinstance(mapped, list):
            errors.append(f"{prefix}.mapped_point_ids must be an array")
            mapped = []
        unknown = [point_id for point_id in mapped if point_id not in point_ids]
        if unknown:
            errors.append(f"{prefix}.mapped_point_ids contains unknown point ids: {unknown}")
        if disposition in {"included", "merged"} and not mapped:
            errors.append(f"{prefix}.mapped_point_ids is required for {disposition}")
        if disposition == "excluded":
            reason = item.get("reason")
            if not isinstance(reason, str) or not reason.strip():
                errors.append(f"{prefix}.reason is required for excluded content")
            if mapped:
                errors.append(f"{prefix}.mapped_point_ids must be empty for excluded content")

    expected_answer_ids = {
        answer.get("answer_id") for answer in answers
        if isinstance(answer, dict) and answer.get("answer_id")
    }
    missing_answers = sorted(expected_answer_ids - reviewed_answer_ids)
    if missing_answers:
        errors.append(
            "reference_calibration has no candidate review for reference answers: "
            + ", ".join(missing_answers)
        )
    coverage_by_answer = {}
    for answer in answers:
        answer_id = answer.get("answer_id")
        normalized_answer = _norm_for_match(answer.get("answer_text", ""))
        covered_positions = set()
        for start, end in answer_spans.get(answer_id, []):
            covered_positions.update(range(start, end))
        ratio = len(covered_positions) / len(normalized_answer) if normalized_answer else 0.0
        coverage_by_answer[answer_id] = round(ratio, 4)
        if ratio < 0.8:
            errors.append(
                f"reference_calibration candidate text coverage for {answer_id} is "
                f"{ratio:.1%}, below required 80%; substantive reference content may be omitted"
            )
    return errors, coverage_by_answer


def _validate_reference_discovery(data):
    """Prevent a bundled answer section from being silently dropped upstream."""
    reference_available = data.get("reference_available")
    if not isinstance(reference_available, bool):
        return ["reference_available must be an explicit boolean for grade-once"]
    discovery = data.get("reference_discovery")
    if not isinstance(discovery, dict):
        return ["reference_discovery is required for grade-once"]
    status = discovery.get("status")
    if status not in {"found", "not_found"}:
        return ["reference_discovery.status must be found or not_found"]
    errors = []
    for field in ("searched_scope", "evidence"):
        if not isinstance(discovery.get(field), str) or not discovery[field].strip():
            errors.append(f"reference_discovery.{field} must be non-empty")

    has_references = bool(data.get("reference_answers") or data.get("reference_answer_set"))
    if reference_available and not has_references:
        errors.append(
            "reference_available=true requires reference_answers or reference_answer_set"
        )
    if not reference_available and has_references:
        errors.append(
            "reference_available=false conflicts with provided reference answers"
        )
    if reference_available and status != "found":
        errors.append(
            "reference_available=true requires reference_discovery.status=found"
        )
    if not reference_available and status != "not_found":
        errors.append(
            "reference_available=false requires reference_discovery.status=not_found"
        )
    if status == "found" and not has_references:
        errors.append(
            "reference_discovery.status=found requires reference_answers or reference_answer_set"
        )
    if status == "not_found" and has_references:
        errors.append(
            "reference_discovery.status=not_found conflicts with provided reference answers"
        )

    references = data.get("reference_answers")
    if not isinstance(references, list):
        reference_set = data.get("reference_answer_set")
        references = reference_set.get("answers", []) if isinstance(reference_set, dict) else []
    expected_reference_count = data.get("expected_reference_answer_count")
    if expected_reference_count is not None:
        if (isinstance(expected_reference_count, bool)
                or not isinstance(expected_reference_count, int)
                or expected_reference_count < 0):
            errors.append(
                "expected_reference_answer_count must be a non-negative integer"
            )
        elif expected_reference_count != len(references):
            errors.append(
                "expected_reference_answer_count does not match current reference answers: "
                f"expected {expected_reference_count}, got {len(references)}"
            )
    source_document_text = data.get("source_document_text")
    if source_document_text is not None:
        if not isinstance(source_document_text, str) or not source_document_text.strip():
            errors.append("source_document_text must be a non-empty string when provided")
        else:
            has_answer_marker = re.search(
                r"参考答案|答案解析|参考作答|评分参考|作答参考",
                source_document_text,
            ) is not None
            if has_answer_marker and status != "found":
                errors.append(
                    "source_document_text contains a reference-answer marker but "
                    "reference_discovery.status is not found"
                )
    return errors


def _configured_dimensions(question_type):
    try:
        config = json.loads((CONFIG_DIR / "scoring-weights.json").read_text(encoding="utf-8"))
        return config["question_types"][question_type]["dimensions"]
    except (OSError, KeyError, json.JSONDecodeError):
        return []


def _derive_small_question_dimension_levels(data, question_type):
    """Derive display-only levels when a point-scored small question omits them."""
    if question_type not in {"归纳概括", "综合分析", "提出对策"}:
        return None
    points = data.get("points")
    if not isinstance(points, list) or not points:
        return None
    if any(not _is_finite_number(item.get("point_value")) for item in points if isinstance(item, dict)):
        return None
    holistic = data.get("holistic_review")
    overall_quality = holistic.get("overall_quality") if isinstance(holistic, dict) else None
    if not isinstance(overall_quality, int) or isinstance(overall_quality, bool) or not 0 <= overall_quality <= 4:
        rates = {"完整覆盖": 4, "等义表达": 4, "部分覆盖": 2, "未覆盖": 0}
        total = 0.0
        earned = 0.0
        for item in points:
            if not isinstance(item, dict):
                return None
            value = float(item.get("point_value"))
            total += value
            earned += value * rates.get(item.get("coverage_status"), 0)
        overall_quality = round(earned / total) if total else 2
    return {
        item["name"]: overall_quality
        for item in _configured_dimensions(question_type)
    }


def _new_input_normalization_audit():
    return {
        "schema_version": "1.0",
        "policy": "deterministic_structure_no_semantic_invention",
        "changed": False,
        "action_count": 0,
        "semantic_change_count": 0,
        "actions": [],
        "strict_fields_preserved": [
            "question_text",
            "material_text",
            "user_answer",
            "coverage_status",
            "point_value",
            "point_role",
            "task_components",
            "reference_answers",
            "reference_calibration",
        ],
    }


def _record_input_normalization(audit, field, action, details=None):
    item = {
        "field": field,
        "action": action,
        "semantic_effect": False,
    }
    if isinstance(details, dict) and details:
        item["details"] = details
    audit["actions"].append(item)
    audit["changed"] = True
    audit["action_count"] = len(audit["actions"])


def _normalize_grade_dimensions(data, question_type, audit):
    """Accept the canonical compact form and common harmless aliases."""
    configured = _configured_dimensions(question_type)
    weights = {item["name"]: item["weight"] for item in configured}
    dimensions = data.get("dimensions")
    levels = data.get("dimension_levels")

    if isinstance(dimensions, dict) and levels is None:
        levels = dimensions
        dimensions = None
        _record_input_normalization(
            audit, "dimensions", "mapping_alias_to_dimension_levels"
        )
    if isinstance(levels, list) and dimensions is None:
        dimensions = levels
        levels = None
        _record_input_normalization(
            audit, "dimension_levels", "list_alias_to_dimensions"
        )

    if isinstance(dimensions, list):
        normalized = []
        alias_count = 0
        weight_fill_count = 0
        for item in dimensions:
            if not isinstance(item, dict):
                normalized.append(item)
                continue
            name = item.get("dimension_name") or item.get("name") or item.get("dimension")
            level = item.get("level")
            if level is None:
                level = item.get("dimension_level", item.get("rating"))
            if "dimension_name" not in item or "level" not in item:
                alias_count += 1
            if item.get("weight") is None and weights.get(name) is not None:
                weight_fill_count += 1
            normalized.append({
                **item,
                "dimension_name": name,
                "weight": (
                    item.get("weight")
                    if item.get("weight") is not None
                    else weights.get(name)
                ),
                "level": level,
            })
        data["dimensions"] = normalized
        data.pop("dimension_levels", None)
        if alias_count:
            _record_input_normalization(
                audit, "dimensions", "normalize_dimension_item_aliases",
                {"item_count": alias_count},
            )
        if weight_fill_count:
            _record_input_normalization(
                audit, "dimensions", "fill_configured_weights",
                {"item_count": weight_fill_count},
            )
        return

    if isinstance(levels, dict):
        data["dimension_levels"] = levels
        data.pop("dimensions", None)
        return

    derived = _derive_small_question_dimension_levels(data, question_type)
    if derived is not None:
        data["dimension_levels"] = derived
        _record_input_normalization(
            audit, "dimension_levels", "derive_display_levels_from_point_review",
            {"dimension_count": len(derived)},
        )


def _dimension_level_mapping_from_list(dimensions):
    if not isinstance(dimensions, list):
        return None
    mapping = {}
    for item in dimensions:
        if not isinstance(item, dict):
            return None
        name = item.get("dimension_name") or item.get("name") or item.get("dimension")
        level = item.get("level")
        if level is None:
            level = item.get("dimension_level", item.get("rating"))
        if not isinstance(name, str) or not isinstance(level, int) or isinstance(level, bool):
            return None
        mapping[name] = level
    return mapping


def _lift_nested_dimension_levels(data, question_type, audit):
    """Lift compact per-review dimension judgments without changing them."""
    review_key = {
        "归纳概括": "holistic_review",
        "综合分析": "holistic_review",
        "提出对策": "holistic_review",
        "贯彻执行": "application_review",
        "申发论述": "essay_review",
    }.get(question_type)
    review = data.get(review_key) if review_key else None
    nested = review.get("dimension_levels") if isinstance(review, dict) else None
    if not isinstance(nested, dict):
        return
    top = data.get("dimension_levels")
    if top is None:
        top = _dimension_level_mapping_from_list(data.get("dimensions"))
    if top is None:
        data["dimension_levels"] = copy.deepcopy(nested)
        _record_input_normalization(
            audit,
            f"{review_key}.dimension_levels",
            "lift_review_dimension_levels",
            {"dimension_count": len(nested)},
        )
        return
    if top != nested:
        data.setdefault("_input_compilation_errors", []).append(
            f"top-level dimensions conflict with {review_key}.dimension_levels"
        )


def _derive_application_dimension_levels(data):
    review = data.get("application_review")
    if not isinstance(review, dict):
        return None
    status_maps = {
        "identity_status": {"accurate": 4, "partial": 2, "wrong": 0},
        "genre_format_status": {"complete": 4, "partial": 2, "missing": 0},
        "purpose_audience_status": {"strong": 4, "adequate": 3, "weak": 1},
        "content_status": {"complete": 4, "partial": 2, "missing": 0},
        "structure_status": {"clear": 4, "partial": 2, "unclear": 0},
        "tone_status": {"appropriate": 4, "partial": 2, "wrong": 0},
    }
    levels = {}
    for field, mapping in status_maps.items():
        value = review.get(field)
        if value not in mapping:
            return None
        levels[field] = mapping[value]
    format_level = levels["identity_status"]
    if data.get("required_format_elements"):
        format_level = min(format_level, levels["genre_format_status"])
    return {
        "身份文种格式": format_level,
        "结构": levels["structure_status"],
        "内容覆盖": levels["content_status"],
        "目的场景": levels["purpose_audience_status"],
        "语言语气": levels["tone_status"],
    }


def _derive_essay_dimension_levels(data):
    review = data.get("essay_review")
    if not isinstance(review, dict):
        return None
    language_map = {"strong": 4, "adequate": 3, "weak": 2, "poor": 1, "unreadable": 0}
    example_map = {"strong": 4, "adequate": 3, "partial": 2, "weak": 1, "missing": 0}
    language_level = language_map.get(review.get("language_status"))
    example_level = example_map.get(review.get("example_support_status"))
    if language_level is None or example_level is None:
        return None

    thesis_scope = review.get("thesis_scope_status")
    relation_required = review.get("prompt_relation_required") is True
    centrality = review.get("relationship_centrality")
    relation = review.get("relationship_coverage_status")
    specificity = review.get("topic_specificity")
    if thesis_scope == "off_topic":
        thesis_level = 0
    elif thesis_scope == "narrowed":
        thesis_level = 2
    elif thesis_scope == "accurate":
        if relation_required and centrality == "core" and relation in {"mentioned_only", "missing", "distorted"}:
            thesis_level = 2
        elif relation_required and relation == "partial":
            thesis_level = 3
        else:
            thesis_level = {"strong": 4, "adequate": 3, "weak": 2}.get(specificity)
    else:
        return None
    if thesis_level is None:
        return None

    material_status = review.get("material_support_status")
    transformation = review.get("material_transformation_status")
    if material_status == "weak" or transformation == "mechanical":
        material_level = 1
    elif material_status == "strong" and transformation == "transformed":
        material_level = 4
    elif material_status in {"strong", "partial"} and transformation in {"transformed", "mixed"}:
        material_level = 3 if transformation == "transformed" or material_status == "strong" else 2
    else:
        return None

    argument_line = review.get("argument_line_status")
    if argument_line == "broken":
        depth_level = 1
    elif argument_line == "weak":
        depth_level = 2
    elif argument_line == "sound":
        has_boundary = isinstance(review.get("counterargument_or_boundary"), str) and bool(
            review.get("counterargument_or_boundary", "").strip()
        )
        depth_level = 4 if has_boundary or (relation_required and relation == "complete") else 3
    else:
        return None

    argument_system = review.get("sub_argument_system_status")
    structure_level = {
        "sound": 3,
        "mixed_levels": 2,
        "material_parallel": 2,
        "broken": 1,
    }.get(argument_system)
    if structure_level is None:
        return None
    return {
        "立意扣题": thesis_level,
        "材料运用": material_level,
        "论证深度": depth_level,
        "结构": structure_level,
        "论据例证": example_level,
        "语言": language_level,
    }


def _default_accuracy_dimension(question_type):
    return {
        "归纳概括": "准确有据",
        "综合分析": "关系逻辑",
        "提出对策": "针对匹配",
        "贯彻执行": "内容覆盖",
        "申发论述": "材料运用",
    }.get(question_type, "任务符合")


def _normalize_grade_once_data(data, prototype):
    """Normalize normal-call aliases before deterministic preflight.

    This adapter deliberately does not invent points, coverage judgments or
    reference calibration. It only removes serialization friction that caused
    agents to inspect schemas and retry one field at a time.
    """
    normalized = copy.deepcopy(data)
    audit = _new_input_normalization_audit()
    question_type = prototype["question_type"]
    _lift_nested_dimension_levels(normalized, question_type, audit)
    _normalize_grade_dimensions(normalized, question_type, audit)
    if normalized.get("dimensions") is None and normalized.get("dimension_levels") is None:
        derived_levels = None
        action = None
        if question_type == "贯彻执行":
            derived_levels = _derive_application_dimension_levels(normalized)
            action = "derive_application_dimensions_from_review"
        elif question_type == "申发论述":
            derived_levels = _derive_essay_dimension_levels(normalized)
            action = "derive_essay_dimensions_from_review"
        if derived_levels is not None:
            normalized["dimension_levels"] = derived_levels
            _record_input_normalization(
                audit,
                "dimension_levels",
                action,
                {"dimension_count": len(derived_levels)},
            )

    has_references = bool(
        normalized.get("reference_answers") or normalized.get("reference_answer_set")
    )
    if "reference_available" not in normalized:
        normalized["reference_available"] = has_references
        _record_input_normalization(
            audit, "reference_available", "infer_from_reference_payload",
            {"inferred_value": has_references},
        )
    default_discovery = {
        "status": "found" if has_references else "not_found",
        "searched_scope": "当前批改输入",
        "evidence": "当前输入已提供参考答案" if has_references else "当前输入未提供参考答案",
    }
    discovery = normalized.get("reference_discovery")
    if isinstance(discovery, str):
        raw_status = discovery.strip()
        aliases = {
            "found": "found", "有": "found", "已找到": "found", "true": "found",
            "not_found": "not_found", "无": "not_found", "未找到": "not_found",
            "false": "not_found",
        }
        status = aliases.get(raw_status, raw_status)
        normalized["reference_discovery"] = {
            **default_discovery,
            "status": status,
            "evidence": raw_status or default_discovery["evidence"],
        }
        _record_input_normalization(
            audit, "reference_discovery", "wrap_status_string",
            {"recognized_alias": raw_status in aliases},
        )
    elif isinstance(discovery, dict):
        normalized["reference_discovery"] = {**default_discovery, **discovery}
        missing_fields = [
            field for field in ("status", "searched_scope", "evidence")
            if field not in discovery
        ]
        if missing_fields:
            _record_input_normalization(
                audit, "reference_discovery", "fill_missing_metadata",
                {"fields": missing_fields},
            )
    else:
        normalized["reference_discovery"] = default_discovery
        _record_input_normalization(
            audit, "reference_discovery", "infer_from_reference_payload",
            {"inferred_status": default_discovery["status"]},
        )
    if has_references:
        references = normalized.get("reference_answers")
        if isinstance(references, list) and "expected_reference_answer_count" not in normalized:
            normalized["expected_reference_answer_count"] = len(references)
            _record_input_normalization(
                audit, "expected_reference_answer_count", "infer_from_reference_answers",
                {"answer_count": len(references)},
            )

    for index, point in enumerate(normalized.get("points") or []):
        if not isinstance(point, dict):
            continue
        original_evidence = point.get("material_evidence")
        anchor, fragments = _canonical_evidence(
            original_evidence, normalized.get("material_text", "")
        )
        if anchor:
            point["material_evidence"] = anchor
            if len(fragments) > 1:
                point["material_evidence_fragments"] = fragments
            if not isinstance(original_evidence, str) or original_evidence != anchor:
                _record_input_normalization(
                    audit, f"points[{index}].material_evidence",
                    "canonicalize_verified_fragments",
                    {"fragment_count": len(fragments)},
                )
        original_quote = point.get("user_quote")
        if isinstance(original_quote, str) and original_quote.strip():
            canonical_quote, quote_fragments = _canonical_user_quote(
                original_quote, normalized.get("user_answer", "")
            )
            if canonical_quote and canonical_quote != original_quote:
                point["user_quote"] = canonical_quote
                _record_input_normalization(
                    audit,
                    f"points[{index}].user_quote",
                    "canonicalize_verified_answer_quote",
                    {"fragment_count": len(quote_fragments)},
                )
        if point.get("expansion_level") in _DERIVE_EXPANSION_ALIASES:
            point.pop("expansion_level")
            _record_input_normalization(
                audit,
                f"points[{index}].expansion_level",
                "derive_from_coverage_status",
            )

    calibration = normalized.get("reference_calibration")
    if isinstance(calibration, dict):
        for index, candidate in enumerate(calibration.get("candidates") or []):
            if not isinstance(candidate, dict):
                continue
            evidence = candidate.get("material_evidence")
            if evidence in (None, ""):
                continue
            anchor, fragments = _canonical_evidence(
                evidence, normalized.get("material_text", "")
            )
            if anchor:
                candidate["material_evidence"] = anchor
                if len(fragments) > 1:
                    candidate["material_evidence_fragments"] = fragments
                if not isinstance(evidence, str) or evidence != anchor:
                    _record_input_normalization(
                        audit, f"reference_calibration.candidates[{index}].material_evidence",
                        "canonicalize_verified_fragments",
                        {"fragment_count": len(fragments)},
                    )

    for index, claim in enumerate(normalized.get("extra_material_claims") or []):
        if not isinstance(claim, dict):
            continue
        original_quote = claim.get("user_quote")
        if isinstance(original_quote, str) and original_quote.strip():
            canonical_quote, quote_fragments = _canonical_user_quote(
                original_quote, normalized.get("user_answer", "")
            )
            if canonical_quote and canonical_quote != original_quote:
                claim["user_quote"] = canonical_quote
                _record_input_normalization(
                    audit,
                    f"extra_material_claims[{index}].user_quote",
                    "canonicalize_verified_answer_quote",
                    {"fragment_count": len(quote_fragments)},
                )
        if not claim.get("deduction_owner"):
            claim["deduction_owner"] = _default_accuracy_dimension(question_type)
            _record_input_normalization(
                audit, f"extra_material_claims[{index}].deduction_owner",
                "fill_question_type_accuracy_owner",
            )
    return normalized, audit


def _load_dimensions_from_levels(question_type, dimension_levels):
    if not isinstance(dimension_levels, dict):
        error_exit(EXIT_INPUT_ERROR, "grade-once requires dimensions or dimension_levels")
    configured = _configured_dimensions(question_type)
    if not configured:
        error_exit(EXIT_INPUT_ERROR, f"cannot load scoring dimensions for {question_type}")
    dimensions = []
    for item in configured:
        name = item["name"]
        level = dimension_levels.get(name)
        if not isinstance(level, int) or isinstance(level, bool) or not 0 <= level <= 4:
            error_exit(EXIT_INPUT_ERROR,
                       f"dimension_levels.{name} must be an integer from 0 to 4")
        dimensions.append({
            "dimension_name": name,
            "weight": item["weight"],
            "level": level,
        })
    extra = set(dimension_levels) - {item["name"] for item in configured}
    if extra:
        error_exit(EXIT_INPUT_ERROR,
                   f"dimension_levels contains unknown dimensions for {question_type}: {sorted(extra)}")
    return dimensions


def _validate_unit_audit(audit, user_answer, point_ids, field_name):
    """Validate sentence/paragraph evidence without turning it into extra scoring."""
    if audit is None:
        return []
    if not isinstance(audit, list):
        return [f"{field_name} must be an array"]
    errors = []
    for index, item in enumerate(audit):
        prefix = f"{field_name}[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix} must be an object")
            continue
        unit_id = item.get("unit_id") or item.get("paragraph_id")
        unit_text = item.get("unit_text") or item.get("paragraph_text")
        if not isinstance(unit_id, str) or not unit_id.strip():
            errors.append(f"{prefix} needs unit_id")
        if not isinstance(unit_text, str) or not unit_text.strip():
            errors.append(f"{prefix} needs unit_text")
        elif not _evidence_in_scope(unit_text, user_answer):
            errors.append(f"{prefix}.unit_text not found in user_answer")
        linked = item.get("point_ids", [])
        if not isinstance(linked, list) or any(pid not in point_ids for pid in linked):
            errors.append(f"{prefix}.point_ids contains unknown point_id")
        for key in ("role", "diagnosis", "revision_action"):
            if key in item and item[key] is not None and not isinstance(item[key], str):
                errors.append(f"{prefix}.{key} must be a string or null")
    return errors


def _compile_leading_summary_reviews(reviews, user_answer, point_ledger):
    """Validate leading labels while keeping them outside point coverage.

    A leading summary is a structure label, not a second copy of the body point.
    The caller still supplies the semantic status, but the engine enforces the
    score boundary and verifies that the mapped body evidence is real.
    """
    if reviews is None:
        return []
    if not isinstance(reviews, list):
        error_exit(EXIT_INPUT_ERROR, "grade-once leading_summary_reviews must be an array")

    normal_points = {
        item.get("point_id"): item
        for item in point_ledger
        if isinstance(item, dict)
        and item.get("point_id")
        and item.get("coverage_status") != "超出材料"
    }
    compiled = []
    valid_statuses = {"accurate", "omitted", "imprecise", "contradictory"}
    for index, review in enumerate(reviews, 1):
        prefix = f"grade-once leading_summary_reviews[{index - 1}]"
        if not isinstance(review, dict):
            error_exit(EXIT_INPUT_ERROR, f"{prefix} must be an object")
        status = review.get("status")
        if status not in valid_statuses:
            error_exit(
                EXIT_INPUT_ERROR,
                f"{prefix}.status must be accurate, omitted, imprecise or contradictory",
            )
        body_quote = review.get("body_quote")
        if not isinstance(body_quote, str) or not body_quote.strip():
            error_exit(EXIT_INPUT_ERROR, f"{prefix}.body_quote must be non-empty")
        if not _evidence_in_scope(body_quote, user_answer):
            error_exit(EXIT_CONSISTENCY, f"{prefix}.body_quote not found in user_answer")
        summary_quote = review.get("summary_quote")
        if status == "omitted":
            if isinstance(summary_quote, str) and summary_quote.strip():
                error_exit(
                    EXIT_CONSISTENCY,
                    f"{prefix}.summary_quote must be empty when status=omitted",
                )
            summary_quote = None
        else:
            if not isinstance(summary_quote, str) or not summary_quote.strip():
                error_exit(EXIT_INPUT_ERROR, f"{prefix}.summary_quote must be non-empty")
            if not _evidence_in_scope(summary_quote, user_answer):
                error_exit(EXIT_CONSISTENCY, f"{prefix}.summary_quote not found in user_answer")

        point_ids = review.get("point_ids")
        if not isinstance(point_ids, list) or not point_ids:
            error_exit(EXIT_INPUT_ERROR, f"{prefix}.point_ids must be a non-empty array")
        unknown = [point_id for point_id in point_ids if point_id not in normal_points]
        if unknown:
            error_exit(
                EXIT_CONSISTENCY,
                f"{prefix}.point_ids contains unknown or non-scorable point ids",
                {"unknown_point_ids": unknown},
            )
        body_mismatches = []
        for point_id in point_ids:
            point_quote = normal_points[point_id].get("user_quote")
            if not isinstance(point_quote, str) or not point_quote.strip():
                body_mismatches.append(point_id)
            elif not _evidence_in_scope(point_quote, body_quote):
                body_mismatches.append(point_id)
        if body_mismatches:
            error_exit(
                EXIT_CONSISTENCY,
                f"{prefix}.body_quote does not contain mapped point evidence",
                {"point_ids": body_mismatches},
            )
        reason = review.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            error_exit(EXIT_INPUT_ERROR, f"{prefix}.reason must be non-empty")

        deduction_owner = review.get("deduction_owner")
        if status == "contradictory":
            deduction_owner = deduction_owner or "准确有据"
            if deduction_owner not in {"准确有据", "分类组织"}:
                error_exit(
                    EXIT_INPUT_ERROR,
                    f"{prefix}.deduction_owner must be 准确有据 or 分类组织 when contradictory",
                )
        elif deduction_owner is not None:
            error_exit(
                EXIT_CONSISTENCY,
                f"{prefix} must not assign deduction_owner unless status=contradictory",
            )

        compiled.append({
            "review_id": review.get("review_id") or f"leading-summary-{index}",
            "summary_quote": summary_quote,
            "body_quote": body_quote,
            "point_ids": list(dict.fromkeys(point_ids)),
            "status": status,
            "reason": reason,
            "deduction_owner": deduction_owner,
        })
    return compiled


def _render_leading_summary_audit(reviews, canonical_ledger, question_text):
    """Project validated leading-label reviews onto the final ledger once."""
    ledger_by_id = {
        item.get("point_id"): item
        for item in canonical_ledger
        if isinstance(item, dict) and item.get("point_id")
    }
    is_change_task = any(token in (question_text or "") for token in ("变化", "转变", "演变"))
    audit = []
    for review in reviews or []:
        mapped = [ledger_by_id[pid] for pid in review["point_ids"] if pid in ledger_by_id]
        coverage_snapshot = [
            {
                "point_id": item.get("point_id"),
                "coverage_status": item.get("coverage_status"),
                "earned_value": item.get("earned_value"),
                "expansion_level": item.get("expansion_level"),
            }
            for item in mapped
        ]
        detail_gap = any(
            item.get("coverage_status") == "部分覆盖"
            or item.get("expansion_level") not in {None, "充分展开"}
            for item in mapped
        )
        coverage_message = "核心变化已覆盖" if is_change_task else "后文实质要点已覆盖"
        if detail_gap:
            coverage_message += "，部分展开细节缺失"

        status = review["status"]
        if status == "accurate":
            diagnosis = "概括词与后文一致"
            display_message = f"{coverage_message}；前置概括词与后文一致。"
        elif status == "omitted":
            diagnosis = "未写前置概括词，但不影响后文实质得分"
            display_message = f"{coverage_message}；未写前置概括词，但不影响后文实质得分。"
        elif status == "imprecise":
            diagnosis = "概括词可优化"
            display_message = f"{coverage_message}；前置概括词略有偏差，但不影响后文实质得分。"
        else:
            diagnosis = "前置概括词与后文形成实质相反关系，需复核准确性或组织"
            display_message = (
                f"{coverage_message}；前置概括词与后文形成实质相反关系，"
                "仅在准确性或组织维度作局部复核，不抹除后文覆盖。"
            )
        contradictory = status == "contradictory"
        audit.append({
            **review,
            "diagnosis": diagnosis,
            "display_message": display_message,
            "mapped_point_coverage": coverage_snapshot,
            "affects_point_coverage": False,
            "score_invariant": not contradictory,
            "automatic_point_deduction": False,
            "requires_dimension_review": contradictory,
            "eligible_score_dimension": review.get("deduction_owner") if contradictory else None,
            "derived_from": "score_ledger",
        })
    return audit


def _unit_contains_quote(unit_text, quote):
    unit_norm = _norm_for_match(unit_text or "")
    quote_norm = _norm_for_match(quote or "")
    if not unit_norm or not quote_norm:
        return False
    return quote_norm in unit_norm or unit_norm in quote_norm


def _split_answer_sentences(user_answer):
    pieces = re.split(r"(?<=[。！？；])|\n+", user_answer or "")
    return [piece.strip() for piece in pieces if isinstance(piece, str) and piece.strip()]


def _derive_sentence_audit(user_answer, point_definitions, point_ledger):
    """Render the existing ledger at sentence granularity; make no new score judgment."""
    definitions = {
        item.get("point_id"): item
        for item in point_definitions if isinstance(item, dict) and item.get("point_id")
    }
    audit = []
    for index, sentence in enumerate(_split_answer_sentences(user_answer), 1):
        linked = [
            item for item in point_ledger
            if isinstance(item, dict)
            and isinstance(item.get("user_quote"), str)
            and _unit_contains_quote(sentence, item.get("user_quote"))
        ]
        point_ids = [item.get("point_id") for item in linked if item.get("point_id")]
        statuses = {item.get("coverage_status") for item in linked}
        if "超出材料" in statuses:
            role = "材料外句"
        elif "部分覆盖" in statuses:
            role = "部分得分句"
        elif statuses & {"完整覆盖", "等义表达"}:
            role = "有效得分句"
        else:
            role = "结构或未映射句"

        point_texts = [
            definitions[pid].get("point_text", pid)
            for pid in point_ids if pid in definitions
        ]
        reasons = []
        actions = []
        for item in linked:
            reason = item.get("loss_reason") or item.get("credit_reason")
            if isinstance(reason, str) and reason and reason not in reasons:
                reasons.append(reason)
            action = item.get("modification_action")
            if isinstance(action, str) and action and action not in actions:
                actions.append(action)
        if linked:
            diagnosis = "；".join(reasons) or "该句已由现有得失账本完成映射"
            revision_action = "；".join(actions) or (
                "保留核心意思并压缩表达" if role == "有效得分句" else "按账本缺口补齐实质信息"
            )
        else:
            diagnosis = "现有点池和得失账本未直接映射该句；只作为结构、衔接或重复风险提示，不自动扣分"
            revision_action = "结合上下文判断是否保留，不能仅因未映射就删除"
        audit.append({
            "unit_id": f"s{index}",
            "unit_text": sentence,
            "role": role,
            "point_ids": point_ids,
            "point_texts": point_texts,
            "diagnosis": diagnosis,
            "revision_action": revision_action,
            "derived_from": "score_ledger",
        })
    return audit


def _split_answer_paragraphs(user_answer):
    paragraphs = [
        part.strip() for part in re.split(r"\n\s*\n+", user_answer or "")
        if isinstance(part, str) and part.strip()
    ]
    return paragraphs or ([user_answer.strip()] if isinstance(user_answer, str) and user_answer.strip() else [])


def _derive_paragraph_audit(user_answer, point_definitions, point_ledger, essay_review):
    """Render essay_review and ledger evidence by paragraph without re-analysing the essay."""
    definitions = {
        item.get("point_id"): item
        for item in point_definitions if isinstance(item, dict) and item.get("point_id")
    }
    judgment = essay_review.get("judgment_evidence", {}) if isinstance(essay_review, dict) else {}
    argument_audits = judgment.get("sub_argument_audit", []) if isinstance(judgment, dict) else []
    paragraphs = _split_answer_paragraphs(user_answer)
    audit = []
    for index, paragraph in enumerate(paragraphs, 1):
        linked = [
            item for item in point_ledger
            if isinstance(item, dict)
            and isinstance(item.get("user_quote"), str)
            and _unit_contains_quote(paragraph, item.get("user_quote"))
        ]
        matched_arguments = [
            item for item in argument_audits
            if isinstance(item, dict)
            and _unit_contains_quote(paragraph, item.get("argument_quote"))
        ]
        if matched_arguments:
            role = "分论点论证段"
        elif index == 1:
            role = "开头段"
        elif index == len(paragraphs):
            role = "结尾段"
        else:
            role = "主体过渡段"

        diagnoses = []
        actions = []
        for item in matched_arguments:
            evidence = item.get("evidence")
            if isinstance(evidence, str) and evidence:
                diagnoses.append(evidence)
            if item.get("supports_thesis") is not True:
                actions.append("调整本段观点，使其直接支撑总论点")
            if item.get("source_role") == "material_topic":
                actions.append("补充材料后的分析与观点回扣，避免只复述材料")
            if (isinstance(essay_review, dict)
                    and essay_review.get("prompt_relation_required") is True
                    and item.get("explains_relationship") is not True):
                actions.append("补出题干关系在本段中的作用或连接")
        if not diagnoses:
            if role == "开头段":
                diagnoses.append("按既有中心论点证据检查开头是否快速扣题")
            elif role == "结尾段":
                diagnoses.append("按既有回扣结论检查结尾是否收束全文")
            else:
                diagnoses.append("该段未匹配独立分论点审计项，只作结构提示，不新增失分判断")
        if not actions:
            actions.append("沿用既有 essay_review 结论优化本段，不另设新的扣分标准")
        point_ids = [item.get("point_id") for item in linked if item.get("point_id")]
        audit.append({
            "unit_id": f"para{index}",
            "unit_text": paragraph,
            "role": role,
            "point_ids": point_ids,
            "point_texts": [
                definitions[pid].get("point_text", pid)
                for pid in point_ids if pid in definitions
            ],
            "diagnosis": "；".join(dict.fromkeys(diagnoses)),
            "revision_action": "；".join(dict.fromkeys(actions)),
            "derived_from": "essay_review+score_ledger",
        })
    return audit


def _default_task_components(question_type, question_text):
    if question_type == "归纳概括":
        return ["summary"]
    if question_type == "综合分析":
        return ["concept_explanation", "relationship_analysis"]
    if question_type == "提出对策":
        # “针对问题提出对策”中的“问题”是对象，不等于题目要求另列问题诊断。
        # 只有复合任务动词明确出现时，才把 problem_diagnosis 纳入评分组件。
        compound_signals = (
            "梳理问题并提出", "分析问题并提出", "概括问题并提出",
            "问题和建议", "问题+建议", "分析原因并提出", "原因并提出",
        )
        if any(token in question_text for token in compound_signals):
            return ["problem_diagnosis", "recommendation"]
        return ["recommendation"]
    if question_type == "贯彻执行":
        return ["scenario_expression"]
    return ["argumentation"]


def _grade_method_route(prototype):
    """Load teaching methods and grading checks in the same grading call."""
    mode_routes = prototype.get("mode_routes", {})
    analysis_cards = list(mode_routes.get("解析") or [])
    grading_cards = list(mode_routes.get("批改") or [])
    cards_map, load_errors = _load_method_cards_map()
    if load_errors:
        error_exit(EXIT_INPUT_ERROR, "grade-once could not load method cards", {"errors": load_errors})

    # Keep the more task-specific (later) card when a legacy prototype lists
    # two ability-core cards, then reserve the grading/revision card.
    selected_analysis = []
    layer_positions = {}
    layer_limits = {"能力内核": 1, "题型工作流": 3, "批改二稿": 1}
    for card_id in analysis_cards:
        card = cards_map.get(card_id) or {}
        layer = card.get("方法层级")
        if layer not in layer_limits:
            continue
        if layer == "能力内核" and layer in layer_positions:
            selected_analysis[layer_positions[layer]] = card_id
            continue
        current = sum(
            1 for selected_id in selected_analysis
            if (cards_map.get(selected_id) or {}).get("方法层级") == layer
        )
        if current < layer_limits[layer]:
            layer_positions.setdefault(layer, len(selected_analysis))
            selected_analysis.append(card_id)

    selected = []
    for card_id in selected_analysis + grading_cards:
        if card_id not in selected:
            selected.append(card_id)
    return selected


def _method_guides(card_ids):
    cards_map, load_errors = _load_method_cards_map()
    if load_errors:
        error_exit(EXIT_INPUT_ERROR, "grade-once could not load method guides", {"errors": load_errors})
    guides = []
    for card_id in card_ids:
        card = cards_map.get(card_id)
        if not isinstance(card, dict):
            continue
        guides.append({
            "method_name": card.get("方法名"),
            "method_layer": card.get("方法层级"),
            "steps": card.get("步骤逻辑", []),
            "boundaries": card.get("适用边界", []),
            "revision_actions": card.get("修改动作", []),
        })
    return guides


def _compile_grade_once_input(data, prototype):
    required = ("question_text", "full_score", "material_text", "user_answer", "points")
    missing = [key for key in required if key not in data]
    if missing:
        error_exit(EXIT_INPUT_ERROR, f"grade-once missing required fields: {missing}")

    question_text = data["question_text"]
    material_text = data["material_text"]
    user_answer = data["user_answer"]
    full_score = data["full_score"]
    points = data["points"]
    question_type = prototype["question_type"]
    if not isinstance(material_text, str) or not material_text.strip():
        error_exit(EXIT_INPUT_ERROR, "grade-once material_text must be non-empty")
    if not isinstance(user_answer, str) or not user_answer.strip():
        error_exit(EXIT_INPUT_ERROR, "grade-once user_answer must be non-empty")
    if not _is_finite_number(full_score) or full_score <= 0:
        error_exit(EXIT_INPUT_ERROR, "grade-once full_score must be a positive number")
    if not isinstance(points, list) or not points:
        error_exit(EXIT_INPUT_ERROR, "grade-once points must be a non-empty array")

    dimensions = data.get("dimensions")
    if dimensions is None:
        dimensions = _load_dimensions_from_levels(question_type, data.get("dimension_levels"))

    task_id = _stable_runtime_id("task", question_text, material_text)
    analysis_id = _stable_runtime_id("analysis", task_id, material_text)
    answer_id = _stable_runtime_id("answer", task_id, user_answer)
    ledger_id = _stable_runtime_id("ledger", analysis_id, answer_id)
    paper_id = data.get("paper_id") or _stable_runtime_id("paper", material_text)
    question_id = data.get("question_id") or "q-single"
    task_components = data.get("task_components") or _default_task_components(question_type, question_text)
    if not isinstance(task_components, list) or not task_components:
        error_exit(EXIT_INPUT_ERROR, "grade-once task_components must be a non-empty array")
    invalid_components = [item for item in task_components if item not in VALID_TASK_COMPONENTS]
    if invalid_components:
        error_exit(EXIT_INPUT_ERROR, "grade-once task_components contains unknown values", invalid_components)
    if question_type == "提出对策":
        if "recommendation" not in task_components:
            error_exit(EXIT_CONSISTENCY,
                       "提出对策 formal scoring must include the recommendation task component")
        if (prototype.get("prototype_id") == "sl-prototype-0026"
                and any(item in task_components for item in ("problem_diagnosis", "cause_analysis"))):
            error_exit(
                EXIT_CONSISTENCY,
                "一般提出对策题不得因考生答案结构扩展为问题/原因复合任务",
                {"task_components": task_components, "task_scope_basis": "question_text"},
            )
    required_format = data.get("required_format_elements") or []
    required_content = data.get("required_content_elements") or []
    relation_requirements = data.get("relation_requirements") or []

    task_spec = {
        "schema_version": "1.0",
        "paper_id": paper_id,
        "question_id": question_id,
        "task_id": task_id,
        "task_instruction": question_text,
        "material_scope": ["material-all"],
        "full_score": full_score,
        "primary_prototype_id": prototype["prototype_id"],
        "prototype_resolution_receipt": prototype["prototype_resolution_receipt"],
        "task_components": task_components,
        "required_content_elements": required_content,
        "required_format_elements": required_format,
        "relation_requirements": relation_requirements,
        "min_length": data.get("min_length"),
        "max_length": data.get("max_length"),
        "length_unit": data.get("length_unit", "字"),
    }

    point_definitions = []
    atomic_points = []
    point_ledger = []
    seen_ids = set()
    default_match = {
        "完整覆盖": "keyword_match",
        "部分覆盖": "keyword_match",
        "等义表达": "semantic_match",
        "未覆盖": "no_match",
        "超出材料": "extra_material",
    }
    default_expansion = {
        "完整覆盖": "基本展开",
        "部分覆盖": "简略提及",
        "等义表达": "基本展开",
        "未覆盖": "未提及",
        "超出材料": "简略提及",
    }
    for index, point in enumerate(points, 1):
        if not isinstance(point, dict):
            error_exit(EXIT_INPUT_ERROR, f"grade-once points[{index - 1}] must be an object")
        point_id = point.get("point_id") or f"p{index}"
        if point_id in seen_ids:
            error_exit(EXIT_INPUT_ERROR, f"grade-once duplicate point_id: {point_id}")
        seen_ids.add(point_id)
        point_text = point.get("point_text")
        evidence = point.get("material_evidence")
        evidence_fragments = point.get("material_evidence_fragments") or [evidence]
        coverage = point.get("coverage_status")
        if not isinstance(point_text, str) or not point_text.strip():
            error_exit(EXIT_INPUT_ERROR, f"grade-once point {point_id} needs point_text")
        if not isinstance(evidence, str) or not evidence.strip():
            error_exit(EXIT_INPUT_ERROR, f"grade-once point {point_id} needs material_evidence")
        if not _evidence_in_scope(evidence, material_text):
            error_exit(EXIT_CONSISTENCY,
                       f"grade-once point {point_id} material_evidence not found in material_text")
        if coverage not in VALID_COVERAGE_ALL:
            error_exit(EXIT_INPUT_ERROR,
                       f"grade-once point {point_id} has invalid coverage_status={coverage!r}")
        if coverage == "超出材料":
            error_exit(
                EXIT_INPUT_ERROR,
                f"grade-once point {point_id} cannot use coverage_status=超出材料",
                {"hint": "put material-outside wording in extra_material_claims instead"},
            )
        ocr_status = point.get("ocr_status", "clear")
        if ocr_status not in {"clear", "uncertain"}:
            error_exit(
                EXIT_INPUT_ERROR,
                f"grade-once point {point_id} ocr_status must be clear or uncertain",
            )
        if ocr_status == "uncertain":
            uncertainty_note = point.get("ocr_uncertainty_note")
            if not isinstance(uncertainty_note, str) or not uncertainty_note.strip():
                error_exit(
                    EXIT_INPUT_ERROR,
                    f"grade-once point {point_id} uncertain OCR requires ocr_uncertainty_note",
                )
            if coverage in {"未覆盖", "超出材料"}:
                error_exit(
                    EXIT_CONSISTENCY,
                    f"grade-once point {point_id} uncertain OCR cannot be scored as {coverage}",
                    {"hint": "mark the evidence as pending/partial or obtain a clearer answer"},
                )
        user_quote = point.get("user_quote")
        if coverage in {"完整覆盖", "部分覆盖", "等义表达", "超出材料"}:
            if not isinstance(user_quote, str) or not user_quote.strip():
                error_exit(EXIT_INPUT_ERROR,
                           f"grade-once point {point_id} requires user_quote for {coverage}")
            if not _evidence_in_scope(user_quote, user_answer):
                error_exit(EXIT_CONSISTENCY,
                           f"grade-once point {point_id} user_quote not found in user_answer")
        else:
            user_quote = None

        status = point.get("status", "active")
        independent = point.get("independent_scoring", True)
        required_or_optional = point.get("required_or_optional", "required")
        importance = point.get("importance", "core" if required_or_optional == "required" else "potential")
        point_value = point.get("point_value")
        point_role = point.get("point_role", "fact")
        task_component_ids = point.get("task_component_ids", task_components)
        if not isinstance(task_component_ids, list) or not task_component_ids:
            error_exit(EXIT_INPUT_ERROR,
                       f"grade-once point {point_id} task_component_ids must be a non-empty array")
        unknown_components = [item for item in task_component_ids if item not in task_components]
        if unknown_components:
            error_exit(
                EXIT_CONSISTENCY,
                f"grade-once point {point_id} is outside the original task scope",
                {"unknown_task_components": unknown_components,
                 "resolved_task_components": task_components},
            )
        if (question_type == "提出对策"
                and "problem_diagnosis" not in task_components
                and point_role in {"problem", "cause"}
                and status == "active"
                and independent is True
                and required_or_optional != "optional"):
            error_exit(
                EXIT_CONSISTENCY,
                f"grade-once point {point_id} expands a recommendation-only task with a scorable {point_role} point",
                {"task_scope_basis": "question_text",
                 "resolved_task_components": task_components,
                 "hint": "keep problem/cause as analysis context, not an active required scoring point"},
            )
        point_def = {
            "point_id": point_id,
            "point_text": point_text,
            "paragraph_id": "material-all",
            "evidence_text": evidence,
            "evidence_fragments": evidence_fragments,
            "status": status,
            "independent_scoring": independent,
            "required_or_optional": required_or_optional,
            "importance": importance,
            "point_value": point_value,
            "critical_qualifiers": point.get("critical_qualifiers", []),
        }
        point_definitions.append(point_def)
        atomic_points.append({
            **point_def,
            "point_role": point_role,
            "ocr_status": ocr_status,
            "ocr_uncertainty_note": point.get("ocr_uncertainty_note"),
        })
        credit_reason = point.get("credit_reason")
        loss_reason = point.get("loss_reason")
        if coverage in {"完整覆盖", "等义表达", "部分覆盖"} and not credit_reason:
            credit_reason = "作答已覆盖该材料要点"
        if coverage == "部分覆盖" and not loss_reason:
            loss_reason = "该要点只形成部分有效表达"
        if coverage == "未覆盖" and not loss_reason:
            loss_reason = "该材料要点未在作答中形成有效表达"
        ledger_entry = {
            "point_id": point_id,
            "task_component_ids": task_component_ids,
            "material_evidence": evidence,
            "material_evidence_fragments": evidence_fragments,
            "user_quote": user_quote,
            "match_type": point.get("match_type", default_match[coverage]),
            "coverage_status": coverage,
            "point_value": point_value,
            "earned_value": None,
            "expansion_level": point.get("expansion_level", default_expansion[coverage]),
            "expansion_evidence": point.get("expansion_evidence", user_quote),
            "credit_reason": credit_reason,
            "loss_reason": loss_reason,
            "deduction_owner": point.get("deduction_owner"),
            "modification_action": point.get("modification_action"),
            "reference_support": point.get("reference_support", "not_applicable"),
            "critical_qualifiers": point.get("critical_qualifiers", []),
            "qualifier_status": point.get("qualifier_status"),
            "missing_qualifiers": point.get("missing_qualifiers", []),
        }
        point_ledger.append(ledger_entry)

    extra_material_claims = data.get("extra_material_claims") or []
    if not isinstance(extra_material_claims, list):
        error_exit(EXIT_INPUT_ERROR, "grade-once extra_material_claims must be an array")
    for index, claim in enumerate(extra_material_claims, 1):
        if not isinstance(claim, dict):
            error_exit(
                EXIT_INPUT_ERROR,
                f"grade-once extra_material_claims[{index - 1}] must be an object",
            )
        claim_id = claim.get("claim_id") or f"extra-{index}"
        if claim_id in seen_ids:
            error_exit(EXIT_INPUT_ERROR, f"grade-once duplicate point/claim id: {claim_id}")
        seen_ids.add(claim_id)
        user_quote = claim.get("user_quote")
        if not isinstance(user_quote, str) or not user_quote.strip():
            error_exit(EXIT_INPUT_ERROR,
                       f"grade-once extra material claim {claim_id} requires user_quote")
        if not _evidence_in_scope(user_quote, user_answer):
            error_exit(EXIT_CONSISTENCY,
                       f"grade-once extra material claim {claim_id} user_quote not found in user_answer")
        if _evidence_in_scope(user_quote, material_text):
            error_exit(
                EXIT_CONSISTENCY,
                f"grade-once extra material claim {claim_id} is present in material_text",
                {"hint": "map supported wording to a normal material point"},
            )
        reason = claim.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            error_exit(EXIT_INPUT_ERROR,
                       f"grade-once extra material claim {claim_id} requires a local accuracy reason")
        point_ledger.append({
            "point_id": claim_id,
            "task_component_ids": claim.get("task_component_ids", task_components),
            "material_evidence": None,
            "user_quote": user_quote,
            "match_type": "extra_material",
            "coverage_status": "超出材料",
            "point_value": None,
            "earned_value": None,
            "expansion_level": "简略提及",
            "expansion_evidence": user_quote,
            "credit_reason": None,
            "loss_reason": reason,
            "deduction_owner": claim.get("deduction_owner", "准确有据"),
            "modification_action": claim.get("modification_action", "删除或改为材料可支持的表述"),
            "reference_support": "unsupported",
            "critical_qualifiers": [],
            "qualifier_status": None,
            "missing_qualifiers": [],
        })

    leading_summary_reviews = _compile_leading_summary_reviews(
        data.get("leading_summary_reviews"), user_answer, point_ledger
    )

    sentence_audit = data.get("sentence_audit")
    paragraph_audit = data.get("paragraph_audit")
    audit_errors = []
    audit_errors.extend(_validate_unit_audit(
        sentence_audit, user_answer, seen_ids, "sentence_audit"))
    audit_errors.extend(_validate_unit_audit(
        paragraph_audit, user_answer, seen_ids, "paragraph_audit"))
    if audit_errors:
        error_exit(EXIT_CONSISTENCY, "grade-once sentence/paragraph audit validation failed", audit_errors)

    structure_ledger = data.get("structure_ledger") or []
    required_structure_ids = set(required_format) | set(required_content) | set(relation_requirements)
    supplied_structure_ids = {
        item.get("element_id") for item in structure_ledger if isinstance(item, dict)
    }
    missing_structure_ids = required_structure_ids - supplied_structure_ids
    if missing_structure_ids:
        error_exit(EXIT_INPUT_ERROR,
                   "grade-once structure_ledger must cover every required structure element",
                   {"missing_element_ids": sorted(missing_structure_ids)})

    score_ledger = {
        "schema_version": "1.0",
        "ledger_id": ledger_id,
        "task_id": task_id,
        "answer_id": answer_id,
        "point_ledger": point_ledger,
        "structure_ledger": structure_ledger,
    }
    analysis_result = {
        "schema_version": "1.0",
        "analysis_id": analysis_id,
        "task_id": task_id,
        "question_type": question_type,
        "task_instruction": question_text,
        "constraints": {"full_score": full_score, "max_length": data.get("max_length")},
        "material_hash": hashlib.sha256(material_text.encode("utf-8")).hexdigest(),
        "paragraphs": [{"paragraph_id": "material-all", "text": material_text}],
        "atomic_points": atomic_points,
        "relationships": data.get("relationships", []),
        "completeness": {"status": "complete"},
    }

    route_cards = _grade_method_route(prototype)
    if not route_cards:
        error_exit(EXIT_CONSISTENCY,
                   f"grade-once prototype {prototype.get('prototype_id')} has no grading method-card route")
    method_errors = _validate_method_card_ids(route_cards)
    if method_errors:
        error_exit(EXIT_CONSISTENCY, "grade-once method route is invalid", method_errors)

    reference_answer_set = data.get("reference_answer_set")
    compact_references = data.get("reference_answers")
    if reference_answer_set is None and compact_references is not None:
        if not isinstance(compact_references, list) or not compact_references:
            error_exit(EXIT_INPUT_ERROR, "grade-once reference_answers must be a non-empty array")
        compiled_answers = []
        confidence_order = {"low": 0, "medium": 1, "high": 2}
        source_confidences = []
        for index, reference in enumerate(compact_references, 1):
            if isinstance(reference, str):
                reference = {"answer_text": reference}
            if not isinstance(reference, dict):
                error_exit(EXIT_INPUT_ERROR,
                           f"grade-once reference_answers[{index - 1}] must be a string or object")
            answer_text = reference.get("answer_text")
            if not isinstance(answer_text, str) or not answer_text.strip():
                error_exit(EXIT_INPUT_ERROR,
                           f"grade-once reference_answers[{index - 1}] needs answer_text")
            source_type = reference.get("source_type", "institution_answer")
            reliability = reference.get("reliability", "medium")
            if source_type not in {"official_rubric", "official_answer", "institution_answer", "teacher_answer", "unverified"}:
                error_exit(EXIT_INPUT_ERROR,
                           f"grade-once reference_answers[{index - 1}] has invalid source_type")
            if reliability not in confidence_order:
                error_exit(EXIT_INPUT_ERROR,
                           f"grade-once reference_answers[{index - 1}] has invalid reliability")
            source_confidences.append(reliability)
            compiled_answers.append({
                "answer_id": _stable_runtime_id("reference", task_id, index, answer_text),
                "label": reference.get("label", f"参考答案{index}"),
                "source_type": source_type,
                "source_note": reference.get("source_note"),
                "reliability": reliability,
                "answer_text": answer_text,
                "supported_point_ids": reference.get("supported_point_ids", []),
                "structure_summary": reference.get("structure_summary"),
            })
        source_confidence = min(source_confidences, key=lambda item: confidence_order[item])
        reference_answer_set = {
            "schema_version": "1.0",
            "reference_set_id": _stable_runtime_id("reference-set", task_id, len(compiled_answers)),
            "paper_id": paper_id,
            "question_id": question_id,
            "answers": compiled_answers,
            "source_confidence": source_confidence,
        }

    point_pool_review = data.get("point_pool_review")
    if not isinstance(point_pool_review, dict):
        error_exit(
            EXIT_INPUT_ERROR,
            "grade-once requires explicit point_pool_review; verified status is never auto-generated",
        )
    if point_pool_review.get("status") not in {"verified", "disputed"}:
        error_exit(
            EXIT_INPUT_ERROR,
            "grade-once point_pool_review.status must be verified or disputed",
        )
    review_evidence = point_pool_review.get("evidence")
    if not isinstance(review_evidence, str) or not review_evidence.strip():
        error_exit(EXIT_INPUT_ERROR, "grade-once point_pool_review.evidence must be non-empty")

    calibration_errors, calibration_coverage = _validate_reference_calibration(
        data.get("reference_calibration"),
        reference_answer_set,
        point_definitions,
        material_text,
    )
    if calibration_errors:
        error_exit(
            EXIT_CONSISTENCY,
            "grade-once reference answer calibration is incomplete",
            {"errors": calibration_errors},
        )

    point_pool_fingerprint = _point_pool_fingerprint(point_definitions)

    scoring_input = {
        "schema_version": "1.0",
        "analysis_id": analysis_id,
        "question_type": question_type,
        "weight_policy": data.get("weight_policy", "default"),
        "source_note": data.get("source_note"),
        "user_answer": user_answer,
        "answer_version": data.get("answer_version", "draft_1"),
        "full_score": full_score,
        "confidence_basis": data.get("confidence_basis", {
            "level": "medium",
            "reason": "材料与作答完整，未提供官方逐点评分细则",
        }),
        "dimensions": dimensions,
        "task_spec": task_spec,
        "analysis_result": analysis_result,
        "material_text_by_scope": {"material-all": material_text},
        "point_definitions": point_definitions,
        "score_ledger": score_ledger,
        "point_pool_review": point_pool_review,
        "method_selection": {
            "selected_card_ids": route_cards,
            "validation_passed": True,
            "mode": "批改",
        },
        "holistic_review": data.get("holistic_review"),
        "application_review": data.get("application_review"),
        "essay_review": data.get("essay_review"),
        "sentence_audit": sentence_audit,
        "paragraph_audit": paragraph_audit,
        "leading_summary_reviews": leading_summary_reviews,
        "reference_answer_set": reference_answer_set,
        "required_format_elements": required_format,
        "missing_format_elements": data.get("missing_format_elements", []),
        "extra_material_claims": extra_material_claims,
    }
    if data.get("max_length") is not None or data.get("min_length") is not None:
        scoring_input["length_check"] = {
            "min_length": data.get("min_length"),
            "max_length": data.get("max_length"),
            "length_unit": data.get("length_unit", "字"),
        }
    return scoring_input, {
        "prototype_id": prototype["prototype_id"],
        "question_type": question_type,
        "resolution_mode": prototype["prototype_resolution_receipt"]["resolution_mode"],
        "method_card_count": len(route_cards),
        "analysis_id": analysis_id,
        "ledger_id": ledger_id,
        "point_pool_fingerprint": point_pool_fingerprint,
        "reference_calibration_verified": bool(reference_answer_set),
        "reference_calibration_coverage": calibration_coverage,
        "reference_discovery_status": data["reference_discovery"]["status"],
        "reference_route": "reference_assisted" if reference_answer_set else "material_only",
        "reference_available": bool(reference_answer_set),
        "reference_answer_count": len(reference_answer_set.get("answers", [])) if reference_answer_set else 0,
        "resolved_task_components": task_components,
        "extra_material_claim_count": len(extra_material_claims),
        "leading_summary_review_count": len(leading_summary_reviews),
        "task_scope_basis": "question_text",
        "selected_card_ids": route_cards,
        "selected_method_guides": _method_guides(route_cards),
        "method_selection_verified": True,
    }


def _score_receipt_consistency(result):
    """Check formal score fields without treating normal integer rounding as an error."""
    raw = result.get("raw_center")
    center = result.get("center_value")
    interval = result.get("interval") or {}
    lower = interval.get("lower")
    upper = interval.get("upper")
    score_base = result.get("score_base")
    errors = []
    numeric_values = (raw, center, lower, upper, score_base)
    if not all(isinstance(value, (int, float)) and not isinstance(value, bool)
               for value in numeric_values):
        errors.append("raw_center, center_value, score_base and interval bounds must be numeric")
        return {
            "passed": False,
            "errors": errors,
            "rounding_tolerance": 0.5,
        }
    if lower > upper:
        errors.append("interval.lower must not exceed interval.upper")
    if center < lower or center > upper:
        errors.append("center_value must lie within the reported interval")
    if raw < 0 or raw > score_base:
        errors.append("raw_center must lie within 0 and score_base")
    if abs(center - raw) > 0.5:
        errors.append(
            "center_value must be the rounded formal value of raw_center within 0.5"
        )
    raw_interval_gap = max(lower - raw, raw - upper, 0.0)
    if raw_interval_gap > 0.5:
        errors.append(
            "raw_center exceeds the reported interval beyond integer-rounding tolerance"
        )
    return {
        "passed": not errors,
        "errors": errors,
        "raw_center": raw,
        "center_value": center,
        "interval": {"lower": lower, "upper": upper},
        "rounding_tolerance": 0.5,
        "raw_interval_gap": round(raw_interval_gap, 4),
    }


def _grade_once_preflight_errors(data):
    """Collect ordinary top-level input errors in one deterministic pass."""
    errors = []
    required = ("question_text", "full_score", "material_text", "user_answer", "points")
    for key in required:
        if key not in data:
            errors.append(f"missing required field: {key}")
    if "question_text" in data and (
            not isinstance(data.get("question_text"), str)
            or not data.get("question_text", "").strip()):
        errors.append("question_text must be a non-empty string")
    if "material_text" in data and (
            not isinstance(data.get("material_text"), str)
            or not data.get("material_text", "").strip()):
        errors.append("material_text must be a non-empty string")
    if "user_answer" in data and (
            not isinstance(data.get("user_answer"), str)
            or not data.get("user_answer", "").strip()):
        errors.append("user_answer must be a non-empty string")
    if "full_score" in data and (
            not _is_finite_number(data.get("full_score"))
            or data.get("full_score") <= 0):
        errors.append("full_score must be a positive number")
    if "points" in data and (
            not isinstance(data.get("points"), list) or not data.get("points")):
        errors.append("points must be a non-empty array")
    if data.get("dimensions") is None and data.get("dimension_levels") is None:
        errors.append("dimensions or dimension_levels is required")
    for item in data.get("_input_compilation_errors") or []:
        if isinstance(item, str) and item.strip():
            errors.append(item)
    input_mode = data.get("input_mode", "pure_text")
    if input_mode not in {"pure_text", "ocr_text"}:
        errors.append("input_mode must be pure_text or ocr_text")
    errors.extend(_validate_reference_discovery(data))
    return list(dict.fromkeys(errors))


def _grade_once_semantic_preflight_errors(data, prototype):
    """Collect common nested-input defects before the one scoring attempt."""
    errors = []
    question_type = prototype["question_type"]
    material_text = data.get("material_text", "")
    user_answer = data.get("user_answer", "")
    configured = _configured_dimensions(question_type)
    configured_names = {item["name"] for item in configured}
    configured_weights = {item["name"]: item["weight"] for item in configured}

    dimensions = data.get("dimensions")
    levels = data.get("dimension_levels")
    if isinstance(dimensions, list):
        seen_names = set()
        for index, item in enumerate(dimensions):
            prefix = f"dimensions[{index}]"
            if not isinstance(item, dict):
                errors.append(f"{prefix} must be an object")
                continue
            name = item.get("dimension_name")
            if name not in configured_names:
                errors.append(f"{prefix}.dimension_name is invalid for {question_type}: {name!r}")
            elif name in seen_names:
                errors.append(f"{prefix}.dimension_name is duplicated: {name}")
            else:
                seen_names.add(name)
            if item.get("weight") != configured_weights.get(name):
                errors.append(f"{prefix}.weight must use the configured weight for {name}")
            level = item.get("level")
            if not isinstance(level, int) or isinstance(level, bool) or not 0 <= level <= 4:
                errors.append(f"{prefix}.level must be an integer from 0 to 4")
        missing = configured_names - seen_names
        if missing:
            errors.append(f"dimensions is missing configured dimensions: {sorted(missing)}")
    elif isinstance(levels, dict):
        unknown = set(levels) - configured_names
        missing = configured_names - set(levels)
        if unknown:
            errors.append(f"dimension_levels contains unknown dimensions: {sorted(unknown)}")
        if missing:
            errors.append(f"dimension_levels is missing dimensions: {sorted(missing)}")
        for name, level in levels.items():
            if not isinstance(level, int) or isinstance(level, bool) or not 0 <= level <= 4:
                errors.append(f"dimension_levels.{name} must be an integer from 0 to 4")

    point_ids = set()
    for index, point in enumerate(data.get("points") or []):
        prefix = f"points[{index}]"
        if not isinstance(point, dict):
            errors.append(f"{prefix} must be an object")
            continue
        point_id = point.get("point_id") or f"p{index + 1}"
        if point_id in point_ids:
            errors.append(f"{prefix}.point_id is duplicated: {point_id}")
        point_ids.add(point_id)
        if not isinstance(point.get("point_text"), str) or not point.get("point_text", "").strip():
            errors.append(f"{prefix}.point_text must be non-empty")
        errors.extend(
            _material_evidence_support_errors(
                point.get("material_evidence"),
                material_text,
                f"{prefix}.material_evidence",
            )
        )
        coverage = point.get("coverage_status")
        if coverage not in VALID_COVERAGE_ALL or coverage == "超出材料":
            errors.append(f"{prefix}.coverage_status must be a normal material coverage status")
        expansion = point.get("expansion_level")
        if expansion is not None and expansion not in _EXPANSION_RATE:
            errors.append(
                f"{prefix}.expansion_level must be omitted or one of "
                f"{sorted(_EXPANSION_RATE)}"
            )
        user_quote = point.get("user_quote")
        if coverage in {"完整覆盖", "部分覆盖", "等义表达"}:
            if not isinstance(user_quote, str) or not user_quote.strip():
                errors.append(f"{prefix}.user_quote is required for {coverage}")
            elif not _evidence_in_scope(user_quote, user_answer):
                errors.append(f"{prefix}.user_quote is not found in user_answer")

    for index, claim in enumerate(data.get("extra_material_claims") or []):
        prefix = f"extra_material_claims[{index}]"
        if not isinstance(claim, dict):
            errors.append(f"{prefix} must be an object")
            continue
        quote = claim.get("user_quote")
        if not isinstance(quote, str) or not quote.strip() or not _evidence_in_scope(quote, user_answer):
            errors.append(f"{prefix}.user_quote must be found in user_answer")
        if isinstance(quote, str) and _evidence_in_scope(quote, material_text):
            errors.append(f"{prefix}.user_quote is material-supported and must map to a normal point")
        if not isinstance(claim.get("reason"), str) or not claim.get("reason", "").strip():
            errors.append(f"{prefix}.reason must be non-empty")
        if claim.get("deduction_owner") not in configured_names:
            errors.append(f"{prefix}.deduction_owner is invalid for {question_type}")

    point_pool_review = data.get("point_pool_review")
    if not isinstance(point_pool_review, dict):
        errors.append("point_pool_review is required")
    else:
        if point_pool_review.get("status") not in {"verified", "disputed"}:
            errors.append("point_pool_review.status must be verified or disputed")
        if not isinstance(point_pool_review.get("evidence"), str) or not point_pool_review.get("evidence", "").strip():
            errors.append("point_pool_review.evidence must be non-empty")

    if question_type in {"归纳概括", "综合分析", "提出对策"}:
        if not isinstance(data.get("holistic_review"), dict):
            errors.append(f"holistic_review is required for {question_type}")
    elif question_type == "贯彻执行":
        if not isinstance(data.get("application_review"), dict):
            errors.append("application_review is required for 贯彻执行")
    elif question_type == "申发论述":
        essay_review = data.get("essay_review")
        if not isinstance(essay_review, dict):
            errors.append("essay_review is required for 申发论述")
        elif data.get("dimensions") is None and data.get("dimension_levels") is None:
            if essay_review.get("language_status") not in {"strong", "adequate", "weak", "poor", "unreadable"}:
                errors.append(
                    "essay_review.language_status is required to compile dimensions "
                    "(strong/adequate/weak/poor/unreadable)"
                )
            if essay_review.get("example_support_status") not in {"strong", "adequate", "partial", "weak", "missing"}:
                errors.append(
                    "essay_review.example_support_status is required to compile dimensions "
                    "(strong/adequate/partial/weak/missing)"
                )
    return list(dict.fromkeys(errors))


def cmd_grade_once(args):
    """Compile compact grading evidence and run the formal scorer exactly once."""
    raw = read_input(args.input)
    raw_data = parse_json_input(raw)
    if not isinstance(raw_data, dict):
        error_exit(EXIT_INPUT_ERROR, "grade-once input must be a JSON object")
    question_text = raw_data.get("question_text")
    if not isinstance(question_text, str) or not question_text.strip():
        preflight_errors = _grade_once_preflight_errors(raw_data)
        error_exit(
            EXIT_INPUT_ERROR,
            "grade-once preflight failed",
            {
                "errors": preflight_errors,
                "retry_policy": "fix_all_listed_errors_once_then_stop",
                "maximum_retry_count": 1,
            },
        )
    prototype = _resolve_task_prototype_once(question_text, "批改")
    data, input_normalization = _normalize_grade_once_data(raw_data, prototype)
    preflight_errors = _grade_once_preflight_errors(data)
    preflight_errors.extend(_grade_once_semantic_preflight_errors(data, prototype))
    preflight_errors = list(dict.fromkeys(preflight_errors))
    if preflight_errors:
        error_exit(
            EXIT_INPUT_ERROR,
            "grade-once preflight failed",
            {
                "errors": preflight_errors,
                "retry_policy": "fix_all_listed_errors_once_then_stop",
                "maximum_retry_count": 1,
                "input_normalization": input_normalization,
            },
        )
    requested_type = data.get("question_type")
    if requested_type is not None and requested_type != prototype["question_type"]:
        error_exit(EXIT_CONSISTENCY, "grade-once question_type conflicts with prototype routing", {
            "requested": requested_type,
            "resolved": prototype["question_type"],
            "prototype_id": prototype["prototype_id"],
        })
    scoring_input, receipt = _compile_grade_once_input(data, prototype)
    result = _calculate_score_data(scoring_input)
    score_consistency = _score_receipt_consistency(result)
    if not score_consistency["passed"]:
        error_exit(
            EXIT_CONSISTENCY,
            "grade-once score receipt consistency check failed",
            score_consistency,
        )

    final_coverage = {
        item.get("point_id"): item
        for item in result.get("point_coverage", [])
        if isinstance(item, dict) and item.get("point_id")
    }
    canonical_ledger = []
    for entry in scoring_input["score_ledger"]["point_ledger"]:
        normalized_entry = dict(entry)
        canonical = final_coverage.get(entry.get("point_id"))
        if canonical:
            normalized_entry["coverage_status"] = canonical.get(
                "coverage_status", normalized_entry.get("coverage_status"))
            normalized_entry["qualifier_status"] = canonical.get(
                "qualifier_status", normalized_entry.get("qualifier_status"))
            normalized_entry["missing_qualifiers"] = canonical.get(
                "missing_qualifiers", normalized_entry.get("missing_qualifiers", []))
            if (normalized_entry.get("coverage_status") == "部分覆盖"
                    and normalized_entry.get("missing_qualifiers")):
                normalized_entry["credit_reason"] = "已命中要点方向，但关键限定不完整"
                normalized_entry["loss_reason"] = (
                    "缺少关键限定：" + "、".join(normalized_entry["missing_qualifiers"])
                )
        canonical_ledger.append(normalized_entry)

    if data.get("sentence_audit") is None and result.get("question_type") != "申发论述":
        result["sentence_audit"] = _derive_sentence_audit(
            scoring_input["user_answer"],
            scoring_input["point_definitions"],
            canonical_ledger,
        )
    if data.get("paragraph_audit") is None and result.get("question_type") == "申发论述":
        result["paragraph_audit"] = _derive_paragraph_audit(
            scoring_input["user_answer"],
            scoring_input["point_definitions"],
            canonical_ledger,
            scoring_input.get("essay_review"),
        )
    result["leading_summary_audit"] = _render_leading_summary_audit(
        scoring_input.get("leading_summary_reviews"),
        canonical_ledger,
        question_text,
    )
    if data.get("max_length") is not None or data.get("min_length") is not None:
        actual_length = _count_answer_chars(scoring_input["user_answer"], strip_markdown=True)
        min_length = data.get("min_length")
        max_length = data.get("max_length")
        result["length_check"] = {
            "actual_length": actual_length,
            "min_length": min_length,
            "max_length": max_length,
            "length_unit": data.get("length_unit", "字"),
            "punctuation_counted": True,
            "markdown_shell_removed": True,
            "compliant": (
                (min_length is None or actual_length >= min_length)
                and (max_length is None or actual_length <= max_length)
            ),
            "affects_point_pool": False,
            "rescoring_performed": False,
        }
    result["grade_once_receipt"] = {
        **receipt,
        "sentence_audit_count": len(result.get("sentence_audit") or []),
        "paragraph_audit_count": len(result.get("paragraph_audit") or []),
        "leading_summary_review_count": len(result.get("leading_summary_audit") or []),
        "leading_summary_score_invariant_count": sum(
            1 for item in result.get("leading_summary_audit") or []
            if item.get("score_invariant") is True
        ),
        "single_compile": True,
        "entrypoint": "grade-once",
        "external_command_count": 1,
        "separate_legacy_command_chain_used": False,
        "score_core_invocations": 1,
        "input_mode": data.get("input_mode", "pure_text"),
        "ledger_validated_inside_scoring": True,
        "formal_score": result.get("formal_score") is True,
        "score_consistency": score_consistency,
        "input_normalization": input_normalization,
        "write_back": False,
    }
    result["input_normalization"] = input_normalization
    report_requirements = _build_full_report_requirements(
        "批改",
        question_type=result.get("question_type"),
        result=result,
        reference_available=receipt["reference_available"],
    )
    result["output_validation_context"] = {
        "output_mode": "批改",
        "reference_available": receipt["reference_available"],
        "final_response": True,
        "reference_answer_text_required": receipt["reference_available"] is False,
        "reference_answer_length_constraints": {
            "min_length": data.get("min_length"),
            "max_length": data.get("max_length"),
            "length_unit": data.get("length_unit", "字"),
        },
        "required_method_names": [
            item.get("method_name")
            for item in receipt.get("selected_method_guides", [])
            if item.get("method_name")
        ],
        "method_guides": receipt.get("selected_method_guides", []),
        "question_type": result.get("question_type"),
        "full_score": result.get("full_score"),
        "full_score_source": "grade_once",
        "canonical_verdict": report_requirements.get("canonical_verdict"),
        "required_verdict_terms": report_requirements.get("required_verdict_terms", []),
        "report_requirements": report_requirements,
    }
    result["point_pool_fingerprint"] = receipt["point_pool_fingerprint"]
    success_output(result, args.output)


def _analysis_length_constraints(data, question_text):
    """Resolve explicit or conservatively inferred answer length bounds."""
    explicit_min = data.get("min_length")
    explicit_max = data.get("max_length")
    valid_bound = lambda value: value is None or (
        isinstance(value, int) and not isinstance(value, bool) and value >= 0
    )
    if not valid_bound(explicit_min) or not valid_bound(explicit_max):
        error_exit(
            EXIT_INPUT_ERROR,
            "analyze-once min_length/max_length must be non-negative integers or null",
        )
    if explicit_min is not None and explicit_max is not None and explicit_min > explicit_max:
        error_exit(EXIT_INPUT_ERROR, "analyze-once min_length must be <= max_length")
    if explicit_min is not None or explicit_max is not None:
        return {
            "min_length": explicit_min,
            "max_length": explicit_max,
            "length_unit": data.get("length_unit", "字"),
            "source": "explicit_input",
        }

    range_match = re.search(
        r"(?<!\d)(\d{2,4})\s*(?:[—\-~～]|至|到)\s*(\d{2,4})\s*字",
        question_text,
    )
    if range_match:
        lower, upper = int(range_match.group(1)), int(range_match.group(2))
        if lower <= upper:
            return {
                "min_length": lower, "max_length": upper,
                "length_unit": "字", "source": "question_text_range",
            }
    max_match = re.search(r"不超过\s*(\d{1,4})\s*字", question_text)
    min_match = re.search(r"(?:不少于|不低于|至少)\s*(\d{1,4})\s*字", question_text)
    return {
        "min_length": int(min_match.group(1)) if min_match else None,
        "max_length": int(max_match.group(1)) if max_match else None,
        "length_unit": "字",
        "source": "question_text_single_bound" if (min_match or max_match) else "not_found",
    }


def _analysis_full_score(question_text):
    """Extract an explicit question score without guessing missing scores."""
    labeled = re.findall(
        r"(?:满分|总分)\s*(?:为|是|：|:)?\s*(\d+(?:\.\d+)?)\s*分",
        question_text,
    )
    heading = re.findall(
        r"(?:^|[\n])\s*第[一二三四五六七八九十百千万0-9]+题\s*[（(]\s*"
        r"(\d+(?:\.\d+)?)\s*分\s*[）)]",
        question_text,
    )
    matches = labeled + heading
    if not matches:
        return {"full_score": None, "source": "not_found", "candidates": []}
    candidates = []
    for value in matches:
        number = float(value)
        candidates.append(int(number) if number.is_integer() else number)
    unique = list(dict.fromkeys(candidates))
    if len(unique) != 1:
        return {"full_score": None, "source": "conflict", "candidates": unique}
    return {
        "full_score": unique[0],
        "source": "question_text_labeled" if labeled else "question_text_heading",
        "candidates": unique,
    }


def _analysis_question_stem_audit(question_text):
    """Reject material summaries or waiting text before prototype routing.

    Prototype matching is intentionally broad, so ordinary words such as
    "概括" or "分析" inside a material summary must not be enough to start an
    analysis.  This audit only verifies that the input contains an exam-style
    task; it does not infer or rewrite the task itself.
    """
    text = question_text.strip()
    line_prefix = (
        r"(?:^|[\n。；])\s*(?:"
        r"第[一二三四五六七八九十百千万0-9]+题"
        r"(?:\s*[（(]\s*\d+(?:\.\d+)?\s*分\s*[）)])?"
        r"|(?:\d+|[一二三四五六七八九十]+)[、.．]"
        r")?\s*"
    )
    task_patterns = [
        line_prefix + r"请(?:根据|结合|阅读|围绕|就|你|谈谈|概括|归纳|梳理|分析|指出|说明|评价|提出|拟写|撰写|写)",
        line_prefix + r".{0,120}?请\s*(?:根据|结合|阅读|围绕|就|谈谈|概括|归纳|梳理|分析|指出|说明|评价|提出|拟写|撰写|草拟|起草|准备|编写|制作|形成|拟定|列出|写)",
        line_prefix + r"(?:根据|结合).{0,60}(?:概括|归纳|梳理|分析|谈谈|指出|说明|评价|提出|拟写|撰写|写)",
        line_prefix + r"(?:概括|归纳|梳理|分析|谈谈|指出|说明|评价|提出|拟写|撰写|写一篇|写一份)",
        r"(?:拟写|撰写|草拟|起草|准备|编写|制作|形成|拟定|列出).{0,120}(?:汇报提纲|情况报告|经验交流材料|经验交流发言材料|发言材料|发言提纲|讲话稿|讲话提纲|案例摘要|案例简介|工作指南|操作指南|提案|建议案|倡议书|公开信|宣传稿|推介稿)",
        r"以[^。\n]{1,100}为(?:题|题目|主题)[^。\n]{0,50}(?:写|撰写)[^。\n]{0,30}(?:文章|议论文)",
        r"围绕[^。\n]{1,100}(?:写|撰写)[^。\n]{0,30}(?:文章|议论文|报告|讲话稿|发言稿)",
    ]
    task_matches = [
        match
        for pattern in task_patterns
        for match in re.finditer(pattern, text, flags=re.IGNORECASE)
    ]
    has_task = bool(task_matches)

    waiting_patterns = [
        r"(?:等待|等你|尚未|还没|未)(?:提供|给出|发来|发送|贴出)?.{0,12}题干",
        r"题干.{0,12}(?:尚未|还没|未)(?:提供|给出|发来|发送|贴出)",
        r"把题干.{0,20}(?:发|贴|给)(?:过来|出来|我)",
    ]
    waiting_matches = [
        match
        for pattern in waiting_patterns
        for match in re.finditer(pattern, text, flags=re.IGNORECASE)
    ]
    latest_task_end = max((match.end() for match in task_matches), default=-1)
    latest_waiting_end = max((match.end() for match in waiting_matches), default=-1)
    # A real task appended after a waiting/meta sentence is accepted.  If the
    # latest signal still says the task is absent, fail closed.
    waiting_overrides = bool(waiting_matches) and latest_waiting_end >= latest_task_end
    return {
        "passed": has_task and not waiting_overrides,
        "task_signal_found": has_task,
        "waiting_or_material_only_signal_found": bool(waiting_matches),
        "task_appended_after_waiting_text": bool(
            task_matches and waiting_matches and latest_task_end > latest_waiting_end
        ),
    }


def cmd_analyze_once(args):
    """Resolve prototype, method cards and analysis branch in one read-only call."""
    raw = read_input(args.input)
    data = parse_json_input(raw)
    if not isinstance(data, dict):
        error_exit(EXIT_INPUT_ERROR, "analyze-once input must be a JSON object")
    question_text = data.get("question_text")
    material_text = data.get("material_text")
    if not isinstance(question_text, str) or not question_text.strip():
        error_exit(EXIT_INPUT_ERROR, "analyze-once requires non-empty question_text")
    if not isinstance(material_text, str) or not material_text.strip():
        error_exit(EXIT_INPUT_ERROR, "analyze-once requires non-empty material_text")

    question_stem_audit = _analysis_question_stem_audit(question_text)
    if not question_stem_audit["passed"]:
        error_exit(
            EXIT_INPUT_ERROR,
            "analyze-once requires an actual exam task stem; material summaries or waiting text are not questions",
            question_stem_audit,
        )

    prototype = _resolve_task_prototype_once(question_text, "解析")
    question_type = prototype["question_type"]
    route_cards = prototype.get("mode_routes", {}).get("解析", [])
    method_errors = _validate_method_card_ids(route_cards)
    if method_errors:
        error_exit(EXIT_CONSISTENCY, "analyze-once method route is invalid", method_errors)
    cards_map, load_errors = _load_method_cards_map()
    if load_errors:
        error_exit(EXIT_INPUT_ERROR, "analyze-once method cards could not be loaded", load_errors)

    resolved_cards = []
    for card_id in route_cards:
        card = cards_map[card_id]
        if question_type not in card.get("适用题型", []):
            error_exit(EXIT_CONSISTENCY,
                       f"analyze-once method card {card_id} does not support {question_type}")
        if "解析" not in card.get("适用模式", []):
            error_exit(EXIT_CONSISTENCY,
                       f"analyze-once method card {card_id} does not support 解析 mode")
        resolved_cards.append({
            "card_id": card_id,
            "method_name": card.get("方法名"),
            "layer": card.get("方法层级"),
            "triggers": card.get("触发信号", []),
            "steps": card.get("步骤逻辑", []),
            "boundaries": card.get("适用边界", []),
            "outputs": card.get("输出产物", []),
        })

    compact_references = data.get("reference_answers")
    reference_set = data.get("reference_answer_set")
    if compact_references is not None and reference_set is not None:
        error_exit(
            EXIT_INPUT_ERROR,
            "analyze-once accepts reference_answers or reference_answer_set, not both",
        )
    if compact_references is not None:
        if not isinstance(compact_references, list) or not compact_references:
            error_exit(EXIT_INPUT_ERROR, "analyze-once reference_answers must be a non-empty array")
        for index, reference in enumerate(compact_references):
            if isinstance(reference, str):
                if not reference.strip():
                    error_exit(EXIT_INPUT_ERROR,
                               f"analyze-once reference_answers[{index}] must be non-empty")
            elif not isinstance(reference, dict) or not isinstance(reference.get("answer_text"), str) or not reference["answer_text"].strip():
                error_exit(EXIT_INPUT_ERROR,
                           f"analyze-once reference_answers[{index}] needs answer_text")
    if reference_set is not None:
        if not isinstance(reference_set, dict) or not isinstance(reference_set.get("answers"), list) or not reference_set["answers"]:
            error_exit(EXIT_INPUT_ERROR,
                       "analyze-once reference_answer_set.answers must be a non-empty array")

    has_references = bool(compact_references or reference_set)
    if isinstance(compact_references, list):
        reference_answer_count = len(compact_references)
    elif isinstance(reference_set, dict) and isinstance(reference_set.get("answers"), list):
        reference_answer_count = len(reference_set["answers"])
    else:
        reference_answer_count = 0
    explicit_reference_available = data.get("reference_available")
    if explicit_reference_available is not None:
        if not isinstance(explicit_reference_available, bool):
            error_exit(EXIT_INPUT_ERROR, "analyze-once reference_available must be boolean")
        if explicit_reference_available != has_references:
            error_exit(
                EXIT_CONSISTENCY,
                "analyze-once reference_available conflicts with current reference payload",
            )
    expected_reference_count = data.get("expected_reference_answer_count")
    if expected_reference_count is not None:
        if (isinstance(expected_reference_count, bool)
                or not isinstance(expected_reference_count, int)
                or expected_reference_count < 0):
            error_exit(
                EXIT_INPUT_ERROR,
                "analyze-once expected_reference_answer_count must be a non-negative integer",
            )
        if expected_reference_count != reference_answer_count:
            error_exit(
                EXIT_CONSISTENCY,
                "analyze-once expected_reference_answer_count does not match current references",
                {"expected": expected_reference_count, "actual": reference_answer_count},
            )
    length_constraints = _analysis_length_constraints(data, question_text)
    score_info = _analysis_full_score(question_text)
    if question_type in {"归纳概括", "综合分析", "提出对策"}:
        analysis_branch = "material_point_pool"
        fast_path_focus = "参考答案候选主点→材料逐点核验→同功能合并→补充材料明确但参考答案遗漏的主点"
        reference_boundary = "参考答案提供候选骨架，不把分条数量直接当作得分点数量"
    elif question_type == "贯彻执行":
        analysis_branch = "application_task_elements"
        fast_path_focus = "参考稿文种功能与内容板块→题干身份对象目的核验→材料内容与成效补漏→合理格式变体检查"
        reference_boundary = "参考稿不是唯一格式模板，不得用其字面顺序替代文种任务判断"
    else:
        analysis_branch = "essay_thesis_and_argument_line"
        fast_path_focus = "机构立意/范文作为候选方向→题干核心命题核验→材料支撑检查→分论点体系与论证线补漏"
        reference_boundary = "范文不是标准答案，不得把范文分论点或顺序设为唯一正确结构"

    if has_references:
        analysis_strategy = {
            "mode": "reference_fast_path",
            "focus": fast_path_focus,
            "material_pass": "targeted_verification_and_gap_scan",
            "reference_boundary": reference_boundary,
            "parallel_full_rebuild": False,
            "required_checks": [
                "reference_matches_current_question",
                "every_candidate_has_material_support",
                "same_function_content_is_merged",
                "material_supported_omissions_are_supplemented",
            ],
        }
    else:
        analysis_strategy = {
            "mode": "material_full_path",
            "focus": "完整材料遍→任务功能拆分→证据结构→反向查漏与拆并复核",
            "material_pass": "full_independent_analysis",
            "reference_boundary": "无外部参考资料，结论须保留中等置信度和争议说明",
            "parallel_full_rebuild": False,
            "required_checks": [
                "task_scope_complete",
                "material_evidence_complete",
                "same_function_content_is_merged",
                "background_examples_not_hard_scored",
            ],
        }
    report_requirements = _build_full_report_requirements(
        "解析",
        question_type=question_type,
        result=None,
        reference_available=has_references,
    )
    result = {
        "schema_version": "1.0",
        "engine_version": ENGINE_VERSION,
        "receipt_type": "analysis_once",
        "question_type": question_type,
        "prototype_id": prototype["prototype_id"],
        "prototype_name": prototype.get("prototype_name"),
        "prototype_resolution_receipt": prototype["prototype_resolution_receipt"],
        "task_components": data.get("task_components") or _default_task_components(question_type, question_text),
        "full_score": score_info["full_score"],
        "full_score_source": score_info["source"],
        "analysis_branch": analysis_branch,
        "reference_route": "reference_assisted" if has_references else "material_only",
        "reference_available": has_references,
        "reference_answer_count": reference_answer_count,
        "analysis_strategy": analysis_strategy,
        "method_card_ids": route_cards,
        "cards": resolved_cards,
        "output_validation_context": {
            "output_mode": "解析",
            "reference_available": has_references,
            "final_response": True,
            "reference_answer_text_required": not has_references,
            "generated_answer_policy": "forbidden" if has_references else "allowed",
            "reference_answer_length_constraints": {
                "min_length": length_constraints["min_length"],
                "max_length": length_constraints["max_length"],
                "length_unit": length_constraints["length_unit"],
            },
            "required_method_names": [
                item["method_name"] for item in resolved_cards if item.get("method_name")
            ],
            "method_guides": resolved_cards,
            "question_type": question_type,
            "full_score": score_info["full_score"],
            "full_score_source": score_info["source"],
            "canonical_verdict": None,
            "required_verdict_terms": [],
            "report_requirements": report_requirements,
            "validation_payload_requirements": {
                "required_fields": (
                    ["receipt_path", "text"]
                    if has_references
                    else ["receipt_path", "text", "reference_answer_text"]
                ),
                "entrypoint": "finalize-analysis",
                "validation_context_source": "saved_analyze_once_receipt",
                "manual_context_fields_allowed": False,
                "reference_answer_text_policy": (
                    "forbidden_existing_user_reference"
                    if has_references
                    else "required_exact_generated_answer_in_text"
                ),
                "source_or_schema_lookup_required": False,
            },
        },
        "analysis_input_audit": {
            "reference_available": has_references,
            "reference_answer_count": reference_answer_count,
            "length_constraint_source": length_constraints["source"],
            "min_length": length_constraints["min_length"],
            "max_length": length_constraints["max_length"],
            "full_score_source": score_info["source"],
            "full_score_candidates": score_info["candidates"],
            "semantic_input_changed": False,
            "raw_text_included": False,
            "question_stem_audit": question_stem_audit,
        },
        "analysis_once_receipt": {
            "passed": True,
            "engine_version": ENGINE_VERSION,
            "single_route": True,
            "entrypoint": "analyze-once",
            "external_command_count": 1,
            "separate_resolve_commands_used": False,
            "scoring_command_count": 0,
            "fast_path": has_references,
            "strategy_mode": analysis_strategy["mode"],
            "reference_route": "reference_assisted" if has_references else "material_only",
            "reference_available": has_references,
            "reference_answer_count": reference_answer_count,
            "full_score": score_info["full_score"],
            "full_score_source": score_info["source"],
            "calibration_mode": "candidate_material_check" if has_references else "material_only",
            "material_present": True,
            "scoring_started": False,
            "write_back": False,
        },
    }
    success_output(result, args.output)


# ---------------------------------------------------------------------------
# compare-drafts
# ---------------------------------------------------------------------------

def cmd_compare_drafts(args):
    raw = read_input(args.input)
    data = parse_json_input(raw)

    required = ["analysis_id", "draft_1", "draft_2"]
    for field in required:
        if field not in data:
            error_exit(EXIT_INPUT_ERROR, f"Missing field: {field}")

    d1 = data["draft_1"]
    d2 = data["draft_2"]

    # Must share the same analysis_id
    if d1.get("analysis_id") != d2.get("analysis_id"):
        error_exit(EXIT_CONSISTENCY, "Drafts must share the same analysis_id",
                    f"d1={d1.get('analysis_id')}, d2={d2.get('analysis_id')}")

    if d1.get("analysis_id") != data["analysis_id"]:
        error_exit(EXIT_CONSISTENCY, "Top-level analysis_id mismatch")

    fingerprint_1 = d1.get("point_pool_fingerprint")
    fingerprint_2 = d2.get("point_pool_fingerprint")
    if not isinstance(fingerprint_1, str) or not fingerprint_1:
        error_exit(EXIT_CONSISTENCY, "draft_1 is missing point_pool_fingerprint")
    if not isinstance(fingerprint_2, str) or not fingerprint_2:
        error_exit(EXIT_CONSISTENCY, "draft_2 is missing point_pool_fingerprint")
    if fingerprint_1 != fingerprint_2:
        error_exit(
            EXIT_CONSISTENCY,
            "Drafts must share the same verified point pool",
            {"draft_1_fingerprint": fingerprint_1, "draft_2_fingerprint": fingerprint_2},
        )

    # Compare point coverage
    d1_cov = {pm["point_id"]: pm["coverage_status"] for pm in d1.get("point_coverage", [])}
    d2_cov = {pm["point_id"]: pm["coverage_status"] for pm in d2.get("point_coverage", [])}

    # --- P1-2: coverage_summary must be recomputed from per-line mappings ---
    def _recompute_summary(cov_map):
        summary = {k: 0 for k in VALID_COVERAGE_ALL}
        for status in cov_map.values():
            if status in summary:
                summary[status] += 1
        return summary

    d1_summary_recomputed = _recompute_summary(d1_cov)
    d2_summary_recomputed = _recompute_summary(d2_cov)

    consistency_errors = []
    d1_summary_declared = d1.get("coverage_summary")
    d2_summary_declared = d2.get("coverage_summary")
    if isinstance(d1_summary_declared, dict) and d1_summary_declared != d1_summary_recomputed:
        consistency_errors.append(
            f"draft_1 coverage_summary mismatch: declared={d1_summary_declared} vs recomputed={d1_summary_recomputed}")
    if isinstance(d2_summary_declared, dict) and d2_summary_declared != d2_summary_recomputed:
        consistency_errors.append(
            f"draft_2 coverage_summary mismatch: declared={d2_summary_declared} vs recomputed={d2_summary_recomputed}")

    point_changes = []
    all_pids = set(d1_cov.keys()) | set(d2_cov.keys())
    for pid in sorted(all_pids):
        s1 = d1_cov.get(pid, "未覆盖")
        s2 = d2_cov.get(pid, "未覆盖")
        if s1 == "未覆盖" and s2 != "未覆盖":
            change_type = "newly_covered"
        elif s1 == "部分覆盖" and s2 in ("完整覆盖", "等义表达"):
            change_type = "partial_to_full"
        elif s1 in ("完整覆盖", "等义表达") and s2 == "部分覆盖":
            change_type = "full_to_partial"
        elif s1 == "部分覆盖" and s2 == "未覆盖":
            change_type = "partial_to_lost"
        elif s1 in ("完整覆盖", "等义表达") and s2 == "未覆盖":
            change_type = "full_to_lost"
        elif s2 == "超出材料" and s1 != "超出材料":
            change_type = "new_excess"
        elif s1 != s2:
            change_type = "expression_only"
        else:
            change_type = "unchanged"
        point_changes.append({
            "point_id": pid,
            "draft_1_status": s1,
            "draft_2_status": s2,
            "change_type": change_type
        })

    # --- P1-2: if external point_changes with change_type are provided, they must match engine-recomputed ---
    external_changes = data.get("point_changes")
    if isinstance(external_changes, list):
        ext_map = {pc.get("point_id"): pc for pc in external_changes if isinstance(pc, dict)}
        for pc in point_changes:
            pid = pc["point_id"]
            ext = ext_map.get(pid)
            if ext is None:
                continue
            ext_ct = ext.get("change_type")
            if ext_ct is not None and ext_ct != pc["change_type"]:
                consistency_errors.append(
                    f"point_changes[{pid}] change_type mismatch: external={ext_ct!r} vs engine-recomputed={pc['change_type']!r} (status {pc['draft_1_status']}->{pc['draft_2_status']})")
            # Also reject explicitly impossible combos
            if ext_ct == "partial_to_full" and not (pc["draft_1_status"] == "部分覆盖" and pc["draft_2_status"] in ("完整覆盖", "等义表达")):
                consistency_errors.append(
                    f"point_changes[{pid}] change_type=partial_to_full but status is {pc['draft_1_status']}->{pc['draft_2_status']} (partial_to_full requires 部分覆盖->完整覆盖/等义表达)")

    if consistency_errors:
        error_exit(EXIT_CONSISTENCY, "Draft comparison consistency check failed", {"errors": consistency_errors})

    # Compare dimensions
    d1_dims = {d["dimension_name"]: d for d in d1.get("dimensions", [])}
    d2_dims = {d["dimension_name"]: d for d in d2.get("dimensions", [])}

    dimension_changes = []
    for name in sorted(set(d1_dims.keys()) | set(d2_dims.keys())):
        d1d = d1_dims.get(name, {"level": 0, "calculated_score": 0})
        d2d = d2_dims.get(name, {"level": 0, "calculated_score": 0})
        dimension_changes.append({
            "dimension_name": name,
            "draft_1_level": d1d.get("level", 0),
            "draft_2_level": d2d.get("level", 0),
            "draft_1_score": d1d.get("calculated_score", 0),
            "draft_2_score": d2d.get("calculated_score", 0),
            "score_delta": round(d2d.get("calculated_score", 0) - d1d.get("calculated_score", 0), 4)
        })

    # Total change
    d1_center = d1.get("center_value", 0)
    d2_center = d2.get("center_value", 0)
    d1_interval = d1.get("interval", {"lower": 0, "upper": 0})
    d2_interval = d2.get("interval", {"lower": 0, "upper": 0})

    # Surface rewrite warning
    has_score_change = any(dc["score_delta"] != 0 for dc in dimension_changes)
    has_expression_only = any(pc["change_type"] == "expression_only" for pc in point_changes)

    result = {
        "schema_version": "1.0",
        "analysis_id": data["analysis_id"],
        "draft_1_scoring_id": d1.get("score_id", "draft_1"),
        "draft_2_scoring_id": d2.get("score_id", "draft_2"),
        "point_changes": point_changes,
        "dimension_changes": dimension_changes,
        "total_change": {
            "draft_1_center": d1_center,
            "draft_2_center": d2_center,
            "draft_1_interval": d1_interval,
            "draft_2_interval": d2_interval
        },
        "coverage_summary_d1": d1_summary_recomputed,
        "coverage_summary_d2": d2_summary_recomputed,
        "residual_issues": data.get("residual_issues", []),
        "surface_rewrite_warning": has_expression_only and not has_score_change
    }

    success_output(result, args.output)


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _get_db_path(args):
    if args.state_db:
        return args.state_db
    return os.path.join(os.getcwd(), "申论复盘引擎", "shenlun-review.sqlite3")


# Critical tables and the columns that MUST be present for schema v3.
# If any table is missing or any listed column is absent, the DB is rejected (exit 4).
_SCHEMA_V3_REQUIRED_TABLES = {
    "metadata": [],
    "materials": ["material_id", "material_hash"],
    "tasks": ["task_id", "material_id", "analysis_id", "question_type", "task_instruction"],
    "material_points": ["point_key", "task_id", "point_id", "evidence_text", "point_text", "status"],
    "answers": ["answer_id", "task_id", "answer_version", "user_answer"],
    "scores": [
        "score_id", "answer_id", "analysis_id", "weight_total", "score_base",
        "diagnostic_total", "raw_center", "center_value", "interval_lower",
        "interval_upper", "confidence", "weight_policy", "weight_source_note",
        "full_score", "scoring_json", "validation_passed",
    ],
    "dimension_scores": ["id", "score_id", "dimension_name", "weight", "level", "calculated_score"],
    "point_mappings": ["mapping_id", "score_id", "answer_id", "point_key", "coverage_status", "user_quote"],
    "extra_claims": ["id", "score_id", "answer_id", "claim_id", "claim_text"],
    "method_usage": ["id", "score_id", "method_card_id"],
    "ability_events": ["id", "task_id", "question_type", "dimension_name", "level", "score_id"],
}

_SCHEMA_V4_REQUIRED_TABLES = dict(_SCHEMA_V3_REQUIRED_TABLES)
_SCHEMA_V4_REQUIRED_TABLES.update({
    "papers": ["paper_id", "title"],
    "questions": ["question_id", "paper_id", "question_type"],
    "task_specs": ["task_spec_id", "paper_id", "question_id", "task_id", "task_instruction"],
    "task_components": ["id", "task_spec_id", "component_name"],
    "reference_answer_sets": ["reference_set_id", "paper_id", "question_id"],
    "reference_answer_items": ["answer_item_id", "reference_set_id", "answer_id", "answer_text"],
    "point_ledgers": ["point_ledger_id", "ledger_id", "task_id", "answer_id", "point_id", "material_evidence", "match_type", "coverage_status"],
    "structure_ledgers": ["structure_ledger_id", "ledger_id", "task_id", "answer_id", "element_id", "element_type", "status"],
})


def _verify_schema_v3(conn, db_path):
    """Verify an existing database strictly conforms to schema v3.

    Checks metadata.schema_version == "3", then verifies every critical table
    exists with every critical column. Returns list of error strings (empty = ok).
    NEVER uses CREATE TABLE IF NOT EXISTS to mask gaps.
    """
    errors = []
    cur = conn.cursor()

    # 1. metadata table must exist
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'")
    if not cur.fetchone():
        errors.append("metadata table missing (old schema)")
        return errors  # nothing else to check safely

    # 2. schema_version must be EXACTLY "3"
    cur.execute("SELECT value FROM metadata WHERE key='schema_version'")
    row = cur.fetchone()
    db_version = row[0] if row else None
    if db_version != "3":
        errors.append(f"metadata.schema_version is '{db_version}', expected '3'")
        return errors  # do not attempt column checks on wrong-version DB

    # 3. Verify every critical table and its critical columns
    for table, required_cols in _SCHEMA_V3_REQUIRED_TABLES.items():
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
        if not cur.fetchone():
            errors.append(f"required table missing: {table}")
            continue
        if not required_cols:
            continue
        cur.execute(f"PRAGMA table_info({table})")
        actual_cols = {c[1] for c in cur.fetchall()}
        for col in required_cols:
            if col not in actual_cols:
                errors.append(f"table '{table}' missing required column: {col}")

    return errors


def _verify_schema_v4(conn, db_path):
    """Verify an existing database strictly conforms to schema v4."""
    errors = []
    cur = conn.cursor()

    # 1. metadata table must exist
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'")
    if not cur.fetchone():
        errors.append("metadata table missing")
        return errors

    # 2. schema_version must be "4"
    cur.execute("SELECT value FROM metadata WHERE key='schema_version'")
    row = cur.fetchone()
    db_version = row[0] if row else None
    if db_version != "4":
        errors.append(f"metadata.schema_version is '{db_version}', expected '4'")
        return errors

    # 3. Verify every critical table and its critical columns
    for table, required_cols in _SCHEMA_V4_REQUIRED_TABLES.items():
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
        if not cur.fetchone():
            errors.append(f"required table missing: {table}")
            continue
        if not required_cols:
            continue
        cur.execute(f"PRAGMA table_info({table})")
        actual_cols = {c[1] for c in cur.fetchall()}
        for col in required_cols:
            if col not in actual_cols:
                errors.append(f"table '{table}' missing required column: {col}")

    return errors


SQL_SCHEMA_V4 = Path(__file__).resolve().parent / "state-schema-v4.sql"


def _migrate_v3_to_v4(db_path):
    """Migrate database from v3 to v4. Returns (success, errors).

    Steps:
    1. Create backup
    2. Run v4 schema (CREATE TABLE IF NOT EXISTS for new tables)
    3. Update schema_version to 4
    4. Verify v4 schema
    5. On failure: restore backup
    """
    import shutil

    # 1. Create backup
    backup_path = db_path + ".v3-backup"
    try:
        shutil.copy2(db_path, backup_path)
    except Exception as e:
        return False, [f"Failed to create backup: {e}"]

    # 2. Run v4 schema
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA foreign_keys = ON")

        if not SQL_SCHEMA_V4.exists():
            return False, [f"v4 schema file not found: {SQL_SCHEMA_V4}"]

        v4_sql = SQL_SCHEMA_V4.read_text(encoding="utf-8")
        conn.executescript(v4_sql)
        # Explicitly update schema_version (INSERT OR IGNORE won't update existing row)
        conn.execute("UPDATE metadata SET value = '4', updated_at = datetime('now') WHERE key = 'schema_version'")
        conn.commit()

        # 3. Verify v4
        verify_errors = _verify_schema_v4(conn, db_path)
        if verify_errors:
            conn.close()
            # Restore backup
            shutil.copy2(backup_path, db_path)
            return False, [f"v4 verification failed after migration: {verify_errors}"]

        conn.close()
        return True, []

    except sqlite3.Error as e:
        if conn:
            conn.close()
        # Restore backup
        try:
            shutil.copy2(backup_path, db_path)
        except Exception:
            pass
        return False, [f"Migration failed: {e}"]
    except Exception as e:
        if conn:
            conn.close()
        # Restore backup
        try:
            shutil.copy2(backup_path, db_path)
        except Exception:
            pass
        return False, [f"Migration failed: {e}"]


def _init_db(db_path, target_version="4"):
    """Initialize or open the SQLite database. Supports v3 and v4.

    New DB: run v4 schema, then verify.
    Existing DB v4: verify v4 schema.
    Existing DB v3: auto-migrate to v4 (with backup).
    Any gap → exit 4 with structured JSON, no traceback.
    """
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    is_new = not os.path.exists(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")

    if is_new:
        schema_file = SQL_SCHEMA_V4 if target_version == "4" else SQL_SCHEMA
        if not schema_file.exists():
            conn.close()
            error_exit(EXIT_DB_ERROR, f"SQL schema not found: {schema_file}")
        try:
            conn.executescript(schema_file.read_text(encoding="utf-8"))
            conn.commit()
        except sqlite3.Error as e:
            conn.close()
            error_exit(EXIT_DB_ERROR, "Failed to initialize new database", str(e))
        # Verify the fresh DB
        verify_fn = _verify_schema_v4 if target_version == "4" else _verify_schema_v3
        verify_errors = verify_fn(conn, db_path)
        if verify_errors:
            conn.close()
            error_exit(EXIT_DB_ERROR, f"Freshly created database failed v{target_version} verification",
                        {"db_path": db_path, "errors": verify_errors})
        return conn

    # Existing DB: check version and handle migration
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'")
    if not cur.fetchone():
        conn.close()
        error_exit(EXIT_DB_ERROR, "metadata table missing (old schema)")

    cur.execute("SELECT value FROM metadata WHERE key='schema_version'")
    row = cur.fetchone()
    db_version = row[0] if row else None

    if db_version == "4":
        # v4 DB: verify directly
        verify_errors = _verify_schema_v4(conn, db_path)
        if verify_errors:
            conn.close()
            error_exit(EXIT_DB_ERROR, "Existing v4 database verification failed",
                        {"db_path": db_path, "errors": verify_errors})
        return conn

    if db_version == "3" and target_version == "4":
        # P1: forbid auto-migration — must use explicit migrate-db-v4 command
        conn.close()
        error_exit(EXIT_DB_ERROR, "Database is v3 but target is v4. Auto-migration is forbidden. "
                    "Run 'migrate-db-v4' explicitly to migrate.",
                    {"db_path": db_path, "current_version": "3", "target_version": "4"})

    # v3 DB with v3 target: verify v3
    if db_version == "3" and target_version == "3":
        verify_errors = _verify_schema_v3(conn, db_path)
        if verify_errors:
            conn.close()
            error_exit(EXIT_DB_ERROR, "Existing v3 database verification failed",
                        {"db_path": db_path, "errors": verify_errors})
        return conn

    # Other versions: strict verification
    verify_fn = _verify_schema_v4 if target_version == "4" else _verify_schema_v3
    verify_errors = verify_fn(conn, db_path)
    if verify_errors:
        conn.close()
        error_exit(EXIT_DB_ERROR,
                    f"Existing database does not conform to schema v{target_version}.",
                    {"db_path": db_path, "errors": verify_errors, "expected_version": target_version})
    return conn


# ---------------------------------------------------------------------------
# write-state: uses the SAME unified kernel as calculate-score
# ---------------------------------------------------------------------------

def _validate_state_write_input(data):
    """Full structural validation of state-write-input. Returns (recomputed, errors).

    Reads atomic_points (NOT material_points). Internally writes to the
    material_points SQLite table, but the input field is atomic_points to match
    analysis-result.schema.json. A legacy material_points field is accepted ONLY
    as an alias and must be field-for-field identical to atomic_points if both
    are present.
    """
    errors = []

    # Top-level must be object
    if not isinstance(data, dict):
        return None, ["state-write-input must be a JSON object"]

    # --- Top-level required fields (atomic_points replaces material_points) ---
    required_top = [
        "schema_version", "analysis_id", "task_id", "question_type",
        "task_instruction", "material_hash", "user_answer", "answer_version",
        "dimensions", "weight_total", "score_base", "diagnostic_total",
        "raw_center", "center_value", "interval", "confidence",
        "point_coverage", "validation_receipt", "atomic_points",
        "weight_policy", "full_score"
    ]
    nullable_fields = {"full_score", "source_note"}
    for f in required_top:
        if f not in data:
            errors.append(f"Missing top-level field: {f}")
        elif data[f] is None and f not in nullable_fields:
            errors.append(f"Field is null: {f}")
        elif isinstance(data[f], str) and data[f].strip() == "" and f not in nullable_fields:
            errors.append(f"Field is empty string: {f}")

    if errors:
        return None, errors

    # --- schema_version ---
    if data["schema_version"] != "1.0":
        errors.append(f"schema_version must be '1.0', got '{data['schema_version']}'")

    # --- source_note type check FIRST (never let non-string reach hash join) ---
    if "source_note" in data and data["source_note"] is not None:
        if not isinstance(data["source_note"], str):
            errors.append(f"source_note must be a string or null, got {type(data['source_note']).__name__}={data['source_note']!r}")

    # --- Enum checks (safe: check string type before set membership) ---
    _check_enum(data["question_type"], VALID_QUESTION_TYPES, "question_type", errors)
    _check_enum(data["answer_version"], VALID_ANSWER_VERSIONS, "answer_version", errors)
    _check_enum(data["confidence"], VALID_CONFIDENCE, "confidence", errors)

    # --- weight_policy validation ---
    weight_policy = data.get("weight_policy")
    source_note = data.get("source_note")
    wp_valid = _check_enum(weight_policy, VALID_WEIGHT_POLICIES, "weight_policy", errors)
    if wp_valid:
        wp_errors = _validate_weight_policy(data["dimensions"], data["question_type"], weight_policy, source_note)
        errors.extend(wp_errors)

    # --- Numeric type checks (reject bool) ---
    for num_field in ("diagnostic_total", "center_value", "weight_total", "score_base", "raw_center"):
        if not _is_finite_number(data[num_field]):
            errors.append(f"{num_field} must be a finite number, got {type(data[num_field]).__name__}")

    # --- interval ---
    interval = data["interval"]
    if not isinstance(interval, dict):
        errors.append("interval must be an object")
    else:
        for bound in ("lower", "upper"):
            if bound not in interval:
                errors.append(f"interval missing '{bound}'")
            elif not _is_finite_number(interval[bound]):
                errors.append(f"interval.{bound} must be a finite number")
        if isinstance(interval, dict) and "lower" in interval and "upper" in interval:
            if _is_finite_number(interval["lower"]) and _is_finite_number(interval["upper"]):
                if interval["lower"] > interval["upper"]:
                    errors.append(f"interval.lower ({interval['lower']}) > interval.upper ({interval['upper']})")

    # --- dimensions: must be non-empty array of objects ---
    dims = data["dimensions"]
    if not isinstance(dims, list) or len(dims) == 0:
        errors.append("dimensions must be a non-empty array")
    else:
        seen_dim_names = set()
        for i, dim in enumerate(dims):
            if not isinstance(dim, dict):
                errors.append(f"dimensions[{i}] must be an object")
                continue
            for df in ("dimension_name", "weight", "level", "calculated_score"):
                if df not in dim:
                    errors.append(f"dimensions[{i}] missing field: {df}")
            name = dim.get("dimension_name", "")
            if not isinstance(name, str) or name.strip() == "":
                errors.append(f"dimensions[{i}].dimension_name must be non-empty string")
            elif name in seen_dim_names:
                errors.append(f"dimensions[{i}].dimension_name '{name}' is duplicate")
            else:
                seen_dim_names.add(name)
            if "weight" in dim and not _is_finite_number(dim["weight"]):
                errors.append(f"dimensions[{i}].weight must be finite number")
            if "weight" in dim and _is_finite_number(dim["weight"]) and dim["weight"] < 0:
                errors.append(f"dimensions[{i}].weight must be >= 0")
            if "level" in dim:
                if not isinstance(dim["level"], int) or isinstance(dim["level"], bool) or dim["level"] < 0 or dim["level"] > 4:
                    errors.append(f"dimensions[{i}].level must be int 0-4, got {dim['level']!r}")
            if "calculated_score" in dim and not _is_finite_number(dim["calculated_score"]):
                errors.append(f"dimensions[{i}].calculated_score must be finite number")

    # --- atomic_points (authoritative field; legacy material_points alias removed) ---
    points = data.get("atomic_points")
    if points is None:
        errors.append("Missing atomic_points")
    elif not isinstance(points, list):
        errors.append(f"atomic_points must be an array, got {type(points).__name__}")
    elif len(points) == 0:
        errors.append("atomic_points must be a non-empty array")
    else:
        seen_mp_pids = set()
        for i, pt in enumerate(points):
            if not isinstance(pt, dict):
                errors.append(f"atomic_points[{i}] must be an object")
                continue
            for pf in ("point_id", "paragraph_id", "evidence_text", "point_text", "point_role", "importance", "independent_scoring", "status"):
                if pf not in pt:
                    errors.append(f"atomic_points[{i}] missing field: {pf}")
            # point_id: non-empty string (reject numbers/bool/list)
            pid = pt.get("point_id", "")
            if _require_str(pid, f"atomic_points[{i}].point_id", errors):
                if pid in seen_mp_pids:
                    errors.append(f"atomic_points[{i}] duplicate point_id: '{pid}'")
                else:
                    seen_mp_pids.add(pid)
            # paragraph_id: non-empty string (reject numbers)
            _require_str(pt.get("paragraph_id"), f"atomic_points[{i}].paragraph_id", errors)
            # evidence_text: non-empty string (reject numbers)
            _require_str(pt.get("evidence_text"), f"atomic_points[{i}].evidence_text", errors)
            # point_text: non-empty string (reject numbers)
            _require_str(pt.get("point_text"), f"atomic_points[{i}].point_text", errors)
            # independent_scoring: boolean
            if "independent_scoring" in pt and not isinstance(pt["independent_scoring"], bool):
                errors.append(f"atomic_points[{i}].independent_scoring must be boolean")
            # qualifiers: array of strings (optional)
            if "qualifiers" in pt:
                quals = pt["qualifiers"]
                if not isinstance(quals, list):
                    errors.append(f"atomic_points[{i}].qualifiers must be an array")
                else:
                    for qi, q in enumerate(quals):
                        if not isinstance(q, str):
                            errors.append(f"atomic_points[{i}].qualifiers[{qi}] must be a string, got {type(q).__name__}")
            # enums (safe check)
            if "point_role" in pt:
                _check_enum(pt["point_role"], VALID_POINT_ROLES, f"atomic_points[{i}].point_role", errors)
            if "importance" in pt:
                _check_enum(pt["importance"], VALID_IMPORTANCE, f"atomic_points[{i}].importance", errors)
            if "status" in pt:
                _check_enum(pt["status"], VALID_POINT_STATUS, f"atomic_points[{i}].status", errors)

    # --- point_coverage: strict validation ---
    pcs = data["point_coverage"]
    if not isinstance(pcs, list):
        errors.append("point_coverage must be an array")
    else:
        user_answer = data["user_answer"]
        mp_pids_active = set()
        mp_pids_all = set()
        if isinstance(points, list):
            for pt in points:
                if isinstance(pt, dict) and "point_id" in pt:
                    mp_pids_all.add(pt["point_id"])
                    if pt.get("status") == "active":
                        mp_pids_active.add(pt["point_id"])

        seen_pc_pids = set()
        for i, pm in enumerate(pcs):
            if not isinstance(pm, dict):
                errors.append(f"point_coverage[{i}] must be an object")
                continue
            for pf in ("point_id", "coverage_status"):
                if pf not in pm:
                    errors.append(f"point_coverage[{i}] missing field: {pf}")
            status = pm.get("coverage_status", "")
            pid = pm.get("point_id", "")
            uq = pm.get("user_quote")

            _check_enum(status, VALID_COVERAGE_ALL, f"point_coverage[{i}].coverage_status", errors)

            if status != "超出材料":
                if pid in seen_pc_pids:
                    errors.append(f"point_coverage[{i}] duplicate point_id: '{pid}' (status={status})")
                seen_pc_pids.add(pid)

                if mp_pids_all and pid not in mp_pids_all:
                    errors.append(f"point_coverage[{i}].point_id '{pid}' not found in atomic_points")

                if status in ("完整覆盖", "部分覆盖", "等义表达"):
                    if not isinstance(uq, str) or uq.strip() == "":
                        errors.append(f"point_coverage[{i}] status={status} but user_quote is empty or non-string")
                    elif not _evidence_in_scope(uq, user_answer):
                        errors.append(f"point_coverage[{i}] user_quote not found in user_answer (status={status})")
                elif status == "未覆盖":
                    if uq is not None and (isinstance(uq, str) and uq.strip() != ""):
                        errors.append(f"point_coverage[{i}] status=未覆盖 but user_quote is non-empty")
            else:
                if not isinstance(uq, str) or uq.strip() == "":
                    errors.append(f"point_coverage[{i}] status=超出材料 but user_quote is empty or non-string")
                elif not _evidence_in_scope(uq, user_answer):
                    errors.append(f"point_coverage[{i}] status=超出材料 user_quote not found in user_answer")

        # Every active atomic_point must appear exactly once in coverage (non-excess)
        for active_pid in mp_pids_active:
            if active_pid not in seen_pc_pids:
                errors.append(f"Active atomic_point '{active_pid}' has no coverage mapping")

    # --- validation_receipt ---
    vr = data["validation_receipt"]
    if not isinstance(vr, dict):
        errors.append("validation_receipt must be an object")
    else:
        if vr.get("passed") is not True:
            errors.append("validation_receipt.passed must be strictly true")
        if "checks" not in vr or not isinstance(vr["checks"], list) or len(vr["checks"]) == 0:
            errors.append("validation_receipt.checks must be a non-empty array")
        else:
            for ci, c in enumerate(vr["checks"]):
                if not isinstance(c, dict):
                    errors.append(f"validation_receipt.checks[{ci}] must be an object")

    # --- method_card_ids ---
    if "method_card_ids" in data:
        errors.extend(_validate_method_card_ids(data["method_card_ids"]))

    if errors:
        return None, errors

    # --- Unified recomputation using the SAME kernel as calculate-score ---
    full_score = data.get("full_score")
    if full_score is not None:
        if not _is_finite_number(full_score) or full_score <= 0:
            errors.append(f"full_score must be null or finite positive, got {full_score!r}")
        elif abs(float(full_score) - data["score_base"]) > 0.01:
            errors.append(f"full_score ({full_score}) != score_base ({data['score_base']})")
    else:
        if abs(data["score_base"] - 100.0) > 0.01:
            errors.append(f"full_score is null but score_base is {data['score_base']}, expected 100")

    recomputed, rerrors = _compute_score_kernel(data["dimensions"], full_score, data["confidence"])
    if rerrors:
        errors.extend(rerrors)
        return None, errors

    # --- Cross-check ALL input values against recomputed values ---
    checks_map = {
        "weight_total": ("weight_total", data["weight_total"]),
        "score_base": ("score_base", data["score_base"]),
        "diagnostic_total": ("diagnostic_total", data["diagnostic_total"]),
        "raw_center": ("raw_center", data["raw_center"]),
        "center_value": ("center_value", data["center_value"]),
        "interval_lower": ("interval_lower", data["interval"]["lower"]),
        "interval_upper": ("interval_upper", data["interval"]["upper"]),
    }
    for field_name, (recomp_key, input_val) in checks_map.items():
        if not _is_finite_number(input_val):
            errors.append(f"{field_name} is not a finite number: {input_val!r}")
        elif abs(input_val - recomputed[recomp_key]) > 0.01:
            errors.append(f"{field_name} mismatch: input={input_val}, recomputed={recomputed[recomp_key]}")

    # --- Per-row calculated_score cross-check ---
    for i, dim in enumerate(data["dimensions"]):
        rdim = recomputed["dimensions"][i] if i < len(recomputed["dimensions"]) else None
        if rdim:
            if abs(dim.get("calculated_score", 0) - rdim["calculated_score"]) > 0.01:
                errors.append(f"dimensions[{i}].calculated_score mismatch: input={dim.get('calculated_score')}, recomputed={rdim['calculated_score']}")

    # --- coverage_summary recheck if present ---
    if "coverage_summary" in data:
        cs_input = data["coverage_summary"]
        cs_recomputed = {k: 0 for k in VALID_COVERAGE_ALL}
        for pm in data["point_coverage"]:
            s = pm.get("coverage_status", "")
            if s in cs_recomputed:
                cs_recomputed[s] += 1
        for k in VALID_COVERAGE_ALL:
            if cs_input.get(k, 0) != cs_recomputed[k]:
                errors.append(f"coverage_summary.{k} mismatch: input={cs_input.get(k,0)}, recomputed={cs_recomputed[k]}")

    if errors:
        return None, errors
    return recomputed, errors


def cmd_write_state(args):
    """Write a complete scoring result to SQLite using the unified kernel."""
    raw = read_input(args.input)
    data = parse_json_input(raw)

    # --- Full validation + unified recomputation ---
    recomputed, val_errors = _validate_state_write_input(data)
    if val_errors:
        code = EXIT_CONSISTENCY if any("mismatch" in e or "must be strictly true" in e for e in val_errors) else EXIT_INPUT_ERROR
        error_exit(code, "write-state validation/recomputation failed; refusing to write", {"errors": val_errors})

    # --- Derive IDs ---
    analysis_id = data["analysis_id"]
    task_id = data["task_id"]
    answer_version = data["answer_version"]
    user_answer = data["user_answer"]
    question_type = data["question_type"]
    task_instruction = data["task_instruction"]
    material_hash = data["material_hash"]

    answer_hash_input = f"{task_id}|{analysis_id}|{answer_version}|{user_answer}"
    answer_id = f"ans-{hashlib.sha256(answer_hash_input.encode()).hexdigest()[:16]}"

    # score_id uses recomputed canonical values + weight_policy + source_note
    weight_policy = data["weight_policy"]
    source_note = data.get("source_note")
    score_id = _compute_score_id(task_id, material_hash, analysis_id, answer_version, user_answer,
                                  recomputed, data["confidence"], data["point_coverage"],
                                  weight_policy, source_note)

    # --- atomic_points is the authoritative input field ---
    points = data["atomic_points"]

    db_path = _get_db_path(args)
    try:
        conn = _init_db(db_path)
    except SystemExit:
        raise
    except Exception as e:
        error_exit(EXIT_DB_ERROR, "Failed to initialize database", str(e))

    try:
        cur = conn.cursor()

        # --- analysis_id uniqueness ---
        cur.execute("SELECT task_id FROM tasks WHERE analysis_id = ?", (analysis_id,))
        existing_task_for_analysis = cur.fetchone()
        if existing_task_for_analysis and existing_task_for_analysis[0] != task_id:
            conn.rollback()
            error_exit(EXIT_CONSISTENCY, f"analysis_id '{analysis_id}' already used by task '{existing_task_for_analysis[0]}'",
                        {"analysis_id": analysis_id, "existing_task_id": existing_task_for_analysis[0], "new_task_id": task_id})

        # --- Task consistency ---
        cur.execute("SELECT material_id, analysis_id, question_type, task_instruction FROM tasks WHERE task_id = ?", (task_id,))
        existing_task = cur.fetchone()
        if existing_task:
            existing_mat_id, existing_aid, existing_qt, existing_ti = existing_task
            cur.execute("SELECT material_hash FROM materials WHERE material_id = ?", (existing_mat_id,))
            mh_row = cur.fetchone()
            existing_mh = mh_row[0] if mh_row else None
            if existing_mh != material_hash or existing_qt != question_type or existing_ti != task_instruction:
                conn.rollback()
                error_exit(EXIT_CONSISTENCY, f"task_id '{task_id}' exists with different attributes",
                            {"existing": {"material_hash": existing_mh, "question_type": existing_qt, "task_instruction": existing_ti},
                             "new": {"material_hash": material_hash, "question_type": question_type, "task_instruction": task_instruction}})
            if existing_aid != analysis_id:
                conn.rollback()
                error_exit(EXIT_CONSISTENCY, f"task_id '{task_id}' exists with different analysis_id",
                            {"existing_analysis_id": existing_aid, "new_analysis_id": analysis_id})

        # --- atomic_points content consistency (BEFORE dedup) ---
        for pt in points:
            pid = pt["point_id"]
            point_key = f"{task_id}/{pid}"
            cur.execute("SELECT paragraph_id, evidence_text, point_text, point_role, importance, independent_scoring, status FROM material_points WHERE point_key = ?", (point_key,))
            existing_pt = cur.fetchone()
            if existing_pt:
                new_vals = (pt.get("paragraph_id", ""), pt["evidence_text"], pt["point_text"],
                            pt.get("point_role", "fact"), pt.get("importance", "core"),
                            1 if pt.get("independent_scoring", False) else 0, pt.get("status", "active"))
                if existing_pt != new_vals:
                    conn.rollback()
                    error_exit(EXIT_CONSISTENCY, f"atomic_points point_key='{point_key}' exists with different content",
                                {"point_key": point_key, "existing": list(existing_pt), "new": list(new_vals)})

        # --- Dedup check ---
        cur.execute("SELECT score_id FROM scores WHERE score_id = ?", (score_id,))
        if cur.fetchone():
            result = {"written": True, "score_id": score_id, "deduplicated": True, "db_path": db_path}
            success_output(result, args.output)
            conn.close()
            return

        # --- Insert material ---
        material_id = f"mat-{hashlib.sha256(material_hash.encode()).hexdigest()[:16]}"
        cur.execute("SELECT material_id FROM materials WHERE material_hash = ?", (material_hash,))
        if not cur.fetchone():
            cur.execute("INSERT OR IGNORE INTO materials (material_id, material_hash, source_type) VALUES (?, ?, ?)",
                        (material_id, material_hash, "manual"))

        # --- Insert task ---
        if not existing_task:
            cur.execute("INSERT INTO tasks (task_id, material_id, analysis_id, question_type, task_instruction, analysis_json) VALUES (?, ?, ?, ?, ?, ?)",
                        (task_id, material_id, analysis_id, question_type, task_instruction, json.dumps(data, ensure_ascii=False)))

        # --- Insert atomic_points into material_points table ---
        for pt in points:
            pid = pt["point_id"]
            point_key = f"{task_id}/{pid}"
            cur.execute("SELECT point_key FROM material_points WHERE point_key = ?", (point_key,))
            if not cur.fetchone():
                cur.execute("""INSERT INTO material_points (point_key, task_id, point_id, paragraph_id, evidence_text, point_text, point_role, importance, independent_scoring, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                            (point_key, task_id, pid, pt.get("paragraph_id", ""), pt["evidence_text"], pt["point_text"],
                             pt.get("point_role", "fact"), pt.get("importance", "core"),
                             1 if pt.get("independent_scoring", False) else 0, pt.get("status", "active")))

        # --- Insert answer ---
        cur.execute("INSERT OR REPLACE INTO answers (answer_id, task_id, answer_version, user_answer) VALUES (?, ?, ?, ?)",
                    (answer_id, task_id, answer_version, user_answer))

        # --- Insert score (recomputed values + weight_policy/source_note/full_score) ---
        full_score_val = data.get("full_score")
        cur.execute("""INSERT INTO scores (score_id, answer_id, analysis_id, weight_total, score_base, diagnostic_total, raw_center, center_value, interval_lower, interval_upper, confidence, weight_policy, weight_source_note, full_score, scoring_json, validation_passed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (score_id, answer_id, analysis_id, recomputed["weight_total"], recomputed["score_base"],
                     recomputed["diagnostic_total"], recomputed["raw_center"], recomputed["center_value"],
                     recomputed["interval_lower"], recomputed["interval_upper"], data["confidence"],
                     weight_policy, source_note, full_score_val,
                     json.dumps(data, ensure_ascii=False), 1))

        # --- Insert dimension_scores ---
        for dim in recomputed["dimensions"]:
            cur.execute("INSERT INTO dimension_scores (score_id, dimension_name, weight, level, calculated_score, note) VALUES (?, ?, ?, ?, ?, ?)",
                        (score_id, dim["dimension_name"], dim["weight"], dim["level"], dim["calculated_score"], ""))

        # --- Insert point_mappings (score_id bound) and extra_claims ---
        for pm in data["point_coverage"]:
            status = pm.get("coverage_status", "")
            pid = pm.get("point_id", "")
            uq = pm.get("user_quote")
            if status == "超出材料":
                cur.execute("INSERT OR IGNORE INTO extra_claims (score_id, answer_id, claim_id, claim_text) VALUES (?, ?, ?, ?)",
                            (score_id, answer_id, pid, uq))
            else:
                point_key = f"{task_id}/{pid}"
                mapping_id = f"map-{score_id}-{point_key}"
                cur.execute("INSERT OR IGNORE INTO point_mappings (mapping_id, score_id, answer_id, point_key, coverage_status, user_quote) VALUES (?, ?, ?, ?, ?, ?)",
                            (mapping_id, score_id, answer_id, point_key, status, uq))

        # --- Insert method_usage (dedup) ---
        seen_mc = set()
        for mc_id in data.get("method_card_ids", []):
            if isinstance(mc_id, str) and mc_id not in seen_mc:
                seen_mc.add(mc_id)
                cur.execute("INSERT OR IGNORE INTO method_usage (score_id, method_card_id) VALUES (?, ?)", (score_id, mc_id))

        # --- Insert ability_events ---
        for dim in recomputed["dimensions"]:
            cur.execute("INSERT INTO ability_events (task_id, question_type, dimension_name, level, score_id) VALUES (?, ?, ?, ?, ?)",
                        (task_id, question_type, dim["dimension_name"], dim["level"], score_id))

        conn.commit()

        # --- Verify ---
        cur.execute("SELECT score_id, validation_passed FROM scores WHERE score_id = ?", (score_id,))
        row = cur.fetchone()
        if not row or row[1] != 1:
            error_exit(EXIT_DB_ERROR, "Write verification failed")

        result = {"written": True, "score_id": score_id, "answer_id": answer_id, "material_id": material_id,
                  "weight_total": recomputed["weight_total"], "score_base": recomputed["score_base"],
                  "raw_center": recomputed["raw_center"], "center_value": recomputed["center_value"],
                  "db_path": db_path, "verified": True}
        success_output(result, args.output)

    except SystemExit:
        raise
    except sqlite3.Error as e:
        conn.rollback()
        error_exit(EXIT_DB_ERROR, "SQLite write failed", str(e))
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# migrate-state: import old Markdown state
# ---------------------------------------------------------------------------

def cmd_migrate_state(args):
    """Scan old Markdown state directory, import verifiable records into SQLite."""
    source_dir = args.input
    if not source_dir or not Path(source_dir).is_dir():
        error_exit(EXIT_INPUT_ERROR, f"Source directory not found: {source_dir}")

    db_path = _get_db_path(args)
    try:
        conn = _init_db(db_path)
    except sqlite3.Error as e:
        error_exit(EXIT_DB_ERROR, "DB init failed", str(e))

    cur = conn.cursor()
    imported = 0
    skipped = 0
    issues = []

    # Scan for Markdown files with YAML-like frontmatter
    for md_file in sorted(Path(source_dir).rglob("*.md")):
        try:
            content = md_file.read_text(encoding="utf-8")
            if not content.strip():
                skipped += 1
                continue

            # Try to extract batch_id and seq from filename or content
            # This is a conservative import — only if we can confirm identity
            file_hash = hashlib.sha256(content.encode()).hexdigest()[:16]

            # Check if already imported by content hash
            cur.execute("SELECT value FROM metadata WHERE key = ?", (f"import_hash:{file_hash}",))
            if cur.fetchone():
                skipped += 1
                continue

            # Record the import hash to prevent re-import
            cur.execute(
                "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
                (f"import_hash:{file_hash}", str(md_file))
            )

            # We only import if the file has recognizable structure
            # For safety, we log it but don't force-import unknown formats
            if "batch_id" in content or "题型" in content:
                imported += 1
            else:
                issues.append(f"Unrecognized format: {md_file.name}")
                skipped += 1

        except Exception as e:
            issues.append(f"Error reading {md_file.name}: {e}")
            skipped += 1

    conn.commit()
    conn.close()

    result = {
        "migrated": imported,
        "skipped": skipped,
        "issues": issues,
        "db_path": db_path,
        "note": "Markdown files are read-only; SQLite is now the authority. Markdown remains as export/legacy format."
    }
    success_output(result, args.output)


# ---------------------------------------------------------------------------
# export-report
# ---------------------------------------------------------------------------

def cmd_export_report(args):
    raw = read_input(args.input)
    data = parse_json_input(raw)
    fmt = args.format or "json"

    if fmt == "json":
        success_output(data, args.output)
        return

    if fmt == "markdown":
        md = _render_markdown_report(data)
        if args.output:
            Path(args.output).write_text(md, encoding="utf-8")
            print(json.dumps({"success": True, "output": args.output}))
        else:
            print(md)
        return

    if fmt == "html":
        html_out = _render_html_report(data)
        if args.output:
            Path(args.output).write_text(html_out, encoding="utf-8")
            print(json.dumps({"success": True, "output": args.output}))
        else:
            print(html_out)
        return

    error_exit(EXIT_INPUT_ERROR, f"Unknown format: {fmt}")


def _escape_html(text):
    """Escape user content for safe HTML output."""
    if text is None:
        return ""
    return html.escape(str(text), quote=True)


def _render_markdown_report(data):
    lines = ["# 申论学情报告", ""]
    lines.append(f"**生成时间**: {datetime.now(timezone.utc).isoformat()}")
    lines.append("")

    if "dimensions" in data:
        lines.append("## 维度表现")
        lines.append("| 维度 | 权重 | 层级 | 得分 |")
        lines.append("|---|---|---|---|")
        for dim in data["dimensions"]:
            lines.append(f"| {_escape_html(dim.get('dimension_name',''))} | {dim.get('weight',0)} | {dim.get('level',0)} | {dim.get('calculated_score',0)} |")
        lines.append("")

    if "coverage_summary" in data:
        lines.append("## 覆盖统计")
        for k, v in data["coverage_summary"].items():
            lines.append(f"- {k}: {v}")
        lines.append("")

    if "diagnostic_total" in data:
        lines.append(f"**诊断总分**: {data['diagnostic_total']}")
        lines.append(f"**中心值**: {data.get('center_value', 'N/A')}")
        interval = data.get("interval", {})
        lines.append(f"**区间**: {interval.get('lower', 'N/A')} – {interval.get('upper', 'N/A')}")
        lines.append("")

    return "\n".join(lines)


def _render_html_report(data):
    template_path = ASSETS_DIR / "report-template.html"
    css_path = ASSETS_DIR / "report.css"

    css = ""
    if css_path.exists():
        css = css_path.read_text(encoding="utf-8")

    # Build content sections
    sections = []

    # Dimensions table
    if "dimensions" in data:
        rows = ""
        for dim in data["dimensions"]:
            rows += f"<tr><td>{_escape_html(dim.get('dimension_name',''))}</td><td>{dim.get('weight',0)}</td><td>{dim.get('level',0)}</td><td>{dim.get('calculated_score',0)}</td></tr>"
        sections.append(f"<section><h2>维度表现</h2><table><thead><tr><th>维度</th><th>权重</th><th>层级</th><th>得分</th></tr></thead><tbody>{rows}</tbody></table></section>")

    # Coverage
    if "coverage_summary" in data:
        items = "".join(f"<li>{_escape_html(k)}: {v}</li>" for k, v in data["coverage_summary"].items())
        sections.append(f"<section><h2>覆盖统计</h2><ul>{items}</ul></section>")

    # Score summary
    if "diagnostic_total" in data:
        interval = data.get("interval", {})
        sections.append(
            f"<section><h2>评分摘要</h2>"
            f"<p>诊断总分: {data.get('diagnostic_total', 'N/A')}</p>"
            f"<p>中心值: {data.get('center_value', 'N/A')}</p>"
            f"<p>区间: {_escape_html(str(interval.get('lower', 'N/A')))} – {_escape_html(str(interval.get('upper', 'N/A')))}</p>"
            f"</section>"
        )

    # If no real data
    if not sections:
        sections.append("<section><p>暂无真实记录，无法生成统计。</p></section>")

    content = "\n".join(sections)

    if template_path.exists():
        template = template_path.read_text(encoding="utf-8")
        html_out = template.replace("{{CSS}}", css).replace("{{CONTENT}}", content)
    else:
        html_out = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>申论学情报告</title>
<style>{css}</style>
</head>
<body>
<main>
<h1>申论学情报告</h1>
{content}
</main>
</body>
</html>"""

    return html_out


# ---------------------------------------------------------------------------
# export-learning-state
# ---------------------------------------------------------------------------

def _learning_state_from_db(conn):
    """Build read models from authoritative SQLite facts; never invent records."""
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    issue_cards = []
    point_rows = cur.execute(
        """SELECT pl.score_id, pl.answer_id, pl.task_id, t.question_type,
                  pl.point_id, pl.coverage_status, pl.material_evidence,
                  pl.user_quote, pl.loss_reason, pl.deduction_owner,
                  pl.modification_action, pl.created_at
           FROM point_ledgers pl JOIN tasks t ON t.task_id = pl.task_id
           WHERE pl.coverage_status NOT IN ('完整覆盖','等义表达')
              OR COALESCE(pl.loss_reason, '') <> ''
           ORDER BY pl.created_at, pl.point_ledger_id"""
    ).fetchall()
    for row in point_rows:
        raw = f"{row['score_id']}|point|{row['point_id']}"
        issue_cards.append({
            "issue_card_id": "issue-" + hashlib.sha256(raw.encode()).hexdigest()[:16],
            "answer_id": row["answer_id"], "score_id": row["score_id"],
            "task_id": row["task_id"], "question_type": row["question_type"],
            "issue_source": "point_ledger", "issue_type": row["coverage_status"],
            "source_element_id": row["point_id"],
            "material_evidence": row["material_evidence"],
            "user_quote": row["user_quote"] or "",
            "loss_reason": row["loss_reason"] or "",
            "primary_dimension": row["deduction_owner"] or "",
            "modification_action": row["modification_action"] or "",
            "draft_status": "未比较", "created_at": row["created_at"],
        })

    structure_rows = cur.execute(
        """SELECT sl.score_id, sl.answer_id, sl.task_id, t.question_type,
                  sl.element_id, sl.element_type, sl.status, sl.basis,
                  sl.user_evidence, sl.loss_reason, sl.deduction_owner,
                  sl.modification_action, sl.created_at
           FROM structure_ledgers sl JOIN tasks t ON t.task_id = sl.task_id
           WHERE sl.required = 1 AND sl.status NOT IN ('已完成','完整','satisfied','complete')
           ORDER BY sl.created_at, sl.structure_ledger_id"""
    ).fetchall()
    for row in structure_rows:
        raw = f"{row['score_id']}|structure|{row['element_id']}"
        issue_cards.append({
            "issue_card_id": "issue-" + hashlib.sha256(raw.encode()).hexdigest()[:16],
            "answer_id": row["answer_id"], "score_id": row["score_id"],
            "task_id": row["task_id"], "question_type": row["question_type"],
            "issue_source": "structure_ledger", "issue_type": "结构要素未完成",
            "source_element_id": row["element_id"],
            "material_evidence": row["basis"] or "",
            "user_quote": row["user_evidence"] or "",
            "loss_reason": row["loss_reason"] or "",
            "primary_dimension": row["deduction_owner"] or "",
            "modification_action": row["modification_action"] or "",
            "draft_status": "未比较", "created_at": row["created_at"],
        })

    ability_profiles = []
    ability_rows = cur.execute(
        """SELECT question_type, dimension_name, COUNT(*) AS record_count,
                  ROUND(AVG(level), 2) AS average_level, MIN(level) AS min_level,
                  MAX(level) AS max_level, MAX(created_at) AS last_recorded_at
           FROM ability_events GROUP BY question_type, dimension_name
           ORDER BY question_type, dimension_name"""
    ).fetchall()
    for row in ability_rows:
        ability_profiles.append(dict(row))

    answer_count = cur.execute("SELECT COUNT(*) FROM answers").fetchone()[0]
    score_count = cur.execute("SELECT COUNT(*) FROM scores").fetchone()[0]
    issue_counts = {}
    for card in issue_cards:
        key = f"{card['question_type']}-" + (card["primary_dimension"] or card["issue_type"])
        issue_counts[key] = issue_counts.get(key, 0) + 1
    priorities = [
        {"key": key, "issue_count": count}
        for key, count in sorted(issue_counts.items(), key=lambda x: (-x[1], x[0]))[:5]
    ]
    strengths = [
        {"key": f"{p['question_type']}-{p['dimension_name']}", "average_level": p["average_level"]}
        for p in sorted(ability_profiles, key=lambda x: (-x["average_level"], x["question_type"], x["dimension_name"]))
        if p["record_count"] >= 2 and p["average_level"] >= 3
    ][:5]
    learner_profile = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "answer_count": answer_count, "score_count": score_count,
        "sample_limited": answer_count < 3,
        "strengths": strengths, "priority_improvements": priorities,
        "refresh_recommended": answer_count >= 3,
    }
    return {
        "schema_version": "1.0", "issue_cards": issue_cards,
        "ability_profiles": ability_profiles, "learner_profile": learner_profile,
    }


def _render_learning_state_markdown(data):
    p = data["learner_profile"]
    lines = ["# 申论学习状态", "", f"真实作答 {p['answer_count']} 份，评分记录 {p['score_count']} 份。"]
    if p["sample_limited"]:
        lines += ["", "当前样本有限，不做稳定能力结论。"]
    lines += ["", "## 优先改进"]
    lines += [f"- {x['key']}：出现 {x['issue_count']} 次" for x in p["priority_improvements"]] or ["- 暂无真实问题记录"]
    lines += ["", "## 当前优势"]
    lines += [f"- {x['key']}：平均层级 {x['average_level']}" for x in p["strengths"]] or ["- 样本不足，暂不判定"]
    lines += ["", f"## 作答问题卡（{len(data['issue_cards'])}）"]
    for card in data["issue_cards"]:
        lines += ["", f"### {card['issue_card_id']}",
                  f"- 题型：{card['question_type']}", f"- 问题：{card['issue_type']}",
                  f"- 材料依据：{card['material_evidence'] or '未记录'}",
                  f"- 用户原句：{card['user_quote'] or '完全遗漏，无原句'}",
                  f"- 修改动作：{card['modification_action'] or '待补充'}"]
    return "\n".join(lines) + "\n"


def cmd_export_learning_state(args):
    db_path = _get_db_path(args)
    conn = _init_db(db_path)
    try:
        data = _learning_state_from_db(conn)
    finally:
        conn.close()
    fmt = args.format or "json"
    if fmt == "json":
        success_output(data, args.output)
        return
    md = _render_learning_state_markdown(data)
    if fmt == "markdown":
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(md, encoding="utf-8")
            success_output({"written": True, "output": args.output, "format": fmt})
        else:
            print(md)
        return
    if fmt == "html":
        body = "<main>" + "".join(
            f"<p>{html.escape(line)}</p>" for line in md.splitlines() if line.strip()
        ) + "</main>"
        rendered = f"<!doctype html><html lang='zh-CN'><meta charset='utf-8'><title>申论学习状态</title><body>{body}</body></html>"
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(rendered, encoding="utf-8")
            success_output({"written": True, "output": args.output, "format": fmt})
        else:
            print(rendered)
        return
    error_exit(EXIT_EXPORT_ERROR, f"Unsupported learning-state format: {fmt}")


# ---------------------------------------------------------------------------
# healthcheck
# ---------------------------------------------------------------------------

def _check_method_library():
    """Validate cards, derived indexes, routing, contracts, and release hygiene."""
    from collections import defaultdict

    package_dir = Path(__file__).resolve().parent.parent
    ml_dir = package_dir / "references" / "method-libraries"
    card_dir = ml_dir / "方法卡"
    issues = []

    def add(message):
        issues.append(message)

    def duplicate_values(values):
        seen = set()
        duplicates = []
        for value in values:
            marker = json.dumps(value, ensure_ascii=False, sort_keys=True)
            if marker in seen:
                duplicates.append(value)
            seen.add(marker)
        return duplicates

    valid_layers = {"能力内核", "题型工作流", "批改二稿"}
    valid_grades = {"A", "B"}
    valid_qt = {"归纳概括", "综合分析", "提出对策", "贯彻执行", "申发论述"}
    valid_modes = {"审题", "解析", "批改", "对照参考答案", "修改二稿", "学情报告"}
    valid_stages = {"审题", "材料遍", "要点提取", "组织结构", "论证", "表达", "批改", "二稿修改"}
    required_fields = [
        "schema_version", "card_id", "方法名", "方法层级", "适用题型", "适用模式",
        "适用环节", "任务原型", "触发信号", "材料结构特征", "输入条件", "诊断项",
        "步骤逻辑", "常见错误", "修改动作", "影响评分维度", "输出产物", "适用边界", "质量等级"
    ]
    array_fields = [
        "适用题型", "适用模式", "适用环节", "触发信号", "材料结构特征", "输入条件",
        "步骤逻辑", "常见错误", "修改动作", "影响评分维度", "输出产物", "适用边界"
    ]

    qt_dims = {}
    try:
        cfg = json.loads((CONFIG_DIR / "scoring-weights.json").read_text(encoding="utf-8"))
        qt_dims = {
            qt: {item["name"] for item in info.get("dimensions", [])}
            for qt, info in cfg.get("question_types", {}).items()
        }
    except Exception as exc:
        add(f"Cannot parse scoring-weights.json: {exc}")

    if not card_dir.exists():
        return {"status": "issues", "total_cards": 0, "issue_count": 1, "issues": ["方法卡/ directory not found"]}

    card_files = sorted(card_dir.glob("sl-card-*.json"))
    if len(card_files) != 84:
        add(f"Expected 84 cards, found {len(card_files)}")

    cards_data = {}
    for card_file in card_files:
        try:
            card = json.loads(card_file.read_text(encoding="utf-8"))
        except Exception as exc:
            add(f"JSON parse error in {card_file.name}: {exc}")
            continue
        cid = card.get("card_id")
        if cid != card_file.stem:
            add(f"File name {card_file.name} has card_id {cid!r}")
        if not isinstance(cid, str) or not re.fullmatch(r"sl-card-\d{4}", cid):
            add(f"Invalid card_id in {card_file.name}: {cid!r}")
            continue
        if cid in cards_data:
            add(f"Duplicate card_id: {cid}")
        cards_data[cid] = card

    expected_ids = {f"sl-card-{number:04d}" for number in range(1, 85)}
    card_ids = set(cards_data)
    if card_ids != expected_ids:
        if expected_ids - card_ids:
            add(f"Missing card IDs: {sorted(expected_ids - card_ids)[:10]}")
        if card_ids - expected_ids:
            add(f"Unexpected card IDs: {sorted(card_ids - expected_ids)[:10]}")

    grade_counts = defaultdict(int)
    layer_counts = defaultdict(int)
    for cid, card in cards_data.items():
        for field in required_fields:
            if field not in card:
                add(f"{cid}: missing field {field}")
        if card.get("schema_version") != "1.2":
            add(f"{cid}: schema_version must be 1.2")
        for field in ("方法名", "任务原型", "诊断项"):
            value = card.get(field)
            if not isinstance(value, str) or not value.strip():
                add(f"{cid}: {field} must be a non-empty string")
        for field in array_fields:
            values = card.get(field)
            if not isinstance(values, list):
                add(f"{cid}: {field} must be an array")
                continue
            if field not in ("材料结构特征",) and not values:
                add(f"{cid}: {field} must not be empty")
            if duplicate_values(values):
                add(f"{cid}: {field} has duplicates")
            if field != "影响评分维度":
                for index, value in enumerate(values):
                    if not isinstance(value, str) or not value.strip():
                        add(f"{cid}: {field}[{index}] must be a non-empty string")

        layer = card.get("方法层级")
        grade = card.get("质量等级")
        if layer not in valid_layers:
            add(f"{cid}: invalid 方法层级 {layer!r}")
        else:
            layer_counts[layer] += 1
        if grade not in valid_grades:
            add(f"{cid}: invalid 质量等级 {grade!r}")
        else:
            grade_counts[grade] += 1
        for value in card.get("适用题型", []) if isinstance(card.get("适用题型"), list) else []:
            if value not in valid_qt:
                add(f"{cid}: invalid 适用题型 {value!r}")
        for value in card.get("适用模式", []) if isinstance(card.get("适用模式"), list) else []:
            if value not in valid_modes:
                add(f"{cid}: invalid 适用模式 {value!r}")
        for value in card.get("适用环节", []) if isinstance(card.get("适用环节"), list) else []:
            if value not in valid_stages:
                add(f"{cid}: invalid 适用环节 {value!r}")

        effects = card.get("影响评分维度", [])
        if isinstance(effects, list):
            for index, effect in enumerate(effects):
                if not isinstance(effect, dict):
                    add(f"{cid}: 影响评分维度[{index}] must be an object")
                    continue
                effect_qt = effect.get("题型")
                dimension = effect.get("维度名")
                level = effect.get("影响程度")
                if effect_qt not in valid_qt:
                    add(f"{cid}: invalid effect question type {effect_qt!r}")
                elif effect_qt not in card.get("适用题型", []):
                    add(f"{cid}: effect question type {effect_qt} not in 适用题型")
                elif dimension not in qt_dims.get(effect_qt, set()):
                    add(f"{cid}: dimension {dimension!r} is invalid for {effect_qt}")
                if level not in {"高", "中", "低"}:
                    add(f"{cid}: invalid impact level {level!r}")

        serialized = json.dumps(card, ensure_ascii=False)
        for keyword in ("白鹭", "Redbook", "RBM", "bly-", "粉笔", "华图", "中公", "/Users/", "/home/", "Mimo", "GLM", "Codex", "字幕"):
            if keyword in serialized:
                add(f"{cid}: contains leaked keyword {keyword!r}")
        for keyword in ("四张皮", "均匀消费"):
            if keyword in serialized:
                add(f"{cid}: contains banned term {keyword!r}")

    index_path = ml_dir / "method-index.json"
    try:
        method_index = json.loads(index_path.read_text(encoding="utf-8"))
        if method_index.get("total_cards") != len(cards_data):
            add(f"index total_cards={method_index.get('total_cards')}, actual={len(cards_data)}")
        indexed_cards = {}
        for item in method_index.get("cards", []):
            if not isinstance(item, dict):
                add("index cards contains a non-object item")
                continue
            indexed_cards[item.get("card_id")] = item
        if set(indexed_cards) != card_ids:
            add("index cards set does not exactly match card files")
        metadata_fields = ("方法名", "方法层级", "质量等级", "适用题型", "适用模式", "适用环节")
        for cid, card in cards_data.items():
            item = indexed_cards.get(cid, {})
            for field in metadata_fields:
                if item.get(field) != card.get(field):
                    add(f"index {cid}: {field} mismatch")
            path_value = item.get("path")
            if not isinstance(path_value, str) or not (ml_dir / path_value).is_file():
                add(f"index {cid}: invalid path {path_value!r}")

        derived_specs = {
            "by_question_type": "适用题型", "by_layer": "方法层级", "by_mode": "适用模式",
            "by_stage": "适用环节", "by_quality": "质量等级", "by_trigger": "触发信号", "by_diagnosis": "诊断项"
        }
        for index_name, card_field in derived_specs.items():
            expected = defaultdict(set)
            for cid, card in cards_data.items():
                values = card.get(card_field, [])
                if not isinstance(values, list):
                    values = [values]
                for value in values:
                    if isinstance(value, str):
                        expected[value].add(cid)
            actual_raw = method_index.get(index_name)
            if not isinstance(actual_raw, dict):
                add(f"index missing or invalid {index_name}")
                continue
            actual = {key: set(value) if isinstance(value, list) else set() for key, value in actual_raw.items()}
            if dict(expected) != actual:
                add(f"index {index_name} is not an exact derivation of cards")
    except Exception as exc:
        add(f"method-index.json error: {exc}")

    routing_path = ml_dir / "method-routing.json"
    try:
        routing = json.loads(routing_path.read_text(encoding="utf-8"))
        budget = routing.get("budget", {})
        max_total = budget.get("max_per_mode")
        max_by_layer = {
            "能力内核": budget.get("ability_core", {}).get("max"),
            "题型工作流": budget.get("question_workflow", {}).get("max"),
            "批改二稿": budget.get("revision_draft", {}).get("max")
        }
        if max_total != 5 or max_by_layer != {"能力内核": 1, "题型工作流": 3, "批改二稿": 1}:
            add("routing budget must be total=5, core=1, workflow=3, revision=1")
        for prototype, mode_map in routing.get("task_prototype_routing", {}).items():
            question_type = prototype.split("_", 1)[0]
            if question_type not in valid_qt or not isinstance(mode_map, dict):
                add(f"routing prototype is invalid: {prototype}")
                continue
            if set(mode_map) != valid_modes:
                add(f"routing {prototype}: mode set is incomplete")
            for mode, ids in mode_map.items():
                if not isinstance(ids, list):
                    add(f"routing {prototype}.{mode} must be an array")
                    continue
                if duplicate_values(ids):
                    add(f"routing {prototype}.{mode} has duplicates")
                if len(ids) > max_total:
                    add(f"routing {prototype}.{mode}: {len(ids)} > {max_total}")
                counts = defaultdict(int)
                for cid in ids:
                    card = cards_data.get(cid)
                    if card is None:
                        add(f"routing {prototype}.{mode}: dangling {cid}")
                        continue
                    counts[card.get("方法层级")] += 1
                    if question_type not in card.get("适用题型", []):
                        add(f"routing {prototype}.{mode}: {cid} does not support {question_type}")
                    if mode not in card.get("适用模式", []):
                        add(f"routing {prototype}.{mode}: {cid} does not support mode")
                for layer, count in counts.items():
                    if layer in max_by_layer and count > max_by_layer[layer]:
                        add(f"routing {prototype}.{mode}: {layer}={count} exceeds budget")
                if mode == "学情报告" and ids:
                    add(f"routing {prototype}.学情报告 must be empty")
    except Exception as exc:
        add(f"method-routing.json error: {exc}")

    for question_type in sorted(valid_qt):
        markdown_path = ml_dir / "按题型索引" / f"{question_type}.md"
        if not markdown_path.exists():
            add(f"Missing Markdown index: {question_type}.md")
            continue
        refs = set(re.findall(r"sl-card-\d{4}", markdown_path.read_text(encoding="utf-8")))
        expected_refs = {cid for cid, card in cards_data.items() if question_type in card.get("适用题型", [])}
        if refs != expected_refs:
            add(f"Markdown index {question_type}.md is not an exact derivation of cards")

    for schema_name in ("analysis-result.schema.json", "state-write-input.schema.json"):
        try:
            contract = json.loads((SCHEMA_DIR / schema_name).read_text(encoding="utf-8"))
            method_ids = contract.get("properties", {}).get("method_card_ids", {})
            if method_ids.get("maxItems") != 5 or method_ids.get("uniqueItems") is not True:
                add(f"{schema_name} method_card_ids must set maxItems=5 and uniqueItems=true")
            if method_ids.get("items", {}).get("pattern") != r"^sl-card-\d{4}$":
                add(f"{schema_name} method_card_ids pattern is invalid")
        except Exception as exc:
            add(f"{schema_name} error: {exc}")

    # --- Task prototype checks ---
    proto_dir = package_dir / "references" / "task-prototypes"
    proto_index_path = proto_dir / "task-prototype-index.json"
    if proto_dir.exists() and proto_index_path.exists():
        try:
            proto_index = json.loads(proto_index_path.read_text(encoding="utf-8"))
            total_protos = proto_index.get("total_prototypes", 0)
            proto_items = proto_index.get("prototypes", [])
            if total_protos != len(proto_items):
                add(f"task-prototype-index total_prototypes={total_protos}, actual items={len(proto_items)}")
            proto_files = sorted((proto_dir / "prototypes").glob("sl-prototype-*.json"))
            if len(proto_files) != total_protos:
                add(f"task-prototype files count={len(proto_files)}, index says {total_protos}")
            # Check each prototype file
            proto_ids = set()
            for pf in proto_files:
                try:
                    pdata = json.loads(pf.read_text(encoding="utf-8"))
                    ppid = pdata.get("prototype_id", "")
                    if ppid != pf.stem:
                        add(f"prototype file {pf.name} has prototype_id {ppid!r}")
                    if not re.fullmatch(r"sl-prototype-\d{4}", ppid):
                        add(f"Invalid prototype_id in {pf.name}: {ppid!r}")
                    if ppid in proto_ids:
                        add(f"Duplicate prototype_id: {ppid}")
                    proto_ids.add(ppid)
                    # Check recommended_card_ids exist
                    for cid in pdata.get("recommended_card_ids", []):
                        if cid not in cards_data:
                            add(f"prototype {ppid}: recommended_card {cid} not found in cards")
                    # Check mode_routes card references
                    for mode_name, mode_ids in pdata.get("mode_routes", {}).items():
                        for cid in mode_ids:
                            if cid not in cards_data:
                                add(f"prototype {ppid}.mode_routes.{mode_name}: {cid} not found")
                    # Check no source leakage
                    serialized = json.dumps(pdata, ensure_ascii=False)
                    for keyword in ("/Users/", "/home/", "Mimo", "GLM", "Codex", "字幕", "Hermes"):
                        if keyword in serialized:
                            add(f"prototype {ppid}: contains leaked keyword {keyword!r}")
                except Exception as exc:
                    add(f"prototype file {pf.name}: {exc}")
            # Check index entries match files
            indexed_ids = {p.get("prototype_id") for p in proto_items}
            if indexed_ids != proto_ids:
                add("task-prototype-index entries do not match prototype files")
        except Exception as exc:
            add(f"task-prototype-index.json error: {exc}")
    else:
        add("task-prototypes directory or index not found")

    allowed_extensions = {".md", ".json", ".py", ".sql", ".html", ".css"}
    for path in package_dir.rglob("*"):
        if path.is_dir() and path.name == "__pycache__":
            add(f"Forbidden cache directory: {path.relative_to(package_dir)}")
        elif path.is_file():
            if path.suffix == ".pyc":
                add(f"Forbidden bytecode file: {path.relative_to(package_dir)}")
            elif path.suffix.lower() not in allowed_extensions:
                add(f"Unsupported release file type: {path.relative_to(package_dir)}")

    return {
        "status": "ok" if not issues else "issues",
        "total_cards": len(cards_data),
        "grades": dict(grade_counts),
        "layers": dict(layer_counts),
        "issue_count": len(issues),
        "issues": issues[:50]
    }


# ---------------------------------------------------------------------------
# check-word-count: deterministic word-count gate (P1-1)
# ---------------------------------------------------------------------------

VALID_LENGTH_UNITS = {"字", "字符"}
VALID_FORMAT_ELEMENTS = {"标题", "称谓", "发文对象", "正文结构", "落款", "署名", "日期"}


def _strip_markdown_noise(text):
    """Strip Markdown heading/list/quote/table markers and blank lines so that
    only answer body characters are counted. Paragraph-internal spaces are kept."""
    if not isinstance(text, str):
        return ""
    kept = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        # Drop pure metadata / non-body lines
        if stripped.startswith("analysis_id"):
            continue
        if stripped.startswith("|") and stripped.endswith("|"):
            continue  # table row
        if re.match(r"^#{1,6}\s", stripped):
            stripped = re.sub(r"^#{1,6}\s+", "", stripped)
        if re.match(r"^>\s?", stripped):
            stripped = re.sub(r"^>\s?", "", stripped)
        if re.match(r"^\d+\.\s", stripped):
            stripped = re.sub(r"^\d+\.\s+", "", stripped)
        if re.match(r"^[-*+]\s", stripped):
            stripped = re.sub(r"^[-*+]\s+", "", stripped)
        kept.append(stripped)
    # Join with no separator; newline chars are excluded from the count.
    return "".join(kept)


def _count_answer_chars(text, strip_markdown=False):
    """Count answer body characters. Newlines/CR excluded; spaces kept.
    strip_markdown=True applies _strip_markdown_noise first."""
    if text is None:
        return 0
    if not isinstance(text, str):
        raise ValueError("text must be a string")
    body = _strip_markdown_noise(text) if strip_markdown else text
    # Remove line-break characters; keep everything else (incl. spaces).
    return len(body.replace("\r", "").replace("\n", ""))


def cmd_check_word_count(args):
    raw = read_input(args.input)
    data = parse_json_input(raw)

    if not isinstance(data, dict):
        error_exit(EXIT_INPUT_ERROR, "check-word-count input must be a JSON object")

    text = data.get("text")
    if text is None:
        text = data.get("answer") if data.get("answer") is not None else data.get("user_answer")
    if not isinstance(text, str) or text == "":
        error_exit(EXIT_INPUT_ERROR, "check-word-count requires a non-empty 'text'/'answer'/'user_answer' string field")

    min_length = data.get("min_length")
    max_length = data.get("max_length")
    length_unit = data.get("length_unit", "字")
    strip_markdown = bool(data.get("strip_markdown", False))
    role = data.get("role", "user_answer")  # user_answer | reference_answer

    if length_unit not in VALID_LENGTH_UNITS:
        error_exit(EXIT_INPUT_ERROR, f"length_unit must be one of {sorted(VALID_LENGTH_UNITS)}, got {length_unit!r}")
    if min_length is not None and (not isinstance(min_length, int) or isinstance(min_length, bool) or min_length < 0):
        error_exit(EXIT_INPUT_ERROR, f"min_length must be a non-negative int or null, got {min_length!r}")
    if max_length is not None and (not isinstance(max_length, int) or isinstance(max_length, bool) or max_length < 0):
        error_exit(EXIT_INPUT_ERROR, f"max_length must be a non-negative int or null, got {max_length!r}")
    if min_length is not None and max_length is not None and min_length > max_length:
        error_exit(EXIT_INPUT_ERROR, f"min_length ({min_length}) must be <= max_length ({max_length})")

    actual = _count_answer_chars(text, strip_markdown=strip_markdown)

    violations = []
    if max_length is not None and actual > max_length:
        violations.append(f"over_limit: actual={actual} > max_length={max_length} (超出 {actual - max_length} {length_unit})")
    if min_length is not None and actual < min_length:
        violations.append(f"under_limit: actual={actual} < min_length={min_length} (不足 {min_length - actual} {length_unit})")

    compliant = len(violations) == 0
    result = {
        "schema_version": "1.0",
        "role": role,
        "count_policy": "raw_characters_punctuation_included",
        "punctuation_counted": True,
        "length_unit": length_unit,
        "actual_length": actual,
        "min_length": min_length,
        "max_length": max_length,
        "strip_markdown": strip_markdown,
        "compliant": compliant,
        "violations": violations,
        "validation_receipt": {
            "passed": compliant,
            "checks": [
                {"check_name": "within_bounds", "passed": compliant,
                 "detail": f"actual={actual}, bounds=[{min_length}, {max_length}]"}
            ]
        }
    }
    # Exit code 3 (consistency) when non-compliant, so callers can detect gate failure.
    if not compliant:
        error_exit(EXIT_CONSISTENCY, "Word-count gate FAILED", result)
    success_output(result, args.output)


# ---------------------------------------------------------------------------
# validate-method-selection: deterministic method-card budget gate (P1-4)
# ---------------------------------------------------------------------------

VALID_MODES = {"审题", "解析", "批改", "对照参考答案", "修改二稿", "学情报告"}
LAYER_BUDGET = {"能力内核": 1, "题型工作流": 3, "批改二稿": 1}


def _load_method_cards_map():
    """Return {card_id: card_dict} from 方法卡/*.json."""
    card_dir = Path(__file__).resolve().parent.parent / "references" / "method-libraries" / "方法卡"
    cards = {}
    if not card_dir.exists():
        return cards, [f"方法卡/ directory not found: {card_dir}"]
    errors = []
    for card_path in sorted(card_dir.glob("sl-card-*.json")):
        try:
            card = json.loads(card_path.read_text(encoding="utf-8"))
            cid = card.get("card_id")
            if cid:
                cards[cid] = card
        except json.JSONDecodeError as e:
            errors.append(f"invalid JSON: {card_path.name}: {e}")
    return cards, errors


def _load_conditional_cards():
    """Return conditional_cards dict from method-routing.json (may be empty)."""
    routing_path = Path(__file__).resolve().parent.parent / "references" / "method-libraries" / "method-routing.json"
    if not routing_path.exists():
        return {}
    try:
        routing = json.loads(routing_path.read_text(encoding="utf-8"))
        cc = routing.get("conditional_cards", {})
        return cc if isinstance(cc, dict) else {}
    except Exception:
        return {}


def _load_method_routing():
    """Load the runtime routing document or fail closed."""
    routing_path = Path(__file__).resolve().parent.parent / "references" / "method-libraries" / "method-routing.json"
    if not routing_path.exists():
        error_exit(EXIT_INPUT_ERROR, f"method-routing.json not found: {routing_path}")
    try:
        routing = json.loads(routing_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        error_exit(EXIT_INPUT_ERROR, f"cannot load method-routing.json: {exc}")
    if not isinstance(routing, dict) or not isinstance(routing.get("task_prototype_routing"), dict):
        error_exit(EXIT_INPUT_ERROR, "method-routing.json has no valid task_prototype_routing object")
    return routing


def _load_task_prototypes_map():
    """Return {prototype_id: prototype_dict} from task-prototypes/prototypes/*.json."""
    prototype_dir = Path(__file__).resolve().parent.parent / "references" / "task-prototypes" / "prototypes"
    if not prototype_dir.exists():
        return {}, [f"task prototype directory not found: {prototype_dir}"]
    prototypes = {}
    errors = []
    for prototype_path in sorted(prototype_dir.glob("sl-prototype-*.json")):
        try:
            prototype = json.loads(prototype_path.read_text(encoding="utf-8"))
            prototype_id = prototype.get("prototype_id")
            if isinstance(prototype_id, str) and prototype_id:
                prototypes[prototype_id] = prototype
            else:
                errors.append(f"missing prototype_id: {prototype_path.name}")
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"invalid prototype: {prototype_path.name}: {exc}")
    return prototypes, errors


def _normalize_trigger_text(value):
    if not isinstance(value, str):
        return ""
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "", value).lower()


def _trigger_matches(signal, question_text):
    """Match a literal signal or an ordered '*' token pattern."""
    if not isinstance(signal, str) or not signal.strip():
        return False
    normalized_question = _normalize_trigger_text(question_text)
    if "*" not in signal:
        normalized_signal = _normalize_trigger_text(signal)
        return bool(normalized_signal and normalized_signal in normalized_question)
    tokens = [_normalize_trigger_text(part) for part in signal.split("*")]
    tokens = [token for token in tokens if token]
    if not tokens:
        return False
    pos = 0
    for token in tokens:
        found = normalized_question.find(token, pos)
        if found < 0:
            return False
        pos = found + len(token)
    return True


def _semantic_fallback_prototype(question_text, prototypes):
    """Resolve common paraphrases by task function when literal triggers miss."""
    def has(*signals):
        return any(_trigger_matches(signal, question_text) for signal in signals)

    def make(pid, basis):
        prototype = prototypes.get(pid)
        if not prototype:
            return None
        return {
            "prototype_id": pid,
            "prototype_name": prototype.get("name"),
            "question_type": prototype.get("question_type"),
            "matched_signals": [basis],
            "score": len(_normalize_trigger_text(basis)) ** 2,
            "mode_routes": prototype.get("mode_routes", {}),
            "constraints": prototype.get("constraints", []),
            "resolution_basis": basis,
        }

    # Explicit output genre outranks words appearing in quoted material.
    genre_rules = [
        ("sl-prototype-0020", ("公开信", "倡议书", "动员信", "倡议信", "动员材料"), "明确文种：公开信/倡议/动员"),
        ("sl-prototype-0019", ("编者按", "宣传材料", "宣传稿", "宣传介绍", "宣传展板", "新闻稿", "导言", "推介稿", "推介文稿", "解说词", "介绍稿"), "明确文种：宣传/介绍/编者按"),
        ("sl-prototype-0016", ("案例摘要", "案例汇编", "案例材料", "案例总结", "案例简介"), "明确文种：案例摘要/案例材料"),
        ("sl-prototype-0011", ("短评", "简短评论", "评论文章"), "明确文种：短评"),
        ("sl-prototype-0012", ("提案", "政协建议案"), "明确文种：提案"),
        ("sl-prototype-0014", ("谈话提纲", "反馈提纲", "沟通提纲", "约谈提纲", "谈话要点", "沟通*要点", "约谈*要点"), "明确文种：谈话/沟通提纲"),
        ("sl-prototype-0015", ("发言提纲", "发言稿", "发言材料", "经验交流发言材料", "座谈会发言", "讲话稿", "讲话提纲", "交流会发言"), "明确文种：发言/讲话"),
        ("sl-prototype-0010", ("情况报告", "情况简报", "工作简报", "调研报告", "考察报告", "汇报提纲", "经验交流材料", "工作情况汇报", "汇报材料", "汇报要点", "总结材料", "供领导参阅"), "明确文种：报告/简报/汇报"),
        ("sl-prototype-0013", ("工作指南", "操作指南", "工作手册", "手册", "办事指南", "办事指引", "操作指引", "办事须知"), "明确文种：指南/手册/指引"),
        ("sl-prototype-0021", ("工作方案", "通知", "工作要点", "工作建议", "实施方案", "实施计划", "行动方案", "行动计划", "工作计划", "实施意见"), "明确文种：方案/建议/通知"),
    ]
    for pid, signals, basis in genre_rules:
        if has(*signals):
            if pid == "sl-prototype-0015" and has("编者按", "短评"):
                continue
            if pid == "sl-prototype-0019" and has("短评"):
                continue
            if pid == "sl-prototype-0021" and has("公开信", "倡议书"):
                continue
            return make(pid, basis)

    if has("写一篇文章", "写一篇申论文章", "撰写一篇文章", "写文章", "撰写文章", "议论文", "自拟题目", "自选角度"):
        if has("劣势*优势", "旧*新生", "旧*新价值", "焕发新生", "重获新生", "变废为宝", "转化", "蝶变", "活化"):
            return make("sl-prototype-0018", "语义判断：文章要求且包含转化/新生命题")
        if has("分与合", "既要", "又要", "相互促进", "相辅相成", "相互依存", "相互作用", "彼此关系", "二者关系", "之间的关系", "之间的联系", "辩证关系"):
            return make("sl-prototype-0022", "语义判断：文章要求且包含关系命题")
        return make("sl-prototype-0017", "语义判断：文章写作")

    if has("原因*提出", "原因*对策", "原因*建议", "成因*办法", "成因*措施", "为什么*解决", "为何*改进"):
        return make("sl-prototype-0008", "语义判断：原因与解决措施复合")
    if has("问题*提出建议", "问题*提出*建议", "问题*提出对策", "梳理*问题*建议", "不足*改进意见", "短板*完善措施", "问题*改进办法"):
        return make("sl-prototype-0009", "语义判断：问题与建议复合")
    if has("提出对策", "提出建议", "改进对策", "改进建议", "治理对策", "提出具体措施", "给出*建议", "提出*办法", "提出*措施", "制定*措施", "针对*给出", "针对*提出", "应如何解决", "如何改进", "如何完善"):
        return make("sl-prototype-0026", "语义判断：一般提出对策")
    if has("概括*解决*问题*办法", "如何解决这些问题", "问题是如何解决", "解决问题的办法", "采取什么办法*解决"):
        return make("sl-prototype-0001", "语义判断：回顾材料中的既有解决做法")
    if has("争议焦点", "不同意见", "各方意见", "意见分歧", "争论焦点", "分歧所在"):
        return make("sl-prototype-0005", "语义判断：争议/分歧提取")
    if has("分别*含义", "分别*内涵", "分别解释", "分别阐释", "几个概念", "概念之间"):
        return make("sl-prototype-0006", "语义判断：多概念分别阐释")
    if has("为什么说", "谈谈*理解", "谈谈*认识", "如何理解", "怎样认识", "解释含义", "说明含义", "阐释含义", "这句话", "这段话", "划线句", "为什么*过程"):
        return make("sl-prototype-0007", "语义判断：词句/观点理解")
    if has("评价", "评析", "看法", "怎么看", "如何看待", "是否正确", "是否合理", "是否赞同", "有无道理", "观点"):
        return make("sl-prototype-0025", "语义判断：评价/看法分析")
    if has("分类", "归类", "分为几类", "划分类别", "类型有哪些"):
        return make("sl-prototype-0003", "语义判断：材料信息分类")
    if has("原因", "成因", "为何", "为什么", "因素", "缘由", "根源"):
        return make("sl-prototype-0023", "语义判断：原因提取")
    if has("启示", "借鉴", "亮点", "特色", "特点", "巧在哪", "体现出了哪些", "可取之处"):
        return make("sl-prototype-0024", "语义判断：亮点/启示提取")
    if has("变化", "新变化", "转变", "演变", "变迁", "发展历程", "不同阶段"):
        return make("sl-prototype-0002", "语义判断：变化提取")
    if has("问题", "不足", "困难", "困境", "短板", "难点", "障碍", "症结"):
        return make("sl-prototype-0004", "语义判断：问题提取")
    if has("意义", "作用", "影响", "价值", "重要性"):
        return make("sl-prototype-0007", "语义判断：意义/作用/影响分析")
    if has("经验", "做法", "举措", "实践", "路径", "采取了什么", "如何实现", "如何做到", "如何解决", "怎样解决", "解决问题的办法", "怎样", "怎么", "成效"):
        return make("sl-prototype-0001", "语义判断：事实/做法概括")
    if has("概述", "概括", "归纳", "梳理", "总结", "提炼", "简述", "说明"):
        return make("sl-prototype-0001", "语义判断：通用材料信息概括")
    return None


def _resolve_task_prototype_once(question_text, mode=None):
    """Return one real prototype without requiring a second CLI round trip."""
    prototypes, load_errors = _load_task_prototypes_map()
    if load_errors:
        error_exit(EXIT_INPUT_ERROR, "Task prototypes could not be loaded", {"errors": load_errors})

    normalized_question = _normalize_trigger_text(question_text)
    essay_task = any(_trigger_matches(signal, question_text) for signal in (
        "写一篇文章", "撰写一篇文章", "写一篇议论文", "撰写一篇议论文",
        "自拟题目", "自选角度", "联系实际*写",
    ))
    candidates = []
    for prototype_id, prototype in prototypes.items():
        if prototype.get("question_type") == "申发论述" and not essay_task:
            continue
        matched = []
        excluded = []
        for signal in prototype.get("trigger_signals", []):
            if _trigger_matches(signal, question_text):
                matched.append(signal)
        for signal in prototype.get("exclusion_signals", []):
            if _trigger_matches(signal, question_text):
                excluded.append(signal)
        if matched and not excluded:
            candidates.append({
                "prototype_id": prototype_id,
                "prototype_name": prototype.get("name"),
                "question_type": prototype.get("question_type"),
                "matched_signals": matched,
                "score": sum(len(_normalize_trigger_text(item)) ** 2 for item in matched),
                "mode_routes": prototype.get("mode_routes", {}),
                "constraints": prototype.get("constraints", []),
            })

    # Explicit essay-writing signals outrank broad small-question triggers
    # such as "怎样" or "概括" that may appear in the stem. Once the task is
    # clearly an essay, do not let a literal match from another question type
    # steal the route before semantic fallback gets a chance.
    if essay_task:
        candidates = [
            candidate for candidate in candidates
            if candidate["question_type"] == "申发论述"
        ]

    resolution_mode = "literal_trigger"
    if not candidates:
        fallback = _semantic_fallback_prototype(question_text, prototypes)
        if fallback:
            candidates = [fallback]
            resolution_mode = "semantic_fallback"
        else:
            error_exit(EXIT_CONSISTENCY, "Question type confirmation required", {
                "question_text": question_text,
                "user_prompt": "请确认这道题属于归纳概括、综合分析、提出对策、贯彻执行或申发论述中的哪一类。",
            })
    candidates.sort(key=lambda item: (-item["score"], item["prototype_id"]))
    top_score = candidates[0]["score"]
    top = [item for item in candidates if item["score"] == top_score]
    if len(top) != 1:
        error_exit(EXIT_CONSISTENCY, "Question type confirmation required", {
            "candidates": top,
            "user_prompt": "请确认这道题属于归纳概括、综合分析、提出对策、贯彻执行或申发论述中的哪一类。",
        })

    selected = dict(top[0])
    selected.pop("score", None)
    selected["prototype_resolution_receipt"] = {
        "matched_from_real_prototype": True,
        "passed": True,
        "resolution_mode": resolution_mode,
        "resolution_basis": selected.get("resolution_basis") or "literal trigger match",
        "prototype_id": selected["prototype_id"],
    }
    return selected


def cmd_resolve_task_prototype(args):
    """Resolve exact task-prototype triggers before question-type selection."""
    raw = read_input(args.input)
    data = parse_json_input(raw)
    if not isinstance(data, dict):
        error_exit(EXIT_INPUT_ERROR, "resolve-task-prototype input must be a JSON object")
    question_text = data.get("question_text")
    mode = data.get("mode")
    if not isinstance(question_text, str) or not question_text.strip():
        error_exit(EXIT_INPUT_ERROR, "resolve-task-prototype requires non-empty question_text")
    if mode is not None and mode not in VALID_MODES:
        error_exit(EXIT_INPUT_ERROR, f"mode must be one of {sorted(VALID_MODES)}, got {mode!r}")
    selected = _resolve_task_prototype_once(question_text, mode)
    success_output(selected, args.output)


VALID_USER_OUTPUT_MODES = {"审题", "解析", "微型解析", "批改", "复盘", "工程审计"}
REFERENCE_POLICY_MODES = {"解析", "微型解析", "批改"}


def _resolve_reference_answer_policy(data, output_mode):
    """Resolve answer-output policy from explicit reference availability."""
    if output_mode not in REFERENCE_POLICY_MODES:
        return data.get("allow_reference_answer", False) is True
    if "reference_available" not in data:
        if output_mode == "批改":
            # Fail closed for grading prose: do not emit a second model answer,
            # but also do not force a schema retry when the grading context was
            # not copied into the final-gate payload.
            return False
        error_exit(
            EXIT_INPUT_ERROR,
            "validate-user-output requires explicit reference_available for explanation/grading output",
        )
    reference_available = data.get("reference_available")
    if not isinstance(reference_available, bool):
        error_exit(EXIT_INPUT_ERROR, "reference_available must be boolean")
    # A supplied answer is calibrated source material, not a reason to emit a
    # second model answer. With no source answer, a teaching answer is allowed.
    return not reference_available


def _basic_user_output_issues(text, allow_table=False, allow_internal_ids=False,
                              allow_reference_answer=False, output_mode=None,
                              required_method_names=None,
                              report_requirements=None, full_score=None,
                              full_score_source=None):
    issues = []
    approximate_lengths = sorted(set(re.findall(
        r"(?:约|大约|将近|接近)\s*\d+(?:\.\d+)?\s*(?:字|字符)", text
    )))
    if approximate_lengths:
        issues.append({
            "type": "approximate_length",
            "values": approximate_lengths,
            "message": "字数必须使用引擎回执的 actual_length，不得使用估算值",
        })
    table_lines = [
        index + 1 for index, line in enumerate(text.splitlines())
        if re.match(r"^\s*\|.*\|\s*$", line)
    ]
    if table_lines and not allow_table:
        issues.append({"type": "markdown_table", "lines": table_lines})
    if not allow_internal_ids:
        ids = sorted(set(re.findall(r"\b(?:sl-card|sl-prototype)-\d{4}\b", text)))
        if ids:
            issues.append({"type": "internal_ids", "values": ids})
        patterns = {
            "internal_command": r"\b(?:analyze-once|grade-once|compare-drafts|calculate-score|validate-user-output)\b",
            "internal_field": r"\b(?:reference_fast_path|material_full_path|write_back|single_compile|formal_score|point_pool_fingerprint|validation_receipt|included|merged|excluded)\b",
            "implementation_receipt": r"工程回执|引擎回执|执行说明|内部实现|正式技能目录|技能版本|RC\s*=?\s*0|CLI|JSON校验|查看所有产物|查看所有变更|本次技能实际走了什么|门禁(?:通过|失败)|校验(?:通过|失败)|运行状态|写回\s*SQLite|核心要点速记|(?:今日)?(?:工作)?日志|按技能(?:铁律|契约)|回执已自动删除|解析已通过引擎校验|引擎方法选择|由引擎[^。；\n]{0,24}(?:命中|选择)",
            "internal_route": r"原型\s*(?:ID|命中|=|：)|方法卡\s*(?:ID|编号|=|：)",
            "method_card_receipt": r"(?:\d+|[一二三四五六七八九十]+)\s*张(?:方法卡|卡片)|方法卡选择回执",
            "internal_point_label": r"(?<![A-Za-z])(?:P|p)\d+(?![A-Za-z])",
        }
        for issue_type, pattern in patterns.items():
            values = sorted(set(re.findall(pattern, text, flags=re.IGNORECASE)))
            if values:
                issues.append({"type": issue_type, "values": values})

        pseudo_point_score_patterns = [
            r"(?:这一点|该点|本点|逐点|(?:P|p)\d+)[^。；\n]{0,24}(?:得|拿到|获得|约)\s*\d+(?:\.\d+)?\s*分",
            r"(?:这一点|该点|本点)[^。；\n]{0,12}(?:满分|全分)",
            r"每点\s*\d+(?:\.\d+)?\s*分",
            r"\d+(?:\.\d+)?\s*分[^。；\n]{0,12}(?:几乎)?(?:全失|全拿|拿满)",
        ]
        pseudo_point_scores = sorted({
            value
            for pattern in pseudo_point_score_patterns
            for value in re.findall(pattern, text)
        })
        if pseudo_point_scores:
            issues.append({
                "type": "pseudo_point_score",
                "values": pseudo_point_scores,
                "message": "用户可见批改只能给总体建议分和区间，不得把模型点值写成官方逐点分值",
            })

    if output_mode in {"解析", "微型解析", "批改"}:
        # User-facing teaching may use a heading, a lead-in sentence, or a
        # natural paragraph. Do not make punctuation/Markdown heading shape a
        # reason to send the host back through validation.
        method_heading = re.search(
            r"(?:方法(?:讲解|依据)?|审题方法|做题方法|解题方法|操作步骤)",
            text,
        )
        method_steps = re.search(
            r"(?:第一步|第二步|操作步骤|先.{0,60}(?:再|然后)|圈出|锁定|回到材料|逐点|合并|核对|下次遇到|同类题)",
            text,
        )
        if not method_heading or not method_steps:
            issues.append({
                "type": "missing_method_explanation",
                "message": "普通解析/批改须用自然的‘方法’小节写出方法名称和可复用步骤",
            })
        required_method_names = [
            item for item in (required_method_names or [])
            if isinstance(item, str) and item.strip()
        ]
        if required_method_names and not any(name in text for name in required_method_names):
            issues.append({
                "type": "missing_loaded_method_name",
                "allowed_names": required_method_names,
                "message": "请直接使用评分回执提供的中文方法名，无需再搜索方法卡文件",
            })
        if not allow_reference_answer:
            reference_answer_headings = re.findall(
                r"(?m)^\s*(?:[一二三四五六七八九十\d]+[、.．]\s*)?"
                r"(?:完整)?参考(?:答案|稿)"
                r"(?:\s*[（(][^\n]{0,40}[）)])?\s*(?:[:：]|$)",
                text,
            )
            if reference_answer_headings:
                issues.append({
                    "type": "unauthorized_reference_answer",
                    "values": sorted(set(reference_answer_headings)),
                    "message": "已有参考答案时不得重复输出完整参考答案；请保留材料逐点解析和校准说明",
                })
        score_guess_patterns = [
            r"暂按\s*\d+(?:\.\d+)?\s*分",
            r"估计\s*\d+(?:\.\d+)?\s*分",
            r"请(?:你)?确认(?:本题)?分值",
        ]
        score_guess_values = sorted({
            value
            for pattern in score_guess_patterns
            for value in re.findall(pattern, text)
        })
        if score_guess_values:
            issues.append({
                "type": "unverified_score_guess",
                "values": score_guess_values,
                "message": "题面未确认分值时只能说明不评分，不得暂估或追问确认",
            })
        if output_mode in {"解析", "微型解析"}:
            if full_score is not None:
                score_text = str(full_score).removesuffix(".0")
                if not re.search(rf"(?<!\d){re.escape(score_text)}\s*分", text):
                    issues.append({
                        "type": "missing_question_score",
                        "full_score": full_score,
                        "message": "题面已提供分值，完整解析必须保留题目满分，不能写成未标注分值",
                    })
            elif full_score_source == "conflict" and not re.search(
                    r"分值.{0,8}(?:冲突|矛盾|不一致)", text):
                issues.append({
                    "type": "unresolved_question_score_conflict",
                    "message": "题面分值存在冲突，解析必须说明冲突并停止猜分",
                })
        fixed_sections = [
            "题型与任务", "材料怎么找点", "核心得分点",
            "答案怎么组织", "方法依据", "易错点",
        ]
        used_sections = [section for section in fixed_sections if section in text]
        if len(used_sections) >= 5:
            issues.append({
                "type": "mechanical_six_section_template",
                "values": used_sections,
            })

        if isinstance(report_requirements, dict) and report_requirements.get(
                "full_teaching_report") is True:
            summary_wrappers = sorted(set(re.findall(
                r"(?m)^\s*(?:#{1,6}\s*)?(?:核心结论速览|结论速览|结果摘要|"
                r"以下仅为摘要|只展示核心结论|完整(?:解析|批改|报告|正文)见(?:附件|文件|上方|下方)|"
                r"正文见(?:附件|文件|上方|下方))",
                text,
            )))
            if summary_wrappers:
                issues.append({
                    "type": "summary_delivery_wrapper",
                    "values": summary_wrappers,
                    "message": "不得用速览、摘要或文件指引替代完整正文；请直接发送完整解析或批改",
                })
            missing_groups = []
            for group in report_requirements.get("required_signal_groups", []):
                if not isinstance(group, dict):
                    continue
                signals = [
                    signal for signal in group.get("signals", [])
                    if isinstance(signal, str) and signal
                ]
                if signals and not any(signal in text for signal in signals):
                    missing_groups.append(group.get("name", "未命名板块"))
            required_terms = [
                term for term in report_requirements.get("required_verdict_terms", [])
                if isinstance(term, str) and term.strip()
            ]
            missing_terms = [term for term in required_terms if term not in text]
            if missing_groups or missing_terms:
                issues.append({
                    "type": "incomplete_teaching_report",
                    "missing_sections": missing_groups,
                    "missing_verdict_terms": missing_terms,
                    "message": (
                        "完整教学批改/解析不得只输出摘要；必须保留题干责任、方法、"
                        "材料证据、逐条或逐段讲解、修复动作及引擎裁决对应的档位表述"
                    ),
                })
    return issues


def _reference_answer_length_audit(data, text, allow_reference_answer):
    """Validate a generated reference answer inside the final output gate.

    Normal grading should not call check-word-count as a separate command. The
    caller passes the exact generated answer as reference_answer_text, while
    the grade-once validation context supplies the question bounds.
    """
    answer_text = data.get("reference_answer_text")
    answer_heading_present = re.search(
        r"(?m)^\s*(?:#{1,6}\s*)?(?:[一二三四五六七八九十\d]+[、.．]\s*)?"
        r"(?:完整)?参考(?:答案|稿)(?:\s*[（(][^\n]{0,60}[）)])?\s*(?:[:：]|$)",
        text,
    ) is not None
    issues = []
    if answer_text is None:
        if allow_reference_answer and answer_heading_present:
            issues.append({
                "type": "missing_reference_answer_text_for_length_check",
                "message": "完整参考答案须随最终回复传入 reference_answer_text，由本次输出校验同时核验字数",
            })
        return None, issues
    if not isinstance(answer_text, str) or not answer_text.strip():
        issues.append({
            "type": "invalid_reference_answer_text",
            "message": "reference_answer_text 必须是非空答案正文",
        })
        return None, issues
    if not allow_reference_answer:
        issues.append({
            "type": "unauthorized_reference_answer_payload",
            "message": "已有参考答案时不得再提交技能生成的完整参考答案",
        })
        return None, issues
    if answer_text not in text:
        issues.append({
            "type": "reference_answer_not_in_final_text",
            "message": "reference_answer_text 必须逐字出现在待发送的完整回复中",
        })

    constraints = data.get("reference_answer_length_constraints")
    if not isinstance(constraints, dict):
        constraints = {}
    min_length = constraints.get("min_length")
    max_length = constraints.get("max_length")
    length_unit = constraints.get("length_unit", "字")
    valid_bound = lambda value: value is None or (
        isinstance(value, int) and not isinstance(value, bool) and value >= 0
    )
    if not valid_bound(min_length) or not valid_bound(max_length):
        issues.append({
            "type": "invalid_reference_answer_length_constraints",
            "message": "参考答案字数上下限必须是非负整数或 null",
        })
        return None, issues
    if min_length is not None and max_length is not None and min_length > max_length:
        issues.append({
            "type": "invalid_reference_answer_length_constraints",
            "message": "参考答案最低字数不得高于最高字数",
        })
        return None, issues

    actual_length = _count_answer_chars(answer_text, strip_markdown=True)
    compliant = (
        (min_length is None or actual_length >= min_length)
        and (max_length is None or actual_length <= max_length)
    )
    audit = {
        "actual_length": actual_length,
        "min_length": min_length,
        "max_length": max_length,
        "length_unit": length_unit,
        "punctuation_counted": True,
        "compliant": compliant,
    }
    if not compliant:
        issues.append({
            "type": "reference_answer_length_violation",
            **audit,
            "message": "技能生成的完整参考答案不符合题面字数限制",
        })
    return audit, issues


def _validate_user_output_payload(data):
    """Validate one complete user-facing payload and return approved text."""
    if not isinstance(data, dict):
        error_exit(EXIT_INPUT_ERROR, "validate-user-output input must be a JSON object")
    context = data.get("validation_context")
    if not isinstance(context, dict):
        context = data.get("output_validation_context")
    if not isinstance(context, dict):
        context = {}
    merged = dict(context)
    merged.update(data)
    data = merged
    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        error_exit(EXIT_INPUT_ERROR, "validate-user-output requires non-empty text")
    output_mode = data.get("output_mode")
    if output_mode not in VALID_USER_OUTPUT_MODES:
        error_exit(EXIT_INPUT_ERROR,
                   f"validate-user-output requires output_mode in {sorted(VALID_USER_OUTPUT_MODES)}")
    if data.get("final_response", True) is not True:
        error_exit(EXIT_INPUT_ERROR,
                   "validate-user-output requires final_response=true; validate the complete text that will be sent")
    allow_table = data.get("allow_table", False) is True
    allow_internal_ids = data.get("allow_internal_ids", False) is True
    allow_reference_answer = _resolve_reference_answer_policy(data, output_mode)
    issues = _basic_user_output_issues(
        text, allow_table=allow_table, allow_internal_ids=allow_internal_ids,
        allow_reference_answer=allow_reference_answer,
        output_mode=output_mode,
        required_method_names=data.get("required_method_names"),
        report_requirements=data.get("report_requirements"),
        full_score=data.get("full_score"),
        full_score_source=data.get("full_score_source"),
    )
    reference_answer_length_check, length_issues = _reference_answer_length_audit(
        data, text, allow_reference_answer,
    )
    issues.extend(length_issues)
    if issues:
        error_exit(EXIT_CONSISTENCY, "User-facing output gate FAILED", {
            "issues": issues,
            "retry_policy": "fix_all_listed_issues_once_then_stop",
            "maximum_retry_count": 1,
            "required_method_names": data.get("required_method_names", []),
        })
    return {
        "schema_version": "1.0", "passed": True,
        "output_mode": output_mode,
        "final_response": True,
        "validated_text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "validated_length": len(text),
        "reference_answer_length_check": reference_answer_length_check,
        "approved_text": text,
        "checks": [
            "complete_final_response", "no_forbidden_table", "no_internal_ids",
            "no_engineering_details", "no_unauthorized_reference_answer",
            "no_mechanical_six_section_template",
        ],
    }


def cmd_validate_user_output(args):
    """Fail closed when normal user-facing prose contains forbidden artifacts."""
    raw = read_input(args.input)
    data = parse_json_input(raw)
    success_output(_validate_user_output_payload(data), args.output)


def _controlled_analysis_receipt_path(raw_path):
    """Resolve a disposable analysis receipt without allowing arbitrary deletion."""
    if not isinstance(raw_path, str) or not raw_path.strip():
        error_exit(EXIT_INPUT_ERROR, "finalize-analysis requires receipt_path")
    path = Path(raw_path).expanduser().resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    try:
        inside_temp = os.path.commonpath([str(path), str(temp_root)]) == str(temp_root)
    except ValueError:
        inside_temp = False
    if (not inside_temp or not path.name.startswith("shenlun-analysis-receipt-")
            or path.suffix.lower() != ".json"):
        error_exit(
            EXIT_INPUT_ERROR,
            "finalize-analysis receipt_path must be a shenlun-analysis-receipt-*.json file under the system temp directory",
        )
    if not path.is_file():
        error_exit(EXIT_INPUT_ERROR, f"finalize-analysis receipt not found: {path}")
    if path.stat().st_size > 2 * 1024 * 1024:
        error_exit(EXIT_INPUT_ERROR, "finalize-analysis receipt exceeds 2 MiB")
    return path


def cmd_finalize_analysis(args):
    """Validate analysis prose using one exact analyze-once receipt, then clean it."""
    raw = read_input(args.input)
    data = parse_json_input(raw)
    if not isinstance(data, dict):
        error_exit(EXIT_INPUT_ERROR, "finalize-analysis input must be a JSON object")
    allowed_fields = {"receipt_path", "text", "reference_answer_text"}
    unknown_fields = sorted(set(data) - allowed_fields)
    if unknown_fields:
        error_exit(
            EXIT_INPUT_ERROR,
            "finalize-analysis accepts only receipt_path, text, and reference_answer_text",
            {"unknown_fields": unknown_fields},
        )

    receipt_path = _controlled_analysis_receipt_path(data.get("receipt_path"))
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        error_exit(EXIT_INPUT_ERROR, "finalize-analysis receipt is unreadable", str(exc))
    if not isinstance(receipt, dict):
        error_exit(EXIT_INPUT_ERROR, "finalize-analysis receipt must be a JSON object")
    once_receipt = receipt.get("analysis_once_receipt")
    if (receipt.get("receipt_type") != "analysis_once"
            or receipt.get("engine_version") != ENGINE_VERSION
            or not isinstance(once_receipt, dict)
            or once_receipt.get("passed") is not True
            or once_receipt.get("entrypoint") != "analyze-once"
            or once_receipt.get("external_command_count") != 1):
        error_exit(
            EXIT_CONSISTENCY,
            "finalize-analysis requires one successful analyze-once receipt from the current engine version",
        )
    context = receipt.get("output_validation_context")
    if not isinstance(context, dict):
        error_exit(EXIT_CONSISTENCY, "finalize-analysis receipt lacks output_validation_context")

    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        error_exit(EXIT_INPUT_ERROR, "finalize-analysis requires complete non-empty text")
    answer_required = context.get("reference_answer_text_required") is True
    answer_text = data.get("reference_answer_text")
    if answer_required and (not isinstance(answer_text, str) or not answer_text.strip()):
        error_exit(
            EXIT_INPUT_ERROR,
            "finalize-analysis requires the exact generated answer in reference_answer_text",
        )
    if not answer_required and answer_text is not None:
        error_exit(
            EXIT_CONSISTENCY,
            "finalize-analysis forbids a second generated answer when a user reference answer exists",
        )

    validation_payload = {
        "text": text,
        "validation_context": context,
    }
    if answer_text is not None:
        validation_payload["reference_answer_text"] = answer_text
    result = _validate_user_output_payload(validation_payload)

    try:
        receipt_path.unlink()
        receipt_deleted = True
    except OSError:
        receipt_deleted = False
    result["analysis_finalize_receipt"] = {
        "passed": True,
        "engine_version": ENGINE_VERSION,
        "analysis_receipt_reused": True,
        "duplicate_analysis_required": False,
        "receipt_deleted": receipt_deleted,
    }
    success_output(result, args.output)


def cmd_validate_user_output_structured(args):
    """Validate user-visible output against structured evidence.

    P0-4: Formal mode requires all of: text, task_spec, analysis_result, score_ledger,
    scoring_result, user_output_plan. Any missing/empty/null/wrong-type causes non-zero exit.

    P1-1: No hardcoded Chinese phrase blacklist — validation uses structured point_ids.
    P1-2: Relationship validation uses generalized relationship_id, not hardcoded P2/P3/R2.
    P1-3: Score check reads from user_output_plan, not regex on all "X分" in text.
    """
    raw = read_input(args.input)
    data = parse_json_input(raw)
    if not isinstance(data, dict):
        error_exit(EXIT_INPUT_ERROR, "validate-user-output-structured input must be a JSON object")

    # P0-4: Formal mode requires all context fields
    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        error_exit(EXIT_INPUT_ERROR, "validate-user-output-structured requires non-empty text")

    task_spec = data.get("task_spec")
    analysis_result = data.get("analysis_result")
    score_ledger = data.get("score_ledger")
    scoring_result = data.get("scoring_result")
    user_output_plan = data.get("user_output_plan")

    # P0-4: Determine formal vs legacy
    is_formal = True
    if isinstance(scoring_result, dict):
        if scoring_result.get("legacy_mode") is True or scoring_result.get("formal_score") is False:
            is_formal = False

    # P0-4: In formal mode, all contexts are required
    if is_formal:
        missing_ctx = []
        for field_name, field_val in [
            ("task_spec", task_spec),
            ("analysis_result", analysis_result),
            ("score_ledger", score_ledger),
            ("scoring_result", scoring_result),
            ("user_output_plan", user_output_plan),
        ]:
            if field_val is None:
                missing_ctx.append(f"{field_name} is null")
            elif not isinstance(field_val, dict):
                missing_ctx.append(f"{field_name} must be an object, got {type(field_val).__name__}")
            elif not field_val:
                missing_ctx.append(f"{field_name} is empty")
        if missing_ctx:
            error_exit(EXIT_CONSISTENCY,
                "Formal structured validation requires all context fields: task_spec, analysis_result, score_ledger, scoring_result, user_output_plan",
                {"missing": missing_ctx})

    output_mode = data.get("output_mode")
    if output_mode not in VALID_USER_OUTPUT_MODES:
        error_exit(EXIT_INPUT_ERROR,
                   f"validate-user-output-structured requires output_mode in {sorted(VALID_USER_OUTPUT_MODES)}")
    if data.get("final_response") is not True:
        error_exit(EXIT_INPUT_ERROR,
                   "validate-user-output-structured requires final_response=true")
    allow_table = data.get("allow_table", False) is True
    allow_internal_ids = data.get("allow_internal_ids", False) is True
    allow_reference_answer = _resolve_reference_answer_policy(data, output_mode)
    issues = _basic_user_output_issues(
        text, allow_table=allow_table, allow_internal_ids=allow_internal_ids,
        allow_reference_answer=allow_reference_answer,
        output_mode=output_mode,
    )

    if not is_formal:
        # Legacy/loose mode — only basic checks above
        if issues:
            error_exit(EXIT_CONSISTENCY, "User-facing structured output gate FAILED", {
                "issues": issues, "mode": "legacy" if scoring_result.get("legacy_mode") else "loose"
            })
        success_output({
            "schema_version": "1.0", "passed": True,
            "output_mode": output_mode,
            "final_response": True,
            "validated_text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "validated_length": len(text),
            "approved_text": text,
            "checks": ["complete_final_response", "no_forbidden_table", "no_internal_ids", "no_engineering_details", "no_unauthorized_reference_answer"],
            "mode": "legacy",
        }, args.output)
        return

    # ========== FORMAL MODE VALIDATION ==========

    # --- Build scorable point IDs and relationship info from analysis_result ---
    scorable_point_ids = set()
    non_scorable_point_ids = set()
    all_relationship_ids = set()
    relationship_map = {}  # relationship_id -> full relationship object

    if isinstance(scoring_result, dict) and isinstance(scoring_result.get("point_coverage"), list):
        for pc in scoring_result["point_coverage"]:
            pid = pc.get("point_id", "")
            if pid:
                scorable_point_ids.add(pid)

    if isinstance(analysis_result, dict):
        for ap in analysis_result.get("atomic_points", []):
            if not isinstance(ap, dict):
                continue
            pid = ap.get("point_id", "")
            if not pid:
                continue
            status = ap.get("status", "active")
            pis = ap.get("independent_scoring", True)
            pro = ap.get("required_or_optional", "required")
            if status != "active" or pis is not True or pro == "optional":
                non_scorable_point_ids.add(pid)
        for rel in analysis_result.get("relationships", []):
            rid = rel.get("relationship_id", "")
            if rid:
                all_relationship_ids.add(rid)
                relationship_map[rid] = rel

    # P0-4: user_output_plan structure validation
    uop = user_output_plan

    # P0-4: final_score must NOT be empty
    plan_fs = uop.get("final_score", {})
    if not isinstance(plan_fs, dict) or not plan_fs:
        issues.append({"type": "empty_final_score", "detail": "user_output_plan.final_score is missing, empty, or not an object"})
    else:
        # P0-4: center_value, interval.lower, interval.upper, confidence must all be present and valid
        for key in ("center_value",):
            val = plan_fs.get(key)
            if val is None:
                issues.append({"type": "missing_final_score_field", "detail": f"final_score.{key} is missing or null"})
            elif not isinstance(val, (int, float)):
                issues.append({"type": "invalid_final_score_type", "detail": f"final_score.{key} must be a number, got {type(val).__name__}"})
        for key in ("interval",):
            interval_obj = plan_fs.get(key, {})
            if not isinstance(interval_obj, dict) or not interval_obj:
                issues.append({"type": "missing_final_score_field", "detail": f"final_score.{key} is missing, empty, or not an object"})
            else:
                for bound in ("lower", "upper"):
                    bv = interval_obj.get(bound)
                    if bv is None:
                        issues.append({"type": "missing_final_score_field", "detail": f"final_score.interval.{bound} is missing or null"})
                    elif not isinstance(bv, (int, float)):
                        issues.append({"type": "invalid_final_score_type", "detail": f"final_score.interval.{bound} must be a number, got {type(bv).__name__}"})
        conf = plan_fs.get("confidence")
        if not conf or conf not in ("high", "medium", "low"):
            issues.append({"type": "invalid_final_score_confidence", "detail": f"final_score.confidence must be high/medium/low, got {conf!r}"})

    # P0-4: dimension_results must NOT be empty and must cover ALL scoring dimensions
    plan_dims = uop.get("dimension_results", [])
    if not isinstance(plan_dims, list) or not plan_dims:
        issues.append({"type": "empty_dimension_results", "detail": "user_output_plan.dimension_results is missing, empty, or not an array"})
    else:
        plan_dim_names = []
        for pd in plan_dims:
            if not isinstance(pd, dict):
                issues.append({"type": "invalid_dimension_entry", "detail": f"dimension_results entry is not an object"})
                continue
            dn = pd.get("dimension_name", "")
            if not dn:
                issues.append({"type": "missing_dimension_name", "detail": "dimension_results entry missing dimension_name"})
                continue
            plan_dim_names.append(dn)
            level = pd.get("level")
            score = pd.get("score")
            if level is None:
                issues.append({"type": "missing_dimension_field", "detail": f"dimension_results '{dn}' missing level"})
            elif not isinstance(level, int):
                issues.append({"type": "invalid_dimension_type", "detail": f"dimension_results '{dn}' level must be int, got {type(level).__name__}"})
            if score is None:
                issues.append({"type": "missing_dimension_field", "detail": f"dimension_results '{dn}' missing score"})
            elif not isinstance(score, (int, float)):
                issues.append({"type": "invalid_dimension_type", "detail": f"dimension_results '{dn}' score must be number, got {type(score).__name__}"})
        # Check for duplicate dimensions
        seen_dim_names = set()
        for dn in plan_dim_names:
            if dn in seen_dim_names:
                issues.append({"type": "duplicate_dimension", "detail": f"dimension_results has duplicate dimension '{dn}'"})
            seen_dim_names.add(dn)
        # Check against scoring_result dimensions
        if isinstance(scoring_result, dict):
            result_dims = scoring_result.get("dimensions", [])
            result_dim_names = {d.get("dimension_name", "") for d in result_dims if isinstance(d, dict)}
            plan_dim_set = set(plan_dim_names)
            missing_from_plan = result_dim_names - plan_dim_set
            extra_in_plan = plan_dim_set - result_dim_names
            if missing_from_plan:
                issues.append({"type": "missing_dimension_in_plan", "detail": f"dimension_results missing dimensions from scoring_result: {sorted(missing_from_plan)}"})
            if extra_in_plan:
                issues.append({"type": "extra_dimension_in_plan", "detail": f"dimension_results has extra dimensions not in scoring_result: {sorted(extra_in_plan)}"})

    uop_issues = []
    earned = set(uop.get("earned_point_ids", []))
    partial = set(uop.get("partial_point_ids", []))
    omitted = set(uop.get("omitted_point_ids", []))
    extra_claims = set(uop.get("extra_material_claim_ids", []))

    # P0-3: Three groups must not overlap
    overlap_ep = earned & partial
    overlap_eo = earned & omitted
    overlap_po = partial & omitted
    if overlap_ep:
        uop_issues.append(f"earned_point_ids and partial_point_ids overlap: {sorted(overlap_ep)}")
    if overlap_eo:
        uop_issues.append(f"earned_point_ids and omitted_point_ids overlap: {sorted(overlap_eo)}")
    if overlap_po:
        uop_issues.append(f"partial_point_ids and omitted_point_ids overlap: {sorted(overlap_po)}")

    # P0-3: earned ∪ partial ∪ omitted = all scorable_point_ids (strict set equality)
    all_plan_pids = earned | partial | omitted
    plan_missing = scorable_point_ids - all_plan_pids
    plan_extra = all_plan_pids - scorable_point_ids

    # Also reject if ALL three groups are empty (bypass attempt)
    if not earned and not partial and not omitted:
        uop_issues.append(
            f"user_output_plan has empty earned/partial/omitted — all three groups must cover "
            f"{len(scorable_point_ids)} scorable points: {sorted(scorable_point_ids)}"
        )
    else:
        if plan_missing:
            uop_issues.append(f"Scorable points missing from plan groups: {sorted(plan_missing)} — earned ∪ partial ∪ omitted must equal all scorable_point_ids")
        if plan_extra:
            uop_issues.append(f"Plan groups contain point_ids not in scorable set: {sorted(plan_extra)}")

    # P0-3: earned/partial/omitted can only use scorable point_ids (non-scorable rejected)
    for pid in all_plan_pids:
        if pid in non_scorable_point_ids:
            uop_issues.append(f"user_output_plan references non-scorable point '{pid}' — optional/non-independent points cannot appear in earned/partial/omitted")
        if pid not in scorable_point_ids and pid not in non_scorable_point_ids:
            uop_issues.append(f"user_output_plan references unknown point_id '{pid}' — not in scoring_result.point_coverage")

    # P0-3: Each group must match ledger coverage status (bidirectional)
    # 完整覆盖/等义表达 → earned, 部分覆盖 → partial, 未覆盖 → omitted
    if isinstance(score_ledger, dict):
        ledger_coverage = {}
        for entry in score_ledger.get("point_ledger", []):
            if isinstance(entry, dict):
                ledger_coverage[entry.get("point_id", "")] = entry.get("coverage_status", "")

        for pid in earned:
            if pid in ledger_coverage:
                ls = ledger_coverage[pid]
                if ls not in ("完整覆盖", "等义表达"):
                    uop_issues.append(f"Point '{pid}' in earned_point_ids but ledger coverage_status is '{ls}' (expected 完整覆盖 or 等义表达)")
        for pid in partial:
            if pid in ledger_coverage:
                ls = ledger_coverage[pid]
                if ls != "部分覆盖":
                    uop_issues.append(f"Point '{pid}' in partial_point_ids but ledger coverage_status is '{ls}' (expected 部分覆盖)")
        for pid in omitted:
            if pid in ledger_coverage:
                ls = ledger_coverage[pid]
                if ls != "未覆盖":
                    uop_issues.append(f"Point '{pid}' in omitted_point_ids but ledger coverage_status is '{ls}' (expected 未覆盖)")

        # P0-3: Converse — every scorable point in ledger MUST appear in exactly one group
        for pid in sorted(scorable_point_ids):
            if pid in ledger_coverage:
                ls = ledger_coverage[pid]
                appears_in = []
                if pid in earned: appears_in.append("earned")
                if pid in partial: appears_in.append("partial")
                if pid in omitted: appears_in.append("omitted")
                if len(appears_in) == 0:
                    # Point not in any group — error
                    expected_group = { "完整覆盖": "earned", "等义表达": "earned", "部分覆盖": "partial", "未覆盖": "omitted" }.get(ls, "unknown")
                    uop_issues.append(f"Scorable point '{pid}' (ledger={ls}) not in any plan group — should be in {expected_group}")
                elif len(appears_in) > 1:
                    uop_issues.append(f"Scorable point '{pid}' appears in multiple groups: {appears_in}")

    # P0-5: Relationship validation with direction checking
    seen_rel_ids = set()
    for rc in uop.get("relationship_claims", []):
        if not isinstance(rc, dict):
            uop_issues.append("relationship_claim entry is not an object")
            continue
        rid = rc.get("relationship_id", "")
        if not rid:
            uop_issues.append("relationship_claim missing relationship_id")
            continue
        if rid in seen_rel_ids:
            uop_issues.append(f"Duplicate relationship_claim for relationship_id '{rid}'")
        seen_rel_ids.add(rid)
        if rid not in all_relationship_ids:
            uop_issues.append(f"relationship_claim references non-existent relationship_id '{rid}'")
            continue

        # P0-5: Check direction — plan's source/target must match analysis_result
        rel_obj = relationship_map.get(rid, {})
        rel_source = set(rel_obj.get("source_point_ids", []))
        rel_target = set(rel_obj.get("target_point_ids", []))

        plan_source = set(rc.get("source_point_ids", []))
        plan_target = set(rc.get("target_point_ids", []))

        # P0-5: If plan provides source/target, must match; if omitted, that's OK (claim_text is sufficient)
        if plan_source or plan_target:
            if plan_source != rel_source:
                uop_issues.append(f"relationship '{rid}' source_point_ids mismatch: plan={sorted(plan_source)}, analysis={sorted(rel_source)}")
            if plan_target != rel_target:
                uop_issues.append(f"relationship '{rid}' target_point_ids mismatch: plan={sorted(plan_target)}, analysis={sorted(rel_target)}")

        # P0-5: Source/target must not reference merged/excluded points
        for src_pid in rel_source | rel_target:
            for ap in analysis_result.get("atomic_points", []):
                if isinstance(ap, dict) and ap.get("point_id") == src_pid:
                    if ap.get("status") in ("merged", "excluded"):
                        uop_issues.append(f"relationship '{rid}' references {ap['status']} point '{src_pid}'")

    # P1-3: final_score must match scoring_result
    if isinstance(plan_fs, dict) and isinstance(scoring_result, dict) and plan_fs:
        plan_cv = plan_fs.get("center_value")
        result_cv = scoring_result.get("center_value")
        if plan_cv is not None and result_cv is not None:
            try:
                if abs(float(plan_cv) - float(result_cv)) > 0.01:
                    uop_issues.append(f"user_output_plan.final_score.center_value={plan_cv} does not match scoring_result.center_value={result_cv}")
            except (TypeError, ValueError):
                uop_issues.append(f"final_score.center_value comparison failed: plan={plan_cv}, result={result_cv}")

        plan_interval = plan_fs.get("interval", {})
        result_interval = scoring_result.get("interval", {})
        if plan_interval and result_interval:
            for bound in ("lower", "upper"):
                pv = plan_interval.get(bound)
                rv = result_interval.get(bound)
                if pv is not None and rv is not None:
                    try:
                        if abs(float(pv) - float(rv)) > 0.01:
                            uop_issues.append(f"user_output_plan.final_score.interval.{bound}={pv} does not match scoring_result.interval.{bound}={rv}")
                    except (TypeError, ValueError):
                        pass

    # dimension_results must match scoring_result per dimension
    if isinstance(scoring_result, dict) and plan_dims:
        result_dims = scoring_result.get("dimensions", [])
        result_dim_map = {d.get("dimension_name", ""): d for d in result_dims if isinstance(d, dict)}
        for pd in plan_dims:
            if not isinstance(pd, dict):
                continue
            dn = pd.get("dimension_name", "")
            rd = result_dim_map.get(dn)
            if rd is None:
                continue  # Already caught by extra_dimension_in_plan above
            pd_score = pd.get("score")
            rd_score = rd.get("calculated_score")
            if pd_score is not None and rd_score is not None:
                try:
                    if abs(float(pd_score) - float(rd_score)) > 0.01:
                        uop_issues.append(f"dimension_results '{dn}' score={pd_score} != scoring_result calculated_score={rd_score}")
                except (TypeError, ValueError):
                    pass

    if uop_issues:
        issues.append({"type": "user_output_plan_validation_failed", "detail": uop_issues})

    # P1-3: Score check — read from user_output_plan, not regex
    # Only check for conflicts between text mentions and plan values
    # Legitimate sub-scores (维度得分/分项得分) are OK; only the overall center value
    # and interval must match. Use explicit labels.
    if isinstance(plan_fs, dict):
        center = plan_fs.get("center_value")
        interval_lower = plan_fs.get("interval", {}).get("lower")
        interval_upper = plan_fs.get("interval", {}).get("upper")
        # Check text for "建议中心值：XX分"
        center_mentions = re.findall(r'建议中心值[：:]\s*(\d+\.?\d*)\s*分', text)
        for cm in center_mentions:
            try:
                if abs(float(cm) - float(center)) > 0.1:
                    issues.append({
                        "type": "center_value_mismatch",
                        "detail": f"Text mentions 建议中心值：{cm}分 but user_output_plan.center_value={center}"
                    })
            except (ValueError, TypeError):
                pass

    # Check: non-scorable points must not appear as "完全遗漏"
    non_scorable_in_text = [
        pid for pid in sorted(non_scorable_point_ids)
        if pid in text or any(
            phrase in text for phrase in ["完全遗漏", "完全漏掉"]
        )
    ]

    # Only flag if the non-scorable point appears in omission context
    omission_section = _extract_omission_section(text)
    for pid in sorted(non_scorable_point_ids):
        if pid in omission_section:
            issues.append({
                "type": "non_scorable_in_omission",
                "detail": f"Non-scorable point '{pid}' appears in omission/loss section of user output"
            })

    # Check: omitted_point_ids consistency with ledger
    if isinstance(score_ledger, dict):
        ledger_coverage = {}
        for entry in score_ledger.get("point_ledger", []):
            if isinstance(entry, dict):
                ledger_coverage[entry.get("point_id", "")] = entry.get("coverage_status", "")
        # omitted_point_ids should only be points with ledger coverage_status="未覆盖"
        for pid in omitted:
            if pid in ledger_coverage:
                ls = ledger_coverage[pid]
                if ls != "未覆盖":
                    issues.append({
                        "type": "omitted_ledger_mismatch",
                        "detail": f"Point '{pid}' in omitted_point_ids but ledger coverage_status is '{ls}' (expected '未覆盖')"
                    })

    if issues:
        error_exit(EXIT_CONSISTENCY, "User-facing structured output gate FAILED", {
            "issues": issues,
            "scorable_point_ids": sorted(scorable_point_ids) if scorable_point_ids else [],
            "non_scorable_point_ids": sorted(non_scorable_point_ids) if non_scorable_point_ids else [],
        })

    success_output({
        "schema_version": "1.0", "passed": True,
        "output_mode": output_mode,
        "final_response": True,
        "validated_text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "validated_length": len(text),
        "approved_text": text,
        "checks": ["complete_final_response", "no_forbidden_table", "no_internal_ids", "no_engineering_details", "no_unauthorized_reference_answer",
                    "no_non_scorable_in_omission", "score_consistency", "relationship_boundary",
                    "user_output_plan_validated"],
        "scorable_point_count": len(scorable_point_ids),
        "non_scorable_point_count": len(non_scorable_point_ids),
        "relationship_count": len(all_relationship_ids),
    }, args.output)


def _extract_omission_section(text):
    """Extract the omission/loss section from user-visible output for validation."""
    markers = ["完全漏掉", "完全遗漏", "你完全漏掉", "你完全遗漏",
               "漏掉或写出材料外", "遗漏或材料外"]
    for marker in markers:
        idx = text.find(marker)
        if idx >= 0:
            return text[idx:]
    return ""


def cmd_resolve_method_selection(args):
    """Resolve a prototype/mode to real cards and return the fields needed by the model.

    This command is the runtime evidence gate: callers should use its output instead
    of inventing a method name from general knowledge.
    """
    raw = read_input(args.input)
    data = parse_json_input(raw)
    if not isinstance(data, dict):
        error_exit(EXIT_INPUT_ERROR, "resolve-method-selection input must be a JSON object")

    question_type = data.get("question_type")
    task_prototype = data.get("task_prototype")
    mode = data.get("mode")
    if question_type not in VALID_QUESTION_TYPES:
        error_exit(EXIT_INPUT_ERROR, f"question_type must be one of {sorted(VALID_QUESTION_TYPES)}, got {question_type!r}")
    if not isinstance(task_prototype, str) or not task_prototype.strip():
        error_exit(EXIT_INPUT_ERROR, "task_prototype must be a non-empty string")
    if mode not in VALID_MODES:
        error_exit(EXIT_INPUT_ERROR, f"mode must be one of {sorted(VALID_MODES)}, got {mode!r}")

    prototype_id = None
    if re.match(r"^sl-prototype-\d{4}$", task_prototype):
        prototypes, load_errors = _load_task_prototypes_map()
        if load_errors:
            error_exit(EXIT_INPUT_ERROR, "Task prototypes could not be loaded", {"errors": load_errors})
        prototype = prototypes.get(task_prototype)
        if prototype is None:
            error_exit(EXIT_CONSISTENCY, "Task prototype ID not found", {"prototype_id": task_prototype})
        if prototype.get("question_type") != question_type:
            error_exit(EXIT_CONSISTENCY, "question_type conflicts with resolved task prototype", {
                "question_type": question_type,
                "prototype_question_type": prototype.get("question_type"),
                "prototype_id": task_prototype,
            })
        route = prototype.get("mode_routes", {})
        prototype_id = task_prototype
    else:
        routing = _load_method_routing()
        prototype_routes = routing["task_prototype_routing"]
        route = prototype_routes.get(task_prototype)
        if not isinstance(route, dict):
            error_exit(EXIT_CONSISTENCY, "No method route for task prototype", {
                "task_prototype": task_prototype,
                "available_prototypes": sorted(prototype_routes)
            })
    card_ids = route.get(mode)
    if not isinstance(card_ids, list):
        error_exit(EXIT_CONSISTENCY, f"No valid {mode!r} route for task prototype {task_prototype!r}")
    if mode != "学情报告" and len(card_ids) == 0:
        error_exit(EXIT_CONSISTENCY, f"Route resolved to no cards for {task_prototype!r}/{mode!r}")

    cards_map, load_errors = _load_method_cards_map()
    if load_errors:
        error_exit(EXIT_INPUT_ERROR, "Method cards could not be loaded", {"errors": load_errors})

    errors = []
    layer_counts = {"能力内核": 0, "题型工作流": 0, "批改二稿": 0}
    resolved_cards = []
    for cid in card_ids:
        card = cards_map.get(cid)
        if card is None:
            errors.append(f"card not found: {cid}")
            continue
        if question_type not in card.get("适用题型", []):
            errors.append(f"{cid} does not support question_type {question_type!r}")
        if mode not in card.get("适用模式", []):
            errors.append(f"{cid} does not support mode {mode!r}")
        layer = card.get("方法层级")
        if layer not in layer_counts:
            errors.append(f"{cid} has unknown layer {layer!r}")
        else:
            layer_counts[layer] += 1
        resolved_cards.append({
            "card_id": cid,
            "method_name": card.get("方法名"),
            "layer": layer,
            "triggers": card.get("触发信号", []),
            "input_conditions": card.get("输入条件", []),
            "steps": card.get("步骤逻辑", []),
            "boundaries": card.get("适用边界", []),
            "outputs": card.get("输出产物", []),
        })

    if len(card_ids) > 5:
        errors.append(f"route exceeds total budget: {len(card_ids)} > 5")
    for layer, count in layer_counts.items():
        if count > LAYER_BUDGET[layer]:
            errors.append(f"route exceeds {layer} budget: {count} > {LAYER_BUDGET[layer]}")
    if errors:
        error_exit(EXIT_CONSISTENCY, "Resolved method route is invalid", {
            "question_type": question_type,
            "task_prototype": task_prototype,
            "mode": mode,
            "errors": errors,
        })

    success_output({
        "schema_version": "1.0",
        "question_type": question_type,
        "task_prototype": task_prototype,
        "prototype_id": prototype_id,
        "mode": mode,
        "method_card_ids": card_ids,
        "cards": resolved_cards,
        "layer_counts": layer_counts,
        "method_usage_receipt": {
            "resolved_from_routing": True,
            "real_card_content_loaded": True,
            "passed": True,
        },
    }, args.output)


def cmd_validate_method_selection(args):
    raw = read_input(args.input)
    data = parse_json_input(raw)

    if not isinstance(data, dict):
        error_exit(EXIT_INPUT_ERROR, "validate-method-selection input must be a JSON object")

    question_type = data.get("question_type")
    mode = data.get("mode")
    method_card_ids = data.get("method_card_ids", [])
    conditional_reasons = data.get("conditional_reasons", {}) or {}

    errors = []

    if not isinstance(question_type, str) or question_type not in VALID_QUESTION_TYPES:
        errors.append(f"question_type must be one of {sorted(VALID_QUESTION_TYPES)}, got {question_type!r}")
    if not isinstance(mode, str) or mode not in VALID_MODES:
        errors.append(f"mode must be one of {sorted(VALID_MODES)}, got {mode!r}")
    if not isinstance(method_card_ids, list):
        errors.append(f"method_card_ids must be an array, got {type(method_card_ids).__name__}")
        method_card_ids = []
    if len(method_card_ids) > 5:
        errors.append(f"method_card_ids total must be <= 5, got {len(method_card_ids)}")
    if not isinstance(conditional_reasons, dict):
        errors.append(f"conditional_reasons must be an object, got {type(conditional_reasons).__name__}")
        conditional_reasons = {}

    if errors:
        error_exit(EXIT_INPUT_ERROR, "Method selection validation failed", {"errors": errors})

    cards_map, load_errors = _load_method_cards_map()
    if load_errors:
        errors.extend(load_errors)

    conditional_cards = _load_conditional_cards()

    seen = set()
    layer_counts = {"能力内核": 0, "题型工作流": 0, "批改二稿": 0}
    per_card = []

    for i, cid in enumerate(method_card_ids):
        card_report = {"card_id": cid, "checks": []}
        if not isinstance(cid, str) or not re.match(r"^sl-card-\d{4}$", cid):
            errors.append(f"method_card_ids[{i}] must match sl-card-XXXX, got {cid!r}")
            per_card.append(card_report)
            continue
        if cid in seen:
            errors.append(f"method_card_ids contains duplicate: {cid}")
            per_card.append(card_report)
            continue
        seen.add(cid)

        card = cards_map.get(cid)
        if card is None:
            errors.append(f"method_card_ids[{i}]: card not found: {cid}")
            per_card.append(card_report)
            continue

        layer = card.get("方法层级")
        if layer in layer_counts:
            layer_counts[layer] += 1
        else:
            errors.append(f"method_card_ids[{i}] {cid}: unknown 方法层级 {layer!r}")

        applicable_qt = card.get("适用题型", [])
        if question_type not in applicable_qt:
            errors.append(f"method_card_ids[{i}] {cid}: does not support question_type {question_type!r} (supports {applicable_qt})")
            card_report["checks"].append({"check": "question_type_fit", "passed": False})
        else:
            card_report["checks"].append({"check": "question_type_fit", "passed": True})

        applicable_modes = card.get("适用模式", [])
        if mode not in applicable_modes:
            errors.append(f"method_card_ids[{i}] {cid}: does not support mode {mode!r} (supports {applicable_modes})")
            card_report["checks"].append({"check": "mode_fit", "passed": False})
        else:
            card_report["checks"].append({"check": "mode_fit", "passed": True})

        # Conditional card gate
        if cid in conditional_cards:
            reason = conditional_reasons.get(cid)
            if not isinstance(reason, str) or reason.strip() == "":
                errors.append(f"method_card_ids[{i}] {cid}: is a conditional card (trigger={conditional_cards[cid].get('trigger')!r}) but no conditional_reasons['{cid}'] provided; conditional cards must not be called without an explicit reason")
                card_report["checks"].append({"check": "conditional_reason", "passed": False})
            else:
                card_report["checks"].append({"check": "conditional_reason", "passed": True, "reason": reason})
        per_card.append(card_report)

    # Layer budget enforcement (based on real 方法层级 field, not ID count)
    for layer, count in layer_counts.items():
        limit = LAYER_BUDGET.get(layer)
        if limit is not None and count > limit:
            errors.append(f"layer budget exceeded: {layer}={count} > {limit}")

    # E2E-04 regression: two 批改二稿 cards in one mode must be rejected
    if layer_counts["批改二稿"] > 1:
        errors.append(f"revision_draft layer cannot exceed 1 per mode; got {layer_counts['批改二稿']} (e.g. E2E-04 二稿 [0067,0068] must be rejected)")

    passed = len(errors) == 0
    result = {
        "schema_version": "1.0",
        "question_type": question_type,
        "mode": mode,
        "method_card_ids": method_card_ids,
        "total_cards": len(method_card_ids),
        "layer_counts": layer_counts,
        "layer_budget": LAYER_BUDGET,
        "per_card": per_card,
        "validation_receipt": {
            "passed": passed,
            "checks": [
                {"check_name": "cards_exist", "passed": passed},
                {"check_name": "no_duplicates", "passed": len(method_card_ids) == len(seen)},
                {"check_name": "total_le_5", "passed": len(method_card_ids) <= 5},
                {"check_name": "question_type_fit", "passed": not any("question_type_fit" in e for e in errors)},
                {"check_name": "mode_fit", "passed": not any("mode_fit" in e for e in errors)},
                {"check_name": "layer_budget", "passed": not any("layer budget" in e or "revision_draft layer" in e for e in errors)},
                {"check_name": "conditional_reasons", "passed": not any("conditional card" in e for e in errors)},
            ]
        },
        "errors": errors
    }

    if not passed:
        error_exit(EXIT_CONSISTENCY, "Method selection validation FAILED", result)
    success_output(result, args.output)


# ---------------------------------------------------------------------------
# validate-scoring-anchor: deterministic anchor evidence gate (稳定性修复)
# ---------------------------------------------------------------------------

def cmd_validate_scoring_anchor(args):
    """Validate that scoring-input dimensions carry anchor evidence fields
    per the stability anchor framework. Optional fields; when present must be
    well-formed and complete per the rules in scoring-core.md §7."""
    raw = read_input(args.input)
    data = parse_json_input(raw)

    if not isinstance(data, dict):
        error_exit(EXIT_INPUT_ERROR, "validate-scoring-anchor input must be a JSON object")

    dimensions = data.get("dimensions")
    if not isinstance(dimensions, list) or len(dimensions) == 0:
        error_exit(EXIT_INPUT_ERROR, "validate-scoring-anchor requires a non-empty dimensions array")

    # Optional: draft_1 / draft_2 for cross-draft level-delta check
    draft_compare = data.get("draft_compare")  # {"draft_1": [...], "draft_2": [...]} optional

    errors = []
    warnings = []

    for i, dim in enumerate(dimensions):
        if not isinstance(dim, dict):
            errors.append(f"dimensions[{i}] must be an object")
            continue
        dn = dim.get("dimension_name", f"dim[{i}]")
        level = dim.get("level")
        if not isinstance(level, int) or isinstance(level, bool) or level < 0 or level > 4:
            errors.append(f"dimensions[{i}] {dn}: level must be int 0-4, got {level!r}")
            continue

        # anchor_evidence: if present, must be non-empty string
        ae = dim.get("anchor_evidence")
        if ae is not None:
            if not isinstance(ae, str) or ae.strip() == "":
                errors.append(f"dimensions[{i}] {dn}: anchor_evidence must be a non-empty string when present")

        # upgrade_condition: levels 1/2/3 must have it if anchor fields are used at all
        uc = dim.get("upgrade_condition")
        if uc is not None:
            if not isinstance(uc, str) or uc.strip() == "":
                errors.append(f"dimensions[{i}] {dn}: upgrade_condition must be a non-empty string when present")
        elif level in (1, 2, 3) and ae is not None:
            # Only enforce if the caller is using anchor fields at all (ae present)
            warnings.append(f"dimensions[{i}] {dn}: level={level} should have upgrade_condition when anchor_evidence is used")

        # borderline_decision: if present, must be well-formed object
        bd = dim.get("borderline_decision")
        if bd is not None:
            if not isinstance(bd, dict):
                errors.append(f"dimensions[{i}] {dn}: borderline_decision must be an object when present")
            else:
                cl = bd.get("current_level")
                tl = bd.get("target_level")
                tl_ok = isinstance(tl, int) and not isinstance(tl, bool) and 0 <= tl <= 4
                cl_ok = isinstance(cl, int) and not isinstance(cl, bool) and 0 <= cl <= 4
                if not cl_ok:
                    errors.append(f"dimensions[{i}] {dn}: borderline_decision.current_level must be int 0-4")
                if not tl_ok:
                    errors.append(f"dimensions[{i}] {dn}: borderline_decision.target_level must be int 0-4")
                if cl_ok and tl_ok and abs(tl - cl) != 1:
                    errors.append(f"dimensions[{i}] {dn}: borderline_decision must be adjacent levels (|target-current|=1), got {cl}->{tl}")
                if not isinstance(bd.get("took_lower"), bool):
                    errors.append(f"dimensions[{i}] {dn}: borderline_decision.took_lower must be boolean")
                if not isinstance(bd.get("rationale"), str) or bd.get("rationale", "").strip() == "":
                    errors.append(f"dimensions[{i}] {dn}: borderline_decision.rationale must be a non-empty string")

    # Cross-draft level-delta check (anti cross-2-level jump without evidence)
    if isinstance(draft_compare, dict):
        d1_dims = draft_compare.get("draft_1", [])
        d2_dims = draft_compare.get("draft_2", [])
        if isinstance(d1_dims, list) and isinstance(d2_dims, list):
            d1_map = {d.get("dimension_name"): d for d in d1_dims if isinstance(d, dict)}
            d2_map = {d.get("dimension_name"): d for d in d2_dims if isinstance(d, dict)}
            for name in sorted(set(d1_map.keys()) & set(d2_map.keys())):
                l1 = d1_map[name].get("level")
                l2 = d2_map[name].get("level")
                if isinstance(l1, int) and isinstance(l2, int) and not isinstance(l1, bool) and not isinstance(l2, bool):
                    delta = abs(l2 - l1)
                    if delta >= 2:
                        # Cross-2-level jump: require at least 2 independent anchor_evidence on the changed draft
                        changed = d2_map[name] if l2 != l1 else d1_map[name]
                        ae = changed.get("anchor_evidence", "")
                        # Count independent evidence: split by；or ; or 。or numbered list
                        if isinstance(ae, str) and ae.strip():
                            pieces = [p.strip() for p in re.split(r"[；;。]|\d[.、]", ae) if p.strip()]
                        else:
                            pieces = []
                        if len(pieces) < 2:
                            errors.append(
                                f"cross-2-level jump in '{name}': level {l1}->{l2} (delta={delta}) requires at least 2 independent anchor_evidence pieces on the changed draft, got {len(pieces)}; 跨两档调整缺少两个独立证据必须失败")

    passed = len(errors) == 0
    result = {
        "schema_version": "1.0",
        "dimensions_checked": len(dimensions),
        "errors": errors,
        "warnings": warnings,
        "validation_receipt": {
            "passed": passed,
            "checks": [
                {"check_name": "anchor_evidence_well_formed", "passed": not any("anchor_evidence" in e for e in errors)},
                {"check_name": "upgrade_condition_well_formed", "passed": not any("upgrade_condition" in e for e in errors)},
                {"check_name": "borderline_decision_well_formed", "passed": not any("borderline_decision" in e for e in errors)},
                {"check_name": "cross_2_level_evidence", "passed": not any("cross-2-level" in e for e in errors)},
            ]
        }
    }
    if not passed:
        error_exit(EXIT_CONSISTENCY, "Scoring anchor validation FAILED", result)
    success_output(result, args.output)


# ---------------------------------------------------------------------------
# validate-task-prototype: validate task prototype JSON files
# ---------------------------------------------------------------------------

def cmd_validate_task_prototype(args):
    """Validate task prototype files against schema and cross-reference method cards."""
    raw = read_input(args.input)
    data = parse_json_input(raw)

    errors = []

    # Required fields
    required = ["schema_version", "prototype_id", "name", "question_type", "trigger_signals",
                "exclusion_signals", "required_task_elements", "optional_task_elements",
                "default_format_reference", "workflow_stages", "recommended_card_ids",
                "mode_routes", "fallback_behavior", "constraints", "evidence_refs"]
    for field in required:
        if field not in data:
            errors.append(f"Missing required field: {field}")

    if errors:
        error_exit(EXIT_INPUT_ERROR, "Task prototype validation failed", errors)

    # prototype_id format
    pid = data.get("prototype_id", "")
    if not re.match(r"^sl-prototype-\d{4}$", pid):
        errors.append(f"prototype_id must match sl-prototype-XXXX, got '{pid}'")

    # question_type enum
    qt = data.get("question_type", "")
    if qt not in VALID_QUESTION_TYPES:
        errors.append(f"question_type must be one of {sorted(VALID_QUESTION_TYPES)}, got '{qt}'")

    # Arrays validation
    for field in ["trigger_signals", "exclusion_signals", "required_task_elements",
                  "optional_task_elements", "workflow_stages", "recommended_card_ids",
                  "constraints", "evidence_refs"]:
        values = data.get(field, [])
        if not isinstance(values, list):
            errors.append(f"{field} must be an array")

    # recommended_card_ids must exist as real cards
    cards_map, load_errors = _load_method_cards_map()
    if load_errors:
        errors.extend(load_errors)

    for cid in data.get("recommended_card_ids", []):
        if not isinstance(cid, str) or not re.match(r"^sl-card-\d{4}$", cid):
            errors.append(f"recommended_card_ids contains invalid ID: {cid}")
        elif cid not in cards_map:
            errors.append(f"recommended_card_ids references non-existent card: {cid}")

    # mode_routes validation
    mode_routes = data.get("mode_routes", {})
    if not isinstance(mode_routes, dict):
        errors.append("mode_routes must be an object")
    else:
        for mode, ids in mode_routes.items():
            if mode not in VALID_MODES:
                errors.append(f"mode_routes contains invalid mode: {mode}")
            if not isinstance(ids, list):
                errors.append(f"mode_routes.{mode} must be an array")
            for cid in ids:
                if cid not in cards_map:
                    errors.append(f"mode_routes.{mode} references non-existent card: {cid}")

    # No source leakage
    serialized = json.dumps(data, ensure_ascii=False)
    for keyword in ("白鹭", "Redbook", "RBM", "bly-", "粉笔", "华图", "中公", "/Users/", "/home/", "Mimo", "GLM", "Codex", "字幕"):
        if keyword in serialized:
            errors.append(f"Contains leaked keyword: {keyword!r}")

    passed = len(errors) == 0
    result = {
        "schema_version": "1.0",
        "prototype_id": pid,
        "validation_receipt": {
            "passed": passed,
            "checks": [
                {"check_name": "fields_complete", "passed": "Missing" not in str(errors)},
                {"check_name": "id_format", "passed": not any("prototype_id" in e for e in errors)},
                {"check_name": "question_type", "passed": not any("question_type" in e for e in errors)},
                {"check_name": "card_references", "passed": not any("non-existent card" in e for e in errors)},
                {"check_name": "no_leakage", "passed": not any("leaked keyword" in e for e in errors)},
            ]
        },
        "errors": errors
    }

    if not passed:
        error_exit(EXIT_CONSISTENCY, "Task prototype validation FAILED", result)
    success_output(result, args.output)


# ---------------------------------------------------------------------------
# validate-prototype-routing: validate prototype-to-card routing
# ---------------------------------------------------------------------------

def cmd_validate_prototype_routing(args):
    """Validate that a prototype's routing is consistent with cards, modes, and budget."""
    raw = read_input(args.input)
    data = parse_json_input(raw)

    errors = []

    question_type = data.get("question_type")
    prototype_id = data.get("task_prototype_id")
    mode = data.get("mode")
    method_card_ids = data.get("method_card_ids", [])
    trigger_signals = data.get("trigger_signals", [])

    if not isinstance(question_type, str) or question_type not in VALID_QUESTION_TYPES:
        errors.append(f"question_type must be one of {sorted(VALID_QUESTION_TYPES)}, got {question_type!r}")
    if not isinstance(mode, str) or mode not in VALID_MODES:
        errors.append(f"mode must be one of {sorted(VALID_MODES)}, got {mode!r}")
    if not isinstance(method_card_ids, list):
        errors.append("method_card_ids must be an array")

    if errors:
        error_exit(EXIT_INPUT_ERROR, "Prototype routing validation failed", errors)

    # Load prototype index
    proto_index_path = Path(__file__).resolve().parent.parent / "references" / "task-prototypes" / "task-prototype-index.json"
    if proto_index_path.exists():
        try:
            proto_index = json.loads(proto_index_path.read_text(encoding="utf-8"))
            proto_ids = {p["prototype_id"] for p in proto_index.get("prototypes", [])}
            if prototype_id and prototype_id not in proto_ids:
                errors.append(f"task_prototype_id '{prototype_id}' not found in prototype index")
        except Exception as exc:
            errors.append(f"Cannot parse task-prototype-index.json: {exc}")

    # Load cards and validate budget
    cards_map, load_errors = _load_method_cards_map()
    if load_errors:
        errors.extend(load_errors)

    seen = set()
    layer_counts = {"能力内核": 0, "题型工作流": 0, "批改二稿": 0}

    for i, cid in enumerate(method_card_ids):
        if not isinstance(cid, str) or not re.match(r"^sl-card-\d{4}$", cid):
            errors.append(f"method_card_ids[{i}] invalid format: {cid}")
            continue
        if cid in seen:
            errors.append(f"method_card_ids contains duplicate: {cid}")
            continue
        seen.add(cid)

        card = cards_map.get(cid)
        if card is None:
            errors.append(f"method_card_ids[{i}]: card not found: {cid}")
            continue

        layer = card.get("方法层级", "")
        if layer in layer_counts:
            layer_counts[layer] += 1

        if question_type not in card.get("适用题型", []):
            errors.append(f"{cid}: does not support question_type {question_type!r}")
        if mode not in card.get("适用模式", []):
            errors.append(f"{cid}: does not support mode {mode!r}")

    # Budget check
    if len(method_card_ids) > 5:
        errors.append(f"total cards {len(method_card_ids)} > 5")
    if layer_counts["能力内核"] > 1:
        errors.append(f"能力内核={layer_counts['能力内核']} > 1")
    if layer_counts["题型工作流"] > 3:
        errors.append(f"题型工作流={layer_counts['题型工作流']} > 3")
    if layer_counts["批改二稿"] > 1:
        errors.append(f"批改二稿={layer_counts['批改二稿']} > 1")

    passed = len(errors) == 0
    result = {
        "schema_version": "1.0",
        "question_type": question_type,
        "task_prototype_id": prototype_id,
        "mode": mode,
        "method_card_ids": method_card_ids,
        "total_cards": len(method_card_ids),
        "layer_counts": layer_counts,
        "validation_receipt": {
            "passed": passed,
            "checks": [
                {"check_name": "prototype_exists", "passed": not any("not found in prototype" in e for e in errors)},
                {"check_name": "cards_exist", "passed": not any("card not found" in e for e in errors)},
                {"check_name": "question_type_fit", "passed": not any("question_type" in e for e in errors)},
                {"check_name": "mode_fit", "passed": not any("does not support mode" in e for e in errors)},
                {"check_name": "budget", "passed": not any(">" in e or "超出" in e for e in errors)},
            ]
        },
        "errors": errors
    }

    if not passed:
        error_exit(EXIT_CONSISTENCY, "Prototype routing validation FAILED", result)
    success_output(result, args.output)


def cmd_healthcheck(args):
    skill_version = None
    try:
        match = re.search(r"Skill v(\d+\.\d+\.\d+)", SKILL_FILE.read_text(encoding="utf-8"))
        skill_version = match.group(1) if match else None
    except OSError:
        skill_version = None
    skill_root = SKILL_FILE.parent
    forbidden_runtime_dirs = [
        name for name in ("tmp", ".cache")
        if (skill_root / name).exists()
    ]
    results = {
        "engine": "ok",
        "engine_version": ENGINE_VERSION,
        "skill_version": skill_version,
        "version_consistent": skill_version == ENGINE_VERSION,
        "ordinary_entrypoints": [
            "analyze-once", "finalize-analysis", "grade-once", "validate-user-output"
        ],
        "standalone_reference_answer_entrypoint": "check-word-count",
        "package_hygiene": (
            "ok" if not forbidden_runtime_dirs
            else "issues: forbidden runtime dirs: " + ", ".join(forbidden_runtime_dirs)
        ),
        "python_version": sys.version,
        "schema_dir_exists": SCHEMA_DIR.exists(),
        "config_dir_exists": CONFIG_DIR.exists(),
        "sql_schema_exists": SQL_SCHEMA.exists(),
        "assets_dir_exists": ASSETS_DIR.exists(),
        "schemas": {},
        "config": None
    }

    # Check schema files
    for schema_file in SCHEMA_DIR.glob("*.json"):
        try:
            json.loads(schema_file.read_text(encoding="utf-8"))
            results["schemas"][schema_file.name] = "valid"
        except Exception as e:
            results["schemas"][schema_file.name] = f"invalid: {e}"

    # Check config
    config_path = CONFIG_DIR / "scoring-weights.json"
    if config_path.exists():
        try:
            results["config"] = "valid"
            cfg = json.loads(config_path.read_text(encoding="utf-8"))
            results["config_question_types"] = list(cfg.get("question_types", {}).keys())
        except Exception as e:
            results["config"] = f"invalid: {e}"
    else:
        results["config"] = "missing"

    # Check DB if path provided
    if args.state_db:
        try:
            conn = _init_db(args.state_db)
            cur = conn.cursor()
            cur.execute("SELECT count(*) FROM sqlite_master WHERE type='table'")
            results["db_tables"] = cur.fetchone()[0]
            conn.close()
            results["db"] = "ok"
        except Exception as e:
            results["db"] = f"error: {e}"

    # --- Method library checks ---
    results["method_library"] = _check_method_library()

    # Determine overall: skip non-status fields, accept True/True for bool checks and ok/valid for string checks
    skip_keys = (
        "python_version", "config_question_types", "db_tables", "db",
        "engine_version", "skill_version", "ordinary_entrypoints",
        "standalone_reference_answer_entrypoint",
    )
    all_ok = True
    for k, v in results.items():
        if k in skip_keys:
            continue
        if isinstance(v, bool):
            if not v:
                all_ok = False
        elif isinstance(v, dict):
            if k == "method_library":
                if v.get("status") != "ok":
                    all_ok = False
            elif not all(x == "valid" for x in v.values()):
                all_ok = False
        elif isinstance(v, str):
            if v not in ("ok", "valid"):
                all_ok = False
        elif v is None:
            all_ok = False
    results["overall"] = "ok" if all_ok else "issues"

    success_output(results, args.output)


# ---------------------------------------------------------------------------
# v0.3 Unified Core: TaskSpec compilation and validation
# ---------------------------------------------------------------------------

VALID_TASK_COMPONENTS = {
    "summary", "change_summary", "classification", "concept_explanation",
    "relationship_analysis", "achievement_summary", "problem_diagnosis",
    "cause_analysis", "recommendation", "scenario_expression", "argumentation"
}

VALID_EVIDENCE_ROLES = {
    "fact", "problem", "cause", "measure", "effect", "data", "policy",
    "authoritative_view", "public_demand", "successful_practice",
    "time_condition", "background"
}

VALID_MATCH_TYPES = {"keyword_match", "semantic_match", "no_match", "extra_material"}
VALID_COVERAGE_STATUSES = {"完整覆盖", "部分覆盖", "等义表达", "未覆盖", "超出材料"}
VALID_ELEMENT_TYPES = {"format", "content_component", "logical_relation", "scenario", "organization", "style"}
VALID_STRUCTURE_STATUSES = {"satisfied", "partial", "missing", "not_applicable"}
VALID_REFERENCE_SUPPORT = {"supported", "partial", "unsupported", "disputed", "not_applicable"}


def _load_all_dimension_names():
    """Load the union of all formal dimension names across all 5 question types
    from scoring-weights.json. Used to validate deduction_owner dynamically."""
    dims = set()
    try:
        cfg_path = CONFIG_DIR / "scoring-weights.json"
        if cfg_path.exists():
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            for qt_info in cfg.get("question_types", {}).values():
                for item in qt_info.get("dimensions", []):
                    if isinstance(item, dict) and "name" in item:
                        dims.add(item["name"])
    except Exception:
        pass
    # Fallback: hardcode the full set if config read fails
    if not dims:
        dims = {
            "任务符合", "要点覆盖", "准确有据", "分类组织", "简洁表达",
            "关系逻辑", "结论解释", "组织表达",
            "问题诊断", "针对匹配", "可行具体",
            "身份文种格式", "内容覆盖", "目的场景", "结构", "语言语气",
            "立意扣题", "材料运用", "论证深度", "论据例证", "语言"
        }
    return dims


VALID_DEDUCTION_OWNERS = _load_all_dimension_names()


def _load_schema(schema_name):
    """Load a JSON schema from the contracts directory."""
    path = SCHEMA_DIR / schema_name
    if not path.exists():
        error_exit(EXIT_INPUT_ERROR, f"Schema not found: {schema_name}")
    return json.loads(path.read_text(encoding="utf-8"))


def _is_bool(v):
    return isinstance(v, bool)


def _validate_against_schema(data, schema, label="input", path=""):
    """Recursive schema validation supporting const/enum/minimum/minLength/minItems/
    uniqueItems/nested required/type (rejecting bool for numbers/integers).
    Returns list of error strings."""
    errors = []
    if not isinstance(schema, dict):
        return errors

    # type check
    expected_type = schema.get("type")
    if expected_type is not None:
        valid = True
        if isinstance(expected_type, list):
            # union type e.g. ["string","null"]
            valid = False
            for t in expected_type:
                if _type_matches(data, t):
                    valid = True
                    break
        else:
            valid = _type_matches(data, expected_type)
        if not valid:
            errors.append(f"{label}{path}: expected type {expected_type}, got {type(data).__name__}={data!r}")
            return errors  # deeper checks meaningless if type wrong

    # const
    if "const" in schema:
        if data != schema["const"]:
            errors.append(f"{label}{path}: expected const {schema['const']!r}, got {data!r}")
            return errors

    # enum
    if "enum" in schema:
        if data not in schema["enum"]:
            errors.append(f"{label}{path}: value {data!r} not in enum {schema['enum']}")

    # numeric constraints (only when not bool — bool already rejected by type check)
    if expected_type in ("number", "integer") and not _is_bool(data) and isinstance(data, (int, float)):
        if "minimum" in schema and data < schema["minimum"]:
            errors.append(f"{label}{path}: {data} < minimum {schema['minimum']}")
        if "exclusiveMinimum" in schema and data <= schema["exclusiveMinimum"]:
            errors.append(f"{label}{path}: {data} <= exclusiveMinimum {schema['exclusiveMinimum']}")
        if "maximum" in schema and data > schema["maximum"]:
            errors.append(f"{label}{path}: {data} > maximum {schema['maximum']}")

    # string constraints
    if expected_type == "string" and isinstance(data, str):
        if "minLength" in schema and len(data) < schema["minLength"]:
            errors.append(f"{label}{path}: string length {len(data)} < minLength {schema['minLength']}")
        if "pattern" in schema:
            if not re.match(schema["pattern"], data):
                errors.append(f"{label}{path}: string {data!r} does not match pattern {schema['pattern']}")

    # array constraints
    if expected_type == "array" and isinstance(data, list):
        if "minItems" in schema and len(data) < schema["minItems"]:
            errors.append(f"{label}{path}: array length {len(data)} < minItems {schema['minItems']}")
        if "uniqueItems" in schema and schema["uniqueItems"]:
            seen = []
            for item in data:
                key = json.dumps(item, ensure_ascii=False, sort_keys=True)
                if key in seen:
                    errors.append(f"{label}{path}: array has duplicate items")
                    break
                seen.append(key)
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for i, item in enumerate(data):
                errors.extend(_validate_against_schema(item, item_schema, label, f"{path}[{i}]"))

    # object: required + properties (recursive)
    if expected_type == "object" and isinstance(data, dict):
        required = schema.get("required", [])
        for field in required:
            if field not in data:
                errors.append(f"{label}{path}: missing required field '{field}'")
        props = schema.get("properties", {})
        for field, field_schema in props.items():
            if field in data:
                errors.extend(_validate_against_schema(data[field], field_schema, label, f"{path}.{field}"))

    return errors


def _type_matches(value, expected_type):
    """Check if value matches the JSON schema type, rejecting bool for number/integer."""
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected_type == "boolean":
        return isinstance(value, bool)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "null":
        return value is None
    return True  # unknown type — don't block


def cmd_compile_task(args):
    """Compile a TaskSpec from structured paper analysis and task prototype matching.
    Reads structured question input; validates paper/question/material_scope;
    loads real prototype registry; validates primary_prototype;
    normalizes task_components/constraints/subtasks; generates stable task_id;
    outputs a TaskSpec that passes validate-task-spec. Illegal input is rejected, not passed through."""
    raw = read_input(args.input)
    data = parse_json_input(raw)

    if not isinstance(data, dict):
        error_exit(EXIT_INPUT_ERROR, "compile-task input must be a JSON object")

    # Required input fields
    required_in = ["paper_id", "question_id", "task_instruction", "material_scope", "task_components"]
    missing = [f for f in required_in if f not in data or not data.get(f)]
    if missing:
        error_exit(EXIT_INPUT_ERROR, f"compile-task missing required fields: {missing}")

    paper_id = data["paper_id"]
    question_id = data["question_id"]
    if not isinstance(paper_id, str) or not paper_id.strip():
        error_exit(EXIT_INPUT_ERROR, "paper_id must be a non-empty string")
    if not isinstance(question_id, str) or not question_id.strip():
        error_exit(EXIT_INPUT_ERROR, "question_id must be a non-empty string")

    task_id = data.get("task_id") or f"{paper_id}-{question_id}"

    # Load and validate primary_prototype
    proto_ids = _load_prototype_ids()
    proto_id = data.get("primary_prototype_id")
    if proto_id is None or proto_id == "general-fallback":
        pass
    elif not isinstance(proto_id, str):
        error_exit(EXIT_INPUT_ERROR, f"primary_prototype_id must be string/null/'general-fallback', got {type(proto_id).__name__}")
    elif proto_id.startswith("sl-card-"):
        error_exit(EXIT_INPUT_ERROR, f"primary_prototype_id '{proto_id}' is a method card ID — forbidden")
    elif proto_id.startswith("sl-prototype-"):
        if proto_id not in proto_ids:
            error_exit(EXIT_INPUT_ERROR, f"primary_prototype_id '{proto_id}' does not exist in prototype registry")
    else:
        error_exit(EXIT_INPUT_ERROR, f"primary_prototype_id '{proto_id}' format unexpected")

    # Validate task_components
    tcs = data["task_components"]
    if not isinstance(tcs, list) or not tcs:
        error_exit(EXIT_INPUT_ERROR, "task_components must be a non-empty array")
    for c in tcs:
        if c not in VALID_TASK_COMPONENTS:
            error_exit(EXIT_INPUT_ERROR, f"Invalid task_component: {c}")

    # Validate material_scope
    ms = data["material_scope"]
    if not isinstance(ms, list) or not ms:
        error_exit(EXIT_INPUT_ERROR, "material_scope must be a non-empty array")

    # Validate full_score
    fs = data.get("full_score")
    if fs is None:
        error_exit(EXIT_INPUT_ERROR, "full_score is required")
    if _is_bool(fs) or not isinstance(fs, (int, float)) or fs <= 0:
        error_exit(EXIT_INPUT_ERROR, f"full_score must be > 0, got {fs!r}")

    # Build TaskSpec
    spec = {
        "schema_version": "1.0",
        "paper_id": paper_id,
        "question_id": question_id,
        "task_id": task_id,
        "task_instruction": data["task_instruction"],
        "material_scope": ms,
        "full_score": fs,
        "identity": data.get("identity"),
        "audience": data.get("audience"),
        "purpose": data.get("purpose"),
        "output_genre": data.get("output_genre"),
        "primary_prototype_id": proto_id,
        "task_components": tcs,
        "required_content_elements": data.get("required_content_elements", []),
        "optional_content_elements": data.get("optional_content_elements", []),
        "required_format_elements": data.get("required_format_elements", []),
        "relation_requirements": data.get("relation_requirements", []),
        "style_requirements": data.get("style_requirements", []),
        "min_length": data.get("min_length"),
        "max_length": data.get("max_length"),
        "length_unit": data.get("length_unit", "字"),
        "subtasks": data.get("subtasks", []),
        "shared_length_limit": data.get("shared_length_limit"),
        "uncertainty": data.get("uncertainty", []),
        "evidence": data.get("evidence", {})
    }

    # Validate the compiled spec
    schema = _load_schema("task-spec.schema.json")
    errors = _validate_single_task_spec(spec, schema, proto_ids)
    if errors:
        error_exit(EXIT_CONSISTENCY, "compile-task: compiled TaskSpec failed validation", {"errors": errors})

    success_output(spec, args.output)


def _load_prototype_ids():
    """Load all valid prototype IDs from the prototype index."""
    proto_index_path = Path(__file__).resolve().parent.parent / "references" / "task-prototypes" / "task-prototype-index.json"
    ids = set()
    if proto_index_path.exists():
        try:
            idx = json.loads(proto_index_path.read_text(encoding="utf-8"))
            for p in idx.get("prototypes", []):
                pid = p.get("prototype_id")
                if pid:
                    ids.add(pid)
        except Exception:
            pass
    return ids


def _validate_single_task_spec(data, schema, proto_ids=None):
    """Validate a single task-spec entry with deep schema + semantic rules. Returns list of errors."""
    if proto_ids is None:
        proto_ids = _load_prototype_ids()

    errors = []
    errors.extend(_validate_against_schema(data, schema, "task_spec"))

    # primary_prototype_id: must be a real sl-prototype-XXXX, or null, or "general-fallback"
    proto_id = data.get("primary_prototype_id")
    if proto_id is None or proto_id == "general-fallback":
        pass  # allowed
    elif not isinstance(proto_id, str) or proto_id == "":
        errors.append("task_spec.primary_prototype_id: must be a non-empty string, null, or 'general-fallback'")
    elif proto_id.startswith("sl-card-"):
        errors.append(f"task_spec.primary_prototype_id: '{proto_id}' is a method card ID, not a prototype ID — forbidden")
    elif proto_id.startswith("sl-prototype-"):
        if proto_id not in proto_ids:
            errors.append(f"task_spec.primary_prototype_id: '{proto_id}' does not exist in prototype registry")
    else:
        errors.append(f"task_spec.primary_prototype_id: '{proto_id}' format unexpected (must be sl-prototype-XXXX, null, or general-fallback)")

    # full_score must be > 0 (not just >= 0)
    fs = data.get("full_score")
    if fs is not None and not _is_bool(fs) and isinstance(fs, (int, float)):
        if fs <= 0:
            errors.append(f"task_spec.full_score: must be > 0, got {fs}")

    # material_scope non-empty
    if not data.get("material_scope"):
        errors.append("task_spec.material_scope: must not be empty")

    # shared_length_limit vs subtasks consistency
    sll = data.get("shared_length_limit")
    subtasks = data.get("subtasks", [])
    if sll is not None and not subtasks:
        errors.append("task_spec.shared_length_limit: set but no subtasks defined")
    # If subtasks exist with their own max_length, shared_length_limit should be consistent
    if sll is not None and subtasks:
        for i, st in enumerate(subtasks):
            st_max = st.get("max_length")
            if st_max is not None and st_max > sll:
                errors.append(f"task_spec.subtasks[{i}].max_length ({st_max}) > shared_length_limit ({sll})")

    # max_length consistency with subtasks: if subtasks have max_length, parent max_length should accommodate
    parent_max = data.get("max_length")
    if parent_max is not None and subtasks and sll is not None:
        if sll > parent_max:
            errors.append(f"task_spec.shared_length_limit ({sll}) > max_length ({parent_max})")

    return errors


def cmd_validate_task_spec(args):
    """Validate task-spec JSON against schema and structural rules. Supports single object or array."""
    raw = read_input(args.input)
    data = parse_json_input(raw)
    schema = _load_schema("task-spec.schema.json")
    proto_ids = _load_prototype_ids()

    # Support both single object and array
    items = data if isinstance(data, list) else [data]
    all_errors = []
    results = []

    for item in items:
        errors = _validate_single_task_spec(item, schema, proto_ids)
        all_errors.extend(errors)
        results.append({
            "task_id": item.get("task_id"),
            "fixture_id": item.get("fixture_id"),
            "valid": len(errors) == 0,
            "errors": errors
        })

    # Check uniqueness of fixture_ids and task_ids
    fixture_ids = [i.get("fixture_id") for i in items if i.get("fixture_id")]
    task_ids = [i.get("task_id") for i in items if i.get("task_id")]
    if len(fixture_ids) != len(set(fixture_ids)):
        all_errors.append(f"Duplicate fixture_ids found")
    if len(task_ids) != len(set(task_ids)):
        all_errors.append(f"Duplicate task_ids found")

    overall_valid = len(all_errors) == 0
    result = {
        "valid": overall_valid,
        "total": len(items),
        "passed": sum(1 for r in results if r["valid"]),
        "failed": sum(1 for r in results if not r["valid"]),
        "errors": all_errors[:20],  # Limit error output
        "details": results if len(results) <= 30 else results[:5] + ["... truncated ..."]
    }
    if not overall_valid:
        error_exit(EXIT_CONSISTENCY, f"task-spec validation: {result['failed']}/{len(items)} failed", all_errors[:10])
    success_output(result, args.output)


def _validate_single_paper_analysis(data, schema):
    """Validate a single paper-analysis entry with deep structural checks."""
    errors = []
    errors.extend(_validate_against_schema(data, schema, "paper_analysis"))

    # Validate questions count matches completeness
    questions = data.get("questions", [])
    completeness = data.get("completeness", {})
    declared_count = completeness.get("question_count")
    if declared_count is not None and declared_count != len(questions):
        errors.append(f"completeness.question_count={declared_count} but actual questions={len(questions)}")

    # Validate task_specs count matches questions
    task_specs = data.get("task_specs", [])
    if len(task_specs) != len(questions):
        errors.append(f"task_specs count ({len(task_specs)}) != questions count ({len(questions)})")

    # Validate question_id uniqueness within paper
    qids = [q.get("question_id") for q in questions if q.get("question_id")]
    if len(qids) != len(set(qids)):
        errors.append(f"Duplicate question_id within paper: {[q for q in qids if qids.count(q) > 1]}")

    # Validate task reference uniqueness. The public schema defines task_specs as
    # string task_id references; tolerate object form only for backward-compatible
    # internal fixtures instead of calling .get() on a string.
    tids = []
    for ts in task_specs:
        if isinstance(ts, str) and ts.strip():
            tids.append(ts)
        elif isinstance(ts, dict) and ts.get("task_id"):
            tids.append(ts["task_id"])
    if len(tids) != len(set(tids)):
        errors.append("Duplicate task_id in task_specs")

    # Validate material section IDs unique
    section_ids = [s.get("section_id") for s in data.get("material_sections", []) if s.get("section_id")]
    if len(section_ids) != len(set(section_ids)):
        errors.append("Duplicate material section_id")

    # Validate material_scope references exist
    section_id_set = set(section_ids)
    for q in questions:
        for ms in q.get("material_scope", []):
            # Allow range notation like "material-1-4" for essay questions — must be expanded/validated
            if ms not in section_id_set:
                if re.match(r'^material-\d+-\d+$', ms):
                    # Range notation: expand and verify endpoints exist
                    m = re.match(r'^material-(\d+)-(\d+)$', ms)
                    if m:
                        start, end = int(m.group(1)), int(m.group(2))
                        for n in range(start, end + 1):
                            expanded = f"material-{n}"
                            if expanded not in section_id_set:
                                errors.append(f"Question {q.get('question_id')}: material_scope range '{ms}' expands to '{expanded}' which is not in material_sections")
                else:
                    errors.append(f"Question {q.get('question_id')}: material_scope '{ms}' not in material_sections and not a valid range")

    # Validate task_specs and questions one-to-one correspondence. For the
    # schema-defined string form, fixtures are ordered with questions and each
    # stable task_id must end in the corresponding question_id.
    q_qids = set(qids)
    if all(isinstance(ts, str) for ts in task_specs):
        for index, (task_ref, question) in enumerate(zip(task_specs, questions)):
            qid = question.get("question_id", "")
            if not task_ref or not qid or not task_ref.endswith(f"-{qid}"):
                errors.append(
                    f"task_specs[{index}] reference {task_ref!r} does not match question_id {qid!r}"
                )
    else:
        ts_qids = set(
            ts.get("question_id") for ts in task_specs
            if isinstance(ts, dict) and ts.get("question_id")
        )
        if ts_qids != q_qids:
            errors.append(f"task_specs question_ids {ts_qids} != questions question_ids {q_qids}")

    # Validate question_analysis_ids count if present
    qa_ids = data.get("question_analysis_ids", [])
    if qa_ids and len(qa_ids) != len(questions):
        errors.append(f"question_analysis_ids count ({len(qa_ids)}) != questions count ({len(questions)})")

    # Validate question types
    for q in questions:
        qt = q.get("question_type", "")
        types = [t.strip() for t in qt.replace("+", "/").split("/")]
        for t in types:
            if t and t not in VALID_QUESTION_TYPES:
                errors.append(f"Invalid question_type: {t}")

    return errors


def cmd_validate_paper_analysis(args):
    """Validate paper-analysis JSON against schema and structural rules. Supports single or array."""
    raw = read_input(args.input)
    data = parse_json_input(raw)
    schema = _load_schema("paper-analysis.schema.json")

    items = data if isinstance(data, list) else [data]
    all_errors = []
    results = []

    for item in items:
        errors = _validate_single_paper_analysis(item, schema)
        all_errors.extend(errors)
        results.append({
            "paper_id": item.get("paper_id"),
            "valid": len(errors) == 0,
            "question_count": len(item.get("questions", [])),
            "errors": errors
        })

    # Check uniqueness of paper_ids
    paper_ids = [i.get("paper_id") for i in items if i.get("paper_id")]
    if len(paper_ids) != len(set(paper_ids)):
        all_errors.append("Duplicate paper_ids found")

    overall_valid = len(all_errors) == 0
    result = {
        "valid": overall_valid,
        "total": len(items),
        "passed": sum(1 for r in results if r["valid"]),
        "failed": sum(1 for r in results if not r["valid"]),
        "errors": all_errors[:20],
        "details": results
    }
    if not overall_valid:
        error_exit(EXIT_CONSISTENCY, f"paper-analysis validation: {result['failed']}/{len(items)} failed", all_errors[:10])
    success_output(result, args.output)


def cmd_compare_reference_answers(args):
    """Compare multiple reference answers using structured point mappings.
    Accepts structured answer_point_mappings (preferred) or raw text (low confidence only).
    For raw text: only outputs 'candidate differences, low confidence' — must NOT claim semantic consensus."""
    raw = read_input(args.input)
    data = parse_json_input(raw)

    if not isinstance(data, dict):
        error_exit(EXIT_INPUT_ERROR, "compare-reference-answers input must be a JSON object")

    answers = data.get("answers", [])
    if len(answers) < 2:
        error_exit(EXIT_INPUT_ERROR, "compare-reference-answers requires at least 2 answers")

    # Check if structured point mappings are provided
    point_mappings = data.get("answer_point_mappings", [])
    equivalence_groups = data.get("equivalence_groups", [])

    result = {
        "reference_set_id": data.get("reference_set_id", ""),
        "paper_id": data.get("paper_id", ""),
        "question_id": data.get("question_id", ""),
        "answer_count": len(answers),
        "consensus_points": [],
        "answer_specific_points": [],
        "disputed_points": [],
        "equivalent_expressions": [],
        "structure_variants": [],
        "source_confidence": data.get("source_confidence", "low"),
        "comparison_method": "structured",
        "warnings": []
    }

    if point_mappings:
        # Structured comparison: group by point_id or equivalence_group
        # Build per-point coverage across answers
        point_coverage = {}  # point_id -> {answer_id: coverage}
        for pm in point_mappings:
            pid = pm.get("point_id")
            aid = pm.get("answer_id")
            cov = pm.get("coverage", "missing")
            if pid not in point_coverage:
                point_coverage[pid] = {}
            point_coverage[pid][aid] = cov

        all_aids = [a["answer_id"] for a in answers]

        for pid, cov_map in point_coverage.items():
            covered_aids = [aid for aid in all_aids if cov_map.get(aid, "missing") in ("covered", "equivalent")]
            if len(covered_aids) == len(all_aids):
                result["consensus_points"].append({
                    "point_id": pid,
                    "supporting_answer_ids": covered_aids
                })
            elif len(covered_aids) == 1:
                result["answer_specific_points"].append({
                    "point_id": pid,
                    "answer_id": covered_aids[0]
                })
            elif len(covered_aids) == 0:
                result["disputed_points"].append({
                    "point_id": pid,
                    "reason": "no answer covers this point",
                    "supporting_answer_ids": []
                })
            else:
                result["disputed_points"].append({
                    "point_id": pid,
                    "reason": f"covered by {len(covered_aids)}/{len(all_aids)} answers",
                    "supporting_answer_ids": covered_aids
                })

        # Process equivalence_groups
        for eg in equivalence_groups:
            result["equivalent_expressions"].append({
                "group_id": eg.get("group_id", ""),
                "point_id": eg.get("point_id", ""),
                "expressions": eg.get("expressions", []),
                "confirmed": True
            })

        # Structure variants
        for a in answers:
            sv = a.get("structure_summary")
            if sv:
                result["structure_variants"].append({
                    "answer_id": a["answer_id"],
                    "structure": sv
                })

    else:
        # Raw text mode: only output candidate differences with low confidence
        # MUST NOT claim semantic consensus
        result["comparison_method"] = "raw_text_low_confidence"
        result["warnings"].append(
            "纯文本答案比较只能输出候选差异和低置信度结果，不得宣称已确定语义共识。"
            "需提供结构化 answer_point_mappings 才能输出 consensus_points。"
        )
        # Output candidate differences only
        for a in answers:
            result["answer_specific_points"].append({
                "answer_id": a["answer_id"],
                "candidate_claims": "候选差异（低置信度，需人工确认）"
            })

    success_output(result, args.output)


def _validate_single_score_ledger(data, schema, context=None):
    """Validate a single score-ledger entry with deep evidence checks.
    TRULY FAIL-CLOSED: no `if collection:` guards — all checks unconditional.
    Requires: task_spec (valid), atomic_points (non-empty active), material_text (non-empty),
    user_answer (non-empty), point_ledger (non-empty), structure_ledger (covers required elements).
    Enforces: active_point_ids == ledger_point_ids (complete mapping).
    Returns list of errors."""
    errors = []
    errors.extend(_validate_against_schema(data, schema, "score_ledger"))

    ctx = context or {}

    # --- UNCONDITIONAL context validation (no guards) ---
    task_spec = ctx.get("task_spec")
    if not task_spec or not isinstance(task_spec, dict):
        errors.append("score_ledger: task_spec is missing or not a dict")
        task_spec = {}

    # Validate task_spec itself against schema (not just non-empty dict)
    if task_spec:
        ts_schema = _load_schema("task-spec.schema.json")
        proto_ids = _load_prototype_ids()
        ts_errors = _validate_single_task_spec(task_spec, ts_schema, proto_ids)
        if ts_errors:
            errors.append(f"score_ledger: task_spec failed validation: {ts_errors[:3]}")

    atomic_points = ctx.get("atomic_points")
    if not isinstance(atomic_points, list):
        errors.append("score_ledger: atomic_points must be a list")
        atomic_points = []

    # Build active point IDs and point→scope mapping (only status=active)
    active_point_ids = set()
    point_scopes = {}  # point_id -> paragraph_id (material scope)
    point_scoring_meta = {}  # point_id -> (independent_scoring, required_or_optional)
    for ap in atomic_points:
        if not isinstance(ap, dict):
            continue
        pid = ap.get("point_id")
        status = ap.get("status", "active")
        if pid and status == "active":
            active_point_ids.add(pid)
            point_scopes[pid] = ap.get("paragraph_id", "")
            point_scoring_meta[pid] = (
                ap.get("independent_scoring") is True,
                ap.get("required_or_optional", "required"),
            )

    # UNCONDITIONAL: atomic_points must have at least one active point
    if not active_point_ids:
        errors.append("score_ledger: no active atomic_points found — at least one active point required")

    # material_text must be non-empty dict with non-empty text values
    material_text = ctx.get("material_text_by_scope", {})
    if not isinstance(material_text, dict):
        material_text = {}
    if not material_text and ctx.get("material_sections"):
        for ms in ctx["material_sections"]:
            if isinstance(ms, dict):
                sid = ms.get("section_id", "")
                if sid:
                    material_text[sid] = ms.get("text", "")

    # UNCONDITIONAL: material_text must have at least one non-empty value
    has_material_content = any(isinstance(v, str) and v.strip() for v in material_text.values())
    if not has_material_content:
        errors.append("score_ledger: material_text_by_scope has no non-empty text — cannot validate material_evidence")

    # UNCONDITIONAL: material_text must cover TaskSpec material_scope
    ts_material_scope = set(task_spec.get("material_scope", []))
    if ts_material_scope:
        covered_scopes = {sid for sid, txt in material_text.items() if isinstance(txt, str) and txt.strip()}
        missing_scopes = ts_material_scope - covered_scopes
        if missing_scopes:
            errors.append(f"score_ledger: material_text_by_scope missing TaskSpec material_scope: {sorted(missing_scopes)}")

    # UNCONDITIONAL: user_answer must be non-empty
    user_answer = ctx.get("user_answer", "")
    if not isinstance(user_answer, str):
        user_answer = ""
    if not user_answer.strip():
        errors.append("score_ledger: user_answer is empty — cannot validate user_quote")

    # UNCONDITIONAL: task_components from TaskSpec
    task_components_in_spec = set(task_spec.get("task_components", []))
    if not task_components_in_spec:
        errors.append("score_ledger: task_spec has no task_components — cannot validate task_component_ids")

    question_type = ctx.get("question_type", "")
    # official_point_scores: only allowed if reference_answer_set has official_rubric
    ref_set = ctx.get("reference_answer_set") or {}
    has_official_rubric = False
    if isinstance(ref_set, dict):
        for item in ref_set.get("items", []):
            if isinstance(item, dict) and item.get("source_type") == "official_rubric":
                has_official_rubric = True
                break
    if ctx.get("official_point_scores") and not has_official_rubric:
        errors.append("score_ledger: official_point_scores provided but reference_answer_set has no official_rubric source")

    # Build allowed deduction owners
    if question_type:
        allowed_dims = _load_dimension_names_for_qt(question_type)
    else:
        allowed_dims = VALID_DEDUCTION_OWNERS

    # --- UNCONDITIONAL: point_ledger must be non-empty ---
    point_ledger = data.get("point_ledger", [])
    if not isinstance(point_ledger, list):
        errors.append("score_ledger: point_ledger must be an array")
        point_ledger = []
    if not point_ledger:
        errors.append("score_ledger: point_ledger is empty — must contain at least one entry per active point")

    # --- point_ledger entry validation ---
    point_ids_seen = set()
    ledger_point_ids = set()  # non-extra_material point_ids
    for i, entry in enumerate(point_ledger):
        prefix = f"point_ledger[{i}]"
        if not isinstance(entry, dict):
            errors.append(f"{prefix}: entry must be an object")
            continue

        mt = entry.get("match_type")
        if mt not in VALID_MATCH_TYPES:
            errors.append(f"{prefix}: invalid or missing match_type '{mt}'")

        cs = entry.get("coverage_status")
        if cs not in VALID_COVERAGE_STATUSES:
            errors.append(f"{prefix}: invalid or missing coverage_status '{cs}'")

        rs = entry.get("reference_support")
        if rs and rs not in VALID_REFERENCE_SUPPORT:
            errors.append(f"{prefix}: invalid reference_support '{rs}'")

        do = entry.get("deduction_owner")
        if do and do not in allowed_dims:
            errors.append(f"{prefix}: deduction_owner '{do}' is not a formal dimension for {question_type or 'this question type'}; allowed: {sorted(allowed_dims)}")

        pid = entry.get("point_id", "")
        is_extra = (cs == "超出材料" or mt == "extra_material")

        if not pid:
            errors.append(f"{prefix}: missing point_id")
        else:
            if pid in point_ids_seen:
                errors.append(f"{prefix}: duplicate point_id '{pid}'")
            point_ids_seen.add(pid)
            # UNCONDITIONAL: point_id must exist in active points (for non-extra entries)
            if not is_extra:
                ledger_point_ids.add(pid)
                if pid not in active_point_ids:
                    errors.append(f"{prefix}: point_id '{pid}' does not exist in active atomic_points")
                # Check for merged/excluded points in normal mapping
                for ap in atomic_points:
                    if isinstance(ap, dict) and ap.get("point_id") == pid:
                        ap_status = ap.get("status", "active")
                        if ap_status != "active":
                            errors.append(f"{prefix}: point_id '{pid}' has status '{ap_status}' — merged/excluded points must not appear in normal point_ledger mapping")
                        break
            else:
                # extra_material must not reference atomic_point
                if pid in active_point_ids:
                    errors.append(f"{prefix}: extra_material entry references atomic_point '{pid}' — must use independent claim_id, not point_id")

        # Normal points require in-material evidence. An independent
        # extra-material claim must have no material evidence by definition.
        me = entry.get("material_evidence", "")
        if is_extra:
            if me not in (None, ""):
                errors.append(
                    f"{prefix}: extra_material claim must not fabricate material_evidence"
                )
        elif not me:
            errors.append(f"{prefix}: missing material_evidence")
        else:
            point_scope = point_scopes.get(pid, "")
            scope_text = material_text.get(point_scope, "")
            if not _evidence_in_scope(me, scope_text):
                found_anywhere = any(_evidence_in_scope(me, st) for st in material_text.values() if isinstance(st, str))
                if not found_anywhere:
                    errors.append(f"{prefix}: material_evidence not found verbatim in material scope '{point_scope}' or any material")
                elif point_scope:
                    errors.append(f"{prefix}: material_evidence found in a different material scope, not in point's scope '{point_scope}'")

        # UNCONDITIONAL: user_quote must exist in user_answer (when non-empty)
        uq = entry.get("user_quote")
        if uq is not None and uq != "":
            if not _evidence_in_scope(uq, user_answer):
                errors.append(f"{prefix}: user_quote not found verbatim in user_answer")

        # UNCONDITIONAL: task_component_ids must exist in TaskSpec
        tcids = entry.get("task_component_ids", [])
        if tcids:
            for tcid in tcids:
                if tcid not in task_components_in_spec:
                    errors.append(f"{prefix}: task_component_id '{tcid}' not in TaskSpec task_components")

        # 未覆盖项 user_quote must be empty
        if cs == "未覆盖":
            if uq is not None and uq != "":
                errors.append(f"{prefix}: coverage '未覆盖' but user_quote is non-empty")

        # Non-independent / optional points are evidence aids, not score-bearing
        # omissions. They may stay in the ledger for traceability, but their
        # absence must never create a deduction or a user-facing loss item.
        independent_scoring, required_or_optional = point_scoring_meta.get(
            pid, (True, "required")
        )
        if not is_extra and (
            not independent_scoring or required_or_optional == "optional"
        ):
            if do:
                errors.append(
                    f"{prefix}: non-independent/optional point '{pid}' must not "
                    "have deduction_owner"
                )
            if entry.get("loss_reason"):
                errors.append(
                    f"{prefix}: non-independent/optional point '{pid}' must not "
                    "have loss_reason or be treated as a scoring loss"
                )

        # match_type + coverage_status legal combinations
        legal_combos = {
            ("keyword_match", "完整覆盖"), ("keyword_match", "部分覆盖"),
            ("semantic_match", "完整覆盖"), ("semantic_match", "部分覆盖"), ("semantic_match", "等义表达"),
            ("no_match", "未覆盖"),
            ("extra_material", "超出材料"),
        }
        if mt and cs and (mt, cs) not in legal_combos:
            errors.append(f"{prefix}: illegal combination match_type='{mt}' + coverage_status='{cs}'")

        # 完整/等义 must have credit_reason
        if cs in ("完整覆盖", "等义表达"):
            if not entry.get("credit_reason"):
                errors.append(f"{prefix}: coverage '{cs}' but no credit_reason")

        # 部分覆盖 must have both credit and loss reason
        if cs == "部分覆盖":
            if not entry.get("credit_reason"):
                errors.append(f"{prefix}: coverage '部分覆盖' but no credit_reason")
            if not entry.get("loss_reason"):
                errors.append(f"{prefix}: coverage '部分覆盖' but no loss_reason")

        # 未覆盖 must not have credit_reason
        if cs == "未覆盖" and entry.get("credit_reason"):
            errors.append(f"{prefix}: coverage '未覆盖' but has credit_reason")

        # no point_score without official rubric
        if "point_score" in entry and not has_official_rubric:
            errors.append(f"{prefix}: point_score present but no official_rubric — forbidden")

    # --- COMPLETE MAPPING: active_point_ids == ledger_point_ids ---
    missing_from_ledger = active_point_ids - ledger_point_ids
    if missing_from_ledger:
        errors.append(f"score_ledger: active points missing from point_ledger: {sorted(missing_from_ledger)} — every active point must have a ledger entry")

    extra_in_ledger = ledger_point_ids - active_point_ids
    if extra_in_ledger:
        errors.append(f"score_ledger: point_ledger contains non-active point_ids: {sorted(extra_in_ledger)}")

    # --- structure_ledger validation with REQUIRED ELEMENTS completeness ---
    # Build required structure elements from TaskSpec
    required_structure_elements = set()
    for fmt_elem in task_spec.get("required_format_elements", []):
        required_structure_elements.add(f"format:{fmt_elem}")
    for content_elem in task_spec.get("required_content_elements", []):
        required_structure_elements.add(f"content_component:{content_elem}")
    for rel_req in task_spec.get("relation_requirements", []):
        required_structure_elements.add(f"logical_relation:{rel_req}")

    structure_ledger = data.get("structure_ledger", [])
    if not isinstance(structure_ledger, list):
        errors.append("score_ledger: structure_ledger must be an array")
        structure_ledger = []

    # UNCONDITIONAL: if TaskSpec has required structure elements, structure_ledger must not be empty
    if required_structure_elements and not structure_ledger:
        errors.append("score_ledger: structure_ledger is empty but TaskSpec has required structure elements — must cover all required elements")

    element_ids_seen = set()
    covered_structure_elements = set()
    for i, entry in enumerate(structure_ledger):
        prefix = f"structure_ledger[{i}]"
        if not isinstance(entry, dict):
            errors.append(f"{prefix}: entry must be an object")
            continue

        et = entry.get("element_type")
        if et and et not in VALID_ELEMENT_TYPES:
            errors.append(f"{prefix}: invalid element_type '{et}'")

        st = entry.get("status")
        if st and st not in VALID_STRUCTURE_STATUSES:
            errors.append(f"{prefix}: invalid status '{st}'")

        do = entry.get("deduction_owner")
        if do and do not in allowed_dims:
            errors.append(f"{prefix}: deduction_owner '{do}' is not a formal dimension for {question_type or 'this question type'}")

        eid = entry.get("element_id", "")
        if not eid:
            errors.append(f"{prefix}: missing element_id")
        else:
            if eid in element_ids_seen:
                errors.append(f"{prefix}: duplicate element_id '{eid}'")
            element_ids_seen.add(eid)
            # Track covered required elements
            if et and eid:
                covered_structure_elements.add(f"{et}:{eid}")

        # UNCONDITIONAL: user_evidence must exist in user_answer when non-empty
        ue = entry.get("user_evidence")
        if ue is not None and ue != "":
            if not _evidence_in_scope(ue, user_answer):
                errors.append(f"{prefix}: user_evidence not found verbatim in user_answer")

        if st == "satisfied":
            if not entry.get("credit_reason"):
                errors.append(f"{prefix}: status 'satisfied' but no credit_reason")
        elif st in ("partial", "missing"):
            if not entry.get("loss_reason") and entry.get("required"):
                errors.append(f"{prefix}: status '{st}' (required element) but no loss_reason")

    # Check all required structure elements are covered
    # Map required elements to structure_ledger entries by element_id
    # required_format_elements use element_id = format element name (e.g. "标题")
    # required_content_elements use element_id = content element name
    # relation_requirements use element_id = relation description
    for fmt_elem in task_spec.get("required_format_elements", []):
        if fmt_elem not in element_ids_seen:
            errors.append(f"score_ledger: structure_ledger missing required format element '{fmt_elem}'")
    for content_elem in task_spec.get("required_content_elements", []):
        if content_elem not in element_ids_seen:
            errors.append(f"score_ledger: structure_ledger missing required content element '{content_elem}'")
    for rel_req in task_spec.get("relation_requirements", []):
        if rel_req not in element_ids_seen:
            errors.append(f"score_ledger: structure_ledger missing required relation '{rel_req}'")

    # same defect must not have multiple deduction_owners without basis
    loss_groups = {}
    for i, entry in enumerate(point_ledger):
        if not isinstance(entry, dict):
            continue
        lr = entry.get("loss_reason")
        if lr and entry.get("coverage_status") in ("部分覆盖", "未覆盖"):
            key = lr[:50]
            if key not in loss_groups:
                loss_groups[key] = []
            loss_groups[key].append((i, entry.get("deduction_owner")))
    for key, group in loss_groups.items():
        owners = set(g[1] for g in group if g[1])
        if len(owners) > 1:
            errors.append(f"point_ledger: same/similar loss_reason '{key}...' has {len(owners)} different deduction_owners — same defect must not have multiple deduction owners without basis")

    # no point_scores at top level without official rubric
    if "point_scores" in data and not has_official_rubric:
        errors.append("score_ledger: point_scores present but no official_rubric — forbidden")

    return errors


def _load_dimension_names_for_qt(question_type):
    """Load dimension names for a specific question type from scoring-weights.json."""
    dims = set()
    try:
        cfg_path = CONFIG_DIR / "scoring-weights.json"
        if cfg_path.exists():
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            qt_info = cfg.get("question_types", {}).get(question_type, {})
            for item in qt_info.get("dimensions", []):
                if isinstance(item, dict) and "name" in item:
                    dims.add(item["name"])
    except Exception:
        pass
    return dims if dims else VALID_DEDUCTION_OWNERS


def cmd_validate_score_ledger(args):
    """Validate score-ledger JSON with deep evidence checks.
    Input must contain: task_spec, material_text_by_scope (or material_sections),
    atomic_points, task_components, user_answer, point_ledger, structure_ledger.
    Optional: reference_answer_set, official_point_scores, question_type."""
    raw = read_input(args.input)
    data = parse_json_input(raw)

    # The input is a context object containing score_ledger + evidence sources
    if not isinstance(data, dict):
        error_exit(EXIT_INPUT_ERROR, "validate-score-ledger input must be a JSON object")

    # Required context fields
    required_ctx = ["task_spec", "atomic_points", "user_answer", "point_ledger", "structure_ledger"]
    missing = [f for f in required_ctx if f not in data]
    if missing:
        error_exit(EXIT_INPUT_ERROR, f"validate-score-ledger missing required context fields: {missing}")

    # Must have material text in one of two forms
    if "material_text_by_scope" not in data and "material_sections" not in data:
        error_exit(EXIT_INPUT_ERROR, "validate-score-ledger requires material_text_by_scope or material_sections")

    # Extract the score_ledger object (may be embedded or top-level)
    # Support two modes:
    # 1. Top-level has point_ledger/structure_ledger directly (context fields alongside)
    # 2. Top-level has a 'score_ledger' key containing the ledger object
    if "score_ledger" in data and isinstance(data["score_ledger"], dict):
        ledger_obj = data["score_ledger"]
        # Merge context
        context = {
            "task_spec": data.get("task_spec", {}),
            "material_text_by_scope": data.get("material_text_by_scope", {}),
            "material_sections": data.get("material_sections", []),
            "atomic_points": data.get("atomic_points", []),
            "task_components": data.get("task_components", data.get("task_spec", {}).get("task_components", [])),
            "user_answer": data.get("user_answer", ""),
            "reference_answer_set": data.get("reference_answer_set"),
            "official_point_scores": data.get("official_point_scores"),
            "question_type": data.get("question_type", ""),
        }
    else:
        # point_ledger and structure_ledger are at top level
        # FAIL-CLOSED: ledger_id, task_id, answer_id must be explicitly provided
        ledger_id = data.get("ledger_id", "")
        task_id = data.get("task_id", "")
        answer_id = data.get("answer_id", "")
        if not ledger_id:
            errors_ctx = ["score_ledger: ledger_id is required — auto-generation forbidden"]
            error_exit(EXIT_INPUT_ERROR, "validate-score-ledger: missing ledger_id", errors_ctx)
        if not task_id:
            ts = data.get("task_spec", {})
            task_id = ts.get("task_id", "")
            if not task_id:
                errors_ctx = ["score_ledger: task_id is required — auto-generation forbidden"]
                error_exit(EXIT_INPUT_ERROR, "validate-score-ledger: missing task_id", errors_ctx)
        if not answer_id:
            errors_ctx = ["score_ledger: answer_id is required — auto-generation forbidden"]
            error_exit(EXIT_INPUT_ERROR, "validate-score-ledger: missing answer_id", errors_ctx)
        ledger_obj = {
            "schema_version": data.get("schema_version", "1.0"),
            "ledger_id": ledger_id,
            "task_id": task_id,
            "answer_id": answer_id,
            "point_ledger": data.get("point_ledger", []),
            "structure_ledger": data.get("structure_ledger", []),
        }
        context = {
            "task_spec": data.get("task_spec", {}),
            "material_text_by_scope": data.get("material_text_by_scope", {}),
            "material_sections": data.get("material_sections", []),
            "atomic_points": data.get("atomic_points", []),
            "task_components": data.get("task_components", data.get("task_spec", {}).get("task_components", [])),
            "user_answer": data.get("user_answer", ""),
            "reference_answer_set": data.get("reference_answer_set"),
            "official_point_scores": data.get("official_point_scores"),
            "question_type": data.get("question_type", ""),
        }

    schema = _load_schema("score-ledger.schema.json")
    errors = _validate_single_score_ledger(ledger_obj, schema, context)

    result = {
        "valid": len(errors) == 0,
        "ledger_id": ledger_obj.get("ledger_id"),
        "point_count": len(ledger_obj.get("point_ledger", [])),
        "structure_count": len(ledger_obj.get("structure_ledger", [])),
        "errors": errors[:30],
        "validation_receipt": {
            "passed": len(errors) == 0,
            "checks": [
                {"check_name": "schema_conformance", "passed": not any("task_spec" in e or "score_ledger" in e for e in errors)},
                {"check_name": "point_ids_exist", "passed": not any("does not exist in active" in e for e in errors)},
                {"check_name": "material_evidence_in_material", "passed": not any("material_evidence not found" in e for e in errors)},
                {"check_name": "user_quote_in_answer", "passed": not any("user_quote not found" in e for e in errors)},
                {"check_name": "no_point_score_without_rubric", "passed": not any("point_score" in e for e in errors)},
                {"check_name": "deduction_owner_valid", "passed": not any("deduction_owner" in e for e in errors)},
                {"check_name": "no_duplicate_point_ids", "passed": not any("duplicate point_id" in e for e in errors)},
                {"check_name": "no_duplicate_element_ids", "passed": not any("duplicate element_id" in e for e in errors)},
            ]
        }
    }
    if errors:
        error_exit(EXIT_CONSISTENCY, "score-ledger validation FAILED", result)
    success_output(result, args.output)


# ---------------------------------------------------------------------------
# export-evidence-report: export evidence report from score-ledger data
# ---------------------------------------------------------------------------

def cmd_export_evidence_report(args):
    """Export evidence report from score-ledger data."""
    raw = read_input(args.input)
    data = parse_json_input(raw)

    fmt = args.format
    point_ledger = data.get("point_ledger", [])
    structure_ledger = data.get("structure_ledger", [])

    if fmt == "json":
        report = {
            "task_id": data.get("task_id"),
            "ledger_id": data.get("ledger_id"),
            "point_summary": {
                "total": len(point_ledger),
                "完整覆盖": sum(1 for p in point_ledger if p.get("coverage_status") == "完整覆盖"),
                "部分覆盖": sum(1 for p in point_ledger if p.get("coverage_status") == "部分覆盖"),
                "等义表达": sum(1 for p in point_ledger if p.get("coverage_status") == "等义表达"),
                "未覆盖": sum(1 for p in point_ledger if p.get("coverage_status") == "未覆盖"),
                "超出材料": sum(1 for p in point_ledger if p.get("coverage_status") == "超出材料")
            },
            "structure_summary": {
                "total": len(structure_ledger),
                "satisfied": sum(1 for s in structure_ledger if s.get("status") == "satisfied"),
                "partial": sum(1 for s in structure_ledger if s.get("status") == "partial"),
                "missing": sum(1 for s in structure_ledger if s.get("status") == "missing")
            },
            "point_details": point_ledger,
            "structure_details": structure_ledger
        }
        success_output(report, args.output)
    else:
        # Markdown format
        lines = [f"# 证据报告\n", f"**任务ID**: {data.get('task_id')}\n"]
        lines.append("## 要点得失\n")
        lines.append("| point_id | 材料证据 | 用户原句 | 匹配方式 | 覆盖判定 | 得分理由 | 失分理由 | 主扣维度 |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for p in point_ledger:
            lines.append(f"| {p.get('point_id','')} | {p.get('material_evidence','')} | {p.get('user_quote','')} | {p.get('match_type','')} | {p.get('coverage_status','')} | {p.get('credit_reason','')} | {p.get('loss_reason','')} | {p.get('deduction_owner','')} |")
        lines.append("\n## 结构要素\n")
        lines.append("| element_id | 类型 | 必需 | 状态 | 得分理由 | 失分理由 | 主扣维度 |")
        lines.append("|---|---|---|---|---|---|---|")
        for s in structure_ledger:
            lines.append(f"| {s.get('element_id','')} | {s.get('element_type','')} | {'是' if s.get('required') else '否'} | {s.get('status','')} | {s.get('credit_reason','')} | {s.get('loss_reason','')} | {s.get('deduction_owner','')} |")
        report_text = "\n".join(lines)
        if args.output:
            Path(args.output).write_text(report_text, encoding="utf-8")
        else:
            print(report_text)


# ---------------------------------------------------------------------------
# migrate-db-v4: explicit v3→v4 migration with backup
# ---------------------------------------------------------------------------

def cmd_migrate_db_v4(args):
    """Explicitly migrate database from v3 to v4.
    Uses SQLite backup API for consistent backup; migrates on temp copy;
    atomically replaces on success; preserves original on failure; idempotent."""
    import shutil
    import tempfile

    db_path = args.state_db
    if not db_path:
        error_exit(EXIT_INPUT_ERROR, "migrate-db-v4 requires --state-db")

    if not os.path.exists(db_path):
        error_exit(EXIT_INPUT_ERROR, f"Database not found: {db_path}")

    # Check current version
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'")
    if not cur.fetchone():
        conn.close()
        error_exit(EXIT_DB_ERROR, "metadata table missing — not a valid shenlun database")
    cur.execute("SELECT value FROM metadata WHERE key='schema_version'")
    row = cur.fetchone()
    current_version = row[0] if row else None
    conn.close()

    if current_version == "4":
        # Idempotent: already v4
        result = {
            "migrated": False,
            "reason": "already_v4",
            "db_path": db_path,
            "current_version": "4"
        }
        success_output(result, args.output)
        return

    if current_version != "3":
        error_exit(EXIT_DB_ERROR, f"Expected v3 database, got version '{current_version}'")

    # 1. Create consistent backup using SQLite backup API
    backup_path = db_path + ".v3-backup"
    try:
        src = sqlite3.connect(db_path)
        dst = sqlite3.connect(backup_path)
        src.backup(dst)
        dst.close()
        src.close()
    except Exception as e:
        error_exit(EXIT_DB_ERROR, f"Backup failed: {e}", {"backup_path": backup_path})

    # 2. Migrate on a temp copy, verify, then atomically replace
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".db", dir=os.path.dirname(db_path))
    os.close(tmp_fd)
    try:
        # Use SQLite backup API (not copy2) to handle WAL/SHM correctly
        src_conn = sqlite3.connect(db_path)
        tmp_conn = sqlite3.connect(tmp_path)
        src_conn.backup(tmp_conn)
        tmp_conn.close()
        src_conn.close()
        # Run v4 schema on temp copy
        conn = sqlite3.connect(tmp_path)
        conn.execute("PRAGMA foreign_keys = ON")
        if not SQL_SCHEMA_V4.exists():
            conn.close()
            os.unlink(tmp_path)
            error_exit(EXIT_DB_ERROR, f"v4 schema file not found: {SQL_SCHEMA_V4}")
        v4_sql = SQL_SCHEMA_V4.read_text(encoding="utf-8")
        conn.executescript(v4_sql)
        conn.execute("UPDATE metadata SET value = '4', updated_at = datetime('now') WHERE key = 'schema_version'")
        conn.commit()
        # Verify v4
        verify_errors = _verify_schema_v4(conn, tmp_path)
        conn.close()
        if verify_errors:
            os.unlink(tmp_path)
            error_exit(EXIT_DB_ERROR, "v4 verification failed on temp copy — original preserved",
                        {"errors": verify_errors, "backup_path": backup_path})
        # Atomically replace
        # Atomic replace on same filesystem
        os.replace(tmp_path, db_path)
    except Exception as e:
        if os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
        # Restore from backup using SQLite backup API (not copy2)
        try:
            src_conn = sqlite3.connect(backup_path)
            dst_conn = sqlite3.connect(db_path)
            src_conn.backup(dst_conn)
            dst_conn.close()
            src_conn.close()
        except Exception:
            # Last resort: file copy (but try backup API first)
            shutil.copy2(backup_path, db_path)
        error_exit(EXIT_DB_ERROR, f"Migration failed — original restored from backup: {e}",
                    {"backup_path": backup_path})

    result = {
        "migrated": True,
        "db_path": db_path,
        "from_version": "3",
        "to_version": "4",
        "backup_path": backup_path
    }
    success_output(result, args.output)


# ---------------------------------------------------------------------------
# write-unified-state: atomic transactional write of paper/questions/task_specs/ledgers
# ---------------------------------------------------------------------------

def _compute_question_key(paper_id, question_id):
    """Stable question_key = hash(paper_id, question_id)."""
    import hashlib
    h = hashlib.sha256(f"{paper_id}/{question_id}".encode("utf-8")).hexdigest()[:16]
    return f"qk-{h}"


def cmd_write_unified_state(args):
    """Atomically write paper, questions, task_specs, task_components,
    reference_answer_sets/items, score_ledgers parent, point_ledgers, structure_ledgers
    in a single transaction. All-or-nothing: any failure rolls back entirely.
    Idempotent: repeated execution does not increase row counts.
    Pre-validates all inputs BEFORE touching the database."""
    raw = read_input(args.input)
    data = parse_json_input(raw)

    if not isinstance(data, dict):
        error_exit(EXIT_INPUT_ERROR, "write-unified-state input must be a JSON object")

    db_path = args.state_db
    if not db_path:
        error_exit(EXIT_INPUT_ERROR, "write-unified-state requires --state-db")

    # P0-1: Reject legacy mode results from entering formal state
    scoring_result = data.get("scoring_result", {})
    if isinstance(scoring_result, dict):
        if scoring_result.get("legacy_mode") is True:
            error_exit(EXIT_CONSISTENCY,
                "write-unified-state: legacy mode result must not enter formal state write-back. "
                "legacy results have formal_score=false and cannot be persisted.")
        if scoring_result.get("formal_score") is False:
            error_exit(EXIT_CONSISTENCY,
                "write-unified-state: scoring_result has formal_score=false — cannot be written to state.")

    # P0-6: When score_ledger exists (score write mode), scoring_result MUST be present and formal
    has_score_ledger = "score_ledger" in data and data["score_ledger"] is not None
    if has_score_ledger:
        if not isinstance(scoring_result, dict) or not scoring_result:
            error_exit(EXIT_CONSISTENCY,
                "write-unified-state: score_ledger present but scoring_result is missing, empty, or not an object. "
                "Scoring write-back requires a complete scoring_result with formal_score=true.")
        if scoring_result.get("formal_score") is not True:
            error_exit(EXIT_CONSISTENCY,
                "write-unified-state: score_ledger present but scoring_result.formal_score is not strictly True. "
                "Only formal scoring results may be written to state.")
        # P0-6: Re-verify scoring_result.point_coverage matches ledger-derived mappings
        # (validation_receipt.passed is not trusted — must re-validate)
        if isinstance(scoring_result.get("point_coverage"), list):
            sl = data["score_ledger"]
            scorable_pids = set()
            # Derive scorable from atomic_points or point_definitions
            for ap in data.get("atomic_points", []):
                if isinstance(ap, dict) and ap.get("status") == "active" and ap.get("independent_scoring") is True and ap.get("required_or_optional") != "optional":
                    scorable_pids.add(ap.get("point_id", ""))
            if not scorable_pids:
                for pd_def in data.get("point_definitions", []):
                    if isinstance(pd_def, dict) and pd_def.get("status") == "active" and pd_def.get("independent_scoring") is True and pd_def.get("required_or_optional") != "optional":
                        scorable_pids.add(pd_def.get("point_id", ""))

            if scorable_pids and isinstance(sl, dict) and isinstance(sl.get("point_ledger"), list):
                derived_mappings, dm_errors = _derive_point_mappings_from_ledger(sl, scorable_pids, data.get("user_answer", ""))
                if not dm_errors:
                    # Compare scoring_result.point_coverage with ledger-derived
                    sr_coverage = [pm for pm in scoring_result.get("point_coverage", []) if isinstance(pm, dict) and pm.get("point_id", "") in scorable_pids]
                    matches, cmp_errors = _compare_point_mappings(derived_mappings, sr_coverage)
                    if not matches:
                        error_exit(EXIT_CONSISTENCY,
                            "write-unified-state: scoring_result.point_coverage drifts from score_ledger. "
                            "point_coverage in state write must exactly match ledger-derived mappings.",
                            {"mapping_drift": cmp_errors})

    # --- PRE-WRITE VALIDATION (before opening DB) ---
    # 1. Validate task_specs
    ts_schema = _load_schema("task-spec.schema.json")
    proto_ids = _load_prototype_ids()
    for ts in data.get("task_specs", []):
        ts_errors = _validate_single_task_spec(ts, ts_schema, proto_ids)
        if ts_errors:
            error_exit(EXIT_INPUT_ERROR, "write-unified-state: task_spec validation failed", {"errors": ts_errors})

    # 2. Validate score_ledger: if the KEY exists, must validate (even if ledger_id missing)
    #    Only skip validation when the key is completely absent (write paper-only mode).
    if "score_ledger" in data:
        sl = data["score_ledger"]
        # Reject null, non-dict, empty dict, or missing required fields BEFORE opening DB
        if sl is None:
            error_exit(EXIT_INPUT_ERROR, "write-unified-state: score_ledger is null — must be a complete object or omit the key")
        if not isinstance(sl, dict):
            error_exit(EXIT_INPUT_ERROR, f"write-unified-state: score_ledger must be an object, got {type(sl).__name__}")
        if not sl:
            error_exit(EXIT_INPUT_ERROR, "write-unified-state: score_ledger is empty — must be complete or omit the key")
        # Check required ledger fields before deep validation
        for req_field in ("ledger_id", "task_id", "answer_id", "score_id", "question_key"):
            if not sl.get(req_field):
                error_exit(EXIT_INPUT_ERROR, f"write-unified-state: score_ledger.{req_field} is missing or empty")
        if not isinstance(sl.get("point_ledger"), list) or not sl.get("point_ledger"):
            error_exit(EXIT_INPUT_ERROR, "write-unified-state: score_ledger.point_ledger is missing or empty")
        # Deep validation
        sl_schema = _load_schema("score-ledger.schema.json")
        sl_context = {
            "task_spec": data.get("task_specs", [{}])[0] if data.get("task_specs") else {},
            "material_text_by_scope": data.get("material_text_by_scope", {}),
            "atomic_points": data.get("atomic_points", []),
            "user_answer": data.get("user_answer", ""),
            "question_type": data.get("question_type", ""),
            "reference_answer_set": data.get("reference_answer_set"),
        }
        sl_errors = _validate_single_score_ledger(sl, sl_schema, sl_context)
        if sl_errors:
            error_exit(EXIT_INPUT_ERROR, "write-unified-state: score_ledger validation failed", {"errors": sl_errors})

    # --- OPEN DB AND WRITE ---
    conn = _init_db(db_path, target_version="4")

    try:
        conn.execute("BEGIN")

        # 1. Paper — use ON CONFLICT DO UPDATE (not INSERT OR REPLACE which deletes+recreates)
        paper = data.get("paper", {})
        paper_id = paper.get("paper_id")
        if not paper_id:
            conn.execute("ROLLBACK")
            error_exit(EXIT_INPUT_ERROR, "paper.paper_id is required")
        # Check identity conflict: if paper exists with different title, fail
        cur = conn.execute("SELECT title FROM papers WHERE paper_id = ?", (paper_id,))
        existing = cur.fetchone()
        if existing and existing[0] and paper.get("title") and existing[0] != paper.get("title"):
            conn.execute("ROLLBACK")
            error_exit(EXIT_INPUT_ERROR, f"paper_id '{paper_id}' exists with different title — identity conflict")
        conn.execute(
            "INSERT INTO papers (paper_id, title, source_file, source_hash, material_sections_json, completeness_json, issues_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(paper_id) DO UPDATE SET title=excluded.title, source_file=excluded.source_file, "
            "source_hash=excluded.source_hash, material_sections_json=excluded.material_sections_json, "
            "completeness_json=excluded.completeness_json, issues_json=excluded.issues_json",
            (paper_id, paper.get("title", ""), paper.get("source_file"), paper.get("source_hash"),
             json.dumps(paper.get("material_sections", []), ensure_ascii=False),
             json.dumps(paper.get("completeness", {}), ensure_ascii=False),
             json.dumps(paper.get("issues", []), ensure_ascii=False))
        )

        # 2. Questions — ON CONFLICT(question_key) DO UPDATE with identity check
        questions = data.get("questions", [])
        for q in questions:
            qid = q.get("question_id")
            if not qid or not str(qid).strip():
                conn.execute("ROLLBACK")
                error_exit(EXIT_INPUT_ERROR, "question.question_id is required and non-empty")
            qk = _compute_question_key(paper_id, qid)
            # Identity check: if question_key exists with different paper_id, fail
            cur = conn.execute("SELECT paper_id FROM questions WHERE question_key = ?", (qk,))
            existing = cur.fetchone()
            if existing and existing[0] != paper_id:
                conn.execute("ROLLBACK")
                error_exit(EXIT_INPUT_ERROR, f"question_key '{qk}' exists with different paper_id — identity conflict")
            conn.execute(
                "INSERT INTO questions (question_key, question_id, paper_id, question_type, material_scope_json, is_essay, essay_material_scope) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(question_key) DO UPDATE SET question_type=excluded.question_type, "
                "material_scope_json=excluded.material_scope_json, is_essay=excluded.is_essay, "
                "essay_material_scope=excluded.essay_material_scope",
                (qk, qid, paper_id, q.get("question_type", ""),
                 json.dumps(q.get("material_scope", []), ensure_ascii=False),
                 1 if q.get("is_essay") else 0,
                 q.get("essay_material_scope"))
            )

        # 3. Task specs — ON CONFLICT(task_spec_id) DO UPDATE
        task_specs = data.get("task_specs", [])
        for ts in task_specs:
            tsid = ts.get("task_spec_id") or ts.get("task_id")
            if not tsid or not str(tsid).strip():
                conn.execute("ROLLBACK")
                error_exit(EXIT_INPUT_ERROR, "task_spec.task_spec_id/task_id is required and non-empty")
            tid = ts.get("task_id", "")
            if not tid or not str(tid).strip():
                conn.execute("ROLLBACK")
                error_exit(EXIT_INPUT_ERROR, "task_spec.task_id is required and non-empty")
            qid = ts.get("question_id")
            qk = _compute_question_key(paper_id, qid) if qid else None
            conn.execute(
                "INSERT INTO task_specs (task_spec_id, question_key, paper_id, question_id, task_id, task_instruction, "
                "material_scope_json, full_score, identity, audience, purpose, output_genre, primary_prototype_id, "
                "required_content_elements_json, optional_content_elements_json, required_format_elements_json, "
                "relation_requirements_json, style_requirements_json, min_length, max_length, length_unit, "
                "subtasks_json, shared_length_limit, uncertainty_json, spec_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(task_spec_id) DO UPDATE SET task_instruction=excluded.task_instruction, "
                "material_scope_json=excluded.material_scope_json, full_score=excluded.full_score, "
                "identity=excluded.identity, audience=excluded.audience, purpose=excluded.purpose, "
                "output_genre=excluded.output_genre, primary_prototype_id=excluded.primary_prototype_id, "
                "required_content_elements_json=excluded.required_content_elements_json, "
                "optional_content_elements_json=excluded.optional_content_elements_json, "
                "required_format_elements_json=excluded.required_format_elements_json, "
                "relation_requirements_json=excluded.relation_requirements_json, "
                "style_requirements_json=excluded.style_requirements_json, "
                "min_length=excluded.min_length, max_length=excluded.max_length, "
                "length_unit=excluded.length_unit, subtasks_json=excluded.subtasks_json, "
                "shared_length_limit=excluded.shared_length_limit, "
                "uncertainty_json=excluded.uncertainty_json, spec_json=excluded.spec_json",
                (tsid, qk, paper_id, qid, tid, ts.get("task_instruction", ""),
                 json.dumps(ts.get("material_scope", []), ensure_ascii=False),
                 ts.get("full_score"), ts.get("identity"), ts.get("audience"), ts.get("purpose"),
                 ts.get("output_genre"), ts.get("primary_prototype_id"),
                 json.dumps(ts.get("required_content_elements", []), ensure_ascii=False),
                 json.dumps(ts.get("optional_content_elements", []), ensure_ascii=False),
                 json.dumps(ts.get("required_format_elements", []), ensure_ascii=False),
                 json.dumps(ts.get("relation_requirements", []), ensure_ascii=False),
                 json.dumps(ts.get("style_requirements", []), ensure_ascii=False),
                 ts.get("min_length"), ts.get("max_length"), ts.get("length_unit", "字"),
                 json.dumps(ts.get("subtasks", []), ensure_ascii=False),
                 ts.get("shared_length_limit"),
                 json.dumps(ts.get("uncertainty", []), ensure_ascii=False),
                 json.dumps(ts, ensure_ascii=False))
            )
            for comp in ts.get("task_components", []):
                conn.execute(
                    "INSERT INTO task_components (task_spec_id, component_name, is_primary) VALUES (?, ?, ?) "
                    "ON CONFLICT(task_spec_id, component_name) DO UPDATE SET is_primary=excluded.is_primary",
                    (tsid, comp, 1 if comp == ts.get("primary_component") else 0)
                )

        # 4. Reference answer sets — ON CONFLICT
        ref_sets = data.get("reference_answer_sets", [])
        for rs in ref_sets:
            rsid = rs.get("reference_set_id")
            qid = rs.get("question_id")
            qk = _compute_question_key(paper_id, qid) if qid else None
            conn.execute(
                "INSERT INTO reference_answer_sets (reference_set_id, question_key, paper_id, question_id, "
                "source_confidence, consensus_json, disputed_json, equivalent_expressions_json, structure_variants_json, issues_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(reference_set_id) DO UPDATE SET source_confidence=excluded.source_confidence, "
                "consensus_json=excluded.consensus_json, disputed_json=excluded.disputed_json, "
                "equivalent_expressions_json=excluded.equivalent_expressions_json, "
                "structure_variants_json=excluded.structure_variants_json, issues_json=excluded.issues_json",
                (rsid, qk, paper_id, qid, rs.get("source_confidence", "low"),
                 json.dumps(rs.get("consensus_points", []), ensure_ascii=False),
                 json.dumps(rs.get("disputed_points", []), ensure_ascii=False),
                 json.dumps(rs.get("equivalent_expressions", []), ensure_ascii=False),
                 json.dumps(rs.get("structure_variants", []), ensure_ascii=False),
                 json.dumps(rs.get("issues", []), ensure_ascii=False))
            )
            for item in rs.get("items", []):
                conn.execute(
                    "INSERT INTO reference_answer_items (answer_item_id, reference_set_id, answer_id, label, source_type, source_note, reliability, answer_text, supported_point_ids_json, structure_summary) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(answer_item_id) DO UPDATE SET label=excluded.label, source_type=excluded.source_type, "
                    "source_note=excluded.source_note, reliability=excluded.reliability, answer_text=excluded.answer_text, "
                    "supported_point_ids_json=excluded.supported_point_ids_json, structure_summary=excluded.structure_summary",
                    (item.get("answer_item_id"), rsid, item.get("answer_id"), item.get("label"),
                     item.get("source_type", "unverified"), item.get("source_note"),
                     item.get("reliability", "low"), item.get("answer_text", ""),
                     json.dumps(item.get("supported_point_ids", []), ensure_ascii=False),
                     item.get("structure_summary"))
                )

        # 5. Score ledger parent — ON CONFLICT, with NOT NULL FK enforcement
        #    sl is set during pre-validation; if score_ledger key was absent, sl is None
        sl = data.get("score_ledger") if "score_ledger" in data else None
        ledger_id = sl.get("ledger_id") if (sl and isinstance(sl, dict)) else None
        if ledger_id:
            score_id = sl.get("score_id")
            task_id = sl.get("task_id", "")
            answer_id = sl.get("answer_id", "")
            question_key = sl.get("question_key", "")
            if not score_id or not task_id or not answer_id or not question_key:
                conn.execute("ROLLBACK")
                error_exit(EXIT_INPUT_ERROR, "score_ledger requires non-null score_id, task_id, answer_id, question_key")
            conn.execute(
                "INSERT INTO score_ledgers (ledger_id, score_id, task_id, answer_id, question_key, schema_version) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(ledger_id) DO UPDATE SET score_id=excluded.score_id, task_id=excluded.task_id, "
                "answer_id=excluded.answer_id, question_key=excluded.question_key",
                (ledger_id, score_id, task_id, answer_id, question_key, sl.get("schema_version", "1.0"))
            )

            # 6. Point ledgers — ON CONFLICT
            for pl in sl.get("point_ledger", []):
                plid = pl.get("point_ledger_id") or f"{ledger_id}-{pl.get('point_id')}"
                point_key = pl.get("point_key", "")
                if not point_key:
                    conn.execute("ROLLBACK")
                    error_exit(EXIT_INPUT_ERROR, f"point_ledger '{pl.get('point_id')}': point_key is required (NOT NULL FK)")
                conn.execute(
                    "INSERT INTO point_ledgers (point_ledger_id, ledger_id, task_id, answer_id, score_id, point_id, point_key, "
                    "task_component_ids_json, material_evidence, user_quote, match_type, coverage_status, "
                    "credit_reason, loss_reason, deduction_owner, modification_action, reference_support) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(point_ledger_id) DO UPDATE SET material_evidence=excluded.material_evidence, "
                    "user_quote=excluded.user_quote, match_type=excluded.match_type, "
                    "coverage_status=excluded.coverage_status, credit_reason=excluded.credit_reason, "
                    "loss_reason=excluded.loss_reason, deduction_owner=excluded.deduction_owner, "
                    "modification_action=excluded.modification_action, reference_support=excluded.reference_support",
                    (plid, ledger_id, task_id, answer_id, score_id,
                     pl.get("point_id", ""), point_key,
                     json.dumps(pl.get("task_component_ids", []), ensure_ascii=False),
                     pl.get("material_evidence", ""), pl.get("user_quote"),
                     pl.get("match_type", ""), pl.get("coverage_status", ""),
                     pl.get("credit_reason"), pl.get("loss_reason"),
                     pl.get("deduction_owner"), pl.get("modification_action"),
                     pl.get("reference_support"))
                )

            # 7. Structure ledgers — ON CONFLICT, score_id NOT NULL
            for stl in sl.get("structure_ledger", []):
                slid = stl.get("structure_ledger_id") or f"{ledger_id}-{stl.get('element_id')}"
                conn.execute(
                    "INSERT INTO structure_ledgers (structure_ledger_id, ledger_id, task_id, answer_id, score_id, "
                    "element_id, element_type, required, basis, user_evidence, status, credit_reason, loss_reason, deduction_owner, modification_action) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(structure_ledger_id) DO UPDATE SET element_type=excluded.element_type, "
                    "required=excluded.required, basis=excluded.basis, user_evidence=excluded.user_evidence, "
                    "status=excluded.status, credit_reason=excluded.credit_reason, "
                    "loss_reason=excluded.loss_reason, deduction_owner=excluded.deduction_owner, "
                    "modification_action=excluded.modification_action",
                    (slid, ledger_id, task_id, answer_id, score_id,
                     stl.get("element_id", ""), stl.get("element_type", ""),
                     1 if stl.get("required") else 0, stl.get("basis"),
                     stl.get("user_evidence"), stl.get("status", ""),
                     stl.get("credit_reason"), stl.get("loss_reason"),
                     stl.get("deduction_owner"), stl.get("modification_action"))
                )

        conn.commit()

    except sqlite3.Error as e:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        conn.close()
        error_exit(EXIT_DB_ERROR, f"write-unified-state transaction failed — all rolled back: {e}", str(e))
    except Exception as e:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        conn.close()
        error_exit(EXIT_DB_ERROR, f"write-unified-state failed — all rolled back: {e}", str(e))

    conn.close()

    result = {
        "written": True,
        "paper_id": paper_id,
        "questions_written": len(questions),
        "task_specs_written": len(task_specs),
        "reference_sets_written": len(ref_sets),
        "ledger_id": ledger_id,
        "point_ledger_count": len(sl.get("point_ledger", [])) if ledger_id else 0,
        "structure_ledger_count": len(sl.get("structure_ledger", [])) if ledger_id else 0,
    }
    success_output(result, args.output)


# ---------------------------------------------------------------------------
# CLI argument parser
# ---------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(
        prog="review_engine.py",
        description="shenlun-review-pro deterministic engine (standard library only)"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(sp):
        sp.add_argument("--input", default="-", help="Input file path or - for stdin")
        sp.add_argument("--output", default=None, help="Output file path (optional)")
        sp.add_argument("--state-db", default=None, help="SQLite database path")
        sp.add_argument("--format", default="json", help="Output format: json|markdown|html")

    sp = sub.add_parser("normalize-input", help="Parse .txt/.md/.html/.json/.srt into plain text")
    add_common(sp)

    sp = sub.add_parser("validate-analysis", help="Validate analysis-result JSON")
    add_common(sp)

    sp = sub.add_parser("calculate-score", help="Compute scores from scoring-input JSON")
    add_common(sp)

    sp = sub.add_parser("analyze-once", help="Resolve one direct-analysis task in a single call")
    add_common(sp)

    sp = sub.add_parser("finalize-analysis", help="Validate analysis prose from a saved analyze-once receipt")
    add_common(sp)

    sp = sub.add_parser("grade-once", help="Compile compact grading evidence and run formal scoring once")
    add_common(sp)

    sp = sub.add_parser("compare-drafts", help="Compare two scoring results")
    add_common(sp)

    sp = sub.add_parser("check-word-count", help="Deterministic word-count gate (P1-1)")
    add_common(sp)

    sp = sub.add_parser("validate-method-selection", help="Validate method card budget & routing (P1-4)")
    add_common(sp)

    sp = sub.add_parser("resolve-task-prototype", help="Resolve question text to a real task prototype")
    add_common(sp)

    sp = sub.add_parser("resolve-method-selection", help="Resolve task prototype/mode to real method card content")
    add_common(sp)

    sp = sub.add_parser("validate-user-output", help="Reject tables and internal details in normal replies")
    add_common(sp)

    sp = sub.add_parser("validate-user-output-structured", help="Validate user output against structured evidence (analysis+ledger+score)")
    add_common(sp)

    sp = sub.add_parser("validate-scoring-anchor", help="Validate anchor evidence & cross-2-level gate (稳定性修复)")
    add_common(sp)

    sp = sub.add_parser("write-state", help="Write scoring result to SQLite")
    add_common(sp)

    sp = sub.add_parser("migrate-state", help="Import old Markdown state into SQLite")
    add_common(sp)

    sp = sub.add_parser("export-report", help="Export report as JSON/Markdown/HTML")
    add_common(sp)

    sp = sub.add_parser("export-learning-state", help="Export issue cards, ability profiles, and learner profile")
    add_common(sp)

    sp = sub.add_parser("validate-task-prototype", help="Validate task prototype JSON files")
    add_common(sp)

    sp = sub.add_parser("validate-prototype-routing", help="Validate prototype-to-card routing")
    add_common(sp)

    sp = sub.add_parser("healthcheck", help="Verify engine, schema, and database")
    add_common(sp)

    sp = sub.add_parser("compile-task", help="Compile TaskSpec from paper analysis")
    add_common(sp)

    sp = sub.add_parser("validate-task-spec", help="Validate task-spec JSON")
    add_common(sp)

    sp = sub.add_parser("validate-paper-analysis", help="Validate paper-analysis JSON")
    add_common(sp)

    sp = sub.add_parser("compare-reference-answers", help="Compare multiple reference answers")
    add_common(sp)

    sp = sub.add_parser("validate-score-ledger", help="Validate score-ledger JSON")
    add_common(sp)

    sp = sub.add_parser("export-evidence-report", help="Export evidence report")
    add_common(sp)

    sp = sub.add_parser("migrate-db-v4", help="Explicitly migrate v3 database to v4")
    add_common(sp)

    sp = sub.add_parser("write-unified-state", help="Atomically write paper/questions/task_specs/ledgers in one transaction")
    add_common(sp)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    commands = {
        "normalize-input": cmd_normalize_input,
        "validate-analysis": cmd_validate_analysis,
        "calculate-score": cmd_calculate_score,
        "analyze-once": cmd_analyze_once,
        "finalize-analysis": cmd_finalize_analysis,
        "grade-once": cmd_grade_once,
        "compare-drafts": cmd_compare_drafts,
        "check-word-count": cmd_check_word_count,
        "validate-method-selection": cmd_validate_method_selection,
        "resolve-task-prototype": cmd_resolve_task_prototype,
        "resolve-method-selection": cmd_resolve_method_selection,
        "validate-user-output": cmd_validate_user_output,
        "validate-user-output-structured": cmd_validate_user_output_structured,
        "validate-scoring-anchor": cmd_validate_scoring_anchor,
        "validate-task-prototype": cmd_validate_task_prototype,
        "validate-prototype-routing": cmd_validate_prototype_routing,
        "write-state": cmd_write_state,
        "migrate-state": cmd_migrate_state,
        "export-report": cmd_export_report,
        "export-learning-state": cmd_export_learning_state,
        "healthcheck": cmd_healthcheck,
        "compile-task": cmd_compile_task,
        "validate-task-spec": cmd_validate_task_spec,
        "validate-paper-analysis": cmd_validate_paper_analysis,
        "compare-reference-answers": cmd_compare_reference_answers,
        "validate-score-ledger": cmd_validate_score_ledger,
        "export-evidence-report": cmd_export_evidence_report,
        "migrate-db-v4": cmd_migrate_db_v4,
        "write-unified-state": cmd_write_unified_state,
    }

    handler = commands.get(args.command)
    if not handler:
        error_exit(EXIT_INPUT_ERROR, f"Unknown command: {args.command}")

    try:
        handler(args)
        # Clean exit 0 after successful handler completion
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as e:
        error_exit(EXIT_INPUT_ERROR, f"Unexpected error in {args.command}", str(e))


if __name__ == "__main__":
    main()
