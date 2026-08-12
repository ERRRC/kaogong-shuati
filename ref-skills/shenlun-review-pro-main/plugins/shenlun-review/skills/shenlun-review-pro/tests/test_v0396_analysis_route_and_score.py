# -*- coding: utf-8 -*-
"""Regression tests for experience-question routing and analysis score carry-through."""

import json
import subprocess
import unittest
from pathlib import Path


ENGINE = Path(__file__).resolve().parents[1] / "scripts" / "review_engine.py"


def run_engine(command, payload):
    proc = subprocess.run(
        ["python3", str(ENGINE), command],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        check=False,
    )
    return proc.returncode, json.loads(proc.stdout or proc.stderr)


class V0396AnalysisRouteAndScoreTests(unittest.TestCase):
    def experience_payload(self):
        return {
            "question_text": (
                "第二题（15分）请根据‘给定资料2’，分析耀州市推动传统制造业"
                "‘产业焕新’的成功经验。要求：分析全面，逻辑清晰，不超过300字。"
            ),
            "material_text": (
                "耀州市启动‘产业焕新’行动，推动传统制造业向高端化、智能化、绿色化转型。"
                "企业建设智能工厂，联合高校共建研究院。"
            ),
        }

    def test_successful_experience_routes_without_fallback(self):
        code, result = run_engine("analyze-once", self.experience_payload())
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertEqual(result["prototype_id"], "sl-prototype-0001")
        self.assertEqual(result["question_type"], "归纳概括")
        self.assertEqual(
            result["prototype_resolution_receipt"]["resolution_mode"],
            "literal_trigger",
        )
        self.assertEqual(result["full_score"], 15)
        self.assertEqual(result["full_score_source"], "question_text_heading")
        context = result["output_validation_context"]
        self.assertEqual(context["full_score"], 15)
        self.assertEqual(result["analysis_once_receipt"]["full_score"], 15)

    def test_missing_score_is_not_guessed(self):
        payload = self.experience_payload()
        payload["question_text"] = payload["question_text"].replace("第二题（15分）", "第二题")
        code, result = run_engine("analyze-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertIsNone(result["full_score"])
        self.assertEqual(result["full_score_source"], "not_found")

    def test_conflicting_explicit_scores_are_not_resolved_by_guessing(self):
        payload = self.experience_payload()
        payload["question_text"] = payload["question_text"].replace(
            "要求：", "总分20分。要求："
        )
        code, result = run_engine("analyze-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertIsNone(result["full_score"])
        self.assertEqual(result["full_score_source"], "conflict")
        self.assertEqual(result["analysis_input_audit"]["full_score_candidates"], [20, 15])

    def test_analysis_output_must_keep_explicit_score(self):
        code, result = run_engine("analyze-once", self.experience_payload())
        self.assertEqual(code, 0)
        context = result["output_validation_context"]
        method = context["required_method_names"][0]
        answer = "一、智能化升级；二、协同创新。"
        base = (
            "题干拆解：明确任务、对象和字数要求。"
            f"方法讲解：使用{method}，先锁定经验对象，再回到材料逐点核对。"
            "材料证据：围绕智能工厂、研究院和转型路径找点。"
            "答案组织：按总体部署、行业做法归类。"
            "易错提醒：不把成效数字单列为经验。"
            f"示范答案：{answer}"
        )
        code, failed = run_engine("validate-user-output", {
            "text": base,
            "validation_context": context,
            "reference_answer_text": answer,
        })
        self.assertNotEqual(code, 0)
        self.assertIn(
            "missing_question_score",
            {item["type"] for item in failed["detail"]["issues"]},
        )
        code, passed = run_engine("validate-user-output", {
            "text": "本题满分15分。" + base,
            "validation_context": context,
            "reference_answer_text": answer,
        })
        self.assertEqual(code, 0, json.dumps(passed, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    unittest.main(verbosity=2)
