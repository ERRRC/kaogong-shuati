# -*- coding: utf-8 -*-
"""Regression tests for the detailed essay-analysis teaching contract."""

import json
import unittest

from test_v0380_behavior import run_engine


class V0405EssayAnalysisDepthTests(unittest.TestCase):
    def analyze_essay(self):
        payload = {
            "question_text": (
                "给定资料体现互补不是简单拼合，而是相互作用、相互激发、相互促进。"
                "请结合全部材料，联系实际，自拟题目写一篇议论文。字数1000—1200字。"
            ),
            "material_text": (
                "政企协同治理形成合力。科研与科普双向促进。"
                "基层服务形成完整闭环。"
            ),
            "min_length": 1000,
            "max_length": 1200,
        }
        code, result = run_engine("analyze-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        return result

    def test_essay_analysis_requires_keyword_and_argument_path_sections(self):
        result = self.analyze_essay()
        groups = result["output_validation_context"]["report_requirements"][
            "required_signal_groups"
        ]
        names = {group["name"] for group in groups}
        self.assertTrue({"关键词关系", "论证路径"}.issubset(names))

    def test_essay_analysis_short_summary_is_rejected_for_new_sections(self):
        result = self.analyze_essay()
        context = result["output_validation_context"]
        text = (
            "题干拆解：明确主题和字数。方法讲解：先定总论点。"
            "材料转化：材料可以作为论据。立意论证：围绕主题展开。"
            "文章结构：开头、主体、结尾。易错提醒：避免跑题。"
            "示范范文：互补能够形成合力。"
        )
        code, output = run_engine("validate-user-output", {
            "text": text,
            "validation_context": context,
        })
        self.assertNotEqual(code, 0)
        issue = next(
            item for item in output["detail"]["issues"]
            if item["type"] == "incomplete_teaching_report"
        )
        self.assertIn("关键词关系", issue["missing_sections"])
        self.assertIn("论证路径", issue["missing_sections"])

    def test_essay_analysis_complete_teaching_sections_are_accepted(self):
        result = self.analyze_essay()
        context = result["output_validation_context"]
        text = (
            "题干拆解：逐词解释核心概念、限制词和写作任务。"
            "关键词关系：判断双方是相互促进关系，说明总论点要覆盖双方及其连接。"
            "方法讲解：本题使用辩证转化立意和分论点四步法，先拆题再回材料，按解释关键词、判断关系、转化材料、检查回扣的步骤执行。"
            "材料转化：逐则完成事实—机制—观点，说明材料为何支撑分论点。"
            "立意论证：总论点和分论点共同展开核心关系。"
            "论证路径：每段按观点—论据—分析—回扣，补足分析桥梁。"
            "文章结构：开头、主体、结尾层次清晰。"
            "易错提醒：不能只堆材料或只给口号。"
            "示范范文：完整文章围绕题目关系展开。"
        )
        code, output = run_engine("validate-user-output", {
            "text": text,
            "validation_context": context,
        })
        self.assertEqual(code, 0, json.dumps(output, ensure_ascii=False, indent=2))
        self.assertTrue(output["passed"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
