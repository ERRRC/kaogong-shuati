# -*- coding: utf-8 -*-
"""Regression tests for summary point hierarchy and final-text cleanliness."""

import json
import unittest
from pathlib import Path

from test_v0380_behavior import run_engine


SKILL_DIR = Path(__file__).resolve().parents[1]


def validation_context():
    return {
        "output_mode": "解析",
        "reference_available": False,
        "final_response": True,
        "required_method_names": ["动词＋名词联合审题"],
        "report_requirements": {
            "full_teaching_report": True,
            "required_signal_groups": [
                {"name": "题干责任", "signals": ["题干拆解"]},
                {"name": "方法使用", "signals": ["方法讲解"]},
                {"name": "材料证据", "signals": ["材料证据"]},
                {"name": "答案组织", "signals": ["答案组织"]},
                {"name": "易错提醒", "signals": ["易错提醒"]},
            ],
        },
    }


class V0406SummaryBoundaryTests(unittest.TestCase):
    def test_summary_protocol_distinguishes_core_and_supplemental_points(self):
        protocol = (
            SKILL_DIR / "references" / "protocols" / "归纳概括.md"
        ).read_text(encoding="utf-8")
        self.assertIn("特征/属性概括的主次边界", protocol)
        self.assertIn("核心属性、支撑机制、具体例证和背景结果", protocol)
        self.assertIn("不预设主次", protocol)
        self.assertIn("是否为核心取决于题干对象", protocol)

    def test_reference_items_are_candidates_not_automatic_core_points(self):
        protocol = (
            SKILL_DIR / "references" / "protocols" / "归纳概括.md"
        ).read_text(encoding="utf-8")
        self.assertIn("参考答案是重要候选，不是自动生效的核心点清单", protocol)
        self.assertIn("不得仅因单列就自动判为独立核心", protocol)
        self.assertIn("若题干和材料证明其能独立回答作答对象，保留为核心", protocol)
        self.assertIn("参考答案—材料依据—AI选择及理由", protocol)
        self.assertIn("粒度冲突按四问处理", protocol)
        self.assertIn("只给一个AI采用口径", protocol)
        self.assertIn("核心点数量必须一致", protocol)

    def test_runtime_contracts_use_simple_reference_conflict_rule(self):
        grade_contract = (
            SKILL_DIR / "references" / "contracts" / "grade-once-runtime.md"
        ).read_text(encoding="utf-8")
        analyze_contract = (
            SKILL_DIR / "references" / "contracts" / "analyze-once-runtime.md"
        ).read_text(encoding="utf-8")
        for contract in (grade_contract, analyze_contract):
            self.assertNotIn("首要候选骨架", contract)
            self.assertIn("重要候选", contract)
            self.assertIn("AI选择及理由", contract)

    def test_output_gate_rejects_internal_ids_and_commands(self):
        text = (
            "题干拆解：明确任务和对象。方法讲解：使用动词＋名词联合审题，"
            "先锁定对象再回材料。材料证据：逐点回到原文。答案组织：同功能合并。"
            "易错提醒：不要把背景当核心点。原型 sl-prototype-0001 已命中。"
        )
        code, output = run_engine("validate-user-output", {
            "text": text,
            "validation_context": validation_context(),
        })
        self.assertNotEqual(code, 0)
        issue_types = {item["type"] for item in output["detail"]["issues"]}
        self.assertIn("internal_ids", issue_types)

    def test_output_gate_rejects_appended_progress_tail(self):
        text = (
            "题干拆解：明确任务和对象。方法讲解：使用动词＋名词联合审题，"
            "先锁定对象再回材料。材料证据：逐点回到原文。答案组织：同功能合并。"
            "易错提醒：不要把背景当核心点。核心要点速记：今日进度已完成。"
        )
        code, output = run_engine("validate-user-output", {
            "text": text,
            "validation_context": validation_context(),
        })
        self.assertNotEqual(code, 0)
        issue_types = {item["type"] for item in output["detail"]["issues"]}
        self.assertIn("implementation_receipt", issue_types)

    def test_clean_complete_summary_text_is_accepted(self):
        text = (
            "题干拆解：明确任务对象、材料范围和字数要求。方法讲解：使用动词＋名词联合审题，"
            "先锁定对象，再回材料核对核心信息。材料证据：逐点说明原句依据和主次层级。"
            "答案组织：同功能合并，核心点与示范答案数量一致。易错提醒：不要把补充内容硬列为核心点。"
        )
        code, output = run_engine("validate-user-output", {
            "text": text,
            "validation_context": validation_context(),
        })
        self.assertEqual(code, 0, json.dumps(output, ensure_ascii=False, indent=2))
        self.assertTrue(output["passed"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
