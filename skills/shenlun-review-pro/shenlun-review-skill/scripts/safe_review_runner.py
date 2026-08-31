#!/usr/bin/env python3
"""Fixed JSON transport for standalone RedSkill grading.

The host supplies one JSON object through stdin. This runner parses it as
data, serializes it canonically, and invokes the deterministic engine without
generating or evaluating Python source code.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path


EXIT_INPUT_ERROR = 2
DEFAULT_TIMEOUT_SECONDS = 60
ALLOWED_COMMANDS = ("grade-once", "validate-user-output")
ENGINE = Path(__file__).resolve().parent / "review_engine.py"


def emit_transport_error(message, detail=None):
    payload = {
        "error": True,
        "exit_code": EXIT_INPUT_ERROR,
        "error_type": "transport_error",
        "message": message,
        "detail": {
            "maximum_retry_count": 1,
            "retry_policy": "fix_all_listed_errors_once_then_stop",
            "do_not_generate_python": True,
        },
    }
    if detail:
        payload["detail"]["cause"] = detail
    print(json.dumps(payload, ensure_ascii=False, indent=2), file=sys.stderr)
    return EXIT_INPUT_ERROR


def read_payload():
    raw = sys.stdin.read()
    if not raw.strip():
        return None, emit_transport_error("Input JSON is empty")

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        return None, emit_transport_error(
            "Invalid JSON transport; do not repair it with generated Python",
            f"line {exc.lineno}, column {exc.colno}: {exc.msg}",
        )

    if not isinstance(payload, dict):
        return None, emit_transport_error("Input JSON must be an object")
    return payload, None


def build_parser():
    parser = argparse.ArgumentParser(
        prog="safe_review_runner.py",
        description="Standalone fixed JSON transport for Shenlun grading",
    )
    parser.add_argument("command", choices=ALLOWED_COMMANDS)
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help="Execution timeout in seconds (1-60)",
    )
    return parser


def main():
    args = build_parser().parse_args()
    if not 1 <= args.timeout <= DEFAULT_TIMEOUT_SECONDS:
        return emit_transport_error("Timeout must be between 1 and 60 seconds")

    payload, error_code = read_payload()
    if error_code is not None:
        return error_code

    canonical_json = json.dumps(payload, ensure_ascii=False)
    try:
        completed = subprocess.run(
            [sys.executable, str(ENGINE), args.command],
            input=canonical_json,
            text=True,
            capture_output=True,
            check=False,
            timeout=args.timeout,
        )
    except subprocess.TimeoutExpired:
        return emit_transport_error(
            f"{args.command} exceeded the {args.timeout}-second execution limit"
        )
    except OSError as exc:
        return emit_transport_error(
            "Could not start the deterministic review engine", type(exc).__name__
        )

    if completed.stdout:
        sys.stdout.write(completed.stdout)
    if completed.stderr:
        sys.stderr.write(completed.stderr)
    return completed.returncode


if __name__ == "__main__":
    sys.exit(main())
