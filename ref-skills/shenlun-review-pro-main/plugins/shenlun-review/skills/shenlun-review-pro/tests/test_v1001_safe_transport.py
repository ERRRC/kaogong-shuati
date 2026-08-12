# -*- coding: utf-8 -*-
"""Regression tests for the fixed JSON-only grading transport."""

import json
import subprocess
import unittest
from pathlib import Path

from test_v0380_behavior import small_payload


SKILL_DIR = Path(__file__).resolve().parents[1]
RUNNER = SKILL_DIR / "scripts" / "safe_review_runner.py"
SKILL_FILE = SKILL_DIR / "SKILL.md"
RUNTIME_CONTRACT = (
    SKILL_DIR / "references" / "contracts" / "grade-once-runtime.md"
)


def run_safe(command, payload_text):
    args = ["python3", str(RUNNER), command]
    return subprocess.run(
        args,
        input=payload_text,
        text=True,
        capture_output=True,
        check=False,
    )


class V1001SafeTransportTests(unittest.TestCase):
    def special_payload(self):
        payload = small_payload()
        special = (
            '群众称政策为"以奖代补"。\n'
            "路径示例为 C:\\review\\draft；"
            "字符 $()、`command` 只属于作答文本。"
        )
        payload["material_text"] += special
        payload["user_answer"] += special
        return payload

    def test_stdin_preserves_quotes_newlines_and_shell_metacharacters(self):
        payload_text = json.dumps(self.special_payload(), ensure_ascii=False)
        proc = run_safe("grade-once", payload_text)
        self.assertEqual(proc.returncode, 0, proc.stdout or proc.stderr)
        result = json.loads(proc.stdout)
        self.assertTrue(result["formal_score"])
        self.assertTrue(result["grade_once_receipt"]["single_compile"])

    def test_invalid_json_returns_transport_error_without_traceback(self):
        malformed = '{"user_answer":"政策称为"以奖代补""}'
        proc = run_safe("grade-once", malformed)
        self.assertEqual(proc.returncode, 2)
        result = json.loads(proc.stderr)
        self.assertEqual(result["error_type"], "transport_error")
        self.assertEqual(result["detail"]["maximum_retry_count"], 1)
        self.assertTrue(result["detail"]["do_not_generate_python"])
        self.assertNotIn("Traceback", proc.stderr)

    def test_timeout_is_bounded(self):
        payload_text = json.dumps(self.special_payload(), ensure_ascii=False)
        proc = subprocess.run(
            [
                "python3",
                str(RUNNER),
                "grade-once",
                "--timeout",
                "61",
            ],
            input=payload_text,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 2)
        result = json.loads(proc.stderr)
        self.assertEqual(result["error_type"], "transport_error")

    def test_contracts_lock_out_generated_python(self):
        skill_text = SKILL_FILE.read_text(encoding="utf-8")
        runtime_text = RUNTIME_CONTRACT.read_text(encoding="utf-8")
        for text in (skill_text, runtime_text):
            self.assertIn("shenlun_grade_once", text)
            self.assertIn("shenlun_validate_user_output", text)
            self.assertIn("python3 - <<'PY'", text)
            self.assertIn("仍未加载或宿主不支持 MCP", text)
            self.assertIn("第二次失败", text)
            self.assertIn("不得改其他已通过字段", text)
            self.assertIn("safe_review_runner.py", text)
        self.assertIn("只供 MCP Server 内部调用", skill_text)
        self.assertIn("普通智能体不得把它当作终端降级入口", runtime_text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
