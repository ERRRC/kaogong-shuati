#!/usr/bin/env python3
"""Install the self-contained Shenlun plugin into WorkBuddy."""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from build_integrations import build_workbuddy, validate_versions


MARKETPLACE_NAME = "shenlun-review-local"
PLUGIN_KEY = "shenlun-review@shenlun-review-local"
LEGACY_PLUGIN_KEYS = (
    "shenlun-review-tools@gongkao-review-local",
    "shenlun-review-tools@shenlun-review-local",
)
LEGACY_SKILL_NAMES = ("申论复盘一体版", "shenlun-review-pro")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="安装申论复盘一体版 WorkBuddy 完整插件")
    parser.add_argument(
        "--workbuddy-home",
        type=Path,
        default=Path.home() / ".workbuddy",
        help="WorkBuddy 数据目录，默认 ~/.workbuddy",
    )
    return parser.parse_args()


def load_object(path: Path, default: dict) -> dict:
    if not path.exists():
        return default
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} 必须是 JSON 对象")
    return payload


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    index = 1
    while True:
        candidate = path.with_name(f"{path.name}.{index}")
        if not candidate.exists():
            return candidate
        index += 1


def write_json(path: Path, payload: dict, stamp: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        shutil.copy2(path, unique_path(path.with_name(f"{path.name}.bak.{stamp}")))
    staging = unique_path(path.with_name(f".{path.name}.tmp.{stamp}"))
    staging.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    staging.replace(path)


def replace_marketplace(
    source: Path, destination: Path, backup_root: Path, stamp: str
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = unique_path(destination.with_name(f".{destination.name}.tmp.{stamp}"))
    shutil.copytree(source, staging, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    backup: Path | None = None
    try:
        if destination.exists():
            backup_root.mkdir(parents=True, exist_ok=True)
            backup = unique_path(backup_root / f"{MARKETPLACE_NAME}.{stamp}")
            shutil.move(str(destination), str(backup))
        staging.rename(destination)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        if backup is not None and backup.exists() and not destination.exists():
            shutil.move(str(backup), str(destination))
        raise


def configure_workbuddy_mcp(marketplace_root: Path, destination: Path) -> None:
    """Bind the WorkBuddy MCP command to this exact installed plugin copy.

    WorkBuddy may load a marketplace MCP configuration outside the plugin
    runtime, where CODEBUDDY_PLUGIN_ROOT is not injected. Resolve the two
    paths while the installer still knows the final destination so the host
    can always start the server.
    """
    packaged_plugin_root = marketplace_root / "plugins" / "shenlun-review"
    installed_plugin_root = destination / "plugins" / "shenlun-review"
    installed_skill_root = installed_plugin_root / "skills" / "shenlun-review-pro"
    server_path = installed_skill_root / "scripts" / "shenlun_mcp_server.py"
    packaged_server_path = (
        packaged_plugin_root
        / "skills"
        / "shenlun-review-pro"
        / "scripts"
        / "shenlun_mcp_server.py"
    )
    config_path = packaged_plugin_root / ".mcp.json"
    payload = load_object(config_path, {})
    servers = payload.get("mcpServers")
    if not isinstance(servers, dict):
        raise ValueError(f"{config_path} 的 mcpServers 必须是对象")
    server = servers.get("shenlun-review")
    if not isinstance(server, dict):
        raise ValueError(f"{config_path} 缺少 shenlun-review MCP 配置")
    if not packaged_server_path.is_file():
        raise FileNotFoundError(f"安装包缺少 MCP Server：{packaged_server_path}")
    server["command"] = "python3"
    server["args"] = [str(server_path)]
    env = server.setdefault("env", {})
    if not isinstance(env, dict):
        raise ValueError(f"{config_path} 的 shenlun-review.env 必须是对象")
    env["SHENLUN_SKILL_DIR"] = str(installed_skill_root)
    config_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def archive_legacy_skills(workbuddy_home: Path, stamp: str) -> list[Path]:
    archived = []
    backup_root = workbuddy_home / "backups" / "shenlun-review" / "legacy-skills"
    for name in LEGACY_SKILL_NAMES:
        source = workbuddy_home / "skills" / name
        if not source.exists():
            continue
        backup_root.mkdir(parents=True, exist_ok=True)
        destination = unique_path(backup_root / f"{name}.{stamp}")
        shutil.move(str(source), str(destination))
        archived.append(destination)
    return archived


def main() -> int:
    args = parse_args()
    workbuddy_home = args.workbuddy_home.expanduser().resolve()
    validate_versions()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    destination = workbuddy_home / "plugins" / "marketplaces" / MARKETPLACE_NAME
    with tempfile.TemporaryDirectory(prefix="shenlun-workbuddy-") as temp_dir:
        source_marketplace = build_workbuddy(Path(temp_dir) / "marketplace")
        configure_workbuddy_mcp(source_marketplace, destination)
        replace_marketplace(
            source_marketplace,
            destination,
            workbuddy_home / "backups" / "shenlun-review",
            stamp,
        )

    known_path = workbuddy_home / "plugins" / "known_marketplaces.json"
    known = load_object(known_path, {})
    known[MARKETPLACE_NAME] = {
        "type": "directory",
        "source": {"source": "directory", "path": str(destination)},
        "installLocation": str(destination),
        "description": f"Marketplace from {destination}",
        "lastUpdated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "autoUpdate": False,
    }
    write_json(known_path, known, stamp)

    settings_path = workbuddy_home / "settings.json"
    settings = load_object(settings_path, {})
    enabled = settings.setdefault("enabledPlugins", {})
    if not isinstance(enabled, dict):
        raise ValueError(f"{settings_path} 的 enabledPlugins 必须是对象")
    for legacy_key in LEGACY_PLUGIN_KEYS:
        if legacy_key in enabled:
            enabled[legacy_key] = False
    enabled[PLUGIN_KEY] = True
    write_json(settings_path, settings, stamp)

    archived = archive_legacy_skills(workbuddy_home, stamp)
    print("申论复盘一体版 WorkBuddy 完整插件安装成功。")
    print(f"插件目录：{destination}")
    for path in archived:
        print(f"已归档重复 Skill：{path}")
    print("请完全退出并重启 WorkBuddy，再新建任务加载 Skill、MCP 和 Hook。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
