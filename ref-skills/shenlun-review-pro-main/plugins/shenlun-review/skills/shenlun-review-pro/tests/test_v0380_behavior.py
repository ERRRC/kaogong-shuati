# -*- coding: utf-8 -*-
"""v0.3.80 minimal behavior tests.

All grading payloads are passed through stdin and no state-write command or
formal data directory is used.
"""

import copy
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
    output = proc.stdout or proc.stderr
    return proc.returncode, json.loads(output)


def grade(payload):
    code, result = run_engine("grade-once", payload)
    if code != 0:
        raise AssertionError(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def no_reference():
    return {
        "reference_available": False,
        "reference_discovery": {
            "status": "not_found",
            "searched_scope": "当前临时测试输入",
            "evidence": "测试输入未提供参考答案",
        },
    }


def small_payload():
    material = (
        "该地建立一站式服务平台，整合多个部门事项。"
        "工作人员主动上门代办，群众办事时间明显缩短。"
    )
    answer = (
        "建立一站式服务平台，整合多个部门事项；"
        "工作人员主动上门代办，缩短群众办事时间。"
    )
    return {
        "input_mode": "pure_text",
        "question_text": "根据给定资料，概括该地提升服务效能的主要做法。（20分，不超过200字）",
        "full_score": 20,
        "material_text": material,
        "user_answer": answer,
        "dimension_levels": {
            "任务符合": 4, "要点覆盖": 4, "准确有据": 4,
            "分类组织": 4, "简洁表达": 4,
        },
        "points": [
            {
                "point_id": "p1", "point_text": "建立一站式平台并整合事项",
                "material_evidence": "该地建立一站式服务平台，整合多个部门事项",
                "coverage_status": "完整覆盖",
                "user_quote": "建立一站式服务平台，整合多个部门事项",
                "point_value": 10, "expansion_level": "充分展开", "importance": "core",
            },
            {
                "point_id": "p2", "point_text": "上门代办缩短办事时间",
                "material_evidence": "工作人员主动上门代办，群众办事时间明显缩短",
                "coverage_status": "完整覆盖",
                "user_quote": "工作人员主动上门代办，缩短群众办事时间",
                "point_value": 10, "expansion_level": "充分展开", "importance": "core",
            },
        ],
        "holistic_review": {
            "evidence": "两个主要做法均有材料及作答证据",
            "overall_quality": 4, "order_logic_status": "sound",
            "duplicate_status": "none", "structure_required": False,
            "structure_status": "not_applicable",
        },
        "point_pool_review": {
            "status": "verified", "evidence": "已复核全部材料，无漏拆、误合或重复",
        },
        "reference_available": True,
        "reference_discovery": {
            "status": "found", "searched_scope": "当前消息",
            "evidence": "用户提供一份参考答案",
        },
        "reference_answers": [material],
        "expected_reference_answer_count": 1,
        "reference_calibration": {
            "status": "verified", "complete_review": True,
            "candidates": [{
                "candidate_id": "r1", "answer_index": 1,
                "candidate_text": material, "material_evidence": material,
                "disposition": "included", "mapped_point_ids": ["p1", "p2"],
            }],
        },
        "max_length": 200,
    }


def leading_summary_payload(status, summary_quote=None):
    material = (
        "有关部门整合成立工商质监局，召开商户座谈会，制定五个统一行业标准，"
        "组织参观示范店，为小微商户提供小额经营扶持贷款和门店装修指导，开展信用评级。"
    )
    body = (
        "整合成立工商质监局，召开商户座谈会，制定五个统一行业标准，"
        "组织参观示范店，提供小额经营扶持贷款和门店装修指导"
    )
    answer = f"{summary_quote}。{body}。" if summary_quote else f"{body}。"
    review = {
        "review_id": "stage-2-label",
        "summary_quote": summary_quote,
        "body_quote": body,
        "point_ids": ["stage-2"],
        "status": status,
        "reason": "后文的机构整合、标准引领和扶持服务内容保持不变",
    }
    if status == "contradictory":
        review["deduction_owner"] = "准确有据"
    return {
        "input_mode": "pure_text",
        "question_text": "根据给定资料，概括该地执法方式发生了哪些变化。（15分，不超过300字）",
        "full_score": 15,
        "material_text": material,
        "user_answer": answer,
        "dimension_levels": {
            "任务符合": 4, "要点覆盖": 4, "准确有据": 4,
            "分类组织": 4, "简洁表达": 4,
        },
        "points": [{
            "point_id": "stage-2",
            "point_text": "从单纯检查转为标准引领与扶持服务",
            "material_evidence": material[:-1],
            "coverage_status": "完整覆盖",
            "user_quote": body,
            "point_value": 15,
            "expansion_level": "基本展开",
            "importance": "core",
            "credit_reason": "核心转向及标准、贷款、装修指导等实质动作已覆盖",
            "loss_reason": "未展开信用评级细节",
        }],
        "leading_summary_reviews": [review],
        "holistic_review": {
            "evidence": "核心变化已由后文实质动作覆盖，信用评级细节未展开",
            "overall_quality": 4,
            "order_logic_status": "sound",
            "duplicate_status": "none",
            "structure_required": False,
            "structure_status": "not_applicable",
        },
        "point_pool_review": {
            "status": "verified",
            "evidence": "第二阶段以标准引领与扶持服务为一个核心变化点",
        },
        **no_reference(),
    }


class V0380BehaviorTests(unittest.TestCase):
    def test_A_complete_pure_text_single_grade(self):
        result = grade(small_payload())
        receipt = result["grade_once_receipt"]
        self.assertTrue(result["formal_score"])
        self.assertTrue(receipt["single_compile"])
        self.assertEqual(receipt["reference_answer_count"], 1)
        self.assertEqual(receipt["external_command_count"], 1)
        self.assertEqual(receipt["score_core_invocations"], 1)
        self.assertFalse(receipt["separate_legacy_command_chain_used"])

    def test_B_formatting_only_changes_are_score_invariant(self):
        base = small_payload()
        formatted = copy.deepcopy(base)
        formatted["user_answer"] = (
            "**1.**  建立一站式服务平台、整合多个部门事项\n\n"
            "**2.**  工作人员主动上门代办；缩短群众办事时间。"
        )
        formatted["points"][0]["user_quote"] = "建立一站式服务平台、整合多个部门事项"
        formatted["points"][1]["user_quote"] = "工作人员主动上门代办；缩短群众办事时间"
        first, second = grade(base), grade(formatted)
        self.assertEqual(first["point_pool_fingerprint"], second["point_pool_fingerprint"])
        first_coverage = [
            (item["point_id"], item["coverage_status"], item["earned_value"], item["expansion_level"])
            for item in first["point_coverage"]
        ]
        second_coverage = [
            (item["point_id"], item["coverage_status"], item["earned_value"], item["expansion_level"])
            for item in second["point_coverage"]
        ]
        self.assertEqual(first_coverage, second_coverage)
        self.assertEqual(first["raw_center"], second["raw_center"])
        self.assertEqual(first["center_value"], second["center_value"])
        self.assertEqual(first["point_scoring_summary"]["tier"], second["point_scoring_summary"]["tier"])

    def test_C_missing_material_or_answer_stops_before_grade(self):
        payload = {"question_text": "概括做法", "full_score": 20}
        missing = [name for name in ("material_text", "user_answer") if not payload.get(name)]
        invocation_count = 0 if missing else 1
        self.assertEqual(missing, ["material_text", "user_answer"])
        self.assertEqual(invocation_count, 0)

    def test_D_one_unified_retry_then_stop(self):
        attempts = []
        payload = {"question_text": ""}
        for _ in range(2):
            code, result = run_engine("grade-once", payload)
            attempts.append((code, result))
            if code == 0:
                break
        self.assertEqual(len(attempts), 2)
        self.assertTrue(all(code != 0 for code, _ in attempts))
        first_detail = attempts[0][1]["detail"]
        self.assertEqual(first_detail["maximum_retry_count"], 1)
        self.assertEqual(first_detail["retry_policy"], "fix_all_listed_errors_once_then_stop")
        self.assertGreaterEqual(len(first_detail["errors"]), 5)

    def test_E_reference_cannot_exempt_material_outside_wording(self):
        payload = small_payload()
        outside = "并实行区块链信用评级。"
        payload["user_answer"] += outside
        payload["reference_answers"] = [payload["material_text"] + outside]
        payload["reference_calibration"]["candidates"] = [
            {
                "candidate_id": "r1", "answer_index": 1,
                "candidate_text": payload["material_text"],
                "material_evidence": payload["material_text"],
                "disposition": "included", "mapped_point_ids": ["p1", "p2"],
            },
            {
                "candidate_id": "r2", "answer_index": 1,
                "candidate_text": outside, "material_evidence": None,
                "disposition": "excluded", "mapped_point_ids": [],
                "reason": "材料未出现该信用评级表述",
            },
        ]
        payload["extra_material_claims"] = [{
            "claim_id": "extra-1", "user_quote": "并实行区块链信用评级",
            "reason": "材料无该技术和评级机制",
        }]
        result = grade(payload)
        issue = next(item for item in result["supplementary_evidence"] if item["point_id"] == "extra-1")
        self.assertEqual(issue["display_role"], "local_accuracy_issue")
        self.assertFalse(issue["reference_exemption"])
        self.assertFalse(issue["affects_covered_points"])
        self.assertEqual(result["scorable_point_count"], 2)

    def test_F_change_core_direction_survives_missing_detail(self):
        material = (
            "过去依靠人工巡查，后来转为数字平台监管，并实行网格登记和风险预警。"
            "过去由单一部门执法，后来转为多部门联合执法，并建立会商机制和联合检查清单。"
        )
        answer = (
            "一是从人工巡查转为数字平台监管；"
            "二是从单一部门执法转为多部门联合执法。另采用区块链平台。"
        )
        payload = {
            "input_mode": "pure_text",
            "question_text": "根据给定资料，概括该地执法方式发生了哪些变化。（20分，不超过200字）",
            "full_score": 20, "material_text": material, "user_answer": answer,
            "dimension_levels": {"任务符合": 4, "要点覆盖": 3, "准确有据": 3, "分类组织": 4, "简洁表达": 4},
            "points": [
                {
                    "point_id": "stage-1", "point_text": "人工巡查转为数字监管",
                    "material_evidence": "过去依靠人工巡查，后来转为数字平台监管，并实行网格登记和风险预警",
                    "coverage_status": "部分覆盖", "user_quote": "从人工巡查转为数字平台监管",
                    "point_value": 10, "expansion_level": "简略提及", "importance": "core",
                    "critical_qualifiers": ["网格登记", "风险预警"],
                },
                {
                    "point_id": "stage-2", "point_text": "单部门执法转为联合执法",
                    "material_evidence": "过去由单一部门执法，后来转为多部门联合执法，并建立会商机制和联合检查清单",
                    "coverage_status": "部分覆盖", "user_quote": "从单一部门执法转为多部门联合执法",
                    "point_value": 10, "expansion_level": "简略提及", "importance": "core",
                    "critical_qualifiers": ["会商机制", "联合检查清单"],
                },
            ],
            "extra_material_claims": [{
                "claim_id": "extra-chain", "user_quote": "区块链平台",
                "reason": "材料只说数字平台，未说区块链",
            }],
            "holistic_review": {
                "evidence": "两个阶段的前后转向均写出，展开细节不全",
                "overall_quality": 3, "order_logic_status": "sound", "duplicate_status": "none",
                "structure_required": False, "structure_status": "not_applicable",
            },
            "point_pool_review": {"status": "verified", "evidence": "以两个完整的前后变化为核心点"},
            **no_reference(),
        }
        result = grade(payload)
        self.assertEqual([p["coverage_status"] for p in result["point_coverage"]], ["完整覆盖", "完整覆盖"])
        self.assertTrue(all(p["expansion_level"] == "基本展开" for p in result["point_coverage"]))
        self.assertGreaterEqual(result["center_value"], 13)
        self.assertEqual(result["supplementary_evidence"][0]["display_role"], "local_accuracy_issue")

    def test_G_application_format_only_when_required(self):
        material = "该地建立便民平台，实现事项集成办理，群众满意度明显提升。"
        answer = "建立便民平台，实现事项集成办理，提升群众满意度。"
        payload = {
            "question_text": "根据给定资料，以工作人员身份拟写一份汇报提纲，介绍主要做法和成效。（25分，不超过400字）",
            "full_score": 25, "material_text": material, "user_answer": answer,
            "dimension_levels": {"身份文种格式": 4, "结构": 4, "内容覆盖": 4, "目的场景": 4, "语言语气": 4},
            "points": [{
                "point_id": "app-1", "point_text": "平台集成办理并提升满意度",
                "material_evidence": material[:-1], "coverage_status": "完整覆盖",
                "user_quote": answer[:-1], "point_value": 25, "expansion_level": "充分展开",
            }],
            "application_review": {
                "identity_status": "accurate", "genre_format_status": "missing",
                "purpose_audience_status": "strong", "content_status": "complete",
                "structure_status": "clear", "tone_status": "appropriate",
                "template_use_status": "not_applicable", "evidence": "内容与场景任务完成",
            },
            "required_format_elements": [],
            "point_pool_review": {"status": "verified", "evidence": "已核对做法与成效"},
            **no_reference(),
        }
        missing = grade(payload)
        complete_payload = copy.deepcopy(payload)
        complete_payload["application_review"]["genre_format_status"] = "complete"
        complete = grade(complete_payload)
        self.assertFalse(missing["application_score_policy"]["format_required"])
        self.assertEqual(missing["center_value"], complete["center_value"])
        self.assertEqual(missing["application_score_policy"]["application_band"], complete["application_score_policy"]["application_band"])

    def test_H_essay_uses_natural_paragraph_audit(self):
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
        audit = [
            {
                "argument_quote": "第一，便民平台让群众办事更高效，体现治理回应需求",
                "logical_level": "服务效率", "supports_thesis": True, "source_role": "mixed",
                "develops_side_a": False, "develops_side_b": False, "explains_relationship": False,
                "evidence": "材料事例已转化为分论点论证",
            },
            {
                "argument_quote": "第二，上门代办连接基层与群众，把服务温度转化为治理精度",
                "logical_level": "基层连接", "supports_thesis": True, "source_role": "mixed",
                "develops_side_a": False, "develops_side_b": False, "explains_relationship": False,
                "evidence": "材料事例已转化为服务与治理的分析",
            },
        ]
        payload = {
            "question_text": "请结合给定资料，以“服务与治理”为题目，自选角度，写一篇文章。（40分，1000字左右）",
            "full_score": 40, "material_text": material, "user_answer": answer,
            "dimension_levels": {"立意扣题": 4, "材料运用": 4, "论证深度": 4, "结构": 4, "论据例证": 4, "语言": 4},
            "points": [
                {"point_id": "essay-1", "point_text": "便民平台提升效率", "material_evidence": "便民平台让群众办事更高效", "coverage_status": "完整覆盖", "user_quote": "便民平台让群众办事更高效"},
                {"point_id": "essay-2", "point_text": "上门代办连接基层群众", "material_evidence": "上门代办连接基层与群众", "coverage_status": "完整覆盖", "user_quote": "上门代办连接基层与群众"},
            ],
            "essay_review": {
                "central_thesis": "优质服务提升治理效能",
                "relationship_type": "theme_link", "relationship_centrality": "not_applicable",
                "material_support": "便民平台与上门代办两个材料事例",
                "reasoning_bridge": "从办事效率和基层连接说明治理效能",
                "return_to_thesis": "结尾回扣以服务夯实治理基础",
                "topic_specificity": "strong", "argument_line_status": "sound",
                "material_support_status": "strong", "template_risk": "none",
                "prompt_relation_required": False, "relationship_coverage_status": "not_applicable",
                "thesis_scope_status": "accurate", "sub_argument_system_status": "sound",
                "material_transformation_status": "transformed",
                "sub_argument_chain": ["服务效率提升治理回应", "基层服务连接提升治理精度"],
                "counterargument_or_boundary": None,
                "evidence": "中心论点、两个分论点、材料转化和结尾回扣均可定位",
                "judgment_evidence": {
                    "prompt_relation_quote": None,
                    "relationship_centrality_rationale": "题目为主题型作文，不强制关系命题",
                    "central_thesis_quote": "服务与治理相互支撑，优质服务提升治理效能",
                    "side_a_quote": None, "side_b_quote": None, "relationship_bridge_quote": None,
                    "scope_rationale": "中心与题目主题一致",
                    "sub_argument_audit": audit,
                    "material_transformation_quote": "上门代办连接基层与群众，把服务温度转化为治理精度",
                },
            },
            "point_pool_review": {"status": "verified", "evidence": "作文材料支撑点已核对"},
            **no_reference(),
        }
        result = grade(payload)
        self.assertTrue(result["formal_score"])
        self.assertIsNone(result.get("sentence_audit"))
        self.assertGreaterEqual(len(result["paragraph_audit"]), 4)
        self.assertEqual(result["grade_once_receipt"]["paragraph_audit_count"], len(result["paragraph_audit"]))

    def test_I_leading_summary_three_way_score_boundary(self):
        cases = [
            ("accurate", "从单纯检查转为标准引领与扶持服务"),
            ("omitted", None),
            ("imprecise", "从专项整治到主动帮助"),
        ]
        results = [grade(leading_summary_payload(status, quote)) for status, quote in cases]

        fingerprints = {result["point_pool_fingerprint"] for result in results}
        coverage = {
            tuple(
                (
                    item["point_id"], item["coverage_status"],
                    item["earned_value"], item["expansion_level"],
                )
                for item in result["point_coverage"]
            )
            for result in results
        }
        scores = {
            (
                result["raw_center"], result["center_value"],
                result["point_scoring_summary"]["tier"],
                result["interval"]["lower"], result["interval"]["upper"],
            )
            for result in results
        }
        self.assertEqual(len(fingerprints), 1)
        self.assertEqual(len(coverage), 1)
        self.assertEqual(len(scores), 1)
        self.assertTrue(all(
            result["leading_summary_audit"][0]["score_invariant"]
            and not result["leading_summary_audit"][0]["affects_point_coverage"]
            for result in results
        ))
        imprecise = results[2]["leading_summary_audit"][0]
        self.assertEqual(imprecise["diagnosis"], "概括词可优化")
        self.assertEqual(
            imprecise["display_message"],
            "核心变化已覆盖，部分展开细节缺失；前置概括词略有偏差，但不影响后文实质得分。",
        )
        self.assertEqual(
            results[2]["grade_once_receipt"]["leading_summary_score_invariant_count"], 1
        )

        contradictory = grade(leading_summary_payload(
            "contradictory", "从标准引领与扶持服务退回单纯处罚"
        ))["leading_summary_audit"][0]
        self.assertFalse(contradictory["score_invariant"])
        self.assertFalse(contradictory["affects_point_coverage"])
        self.assertFalse(contradictory["automatic_point_deduction"])
        self.assertTrue(contradictory["requires_dimension_review"])
        self.assertEqual(contradictory["eligible_score_dimension"], "准确有据")


if __name__ == "__main__":
    unittest.main(verbosity=2)
