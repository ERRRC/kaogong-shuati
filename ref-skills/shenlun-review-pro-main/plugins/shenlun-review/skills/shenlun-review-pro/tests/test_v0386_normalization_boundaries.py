# -*- coding: utf-8 -*-
"""Correctness-first regression matrix for grade-once input normalization."""

import copy
import json
import unittest

from test_v0380_behavior import small_payload
from test_v0381_normal_flow import compact_payload, run_engine, SKILL_DIR


class V0386NormalizationBoundaryTests(unittest.TestCase):
    def assert_rejected(self, payload, expected_fragment):
        code, result = run_engine("grade-once", payload)
        self.assertNotEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        errors = result.get("detail", {}).get("errors", [])
        searchable = [str(result.get("message", "")).lower(), *[
            str(item).lower() for item in errors
        ]]
        self.assertTrue(
            any(expected_fragment.lower() in item for item in searchable),
            json.dumps(result, ensure_ascii=False, indent=2),
        )
        return result

    def test_canonical_and_tolerant_inputs_have_identical_score_semantics(self):
        canonical = compact_payload()
        canonical["reference_available"] = False
        canonical["reference_discovery"] = {
            "status": "not_found",
            "searched_scope": "当前批改输入",
            "evidence": "当前输入未提供参考答案",
        }
        canonical["points"][0]["material_evidence"] = "该地建立一站式服务平台"

        tolerant = compact_payload()
        tolerant.pop("dimensions")
        tolerant["reference_discovery"] = "not_found"
        tolerant["points"][0]["material_evidence"] = [
            "整合多个部门事项",
            "该地建立一站式服务平台……整合多个部门事项",
        ]

        canonical_code, canonical_result = run_engine("grade-once", canonical)
        tolerant_code, tolerant_result = run_engine("grade-once", tolerant)
        self.assertEqual(canonical_code, 0, json.dumps(canonical_result, ensure_ascii=False, indent=2))
        self.assertEqual(tolerant_code, 0, json.dumps(tolerant_result, ensure_ascii=False, indent=2))

        for field in (
            "point_pool_fingerprint", "raw_center", "center_value", "interval",
            "formal_score",
        ):
            self.assertEqual(canonical_result[field], tolerant_result[field], field)
        self.assertEqual(canonical_result["point_coverage"], tolerant_result["point_coverage"])
        for field in ("tier", "tier_label", "tier_position", "tier_position_label"):
            self.assertEqual(
                canonical_result["point_scoring_summary"][field],
                tolerant_result["point_scoring_summary"][field],
                field,
            )

        audit = tolerant_result["input_normalization"]
        self.assertTrue(audit["changed"])
        self.assertEqual(audit["semantic_change_count"], 0)
        self.assertTrue(all(item["semantic_effect"] is False for item in audit["actions"]))

    def test_normalization_audit_never_contains_source_text(self):
        payload = compact_payload()
        payload.pop("dimensions")
        payload["reference_discovery"] = "not_found"
        code, result = run_engine("grade-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        serialized = json.dumps(result["input_normalization"], ensure_ascii=False)
        for secret in (payload["question_text"], payload["material_text"], payload["user_answer"]):
            self.assertNotIn(secret, serialized)

    def test_reference_assisted_tolerance_is_score_invariant(self):
        canonical = small_payload()
        tolerant = copy.deepcopy(canonical)
        tolerant.pop("reference_available")
        tolerant["reference_discovery"] = "found"
        tolerant["reference_calibration"]["candidates"][0]["material_evidence"] = [
            "该地建立一站式服务平台……整合多个部门事项",
            "工作人员主动上门代办……群众办事时间明显缩短",
        ]

        canonical_code, canonical_result = run_engine("grade-once", canonical)
        tolerant_code, tolerant_result = run_engine("grade-once", tolerant)
        self.assertEqual(canonical_code, 0, json.dumps(canonical_result, ensure_ascii=False, indent=2))
        self.assertEqual(tolerant_code, 0, json.dumps(tolerant_result, ensure_ascii=False, indent=2))
        for field in (
            "point_pool_fingerprint", "raw_center", "center_value", "interval",
            "point_coverage", "formal_score",
        ):
            self.assertEqual(canonical_result[field], tolerant_result[field], field)
        self.assertEqual(
            tolerant_result["grade_once_receipt"]["reference_route"],
            "reference_assisted",
        )
        self.assertEqual(
            tolerant_result["grade_once_receipt"]["reference_answer_count"], 1
        )
        self.assertEqual(
            tolerant_result["input_normalization"]["semantic_change_count"], 0
        )

    def test_null_dimension_weights_are_filled_without_score_change(self):
        canonical = compact_payload()
        tolerant = copy.deepcopy(canonical)
        for item in tolerant["dimensions"]:
            item["weight"] = None
        canonical_code, canonical_result = run_engine("grade-once", canonical)
        tolerant_code, tolerant_result = run_engine("grade-once", tolerant)
        self.assertEqual(canonical_code, 0, json.dumps(canonical_result, ensure_ascii=False, indent=2))
        self.assertEqual(tolerant_code, 0, json.dumps(tolerant_result, ensure_ascii=False, indent=2))
        self.assertEqual(canonical_result["center_value"], tolerant_result["center_value"])
        self.assertTrue(all(item["weight"] is not None for item in tolerant_result["dimensions"]))

    def test_unknown_reference_status_is_not_guessed(self):
        payload = compact_payload()
        payload["reference_discovery"] = "maybe"
        self.assert_rejected(payload, "reference_discovery.status must be found or not_found")

    def test_explicit_reference_conflict_is_rejected(self):
        payload = compact_payload()
        payload["reference_available"] = True
        payload["reference_discovery"] = "found"
        self.assert_rejected(
            payload, "reference_available=true requires reference_answers"
        )

    def test_reference_count_mismatch_is_rejected(self):
        payload = compact_payload()
        payload["expected_reference_answer_count"] = 1
        self.assert_rejected(
            payload, "expected_reference_answer_count does not match"
        )

    def test_material_evidence_with_unsupported_fragment_is_rejected(self):
        payload = compact_payload()
        payload["points"][0]["material_evidence"] = [
            "该地建立一站式服务平台",
            "材料中完全没有的政策",
        ]
        result = self.assert_rejected(
            payload, "points[0].material_evidence[1] is not found"
        )
        errors = result.get("detail", {}).get("errors", [])
        self.assertFalse(any("material_evidence[0]" in item for item in errors))

    def test_reverse_order_ellipsis_shorthand_is_rejected(self):
        payload = compact_payload()
        payload["points"][0]["material_evidence"] = (
            "整合多个部门事项……该地建立一站式服务平台"
        )
        self.assert_rejected(
            payload,
            "uses shorthand fragments in a different material order",
        )

    def test_reverse_order_array_items_remain_valid_independent_excerpts(self):
        payload = compact_payload()
        payload["points"][0]["material_evidence"] = [
            "整合多个部门事项",
            "该地建立一站式服务平台",
        ]
        code, result = run_engine("grade-once", payload)
        self.assertEqual(
            code, 0, json.dumps(result, ensure_ascii=False, indent=2)
        )

    def test_invalid_coverage_status_is_rejected(self):
        payload = compact_payload()
        payload["points"][0]["coverage_status"] = "差不多覆盖"
        self.assert_rejected(payload, "coverage_status")

    def test_answer_quote_ellipsis_and_partial_expansion_normalize_once(self):
        payload = compact_payload()
        point = payload["points"][0]
        point["coverage_status"] = "部分覆盖"
        point["user_quote"] = "建立一站式服务平台……整合事项"
        point["expansion_level"] = "部分展开"
        code, result = run_engine("grade-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        coverage = result["point_coverage"][0]
        self.assertEqual(coverage["user_quote"], "建立一站式服务平台，整合事项")
        self.assertEqual(coverage["expansion_level"], "简略提及")
        actions = result["input_normalization"]["actions"]
        self.assertTrue(any(
            item["field"] == "points[0].user_quote"
            and item["action"] == "canonicalize_verified_answer_quote"
            for item in actions
        ))
        self.assertTrue(any(
            item["field"] == "points[0].expansion_level"
            and item["action"] == "derive_from_coverage_status"
            for item in actions
        ))

    def test_unknown_expansion_level_is_reported_in_aggregated_preflight(self):
        payload = compact_payload()
        payload["points"][0]["user_quote"] = "作答完全没有的句子"
        payload["points"][0]["expansion_level"] = "随意展开"
        result = self.assert_rejected(payload, "user_quote")
        errors = result["detail"]["errors"]
        self.assertTrue(any("expansion_level" in item for item in errors))

    def test_ocr_uncertainty_cannot_be_declared_uncovered(self):
        payload = compact_payload()
        payload["points"][0].update({
            "coverage_status": "未覆盖",
            "user_quote": "",
            "ocr_status": "uncertain",
            "ocr_uncertainty_note": "手写此处模糊",
        })
        self.assert_rejected(payload, "ocr")

    def test_runtime_documents_are_small_and_separated(self):
        skill = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
        runtime = (
            SKILL_DIR / "references" / "contracts" / "grade-once-runtime.md"
        ).read_text(encoding="utf-8")
        self.assertLess(len(skill.encode("utf-8")), 10_000)
        self.assertLess(len(runtime.encode("utf-8")), 9_000)
        self.assertIn("普通批改：`references/contracts/grade-once-runtime.md`", skill)
        self.assertIn("工程审计/契约开发", skill)


if __name__ == "__main__":
    unittest.main(verbosity=2)
