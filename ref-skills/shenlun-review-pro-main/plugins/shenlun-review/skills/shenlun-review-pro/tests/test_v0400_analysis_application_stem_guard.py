# -*- coding: utf-8 -*-
"""Regression tests for application-task stems with role preambles."""

import json
import subprocess
import unittest
from pathlib import Path


ENGINE = Path(__file__).resolve().parents[1] / "scripts" / "review_engine.py"


def analyze(question_text):
    proc = subprocess.run(
        ["python3", str(ENGINE), "analyze-once"],
        input=json.dumps(
            {"question_text": question_text, "material_text": "材料：某地推进相关工作。"},
            ensure_ascii=False,
        ),
        text=True,
        capture_output=True,
        check=False,
    )
    return proc.returncode, json.loads(proc.stdout or proc.stderr)


class V0400AnalysisApplicationStemGuardTests(unittest.TestCase):
    def test_role_preamble_with_written_report_outline_is_accepted(self):
        code, result = analyze(
            "第三题（20分）假如你是陵江市政务服务管理局工作人员，请根据给定资料3，撰写一份汇报提纲，供领导参阅。"
        )
        self.assertEqual(code, 0, result)
        self.assertEqual(result["prototype_id"], "sl-prototype-0010")
        self.assertTrue(result["analysis_input_audit"]["question_stem_audit"]["task_signal_found"])

    def test_explicit_genre_is_enough_without_role_preamble(self):
        code, result = analyze("请根据给定资料，撰写一份汇报提纲，供领导参阅。")
        self.assertEqual(code, 0, result)
        self.assertEqual(result["prototype_id"], "sl-prototype-0010")

    def test_common_application_verbs_are_accepted(self):
        cases = {
            "请草拟一份情况报告，供领导参阅。": "sl-prototype-0010",
            "请准备一份经验交流发言材料。": "sl-prototype-0015",
            "假如你是工作人员，请起草一份工作指南。": "sl-prototype-0013",
            "请拟写一份政协建议案。": "sl-prototype-0012",
        }
        for question, expected in cases.items():
            with self.subTest(question=question):
                code, result = analyze(question)
                self.assertEqual(code, 0, result)
                self.assertEqual(result["prototype_id"], expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
