# -*- coding: utf-8 -*-
"""Regression tests for the balanced five-tier score ranges."""

import json
import unittest

from test_v0380_behavior import run_engine, small_payload
from test_v0391_input_compiler import essay_payload


class V0410BalancedTierRangeTests(unittest.TestCase):
    def test_first_tier_keeps_16_as_lower_bound(self):
        payload = small_payload()
        payload["points"][0]["expansion_level"] = "基本展开"
        payload["points"][1]["expansion_level"] = "简略提及"
        code, result = run_engine("grade-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertEqual(result["point_scoring_summary"]["tier"], 1)
        self.assertEqual(result["center_value"], 16)
        self.assertEqual(result["point_scoring_summary"]["tier_label"], "一档")

    def test_low_coverage_uses_fifth_tier_without_leaking_into_fourth(self):
        payload = small_payload()
        for point in payload["points"]:
            point["coverage_status"] = "未覆盖"
            point["user_quote"] = ""
            point["expansion_level"] = "未提及"
        payload["user_answer"] = "建立平台"
        payload["points"][0]["point_value"] = 1
        payload["points"][1]["point_value"] = 19
        payload["points"][0]["coverage_status"] = "部分覆盖"
        payload["points"][0]["user_quote"] = "建立平台"
        payload["points"][0]["expansion_level"] = "仅列标题"
        code, result = run_engine("grade-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertEqual(result["point_scoring_summary"]["tier"], 5)
        self.assertLessEqual(result["center_value"], 3)

    def test_35_point_essay_uses_ratio_aligned_ceiling(self):
        payload = essay_payload()
        payload["full_score"] = 35
        payload["question_text"] = payload["question_text"].replace("40分", "35分")
        code, result = run_engine("grade-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertEqual(result["question_type"], "申发论述")
        self.assertEqual(result["essay_score_policy"]["tier"], 1)
        self.assertEqual(result["essay_score_policy"]["tier_ceiling"], 28)
        self.assertEqual(result["center_value"], 28)


if __name__ == "__main__":
    unittest.main(verbosity=2)
