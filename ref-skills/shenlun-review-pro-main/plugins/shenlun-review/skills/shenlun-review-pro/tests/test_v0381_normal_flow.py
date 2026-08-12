# -*- coding: utf-8 -*-
"""Regression tests for the normal one-call grading path."""

import json
import subprocess
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
ENGINE = SKILL_DIR / "scripts" / "review_engine.py"


def run_engine(command, payload):
    proc = subprocess.run(
        ["python3", str(ENGINE), command],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        check=False,
    )
    return proc.returncode, json.loads(proc.stdout or proc.stderr)


def compact_payload():
    material = (
        "该地建立一站式服务平台，整合多个部门事项。"
        "工作人员主动上门代办，群众办事时间明显缩短。"
    )
    answer = "建立一站式服务平台，整合事项；主动上门代办，缩短办事时间。"
    return {
        "question_text": "根据给定资料，概括该地提升服务效能的主要做法。（20分，不超过200字）",
        "full_score": 20,
        "max_length": 200,
        "material_text": material,
        "user_answer": answer,
        "dimensions": [
            {"name": "任务符合", "level": 4},
            {"name": "要点覆盖", "level": 4},
            {"name": "准确有据", "level": 4},
            {"name": "分类组织", "level": 4},
            {"name": "简洁表达", "level": 4},
        ],
        "points": [
            {
                "point_id": "p1",
                "point_text": "建立平台并整合事项",
                "material_evidence": "该地建立一站式服务平台……整合多个部门事项",
                "coverage_status": "完整覆盖",
                "user_quote": "建立一站式服务平台，整合事项",
                "point_value": 10,
                "expansion_level": "充分展开",
                "importance": "core",
            },
            {
                "point_id": "p2",
                "point_text": "上门代办缩短时间",
                "material_evidence": "工作人员主动上门代办，群众办事时间明显缩短",
                "coverage_status": "完整覆盖",
                "user_quote": "主动上门代办，缩短办事时间",
                "point_value": 10,
                "expansion_level": "充分展开",
                "importance": "core",
            },
        ],
        "holistic_review": {
            "evidence": "两个主要做法均有材料与作答证据",
            "overall_quality": 4,
            "order_logic_status": "sound",
            "duplicate_status": "none",
            "structure_required": False,
            "structure_status": "not_applicable",
        },
        "point_pool_review": {
            "status": "verified",
            "evidence": "已按材料功能核对全部做法，无重复或遗漏",
        },
    }


class V0381NormalFlowTests(unittest.TestCase):
    def test_short_path_execution_lock_is_published(self):
        skill_text = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
        contract_text = (
            SKILL_DIR / "references" / "contracts" / "grade-once-runtime.md"
        ).read_text(encoding="utf-8")
        self.assertIn("普通批改执行锁", skill_text)
        self.assertIn("shenlun_grade_once", skill_text)
        self.assertIn("shenlun_validate_user_output", skill_text)
        self.assertIn("停止正式评分并提示用户启用/重启申论插件", skill_text)
        self.assertIn("只供 MCP Server 内部调用", skill_text)
        self.assertIn("禁止用 `python3 - <<'PY'`", skill_text)
        self.assertIn("仍未加载或宿主不支持 MCP", skill_text)
        self.assertIn("第二次失败或同错再现立即停止", skill_text)
        self.assertIn("普通批改的首选契约", contract_text)
        self.assertIn("受控读取完整契约", contract_text)
        self.assertIn("不得查源码、Schema、`--help`", contract_text)
        self.assertIn("普通智能体不得把它当作终端降级入口", contract_text)

    def test_compact_aliases_and_fragmented_evidence_succeed_once(self):
        code, result = run_engine("grade-once", compact_payload())
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertTrue(result["formal_score"])
        receipt = result["grade_once_receipt"]
        self.assertEqual(receipt["external_command_count"], 1)
        self.assertEqual(receipt["reference_route"], "material_only")
        self.assertEqual(receipt["reference_answer_count"], 0)
        self.assertGreaterEqual(len(receipt["selected_method_guides"]), 2)
        self.assertIn("动词＋名词联合审题", [
            item["method_name"] for item in receipt["selected_method_guides"]
        ])
        self.assertIn("有问有答连读检验", [
            item["method_name"] for item in receipt["selected_method_guides"]
        ])
        self.assertEqual(
            result["output_validation_context"]["required_method_names"],
            [item["method_name"] for item in receipt["selected_method_guides"]],
        )

    def test_evidence_excerpt_list_does_not_require_source_order(self):
        payload = compact_payload()
        payload["points"][0]["material_evidence"] = [
            "整合多个部门事项",
            "该地建立一站式服务平台",
        ]
        code, result = run_engine("grade-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertTrue(result["formal_score"])

    def test_evidence_list_item_with_ellipsis_is_normalized(self):
        payload = compact_payload()
        payload["points"][0]["material_evidence"] = [
            "该地建立一站式服务平台……整合多个部门事项",
        ]
        code, result = run_engine("grade-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertTrue(result["formal_score"])

    def test_reference_discovery_benign_aliases_are_normalized(self):
        for discovery in ("not_found", {"status": "not_found"}):
            payload = compact_payload()
            payload["reference_discovery"] = discovery
            code, result = run_engine("grade-once", payload)
            self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
            self.assertEqual(result["grade_once_receipt"]["reference_route"], "material_only")

    def test_small_question_can_derive_display_dimensions(self):
        payload = compact_payload()
        explicit_code, explicit = run_engine("grade-once", payload)
        self.assertEqual(explicit_code, 0, json.dumps(explicit, ensure_ascii=False, indent=2))
        payload.pop("dimensions")
        code, result = run_engine("grade-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertEqual(result["center_value"], explicit["center_value"])
        self.assertEqual(result["raw_center"], explicit["raw_center"])
        self.assertTrue(all(item["level"] == 4 for item in result["dimensions"]))

    def test_extra_claim_gets_a_valid_question_specific_owner(self):
        payload = compact_payload()
        payload["question_text"] = "请结合给定资料，谈谈你对‘服务既要效率也要温度’的理解。（20分）"
        payload["user_answer"] += "并全面使用区块链。"
        payload["dimensions"] = [
            {"dimension": "任务符合", "level": 4},
            {"dimension": "要点覆盖", "level": 4},
            {"dimension": "关系逻辑", "level": 3},
            {"dimension": "结论解释", "level": 3},
            {"dimension": "组织表达", "level": 4},
        ]
        payload["extra_material_claims"] = [{
            "claim_id": "extra-1",
            "user_quote": "全面使用区块链",
            "reason": "材料未出现区块链",
        }]
        code, result = run_engine("grade-once", payload)
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        issue = next(item for item in result["supplementary_evidence"] if item["point_id"] == "extra-1")
        self.assertEqual(issue["deduction_owner"], "关系逻辑")

    def test_output_gate_reuses_grade_context_and_natural_method_heading(self):
        code, graded = run_engine("grade-once", compact_payload())
        self.assertEqual(code, 0, json.dumps(graded, ensure_ascii=False, indent=2))
        summary = graded["point_scoring_summary"]
        text = (
            "题干拆解：题目要求概括提升服务效能的主要做法，答案责任是抓主体动作。\n\n"
            "**二、方法讲解**\n"
            "本题使用动词＋名词联合审题：先圈出‘概括’和‘主要做法’，"
            "再回到材料逐点核对主体动作。\n\n"
            "逐条点评：考生原句分别对应材料依据，平台整合和上门代办均已覆盖，"
            "覆盖状态、缺口和修改动作逐项说明。\n\n"
            "主要失分与修复：检查关键限定，补足材料动作并压缩重复表达。\n\n"
            f"档位结论：{summary['tier_label']}，档内位置为{summary['tier_position_label']}；"
            f"建议分和建议区间为{graded['center_value']}分、"
            f"{graded['interval']['lower']}—{graded['interval']['upper']}分，置信度中。"
        )
        code, result = run_engine("validate-user-output", {
            "text": text,
            "validation_context": graded["output_validation_context"],
        })
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertTrue(result["passed"])

    def test_output_gate_accepts_natural_method_prose_without_heading_shape(self):
        code, result = run_engine("validate-user-output", {
            "text": (
                "本题的审题方法是先看题干动作和对象，再回到材料逐点核对。"
                "下次遇到同类题，先圈出任务要求，再合并同功能动作。"
            ),
            "output_validation_context": {
                "output_mode": "批改",
                "reference_available": False,
                "final_response": True,
                "required_method_names": [],
            },
        })
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertTrue(result["passed"])

    def test_output_gate_hides_internal_point_labels_and_pseudo_point_scores(self):
        code, result = run_engine("validate-user-output", {
            "text": (
                "方法讲解：先回到题干，再逐条核对材料。"
                "P2得3分，4分几乎全失。总体建议8分。"
            ),
            "validation_context": {
                "output_mode": "批改",
                "reference_available": False,
                "final_response": True,
                "required_method_names": [],
            },
        })
        self.assertNotEqual(code, 0)
        issue_types = {item["type"] for item in result["detail"]["issues"]}
        self.assertIn("internal_point_label", issue_types)
        self.assertIn("pseudo_point_score", issue_types)

    def test_output_gate_hides_internal_reference_and_method_receipts(self):
        code, result = run_engine("validate-user-output", {
            "text": (
                "方法讲解：先回到题干，再逐条核对材料。"
                "该点满分；参考答案候选已 included，由引擎方法选择命中。"
            ),
            "validation_context": {
                "output_mode": "批改",
                "reference_available": False,
                "final_response": True,
                "required_method_names": [],
            },
        })
        self.assertNotEqual(code, 0)
        issue_types = {item["type"] for item in result["detail"]["issues"]}
        self.assertIn("pseudo_point_score", issue_types)
        self.assertIn("internal_field", issue_types)
        self.assertIn("implementation_receipt", issue_types)

    def test_final_gate_checks_generated_reference_answer_without_separate_command(self):
        code, graded = run_engine("grade-once", compact_payload())
        self.assertEqual(code, 0, json.dumps(graded, ensure_ascii=False, indent=2))
        method_name = graded["output_validation_context"]["required_method_names"][0]
        summary = graded["point_scoring_summary"]
        answer_text = "建立一站式服务平台，整合部门事项；工作人员主动上门代办，缩短群众办事时间。"
        final_text = (
            "题干拆解：明确题目要求和答案责任。\n\n"
            f"方法讲解：本题使用{method_name}，先圈出题干动作，再逐点核对材料。\n\n"
            "逐条点评：考生原句与材料依据逐项对应，说明覆盖状态和缺口。\n\n"
            "主要失分与修复：补足关键限定并调整表达。\n\n"
            f"档位结论：{summary['tier_label']}、档内位置{summary['tier_position_label']}，"
            "建议分和建议区间按评分回执说明。\n\n"
            f"参考答案：\n{answer_text}"
        )
        code, result = run_engine("validate-user-output", {
            "text": final_text,
            "reference_answer_text": answer_text,
            "output_validation_context": graded["output_validation_context"],
        })
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertTrue(result["reference_answer_length_check"]["compliant"])
        self.assertEqual(
            result["reference_answer_length_check"]["actual_length"],
            len(answer_text),
        )

    def test_final_gate_rejects_overlength_generated_reference_answer(self):
        code, graded = run_engine("grade-once", compact_payload())
        self.assertEqual(code, 0, json.dumps(graded, ensure_ascii=False, indent=2))
        method_name = graded["output_validation_context"]["required_method_names"][0]
        answer_text = "办" * 201
        final_text = (
            f"方法讲解：本题使用{method_name}，先圈出题干动作，再逐点核对材料。\n\n"
            f"参考答案：\n{answer_text}"
        )
        code, result = run_engine("validate-user-output", {
            "text": final_text,
            "reference_answer_text": answer_text,
            "output_validation_context": graded["output_validation_context"],
        })
        self.assertNotEqual(code, 0)
        issue_types = {item["type"] for item in result["detail"]["issues"]}
        self.assertIn("reference_answer_length_violation", issue_types)

    def test_output_gate_reports_all_repairs_with_one_retry_policy(self):
        context = {
            "output_mode": "批改",
            "reference_available": False,
            "final_response": True,
            "required_method_names": ["动词＋名词联合审题"],
        }
        code, result = run_engine("validate-user-output", {
            "text": "|字段|内容|\n|---|---|\n|结论|完成|",
            "validation_context": context,
        })
        self.assertNotEqual(code, 0)
        detail = result["detail"]
        self.assertEqual(detail["maximum_retry_count"], 1)
        self.assertEqual(detail["retry_policy"], "fix_all_listed_issues_once_then_stop")
        issue_types = {item["type"] for item in detail["issues"]}
        self.assertIn("markdown_table", issue_types)
        self.assertIn("missing_method_explanation", issue_types)
        self.assertIn("missing_loaded_method_name", issue_types)

    def test_grade_preflight_aggregates_nested_repairs(self):
        payload = compact_payload()
        payload["points"][0]["material_evidence"] = "材料完全没有的做法"
        payload["points"][1]["user_quote"] = "作答完全没有的句子"
        payload["point_pool_review"] = {"status": "unknown", "evidence": ""}
        payload.pop("holistic_review")
        code, result = run_engine("grade-once", payload)
        self.assertNotEqual(code, 0)
        detail = result["detail"]
        errors = detail["errors"]
        self.assertGreaterEqual(len(errors), 5)
        self.assertTrue(any("material_evidence" in item for item in errors))
        self.assertTrue(any("user_quote" in item for item in errors))
        self.assertTrue(any("point_pool_review.status" in item for item in errors))
        self.assertTrue(any("holistic_review" in item for item in errors))
        self.assertEqual(detail["maximum_retry_count"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
