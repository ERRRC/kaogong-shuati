# -*- coding: utf-8 -*-
"""Regression tests for analysis task detection and self-describing output validation."""

import json
import unittest

from test_v0381_normal_flow import run_engine


MATERIAL = "该地搭建服务平台，整合部门事项；组织工作人员上门代办。"


class V0392AnalysisTaskGuardTests(unittest.TestCase):
    def test_material_summary_waiting_for_question_is_rejected(self):
        payload = {
            "question_text": (
                "已收到素材部分，先做材料脉络梳理。五则材料适合出题概括、"
                "分析、应用文和大作文，等你把题干发过来。"
            ),
            "material_text": MATERIAL,
        }
        code, result = run_engine("analyze-once", payload)
        self.assertNotEqual(code, 0)
        self.assertIn("actual exam task stem", result["message"])

    def test_real_task_after_waiting_text_is_accepted(self):
        payload = {
            "question_text": (
                "材料已收到，等你把题干发过来。\n"
                "一、请根据给定资料1，概括该地的主要做法。不超过30字。"
            ),
            "material_text": MATERIAL,
        }
        code, result = run_engine("analyze-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        audit = result["analysis_input_audit"]["question_stem_audit"]
        self.assertTrue(audit["passed"])
        self.assertTrue(audit["task_appended_after_waiting_text"])

    def test_short_exam_task_without_qing_is_accepted(self):
        payload = {
            "question_text": "谈谈小雷是如何解决这些问题的。不超过300字。",
            "material_text": MATERIAL,
        }
        code, result = run_engine("analyze-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))

    def test_no_reference_context_is_self_describing(self):
        payload = {
            "question_text": "请根据给定资料，概括该地的主要做法。不超过30字。",
            "material_text": MATERIAL,
        }
        code, result = run_engine("analyze-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        context = result["output_validation_context"]
        self.assertEqual(context["generated_answer_policy"], "allowed")
        requirements = context["validation_payload_requirements"]
        self.assertEqual(
            requirements["required_fields"],
            ["receipt_path", "text", "reference_answer_text"],
        )
        self.assertEqual(requirements["entrypoint"], "finalize-analysis")
        self.assertFalse(requirements["manual_context_fields_allowed"])
        self.assertFalse(requirements["source_or_schema_lookup_required"])

    def test_existing_reference_context_forbids_second_answer(self):
        payload = {
            "question_text": "请根据给定资料，概括该地的主要做法。不超过30字。",
            "material_text": MATERIAL,
            "reference_answers": [{"answer_text": "搭建平台，整合事项；上门代办。"}],
        }
        code, result = run_engine("analyze-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        context = result["output_validation_context"]
        self.assertEqual(context["generated_answer_policy"], "forbidden")
        self.assertEqual(
            context["validation_payload_requirements"]["required_fields"],
            ["receipt_path", "text"],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
