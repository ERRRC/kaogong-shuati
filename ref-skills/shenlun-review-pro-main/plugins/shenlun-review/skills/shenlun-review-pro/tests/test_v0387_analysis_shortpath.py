# -*- coding: utf-8 -*-
"""Regression tests for the direct-analysis short path."""

import copy
import json
import unittest

from test_v0381_normal_flow import run_engine, SKILL_DIR


def analysis_payload():
    return {
        "question_text": "根据给定资料，概括该地的主要做法。不超过30字。",
        "material_text": "该地搭建服务平台，整合部门事项；组织工作人员上门代办。",
    }


class V0387AnalysisShortPathTests(unittest.TestCase):
    def test_minimal_analysis_returns_complete_final_gate_context(self):
        code, result = run_engine("analyze-once", analysis_payload())
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        receipt = result["analysis_once_receipt"]
        self.assertEqual(receipt["external_command_count"], 1)
        self.assertEqual(receipt["scoring_command_count"], 0)
        self.assertFalse(receipt["write_back"])
        context = result["output_validation_context"]
        self.assertEqual(context["output_mode"], "解析")
        self.assertFalse(context["reference_available"])
        self.assertEqual(
            context["reference_answer_length_constraints"]["max_length"], 30
        )
        self.assertTrue(context["required_method_names"])
        self.assertFalse(result["analysis_input_audit"]["raw_text_included"])

    def test_no_reference_analysis_checks_answer_length_in_final_gate(self):
        code, analyzed = run_engine("analyze-once", analysis_payload())
        self.assertEqual(code, 0, json.dumps(analyzed, ensure_ascii=False, indent=2))
        method = analyzed["output_validation_context"]["required_method_names"][0]
        answer = "搭建服务平台整合事项，组织上门代办。"
        text = (
            "题干拆解：明确概括任务和作答对象，形成答案责任。\n"
            f"方法讲解：本题用{method}，先圈出题干动作，"
            "再回到材料逐点合并。\n\n"
            "材料证据：平台整合和上门代办均有材料依据，说明为什么归为主要做法。\n"
            "答案组织：按主体动作分点，保留关键限定。\n"
            "易错提醒：不要把结果或背景替代做法。\n\n"
            f"参考答案：\n{answer}"
        )
        code, validated = run_engine("validate-user-output", {
            "text": text,
            "reference_answer_text": answer,
            "validation_context": analyzed["output_validation_context"],
        })
        self.assertEqual(code, 0, json.dumps(validated, ensure_ascii=False, indent=2))
        self.assertTrue(validated["reference_answer_length_check"]["compliant"])

    def test_analysis_range_length_is_inferred_conservatively(self):
        payload = analysis_payload()
        payload["question_text"] = "请以‘流动与新生’为题目，写一篇文章，1000—1200字。"
        code, result = run_engine("analyze-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        constraints = result["output_validation_context"]["reference_answer_length_constraints"]
        self.assertEqual(constraints["min_length"], 1000)
        self.assertEqual(constraints["max_length"], 1200)
        self.assertEqual(
            result["analysis_input_audit"]["length_constraint_source"],
            "question_text_range",
        )

    def test_reference_route_disallows_second_generated_answer(self):
        payload = analysis_payload()
        payload["reference_answers"] = [{"answer_text": "搭建平台，整合事项；上门代办。"}]
        payload["expected_reference_answer_count"] = 1
        code, result = run_engine("analyze-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertEqual(result["reference_route"], "reference_assisted")
        self.assertTrue(result["output_validation_context"]["reference_available"])
        self.assertFalse(
            result["output_validation_context"]["reference_answer_text_required"]
        )

    def test_reference_count_conflict_is_rejected(self):
        payload = analysis_payload()
        payload["reference_answers"] = ["参考答案"]
        payload["expected_reference_answer_count"] = 2
        code, result = run_engine("analyze-once", payload)
        self.assertNotEqual(code, 0)
        self.assertIn("does not match", result["message"])

    def test_two_reference_container_forms_are_rejected(self):
        payload = analysis_payload()
        payload["reference_answers"] = ["参考答案"]
        payload["reference_answer_set"] = {
            "answers": [{"answer_id": "r1", "answer_text": "参考答案"}]
        }
        code, result = run_engine("analyze-once", payload)
        self.assertNotEqual(code, 0)
        self.assertIn("not both", result["message"])

    def test_analysis_runtime_contract_is_small_and_explicit(self):
        skill = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
        contract = (
            SKILL_DIR / "references" / "contracts" / "analyze-once-runtime.md"
        ).read_text(encoding="utf-8")
        grade_contract = (
            SKILL_DIR / "references" / "contracts" / "grade-once-runtime.md"
        ).read_text(encoding="utf-8")
        self.assertLess(len(contract.encode("utf-8")), 8_000)
        self.assertIn("普通解析执行锁", skill)
        self.assertIn("不得单独调用 `check-word-count`", contract)
        self.assertIn("只发送 `approved_text`", contract)
        self.assertIn("application_review", grade_contract)
        self.assertIn("essay_review", grade_contract)
        self.assertIn("sub_argument_audit", grade_contract)
        self.assertIn("格式只有在题目明确要求时检查", grade_contract)
        self.assertIn("不得手工改分", grade_contract)
        self.assertIn("受控读取完整契约", grade_contract)
        self.assertIn("正确率优先", skill)


if __name__ == "__main__":
    unittest.main(verbosity=2)
