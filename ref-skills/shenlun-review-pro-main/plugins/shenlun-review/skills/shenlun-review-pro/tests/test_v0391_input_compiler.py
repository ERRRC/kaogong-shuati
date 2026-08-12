# -*- coding: utf-8 -*-
"""Regression tests for deterministic grade-once input compilation."""

import copy
import json
import unittest

from test_v0380_behavior import no_reference, run_engine


def application_payload():
    material = "该地建立便民平台，实现事项集成办理，群众满意度明显提升。"
    answer = "建立便民平台，实现事项集成办理，提升群众满意度。"
    return {
        "question_text": "根据给定资料，以工作人员身份拟写一份汇报提纲，介绍主要做法和成效。（25分，不超过400字）",
        "full_score": 25,
        "material_text": material,
        "user_answer": answer,
        "points": [{
            "point_id": "app-1",
            "point_text": "平台集成办理并提升满意度",
            "material_evidence": material[:-1],
            "coverage_status": "完整覆盖",
            "user_quote": answer[:-1],
            "point_value": 25,
            "expansion_level": "充分展开",
        }],
        "application_review": {
            "identity_status": "accurate",
            "genre_format_status": "missing",
            "purpose_audience_status": "strong",
            "content_status": "complete",
            "structure_status": "clear",
            "tone_status": "appropriate",
            "template_use_status": "not_applicable",
            "evidence": "内容与场景任务完成",
        },
        "required_format_elements": [],
        "point_pool_review": {"status": "verified", "evidence": "已核对做法与成效"},
        **no_reference(),
    }


def essay_payload():
    material = (
        "便民平台让群众办事更高效。"
        "上门代办连接基层与群众，提升了治理的温度和精度。"
    )
    answer = (
        "服务与治理相互支撑，优质服务提升治理效能。\n\n"
        "第一，便民平台让群众办事更高效，体现治理回应需求。\n\n"
        "第二，上门代办连接基层与群众，把服务温度转化为治理精度。\n\n"
        "因此，应以持续服务夯实治理基础。"
    )
    audits = [
        {
            "argument_quote": "第一，便民平台让群众办事更高效，体现治理回应需求",
            "logical_level": "服务效率",
            "supports_thesis": True,
            "source_role": "mixed",
            "develops_side_a": False,
            "develops_side_b": False,
            "explains_relationship": False,
            "evidence": "材料事例已转化为分论点论证",
        },
        {
            "argument_quote": "第二，上门代办连接基层与群众，把服务温度转化为治理精度",
            "logical_level": "基层连接",
            "supports_thesis": True,
            "source_role": "mixed",
            "develops_side_a": False,
            "develops_side_b": False,
            "explains_relationship": False,
            "evidence": "材料事例已转化为服务与治理的分析",
        },
    ]
    return {
        "question_text": "请结合给定资料，以“服务与治理”为题目，自选角度，写一篇文章。（40分，1000字左右）",
        "full_score": 40,
        "material_text": material,
        "user_answer": answer,
        "points": [
            {
                "point_id": "essay-1",
                "point_text": "便民平台提升效率",
                "material_evidence": "便民平台让群众办事更高效",
                "coverage_status": "完整覆盖",
                "user_quote": "便民平台让群众办事更高效",
            },
            {
                "point_id": "essay-2",
                "point_text": "上门代办连接基层群众",
                "material_evidence": "上门代办连接基层与群众",
                "coverage_status": "完整覆盖",
                "user_quote": "上门代办连接基层与群众",
            },
        ],
        "essay_review": {
            "central_thesis": "优质服务提升治理效能",
            "relationship_type": "theme_link",
            "relationship_centrality": "not_applicable",
            "material_support": "便民平台与上门代办两个材料事例",
            "reasoning_bridge": "从办事效率和基层连接说明治理效能",
            "return_to_thesis": "结尾回扣以服务夯实治理基础",
            "topic_specificity": "strong",
            "argument_line_status": "sound",
            "material_support_status": "strong",
            "template_risk": "none",
            "prompt_relation_required": False,
            "relationship_coverage_status": "not_applicable",
            "thesis_scope_status": "accurate",
            "sub_argument_system_status": "sound",
            "material_transformation_status": "transformed",
            "sub_argument_chain": ["服务效率提升治理回应", "基层服务连接提升治理精度"],
            "counterargument_or_boundary": None,
            "language_status": "strong",
            "example_support_status": "strong",
            "evidence": "中心论点、两个分论点、材料转化和结尾回扣均可定位",
            "judgment_evidence": {
                "prompt_relation_quote": None,
                "relationship_centrality_rationale": "题目为主题型作文，不强制关系命题",
                "central_thesis_quote": "服务与治理相互支撑，优质服务提升治理效能",
                "side_a_quote": None,
                "side_b_quote": None,
                "relationship_bridge_quote": None,
                "scope_rationale": "中心与题目主题一致",
                "sub_argument_audit": audits,
                "material_transformation_quote": "上门代办连接基层与群众，把服务温度转化为治理精度",
            },
        },
        "point_pool_review": {"status": "verified", "evidence": "作文材料支撑点已核对"},
        **no_reference(),
    }


class V0391InputCompilerTests(unittest.TestCase):
    def run_grade(self, payload):
        code, result = run_engine("grade-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        return result

    def assert_rejected(self, payload, fragment):
        code, result = run_engine("grade-once", payload)
        self.assertNotEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        errors = result.get("detail", {}).get("errors", [])
        text = "\n".join([str(result.get("message", "")), *map(str, errors)])
        self.assertIn(fragment, text)

    def test_application_dimensions_compile_without_format_penalty(self):
        compact = application_payload()
        canonical = copy.deepcopy(compact)
        canonical["dimension_levels"] = {
            "身份文种格式": 4,
            "结构": 4,
            "内容覆盖": 4,
            "目的场景": 4,
            "语言语气": 4,
        }
        compact_result = self.run_grade(compact)
        canonical_result = self.run_grade(canonical)
        for field in ("raw_center", "center_value", "interval", "formal_score"):
            self.assertEqual(compact_result[field], canonical_result[field], field)
        self.assertEqual(
            compact_result["application_score_policy"]["format_required"], False
        )
        self.assertTrue(any(
            item["action"] == "derive_application_dimensions_from_review"
            for item in compact_result["input_normalization"]["actions"]
        ))

    def test_application_material_coverage_cannot_be_overstated(self):
        payload = application_payload()
        payload["points"][0]["coverage_status"] = "部分覆盖"
        payload["points"][0]["expansion_level"] = "简略提及"
        result = self.run_grade(payload)
        levels = {item["dimension_name"]: item["level"] for item in result["dimensions"]}
        self.assertEqual(levels["内容覆盖"], 2)
        self.assertEqual(
            result["application_score_policy"]["material_content_status"], "partial"
        )

    def test_essay_dimensions_compile_to_same_formal_score(self):
        compact = essay_payload()
        canonical = copy.deepcopy(compact)
        canonical["dimension_levels"] = {
            "立意扣题": 4,
            "材料运用": 4,
            "论证深度": 3,
            "结构": 3,
            "论据例证": 4,
            "语言": 4,
        }
        compact_result = self.run_grade(compact)
        canonical_result = self.run_grade(canonical)
        for field in (
            "raw_center", "center_value", "interval", "formal_score",
            "essay_score_policy", "point_pool_fingerprint",
        ):
            self.assertEqual(compact_result[field], canonical_result[field], field)
        self.assertTrue(any(
            item["action"] == "derive_essay_dimensions_from_review"
            for item in compact_result["input_normalization"]["actions"]
        ))

    def test_nested_dimension_levels_are_lifted_without_change(self):
        payload = essay_payload()
        payload["essay_review"].pop("language_status")
        payload["essay_review"].pop("example_support_status")
        payload["essay_review"]["dimension_levels"] = {
            "立意扣题": 3,
            "材料运用": 3,
            "论证深度": 3,
            "结构": 3,
            "论据例证": 3,
            "语言": 3,
        }
        result = self.run_grade(payload)
        self.assertTrue(any(
            item["action"] == "lift_review_dimension_levels"
            for item in result["input_normalization"]["actions"]
        ))

    def test_conflicting_top_and_nested_levels_are_rejected(self):
        payload = application_payload()
        payload["dimension_levels"] = {
            "身份文种格式": 4,
            "结构": 4,
            "内容覆盖": 4,
            "目的场景": 4,
            "语言语气": 4,
        }
        payload["application_review"]["dimension_levels"] = {
            **payload["dimension_levels"],
            "内容覆盖": 1,
        }
        self.assert_rejected(payload, "conflict")

    def test_essay_missing_compiler_judgments_fails_closed(self):
        payload = essay_payload()
        payload["essay_review"].pop("language_status")
        payload["essay_review"].pop("example_support_status")
        self.assert_rejected(payload, "language_status")
        self.assert_rejected(payload, "example_support_status")


if __name__ == "__main__":
    unittest.main(verbosity=2)
