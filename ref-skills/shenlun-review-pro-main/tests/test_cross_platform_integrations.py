# -*- coding: utf-8 -*-
"""Cross-client packaging tests for the GitHub Shenlun plugin."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
PLUGIN = ROOT / "plugins" / "shenlun-review"
SKILL = PLUGIN / "skills" / "shenlun-review-pro"
SERVER = SKILL / "scripts" / "shenlun_mcp_server.py"
GUARD = SKILL / "scripts" / "pretooluse_guard.py"
GENERATED_SKILLS = (
    DIST / "workbuddy" / "plugins" / "shenlun-review" / "skills" / "shenlun-review-pro",
    DIST / "codex" / "shenlun-review" / "skills" / "shenlun-review-pro",
    DIST / "claude-code" / "shenlun-review" / "skills" / "shenlun-review-pro",
)

sys.path.insert(0, str(SKILL / "tests"))
from test_v0380_behavior import small_payload


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def skill_hashes(path: Path) -> dict[str, str]:
    result = {}
    for file_path in sorted(path.rglob("*")):
        relative = file_path.relative_to(path)
        if (
            not file_path.is_file()
            or "tests" in relative.parts
            or "__pycache__" in relative.parts
            or file_path.suffix == ".pyc"
        ):
            continue
        result[str(relative)] = hashlib.sha256(file_path.read_bytes()).hexdigest()
    return result


class CrossPlatformIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        completed = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "build_integrations.py")],
            text=True,
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr or completed.stdout)

    def test_committed_plugin_is_complete_for_all_three_hosts(self):
        required = (
            PLUGIN / ".codex-plugin" / "plugin.json",
            PLUGIN / ".claude-plugin" / "plugin.json",
            PLUGIN / ".codebuddy-plugin" / "plugin.json",
            SKILL / "SKILL.md",
            SERVER,
        )
        for path in required:
            self.assertTrue(path.is_file(), path)
        self.assertFalse((ROOT / "integrations" / "codex").exists())
        self.assertFalse((ROOT / "integrations" / "claude-code").exists())

    def test_repo_marketplaces_point_to_the_committed_plugin(self):
        codex = load_json(ROOT / ".agents" / "plugins" / "marketplace.json")
        self.assertEqual(codex["name"], "shenlun-review")
        self.assertEqual(
            codex["plugins"][0]["source"]["path"], "./plugins/shenlun-review"
        )
        self.assertEqual(
            codex["plugins"][0]["policy"],
            {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
        )
        claude = load_json(ROOT / ".claude-plugin" / "marketplace.json")
        self.assertEqual(claude["name"], "shenlun-review")
        self.assertEqual(claude["plugins"][0]["source"], "./plugins/shenlun-review")

    def test_skill_uses_machine_id_and_chinese_display_name(self):
        text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        frontmatter = text.split("---", 2)[1]
        name_match = re.search(r"(?m)^name:\s*(.+)$", frontmatter)
        self.assertIsNotNone(name_match)
        self.assertEqual(name_match.group(1).strip(), "shenlun-review-pro")
        self.assertRegex(name_match.group(1).strip(), r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
        metadata = (SKILL / "agents" / "openai.yaml").read_text(encoding="utf-8")
        self.assertIn('display_name: "申论复盘一体版"', metadata)
        self.assertIn("$shenlun-review-pro", metadata)

    def test_generated_plugins_contain_the_exact_canonical_skill(self):
        expected = skill_hashes(SKILL)
        self.assertGreater(len(expected), 150)
        for generated in GENERATED_SKILLS:
            self.assertEqual(skill_hashes(generated), expected, generated)

    def test_all_manifests_use_the_release_version(self):
        manifests = (
            PLUGIN / ".codex-plugin" / "plugin.json",
            PLUGIN / ".claude-plugin" / "plugin.json",
            PLUGIN / ".codebuddy-plugin" / "plugin.json",
            DIST / "workbuddy" / "plugins" / "shenlun-review" / ".codebuddy-plugin" / "plugin.json",
            DIST / "codex" / "shenlun-review" / ".codex-plugin" / "plugin.json",
            DIST / "claude-code" / "shenlun-review" / ".claude-plugin" / "plugin.json",
        )
        for manifest in manifests:
            self.assertEqual(load_json(manifest)["version"], VERSION, manifest)

    def test_builder_refuses_to_write_into_source_roots(self):
        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "build_integrations.py"),
                "--output",
                str(ROOT / "plugins"),
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("不能覆盖或进入源码目录", completed.stderr + completed.stdout)

    def test_client_configs_use_host_specific_plugin_roots(self):
        cases = (
            (PLUGIN / ".mcp.json", "CODEX_PLUGIN_ROOT", True),
            (PLUGIN / "config" / "claude" / ".mcp.json", "CLAUDE_PLUGIN_ROOT", False),
        )
        for config, root_variable, wrapped in cases:
            payload = load_json(config)
            server = (
                payload["mcpServers"]["shenlun-review"]
                if wrapped
                else payload["shenlun-review"]
            )
            self.assertEqual(server["command"], "python3")
            self.assertIn(root_variable, server["args"][0])
            self.assertTrue(server["args"][0].endswith("scripts/shenlun_mcp_server.py"))
            self.assertIn(root_variable, server["env"]["SHENLUN_SKILL_DIR"])

        workbuddy_manifest = load_json(
            PLUGIN / ".codebuddy-plugin" / "plugin.json"
        )
        self.assertEqual(workbuddy_manifest["mcpServers"], "./.mcp.json")

    def test_mcp_preserves_quote_rich_chinese_and_calls_fixed_runner(self):
        env = os.environ.copy()
        env.pop("SHENLUN_SKILL_DIR", None)
        process = subprocess.Popen(
            [sys.executable, str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        try:
            initialize = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2024-11-05"},
            }
            process.stdin.write(json.dumps(initialize, ensure_ascii=False) + "\n")
            process.stdin.flush()
            initialized = json.loads(process.stdout.readline())
            self.assertEqual(initialized["result"]["serverInfo"]["version"], VERSION)

            payload = small_payload()
            special = (
                '群众称政策为“以奖代补”，也写作"以奖代补"。\n'
                "路径 C:\\review\\draft 与字符 $()、`command` 都只是作答文本。"
            )
            payload["material_text"] += special
            payload["user_answer"] += special
            payload["points"][0].update({
                "coverage_status": "部分覆盖",
                "user_quote": "建立一站式服务平台……整合多个部门事项",
                "expansion_level": "部分展开",
            })
            call = {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "shenlun_grade_once", "arguments": payload},
            }
            process.stdin.write(json.dumps(call, ensure_ascii=False) + "\n")
            process.stdin.flush()
            response = json.loads(process.stdout.readline())["result"]
            self.assertFalse(response["isError"], response)
            self.assertTrue(response["structuredContent"]["formal_score"])
            self.assertTrue(
                response["structuredContent"]["grade_once_receipt"]["single_compile"]
            )
            point = response["structuredContent"]["point_coverage"][0]
            self.assertEqual(
                point["user_quote"], "建立一站式服务平台，整合多个部门事项"
            )
            self.assertEqual(point["expansion_level"], "简略提及")

            repooled = json.loads(json.dumps(payload, ensure_ascii=False))
            repooled["points"][0].update({
                "coverage_status": "完整覆盖",
                "expansion_level": "充分展开",
            })
            process.stdin.write(json.dumps({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "shenlun_grade_once", "arguments": repooled},
            }, ensure_ascii=False) + "\n")
            process.stdin.flush()
            duplicate = json.loads(process.stdout.readline())["result"]
            self.assertFalse(duplicate["isError"], duplicate)
            self.assertEqual(
                duplicate["structuredContent"]["point_coverage"],
                response["structuredContent"]["point_coverage"],
            )
            self.assertEqual(
                duplicate["structuredContent"]["center_value"],
                response["structuredContent"]["center_value"],
            )

            revised = json.loads(json.dumps(payload, ensure_ascii=False))
            revised["user_answer"] += "补充说明。"
            process.stdin.write(json.dumps({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {"name": "shenlun_grade_once", "arguments": revised},
            }, ensure_ascii=False) + "\n")
            process.stdin.flush()
            revised_response = json.loads(process.stdout.readline())["result"]
            self.assertFalse(revised_response["isError"], revised_response)
            self.assertNotEqual(
                revised_response["structuredContent"]["grade_once_receipt"]["ledger_id"],
                response["structuredContent"]["grade_once_receipt"]["ledger_id"],
            )
        finally:
            if process.stdin:
                process.stdin.close()
            process.wait(timeout=5)
            if process.stdout:
                process.stdout.close()
            if process.stderr:
                process.stderr.close()

    def test_guard_blocks_all_terminal_grading_paths_and_artifacts(self):
        request = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "python3 review_engine.py grade-once"},
        }
        blocked = subprocess.run(
            [sys.executable, str(GUARD)],
            input=json.dumps(request, ensure_ascii=False),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(blocked.returncode, 0, blocked.stderr)
        self.assertEqual(
            json.loads(blocked.stdout)["hookSpecificOutput"]["permissionDecision"],
            "deny",
        )

        request["tool_input"] = {
            "command": "python3 safe_review_runner.py grade-once"
        }
        runner_blocked = subprocess.run(
            [sys.executable, str(GUARD)],
            input=json.dumps(request, ensure_ascii=False),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(
            json.loads(runner_blocked.stdout)["hookSpecificOutput"]["permissionDecision"],
            "deny",
        )

        request["tool_name"] = "Write"
        request["tool_input"] = {
            "file_path": "/tmp/validate_input.json",
            "content": "{}",
        }
        artifact_blocked = subprocess.run(
            [sys.executable, str(GUARD)],
            input=json.dumps(request, ensure_ascii=False),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(
            json.loads(artifact_blocked.stdout)["hookSpecificOutput"]["permissionDecision"],
            "deny",
        )

    def test_trae_installer_is_repeatable_and_preserves_other_servers(self):
        installer = ROOT / "integrations" / "trae" / "install.py"
        with tempfile.TemporaryDirectory() as temp_dir:
            project = Path(temp_dir)
            mcp_path = project / ".trae" / "mcp.json"
            mcp_path.parent.mkdir(parents=True)
            mcp_path.write_text(
                json.dumps({"mcpServers": {"existing": {"command": "existing"}}}),
                encoding="utf-8",
            )
            for _ in range(3):
                completed = subprocess.run(
                    [sys.executable, str(installer), "--project", str(project)],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
            payload = load_json(mcp_path)
            self.assertIn("existing", payload["mcpServers"])
            server = payload["mcpServers"]["shenlun-review"]
            self.assertTrue(Path(server["args"][0]).is_absolute())
            self.assertTrue(Path(server["env"]["SHENLUN_SKILL_DIR"]).is_dir())
            backups = list((project / ".trae" / "backups").iterdir())
            self.assertGreaterEqual(len(backups), 4)
            self.assertEqual(len(backups), len({path.name for path in backups}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
