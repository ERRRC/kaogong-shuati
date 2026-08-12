# -*- coding: utf-8 -*-
"""Tests for the WorkBuddy one-command installer."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "scripts" / "install_workbuddy.py"


class WorkBuddyInstallerTests(unittest.TestCase):
    def test_installer_migrates_legacy_entries_and_registers_complete_plugin(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            workbuddy_home = Path(temp_dir) / ".workbuddy"
            legacy_skill = workbuddy_home / "skills" / "申论复盘一体版"
            legacy_skill.mkdir(parents=True)
            (legacy_skill / "SKILL.md").write_text("legacy", encoding="utf-8")
            (workbuddy_home / "settings.json").write_text(
                json.dumps(
                    {
                        "theme": "dark",
                        "enabledPlugins": {
                            "another-plugin@example": True,
                            "shenlun-review-tools@gongkao-review-local": True,
                            "shenlun-review-tools@shenlun-review-local": True,
                        },
                    }
                ),
                encoding="utf-8",
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    str(INSTALLER),
                    "--workbuddy-home",
                    str(workbuddy_home),
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)

            settings = json.loads((workbuddy_home / "settings.json").read_text())
            self.assertEqual(settings["theme"], "dark")
            self.assertTrue(settings["enabledPlugins"]["another-plugin@example"])
            self.assertFalse(
                settings["enabledPlugins"]["shenlun-review-tools@gongkao-review-local"]
            )
            self.assertFalse(
                settings["enabledPlugins"]["shenlun-review-tools@shenlun-review-local"]
            )
            self.assertTrue(
                settings["enabledPlugins"]["shenlun-review@shenlun-review-local"]
            )

            markets = json.loads(
                (workbuddy_home / "plugins" / "known_marketplaces.json").read_text()
            )
            installed = Path(markets["shenlun-review-local"]["installLocation"])
            plugin = installed / "plugins" / "shenlun-review"
            self.assertTrue((plugin / ".codebuddy-plugin" / "plugin.json").is_file())
            self.assertTrue(
                (
                    plugin
                    / "skills"
                    / "shenlun-review-pro"
                    / "scripts"
                    / "shenlun_mcp_server.py"
                ).is_file()
            )
            mcp_config = json.loads(
                (plugin / ".mcp.json").read_text(encoding="utf-8")
            )
            server = mcp_config["mcpServers"]["shenlun-review"]
            self.assertEqual(server["command"], "python3")
            self.assertTrue(Path(server["args"][0]).is_absolute())
            self.assertTrue(Path(server["args"][0]).is_file())
            self.assertTrue(Path(server["env"]["SHENLUN_SKILL_DIR"]).is_dir())
            self.assertNotIn("CODEBUDDY_PLUGIN_ROOT", server["args"][0])
            self.assertNotIn(
                "CODEBUDDY_PLUGIN_ROOT", server["env"]["SHENLUN_SKILL_DIR"]
            )

            env = os.environ.copy()
            env.update(server["env"])
            process = subprocess.Popen(
                [server["command"], *server["args"]],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            try:
                process.stdin.write(
                    json.dumps({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {"protocolVersion": "2024-11-05"},
                    }) + "\n"
                )
                process.stdin.flush()
                initialized = json.loads(process.stdout.readline())
                self.assertEqual(
                    initialized["result"]["serverInfo"]["name"], "shenlun_review_mcp"
                )
                process.stdin.write(
                    json.dumps({
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/list",
                        "params": {},
                    }) + "\n"
                )
                process.stdin.flush()
                listed = json.loads(process.stdout.readline())
                tool_names = {
                    item["name"] for item in listed["result"]["tools"]
                }
                self.assertEqual(
                    tool_names,
                    {"shenlun_grade_once", "shenlun_validate_user_output"},
                )
            finally:
                if process.stdin:
                    process.stdin.close()
                process.wait(timeout=5)
                if process.stdout:
                    process.stdout.close()
                if process.stderr:
                    process.stderr.close()
            self.assertFalse(legacy_skill.exists())
            archived = (
                workbuddy_home
                / "backups"
                / "shenlun-review"
                / "legacy-skills"
            )
            self.assertTrue(any(archived.iterdir()))

    def test_three_rapid_installs_create_unique_recoverable_backups(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            workbuddy_home = Path(temp_dir) / ".workbuddy"
            command = [
                sys.executable,
                str(INSTALLER),
                "--workbuddy-home",
                str(workbuddy_home),
            ]
            for _ in range(3):
                completed = subprocess.run(command, text=True, capture_output=True)
                self.assertEqual(completed.returncode, 0, completed.stderr)
            backups = workbuddy_home / "backups" / "shenlun-review"
            entries = [path for path in backups.iterdir() if path.is_dir()]
            self.assertGreaterEqual(len(entries), 2)
            self.assertEqual(len(entries), len({path.name for path in entries}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
