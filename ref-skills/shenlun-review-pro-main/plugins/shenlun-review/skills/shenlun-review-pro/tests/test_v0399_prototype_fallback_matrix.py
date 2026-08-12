# -*- coding: utf-8 -*-
"""Coverage matrix for all task prototypes and safe routing fallback behavior."""

import json
import subprocess
import unittest
from pathlib import Path


ENGINE = Path(__file__).resolve().parents[1] / "scripts" / "review_engine.py"


def resolve(question_text):
    proc = subprocess.run(
        ["python3", str(ENGINE), "resolve-task-prototype"],
        input=json.dumps({"question_text": question_text}, ensure_ascii=False),
        text=True,
        capture_output=True,
        check=False,
    )
    return proc.returncode, json.loads(proc.stdout or proc.stderr)


PARAPHRASE_CASES = {
    "sl-prototype-0001": "请根据材料，分析该地可复制推广的宝贵经验。",
    "sl-prototype-0002": "请结合材料，梳理监管方式的演变过程。",
    "sl-prototype-0003": "请根据材料，对上述现象加以归类。",
    "sl-prototype-0004": "请根据材料，概括当前发展中的主要短板。",
    "sl-prototype-0005": "请梳理各方的不同意见及分歧所在。",
    "sl-prototype-0006": "请分别说明三个概念的内涵及其联系。",
    "sl-prototype-0007": "请谈谈你对材料中划线句的认识。",
    "sl-prototype-0008": "请分析问题产生的成因，并提出改进办法。",
    "sl-prototype-0009": "请指出工作中的短板，并给出完善措施。",
    "sl-prototype-0010": "请拟写一份供领导参阅的汇报材料。",
    "sl-prototype-0011": "请就上述现象写一篇简短评论。",
    "sl-prototype-0012": "请根据材料撰写一份政协建议案。",
    "sl-prototype-0013": "请为群众编写一份办事指引。",
    "sl-prototype-0014": "请列出与企业负责人沟通的要点。",
    "sl-prototype-0015": "请草拟一份交流会讲话提纲。",
    "sl-prototype-0016": "请将上述实践整理成案例简介。",
    "sl-prototype-0017": "请结合全部材料，联系实际，撰写一篇文章。",
    "sl-prototype-0018": "请围绕旧事物如何重获新生，自拟题目写文章。",
    "sl-prototype-0019": "请为考察团撰写一份城市形象推介文稿。",
    "sl-prototype-0020": "请给社区居民写一封参与治理的动员信。",
    "sl-prototype-0021": "请拟定下一阶段专项行动计划。",
    "sl-prototype-0022": "请围绕发展与保护之间的联系，自拟题目写文章。",
    "sl-prototype-0023": "请概括这一现象形成的根源。",
    "sl-prototype-0024": "请谈谈上述实践有哪些可取之处。",
    "sl-prototype-0025": "请分析材料中的观点有无道理。",
    "sl-prototype-0026": "请针对上述情况给出解决办法。",
}


class V0399PrototypeFallbackMatrixTests(unittest.TestCase):
    def test_common_paraphrases_cover_all_26_prototypes(self):
        resolved_types = set()
        for expected, question in PARAPHRASE_CASES.items():
            with self.subTest(expected=expected):
                code, result = resolve(question)
                self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
                self.assertEqual(result["prototype_id"], expected)
                self.assertIn(
                    result["prototype_resolution_receipt"]["resolution_mode"],
                    {"literal_trigger", "semantic_fallback"},
                )
                resolved_types.add(result["question_type"])
        self.assertEqual(
            resolved_types,
            {"归纳概括", "综合分析", "提出对策", "贯彻执行", "申发论述"},
        )

    def test_unknown_task_stops_without_source_edit_recovery(self):
        code, result = resolve("请处理上述材料。")
        self.assertNotEqual(code, 0)
        self.assertEqual(result["message"], "Question type confirmation required")
        self.assertIn("请确认这道题属于", result["detail"]["user_prompt"])

    def test_proposal_is_not_taken_by_general_work_suggestion(self):
        code, result = resolve("请根据材料撰写一份政协建议案。")
        self.assertEqual(code, 0)
        self.assertEqual(result["prototype_id"], "sl-prototype-0012")

    def test_existing_solution_and_new_proposal_are_distinguished(self):
        cases = {
            "请根据材料，概括小李解决上述问题的办法。": "sl-prototype-0001",
            "针对上述问题，你认为应如何解决？": "sl-prototype-0026",
            "请分析问题产生的原因并提出对策。": "sl-prototype-0008",
        }
        for question, expected in cases.items():
            with self.subTest(question=question):
                code, result = resolve(question)
                self.assertEqual(code, 0)
                self.assertEqual(result["prototype_id"], expected)

    def test_essay_keywords_do_not_hijack_small_questions(self):
        cases = {
            "请分析科研成果转化面临的主要问题。": "sl-prototype-0004",
            "请围绕旧事物如何焕发新生，自拟题目写一篇文章。": "sl-prototype-0018",
            "请围绕发展与保护之间的关系，自拟题目写一篇文章。": "sl-prototype-0022",
            "请结合全部材料，联系实际，自选角度，自拟题目，写一篇议论文。": "sl-prototype-0017",
        }
        for question, expected in cases.items():
            with self.subTest(question=question):
                code, result = resolve(question)
                self.assertEqual(code, 0)
                self.assertEqual(result["prototype_id"], expected)

    def test_general_summary_is_not_misread_as_classification(self):
        code, result = resolve("请归纳总结该地的成功经验。")
        self.assertEqual(code, 0)
        self.assertEqual(result["prototype_id"], "sl-prototype-0001")


if __name__ == "__main__":
    unittest.main(verbosity=2)
