#!/usr/bin/env python3
"""Cross-client guard against terminal bypasses in ordinary grading.

The deterministic runner is private to the MCP server. In a normal user
conversation, grading must use the two MCP tools; terminal-built input files
and direct engine invocations are rejected.
"""

import json
import re
import sys
from pathlib import Path


BLOCK_MESSAGE = (
    "申论普通批改优先使用结构化工具 shenlun_grade_once；成稿优先使用 "
    "shenlun_validate_user_output。MCP 不可用时，停止正式评分并提示用户启用 "
    "申论插件；不要用终端、heredoc、python -c、临时 Python 或临时 JSON 调用 "
    "评分引擎。"
)

TEMPORARY_GRADING_NAMES = {
    "build_grade_json.py",
    "grade_once_input.json",
    "grade-once-input.json",
    "shenlun_grade_input.json",
    "shenlun-grade-input.json",
    "grade_input.json",
    "grade-input.json",
    "validate_input.json",
    "validate-input.json",
    "grade_receipt.json",
    "grade-receipt.json",
    "validate_receipt.json",
    "validate-receipt.json",
}

GRADE_COMMAND = re.compile(r"\b(?:grade-once|validate-user-output)\b", re.I)
TERMINAL_GRADING_RUNNER = re.compile(
    r"\b(?:safe_review_runner|review_engine|shenlun_mcp_server)\.py\b", re.I
)
GRADING_ARTIFACT_NAME = re.compile(
    r"^(?:shenlun[-_]?)?(?:grade|grading|score|scoring|validate|validation|"
    r"receipt|review)(?:[-_][a-z0-9]+)*\.(?:json|py)$",
    re.I,
)
PYTHON_HEREDOC = re.compile(
    r"\bpython(?:3(?:\.\d+)?)?\b[^\n]*(?:<<[-~]?\s*['\"]?[A-Za-z_][A-Za-z0-9_]*|-[cC]\b)",
    re.I,
)
SHENLUN_MARKER = re.compile(
    r"shenlun|申论|grade[_-]?once|review_engine|safe_review_runner", re.I
)


def deny(reason):
    message = f"{BLOCK_MESSAGE}\n\n拦截原因：{reason}"
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": message,
        },
        "systemMessage": message,
    }


def filename_is_blocked(value):
    if not isinstance(value, str) or not value:
        return False
    name = Path(value).name.lower()
    return name in TEMPORARY_GRADING_NAMES or bool(
        GRADING_ARTIFACT_NAME.fullmatch(name)
    )


def inspect_bash(tool_input):
    command = tool_input.get("command")
    if not isinstance(command, str):
        return None

    lowered = command.lower()
    if any(name in lowered for name in TEMPORARY_GRADING_NAMES):
        return deny("检测到旧的申论批改临时输入或临时脚本名")

    if TERMINAL_GRADING_RUNNER.search(command):
        return deny("检测到从终端直接调用申论评分、校验或 MCP 脚本")

    if GRADE_COMMAND.search(command) and SHENLUN_MARKER.search(command):
        return deny("检测到从终端绕过申论 MCP 工具调用评分或成稿校验")

    if PYTHON_HEREDOC.search(command) and SHENLUN_MARKER.search(command):
        return deny("检测到为申论批改拼装输入的 Python heredoc 或 python -c")

    return None


def inspect_file_tool(tool_name, tool_input):
    paths = []
    for key in ("file_path", "path"):
        value = tool_input.get(key)
        if isinstance(value, str):
            paths.append(value)

    if tool_name == "MultiEdit":
        edits = tool_input.get("edits")
        if isinstance(edits, list):
            for edit in edits:
                if isinstance(edit, dict):
                    for key in ("file_path", "path"):
                        value = edit.get(key)
                        if isinstance(value, str):
                            paths.append(value)

    if any(filename_is_blocked(path) for path in paths):
        return deny("检测到创建或修改旧的申论批改临时脚本/临时 JSON")
    return None


def main():
    try:
        request = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeError):
        print("{}")
        return 0

    if not isinstance(request, dict):
        print("{}")
        return 0

    tool_name = request.get("tool_name", "")
    tool_input = request.get("tool_input", {})
    if not isinstance(tool_input, dict):
        tool_input = {}

    result = None
    if tool_name == "Bash":
        result = inspect_bash(tool_input)
    elif tool_name in {"Write", "Edit", "MultiEdit"}:
        result = inspect_file_tool(tool_name, tool_input)

    print(json.dumps(result or {}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
