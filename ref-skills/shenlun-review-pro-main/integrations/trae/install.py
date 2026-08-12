#!/usr/bin/env python3
"""Install the Shenlun Skill and MCP into one TRAE project."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE_SKILL = ROOT / "plugins" / "shenlun-review" / "skills" / "shenlun-review-pro"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="安装申论 Skill 与 MCP 到 TRAE 项目")
    parser.add_argument(
        "--project",
        type=Path,
        default=Path.cwd(),
        help="TRAE 项目根目录，默认当前目录",
    )
    return parser.parse_args()


def load_mcp(path: Path) -> dict:
    if not path.exists():
        return {"mcpServers": {}}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} 必须是 JSON 对象")
    servers = payload.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        raise ValueError(f"{path} 的 mcpServers 必须是对象")
    return payload


def backup(path: Path, backup_root: Path, stamp: str) -> None:
    if not path.exists():
        return
    backup_root.mkdir(parents=True, exist_ok=True)
    destination = backup_root / f"{path.name}.{stamp}"
    index = 1
    while destination.exists():
        destination = backup_root / f"{path.name}.{stamp}.{index}"
        index += 1
    if path.is_dir():
        shutil.copytree(path, destination)
    else:
        shutil.copy2(path, destination)


def main() -> int:
    args = parse_args()
    project = args.project.expanduser().resolve()
    if not project.is_dir():
        raise SystemExit(f"项目目录不存在：{project}")
    trae_dir = project / ".trae"
    destination = trae_dir / "skills" / "shenlun-review-pro"
    mcp_path = trae_dir / "mcp.json"
    backup_root = trae_dir / "backups"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")

    backup(destination, backup_root, stamp)
    backup(mcp_path, backup_root, stamp)
    if destination.exists():
        shutil.rmtree(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        SOURCE_SKILL,
        destination,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "tests"),
    )

    payload = load_mcp(mcp_path)
    payload["mcpServers"]["shenlun-review"] = {
        "command": sys.executable,
        "args": [str(destination / "scripts" / "shenlun_mcp_server.py")],
        "env": {"SHENLUN_SKILL_DIR": str(destination)},
    }
    mcp_path.parent.mkdir(parents=True, exist_ok=True)
    mcp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"已安装 Skill：{destination}")
    print(f"已配置 MCP：{mcp_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
