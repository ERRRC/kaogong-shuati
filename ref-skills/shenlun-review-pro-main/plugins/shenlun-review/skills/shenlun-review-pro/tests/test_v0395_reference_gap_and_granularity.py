# -*- coding: utf-8 -*-
"""Regression test for reference-answer gaps and over-split reference points."""

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


class V0395ReferenceCalibrationTests(unittest.TestCase):
    def payload(self):
        water_soil = "依据城北土壤碳酸钙和柳川河钾页岩水系种植葡萄"
        funnel = "采用漏斗架栽培，通风透光、雨季排水减病、冬季覆土防冻，适应北方气候"
        cycle = "将秸秆、枯枝就地堆肥，全程不用化肥农药，形成闭环生态循环"
        coexist = "在有限城区空间兼顾生产、景观、生态和文旅，实现互补共生"
        active_inheritance = "建设研学基地，传授修剪、压条古法，发展文创餐饮，推动农业文化遗产保护利用"
        material = "。".join((water_soil, funnel, cycle, coexist, active_inheritance)) + "。"
        reference = "；".join((funnel, cycle, active_inheritance)) + "。"
        answer = "；".join((water_soil, funnel, cycle, coexist)) + "。"
        return {
            "input_mode": "pure_text",
            "question_text": "根据给定资料1，概括宣化城市传统葡萄园蕴含的生态实践智慧。（10分，不超过200字）",
            "full_score": 10,
            "material_text": material,
            "user_answer": answer,
            "dimension_levels": {
                "任务符合": 4,
                "要点覆盖": 4,
                "准确有据": 4,
                "分类组织": 4,
                "简洁表达": 4,
            },
            "points": [
                {
                    "point_id": "p1",
                    "point_text": "因地制宜利用水土条件",
                    "material_evidence": water_soil,
                    "coverage_status": "完整覆盖",
                    "user_quote": water_soil,
                    "point_value": 3,
                    "expansion_level": "充分展开",
                    "importance": "core",
                },
                {
                    "point_id": "p2",
                    "point_text": "漏斗架栽培适配气候并减少病害",
                    "material_evidence": funnel,
                    "coverage_status": "完整覆盖",
                    "user_quote": funnel,
                    "point_value": 3,
                    "expansion_level": "充分展开",
                    "importance": "core",
                },
                {
                    "point_id": "p3",
                    "point_text": "生态循环与城市农业文旅共生",
                    "material_evidence": coexist,
                    "coverage_status": "完整覆盖",
                    "user_quote": coexist,
                    "point_value": 4,
                    "expansion_level": "充分展开",
                    "importance": "core",
                },
            ],
            "holistic_review": {
                "evidence": "考生完整覆盖补漏后的三个独立主点，未机械拆分传承文旅子动作",
                "overall_quality": 4,
                "order_logic_status": "sound",
                "duplicate_status": "none",
                "structure_required": False,
                "structure_status": "not_applicable",
            },
            "point_pool_review": {
                "status": "verified",
                "evidence": "已完成参考答案候选、材料补漏和同功能粒度复核",
            },
            "reference_available": True,
            "reference_discovery": {
                "status": "found",
                "searched_scope": "当前测试输入",
                "evidence": "用户提供一份参考答案",
            },
            "reference_answers": [{
                "label": "故意漏点并过拆的参考答案",
                "answer_text": reference,
                "source_type": "institution_answer",
                "reliability": "medium",
            }],
            "expected_reference_answer_count": 1,
            "reference_calibration": {
                "status": "verified",
                "complete_review": True,
                "candidates": [
                    {
                        "candidate_id": "r2",
                        "answer_index": 1,
                        "candidate_text": funnel,
                        "material_evidence": funnel,
                        "disposition": "included",
                        "mapped_point_ids": ["p2"],
                    },
                    {
                        "candidate_id": "r3",
                        "answer_index": 1,
                        "candidate_text": cycle,
                        "material_evidence": cycle,
                        "disposition": "included",
                        "mapped_point_ids": ["p3"],
                    },
                    {
                        "candidate_id": "r4",
                        "answer_index": 1,
                        "candidate_text": active_inheritance,
                        "material_evidence": active_inheritance,
                        "disposition": "merged",
                        "mapped_point_ids": ["p3"],
                        "reason": "与城市农业文旅共生同属活化利用的展开，不另立核心点",
                    },
                ],
            },
            "max_length": 200,
            "length_unit": "字",
        }

    def test_reference_gap_is_added_and_over_split_is_merged(self):
        code, result = run_engine("grade-once", self.payload())
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        receipt = result["grade_once_receipt"]
        self.assertEqual(receipt["reference_route"], "reference_assisted")
        self.assertEqual(receipt["reference_answer_count"], 1)
        self.assertTrue(receipt["reference_calibration_verified"])
        self.assertEqual(receipt["reference_calibration_coverage"][next(iter(receipt["reference_calibration_coverage"]))], 1.0)
        self.assertGreaterEqual(result["center_value"], 8)
        self.assertNotIn("p4", [item["point_id"] for item in result["point_coverage"]])
        self.assertEqual(
            {item["point_id"] for item in result["point_coverage"]},
            {"p1", "p2", "p3"},
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
