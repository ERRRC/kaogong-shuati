#!/usr/bin/env python3
"""Build optional offline packages from the committed universal plugin."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
PLUGIN_SOURCE = ROOT / "plugins" / "shenlun-review"
SOURCE_SKILL = PLUGIN_SOURCE / "skills" / "shenlun-review-pro"
WORKBUDDY_TEMPLATE = ROOT / "integrations" / "workbuddy"
DEFAULT_OUTPUT = ROOT / "dist"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="构建申论客户端离线安装包")
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"构建输出目录，默认 {DEFAULT_OUTPUT}",
    )
    return parser.parse_args()


def ignore_package_noise(directory: str, names: list[str]) -> set[str]:
    ignored = {
        name
        for name in names
        if name == ".DS_Store" or name == "__pycache__" or name.endswith(".pyc")
    }
    if Path(directory).resolve() == SOURCE_SKILL.resolve() and "tests" in names:
        ignored.add("tests")
    return ignored


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_versions() -> None:
    skill_text = (SOURCE_SKILL / "SKILL.md").read_text(encoding="utf-8")
    engine_text = (SOURCE_SKILL / "scripts" / "review_engine.py").read_text(
        encoding="utf-8"
    )
    server_text = (SOURCE_SKILL / "scripts" / "shenlun_mcp_server.py").read_text(
        encoding="utf-8"
    )
    expected = f'"{VERSION}"'
    checks = {
        "SKILL.md": f"Skill v{VERSION}" in skill_text,
        "review_engine.py": f"ENGINE_VERSION = {expected}" in engine_text,
        "shenlun_mcp_server.py": f"SERVER_VERSION = {expected}" in server_text,
        "Codex plugin": read_json(
            PLUGIN_SOURCE / ".codex-plugin" / "plugin.json"
        )["version"]
        == VERSION,
        "Claude Code plugin": read_json(
            PLUGIN_SOURCE / ".claude-plugin" / "plugin.json"
        )["version"]
        == VERSION,
        "WorkBuddy plugin": read_json(
            PLUGIN_SOURCE / ".codebuddy-plugin" / "plugin.json"
        )["version"]
        == VERSION,
        "Claude marketplace": read_json(
            ROOT / ".claude-plugin" / "marketplace.json"
        )["plugins"][0]["version"]
        == VERSION,
        "WorkBuddy marketplace": read_json(
            WORKBUDDY_TEMPLATE / ".codebuddy-plugin" / "marketplace.json"
        )["plugins"][0]["version"]
        == VERSION,
    }
    failed = [name for name, passed in checks.items() if not passed]
    if failed:
        raise SystemExit("版本不一致：" + "、".join(failed))


def validate_output(output: Path) -> Path:
    output = output.expanduser().resolve()
    protected_roots = (
        ROOT / "plugins",
        ROOT / "integrations",
        ROOT / "scripts",
        ROOT / "tests",
        ROOT / ".agents",
        ROOT / ".claude-plugin",
    )
    if output == ROOT or any(
        output == protected or protected in output.parents for protected in protected_roots
    ):
        raise SystemExit("构建输出目录不能覆盖或进入源码目录")
    return output


def replace_tree(source: Path, destination: Path) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination, ignore=ignore_package_noise)


def build_workbuddy(destination: Path) -> Path:
    replace_tree(WORKBUDDY_TEMPLATE, destination)
    replace_tree(PLUGIN_SOURCE, destination / "plugins" / "shenlun-review")
    return destination


def build_all(output: Path) -> tuple[Path, Path, Path]:
    validate_versions()
    output = validate_output(output)
    packages = (
        build_workbuddy(output / "workbuddy"),
        output / "codex" / "shenlun-review",
        output / "claude-code" / "shenlun-review",
    )
    replace_tree(PLUGIN_SOURCE, packages[1])
    replace_tree(PLUGIN_SOURCE, packages[2])
    return packages


def main() -> int:
    args = parse_args()
    for package in build_all(args.output):
        print(f"built {package}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
