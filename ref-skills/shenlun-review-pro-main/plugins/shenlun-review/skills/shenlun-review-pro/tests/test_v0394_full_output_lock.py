# -*- coding: utf-8 -*-
"""Regression tests for canonical verdicts and full-report output locking."""

import json
import unittest

from test_v0380_behavior import run_engine
from test_v0391_input_compiler import application_payload, essay_payload


class V0394FullOutputLockTests(unittest.TestCase):
    def grade_application(self):
        code, result = run_engine("grade-once", application_payload())
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        return result

    def grade_essay(self):
        code, result = run_engine("grade-once", essay_payload())
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        return result

    def test_application_exposes_canonical_band_and_position(self):
        result = self.grade_application()
        policy = result["application_score_policy"]
        context = result["output_validation_context"]
        self.assertIn(policy["application_band"], {"高档", "中高档", "中档"})
        self.assertIn(policy["position_label"], {"上位", "中位", "下位"})
        self.assertEqual(
            context["canonical_verdict"]["band"], policy["application_band"]
        )
        self.assertEqual(
            context["canonical_verdict"]["position"], policy["position_label"]
        )
        self.assertTrue(context["report_requirements"]["full_teaching_report"])

    def test_summary_only_output_is_rejected(self):
        result = self.grade_application()
        policy = result["application_score_policy"]
        method = result["output_validation_context"]["required_method_names"][0]
        text = (
            f"总体评价：答案基本覆盖材料，建议{policy['application_band']}、"
            f"{policy['position_label']}，中心值{result['center_value']}分。"
            f"方法讲解：本题使用{method}。"
        )
        code, output = run_engine("validate-user-output", {
            "text": text,
            "validation_context": result["output_validation_context"],
        })
        self.assertNotEqual(code, 0)
        issue_types = {item["type"] for item in output["detail"]["issues"]}
        self.assertIn("incomplete_teaching_report", issue_types)

    def test_cross_scheme_tier_label_is_rejected(self):
        result = self.grade_application()
        method = result["output_validation_context"]["required_method_names"][0]
        text = (
            "题干拆解：明确身份、文种和内容任务。方法讲解："
            f"本题使用{method}，先拆任务再回材料。逐条点评："
            "考生原句与材料依据逐项核对，覆盖状态和缺口均已说明。"
            "主要失分与修复：补足内容并调整表达。档位结论：三档上位，"
            "建议分和区间按回执确定。"
        )
        code, output = run_engine("validate-user-output", {
            "text": text,
            "validation_context": result["output_validation_context"],
        })
        self.assertNotEqual(code, 0)
        issue = next(
            item for item in output["detail"]["issues"]
            if item["type"] == "incomplete_teaching_report"
        )
        self.assertIn(
            result["application_score_policy"]["application_band"],
            issue["missing_verdict_terms"],
        )

    def test_complete_report_accepts_exact_engine_verdict(self):
        result = self.grade_application()
        policy = result["application_score_policy"]
        method = result["output_validation_context"]["required_method_names"][0]
        text = (
            "一、题干拆解：题目要求结合身份、文种、对象和材料任务完成作答，"
            "答案责任已拆成内容与表达两层。\n\n"
            f"二、方法讲解：本题使用{method}。先锁定题干任务，再回到材料；"
            "下次按主体、动作、对象逐项检查。\n\n"
            "三、逐条点评：考生原句逐条对应材料依据，说明每条的覆盖状态、"
            "命中内容和具体缺口；未覆盖内容也逐项指出。\n\n"
            "四、主要失分与修复：缺口集中在限定信息和表达准确性，修改时补回"
            "材料动作并压缩重复表述。\n\n"
            f"五、档位结论：整体为{policy['application_band']}，档内位置为"
            f"{policy['position_label']}。建议分{result['center_value']}分，"
            f"建议区间为{result['interval']['lower']}—{result['interval']['upper']}分，"
            "置信度中等。"
        )
        code, output = run_engine("validate-user-output", {
            "text": text,
            "validation_context": result["output_validation_context"],
        })
        self.assertEqual(code, 0, json.dumps(output, ensure_ascii=False, indent=2))
        self.assertTrue(output["passed"])

    def test_analysis_receipt_also_carries_full_report_contract(self):
        payload = {
            "question_text": "根据给定资料，概括提升服务效能的主要做法。（不超过200字）",
            "material_text": "该地建立一站式服务平台，整合多个部门事项。工作人员主动上门代办。",
            "max_length": 200,
            "length_unit": "字",
        }
        code, result = run_engine("analyze-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        requirements = result["output_validation_context"]["report_requirements"]
        self.assertTrue(requirements["full_teaching_report"])
        self.assertTrue(requirements["summary_only_forbidden"])
        self.assertTrue(requirements["direct_body_required"])
        self.assertTrue(requirements["artifact_only_forbidden"])
        self.assertGreaterEqual(len(requirements["required_signal_groups"]), 5)

    def test_reference_analysis_requires_calibration_section(self):
        payload = {
            "question_text": "根据给定资料，概括提升服务效能的主要做法。（不超过200字）",
            "material_text": "该地建立一站式服务平台，整合多个部门事项。工作人员主动上门代办。",
            "reference_answers": [{"answer_text": "建立平台整合事项，组织上门代办。"}],
            "max_length": 200,
        }
        code, result = run_engine("analyze-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        groups = result["output_validation_context"]["report_requirements"]["required_signal_groups"]
        self.assertIn("参考答案校准", {group["name"] for group in groups})

    def test_summary_wrapper_is_rejected_even_when_sections_are_present(self):
        result = self.grade_application()
        policy = result["application_score_policy"]
        method = result["output_validation_context"]["required_method_names"][0]
        text = (
            "核心结论速览\n"
            "题干拆解：明确身份、文种和答案责任。\n"
            f"方法讲解：使用{method}，先锁定任务，再回到材料核对。\n"
            "逐条点评：按考生原句逐条说明覆盖状态。\n"
            "材料依据：每项判断均回到材料原句。\n"
            "缺口修复：补全遗漏并给出直接改法。\n"
            f"档位结论：{policy['application_band']}，档内{policy['position_label']}，"
            "建议分、建议区间和置信度按正式结果说明。"
        )
        code, output = run_engine("validate-user-output", {
            "text": text,
            "validation_context": result["output_validation_context"],
        })
        self.assertNotEqual(code, 0)
        issue_types = {item["type"] for item in output["detail"]["issues"]}
        self.assertIn("summary_delivery_wrapper", issue_types)

    def test_essay_analysis_requires_material_thesis_and_structure(self):
        payload = {
            "question_text": (
                "给定资料体现互补不是简单拼合，而是相互作用、相互激发、相互促进。"
                "请结合全部材料，联系实际，自拟题目写一篇议论文。字数1000—1200字。"
            ),
            "material_text": "政企协同治理形成合力，科研与科普双向促进，基层服务形成完整闭环。",
            "min_length": 1000,
            "max_length": 1200,
        }
        code, result = run_engine("analyze-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        groups = result["output_validation_context"]["report_requirements"]["required_signal_groups"]
        names = {group["name"] for group in groups}
        self.assertTrue({"材料转化", "立意论证", "文章组织"}.issubset(names))

    def test_essay_summary_only_output_is_rejected(self):
        result = self.grade_essay()
        method = result["output_validation_context"]["required_method_names"][0]
        text = (
            "总评：立意正确，结构完整，建议继续强化材料分析。"
            f"方法讲解：本题使用{method}。"
            f"档位结论：建议按{result['essay_score_policy']['tier_label']}评定。"
        )
        code, output = run_engine("validate-user-output", {
            "text": text,
            "validation_context": result["output_validation_context"],
        })
        self.assertNotEqual(code, 0)
        issue_types = {item["type"] for item in output["detail"]["issues"]}
        self.assertIn("incomplete_teaching_report", issue_types)

    def test_essay_complete_report_accepts_natural_paragraph_audit(self):
        result = self.grade_essay()
        method = result["output_validation_context"]["required_method_names"][0]
        tier = result["essay_score_policy"]["tier_label"]
        text = (
            "一、题干拆解：明确题目主题、关系要求、材料范围、字数和文章责任，"
            "总论点与分论点的检查标准已经列明。\n\n"
            f"二、方法讲解：本题使用{method}。先识别命题关系，再检查总论点、"
            "分论点和论据是否形成论证链，最后回扣题干完成自检。\n\n"
            "三、自然段点评：按开头、各个分论点段、过渡段和结尾逐段说明段落功能；"
            "逐段核对考生原句、材料依据、事实—分析—观点转化和与总论点的关系。\n\n"
            "四、缺口修复：指出材料事实、分析桥梁和关系展开的具体缺口，给出段落级"
            "修改动作，并说明哪些内容保留、补充或删除。\n\n"
            f"五、档位结论：整体为{tier}，结合中心值、建议区间和置信度说明定档依据。"
        )
        code, output = run_engine("validate-user-output", {
            "text": text,
            "validation_context": result["output_validation_context"],
        })
        self.assertEqual(code, 0, json.dumps(output, ensure_ascii=False, indent=2))
        self.assertTrue(output["passed"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
