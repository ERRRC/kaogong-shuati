# -*- coding: utf-8 -*-
"""Regression tests for saved analysis receipts and dedicated finalization."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_v0381_normal_flow import ENGINE, run_engine


def analysis_payload(with_reference=False):
    payload = {
        "question_text": "请根据给定资料，概括该地的主要做法。不超过30字。",
        "material_text": "该地搭建服务平台，整合部门事项；组织工作人员上门代办。",
    }
    if with_reference:
        payload["reference_answers"] = [
            {"answer_text": "搭建平台整合事项，组织上门代办。"}
        ]
    return payload


def saved_analysis_receipt(payload):
    handle = tempfile.NamedTemporaryFile(
        prefix="shenlun-analysis-receipt-", suffix=".json", delete=False
    )
    path = Path(handle.name)
    handle.close()
    proc = subprocess.run(
        ["python3", str(ENGINE), "analyze-once", "--output", str(path)],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        path.unlink(missing_ok=True)
    return proc.returncode, path, json.loads(proc.stdout or proc.stderr)


class V0393AnalysisFinalizeTests(unittest.TestCase):
    def test_finalize_reuses_exact_receipt_and_deletes_it(self):
        code, path, pointer = saved_analysis_receipt(analysis_payload())
        self.assertEqual(code, 0, json.dumps(pointer, ensure_ascii=False, indent=2))
        receipt = json.loads(path.read_text(encoding="utf-8"))
        method = receipt["output_validation_context"]["required_method_names"][0]
        answer = "搭建服务平台整合事项，组织工作人员上门代办。"
        text = (
            "题干拆解：明确任务、对象和字数要求，形成答案责任。\n"
            f"方法讲解：本题使用{method}，先圈出任务，再回到材料合并做法。\n"
            "材料证据：平台整合和上门代办均有原句依据。\n"
            "答案组织：按主体动作分点；易错提醒：不要把成效当做法。\n"
            f"示范答案：\n{answer}"
        )
        code, result = run_engine("finalize-analysis", {
            "receipt_path": str(path),
            "text": text,
            "reference_answer_text": answer,
        })
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertEqual(result["approved_text"], text)
        self.assertTrue(result["analysis_finalize_receipt"]["analysis_receipt_reused"])
        self.assertFalse(result["analysis_finalize_receipt"]["duplicate_analysis_required"])
        self.assertTrue(result["analysis_finalize_receipt"]["receipt_deleted"])
        self.assertFalse(path.exists())

    def test_failed_finalize_retains_receipt_for_one_corrected_retry(self):
        code, path, _ = saved_analysis_receipt(analysis_payload())
        self.assertEqual(code, 0)
        code, failed = run_engine("finalize-analysis", {
            "receipt_path": str(path),
            "text": "只有示范答案，没有方法说明。",
            "reference_answer_text": "没有出现在正文中的答案",
        })
        self.assertNotEqual(code, 0)
        self.assertIn("FAILED", failed["message"])
        self.assertTrue(path.exists())

        receipt = json.loads(path.read_text(encoding="utf-8"))
        method = receipt["output_validation_context"]["required_method_names"][0]
        answer = "搭建平台整合事项，上门代办。"
        text = (
            f"题干拆解：明确任务和答案责任。\n方法讲解：使用{method}，"
            "先圈出任务，再逐点合并。\n材料证据：逐点回到原文核对。\n"
            "答案组织：按功能分点；易错提醒：不要把背景当措施。\n"
            f"示范答案：\n{answer}"
        )
        code, result = run_engine("finalize-analysis", {
            "receipt_path": str(path),
            "text": text,
            "reference_answer_text": answer,
        })
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertFalse(path.exists())

    def test_existing_reference_forbids_generated_answer_payload(self):
        code, path, _ = saved_analysis_receipt(analysis_payload(with_reference=True))
        self.assertEqual(code, 0)
        code, result = run_engine("finalize-analysis", {
            "receipt_path": str(path),
            "text": "方法讲解：先圈出任务，再回到材料逐点核对。",
            "reference_answer_text": "不应再生成第二份答案",
        })
        self.assertNotEqual(code, 0)
        self.assertIn("forbids", result["message"])
        receipt = json.loads(path.read_text(encoding="utf-8"))
        method = receipt["output_validation_context"]["required_method_names"][0]
        text = (
            f"题干拆解：明确任务和答案责任。\n方法讲解：使用{method}，"
            "先圈出任务，再回到材料逐点核对。\n材料证据：按材料功能逐点核验。\n"
            "参考答案校准：将已有答案作为候选骨架，回材料补漏并合并同功能内容。\n"
            "答案组织：按主点归并；易错提醒：不要脱离题目范围。"
        )
        code, result = run_engine("finalize-analysis", {
            "receipt_path": str(path),
            "text": text,
        })
        self.assertEqual(code, 0, json.dumps(result, ensure_ascii=False, indent=2))
        self.assertFalse(path.exists())

    def test_finalize_rejects_reconstructed_context_fields(self):
        code, path, _ = saved_analysis_receipt(analysis_payload())
        self.assertEqual(code, 0)
        code, result = run_engine("finalize-analysis", {
            "receipt_path": str(path),
            "text": "正文",
            "output_mode": "解析",
        })
        self.assertNotEqual(code, 0)
        self.assertIn("accepts only", result["message"])
        path.unlink(missing_ok=True)

    def test_contract_requires_one_disposable_receipt_not_reanalysis(self):
        skill = (ENGINE.parent.parent / "SKILL.md").read_text(encoding="utf-8")
        contract = (
            ENGINE.parent.parent / "references" / "contracts" / "analyze-once-runtime.md"
        ).read_text(encoding="utf-8")
        self.assertIn("finalize-analysis", skill)
        self.assertIn("取得回执后绝不再次调用 `analyze-once`", skill)
        self.assertIn("shenlun-analysis-receipt-", contract)
        self.assertIn("禁止再次调用 `analyze-once`", contract)
        self.assertIn("不得手工复制、删减或重建校验上下文", contract)


if __name__ == "__main__":
    unittest.main(verbosity=2)
