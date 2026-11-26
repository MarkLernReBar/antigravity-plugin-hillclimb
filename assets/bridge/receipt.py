#!/usr/bin/env python3
"""Run the registered verifier and append exactly one receipt line.

The bridge will not take an agent's word for a score. This script runs the
command itself, keeps the command's own exit code and a bounded tail of its
output, and appends one JSON line to the receipt file. The bridge then mints
evidence only when the line's exit code is zero, its binding matches the
dispatch marker, and its number agrees with the number the engine recorded —
so a receipt always names a command that really ran, on a run that really
exists, against the contract it was dispatched for.

Nothing here scores anything, decides anything, or edits the climb's state.

Usage (the bridge writes this line for you; do not retype it):

    receipt.py --receipt .hillclimb/bridge/<run>.receipts.jsonl \\
               --run-id <run> --binding <hex digest> \\
               --outcome <outcome key> --version <n> \\
               --criteria <id,id> --engine repo|search --track main \\
               --command '<the verifier command, as a human reads it>' \\
               [--score-pattern '<regex with one capture group>'] \\
               -- <argv of the verifier command>

Exit status: the verifier's own. A missing executable is 127 and is recorded
the same way, because "it did not run" is a result too.
"""

from __future__ import annotations

import json
import math
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
NUMBER = re.compile(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?")
DEFAULT_TIMEOUT = 1800
OUTPUT_TAIL = 4000
VALUE_FLAGS = {
    "--receipt": "receipt",
    "--run-id": "run_id",
    "--binding": "binding",
    "--outcome": "outcome",
    "--version": "version",
    "--criteria": "criteria",
    "--engine": "engine",
    "--track": "track",
    "--command": "command",
    "--score-pattern": "score_pattern",
    "--timeout": "timeout",
}
REQUIRED = ("receipt", "run_id", "binding", "outcome", "version", "engine", "command")


def parse(argv: list[str]) -> tuple[dict[str, str], list[str]]:
    """Split at `--`: options before, the verifier's own argv after."""
    if "--" not in argv:
        raise SystemExit("receipt.py: the verifier command must follow `--`")
    split = argv.index("--")
    flags, command = argv[:split], argv[split + 1 :]
    if not command:
        raise SystemExit("receipt.py: no verifier command after `--`")
    values: dict[str, str] = {}
    index = 0
    while index < len(flags):
        flag = flags[index]
        key = VALUE_FLAGS.get(flag)
        if key is None:
            raise SystemExit(f"receipt.py: unknown option {flag!r}")
        if index + 1 >= len(flags):
            raise SystemExit(f"receipt.py: {flag} needs a value")
        values[key] = flags[index + 1]
        index += 2
    missing = [key for key in REQUIRED if values.get(key) is None]
    if missing:
        raise SystemExit("receipt.py: missing " + ", ".join("--" + key.replace("_", "-") for key in missing))
    return values, command


def number(pattern: str | None, output: str) -> float | None:
    """The score the command printed, as a number, or None."""
    if pattern is None:
        return None
    text = ANSI.sub("", output)
    raw_lines = [line.rstrip("\r").split("\r")[-1] for line in text.split("\n")]
    lines = [line for line in raw_lines if re.search(pattern, line)]
    if not lines:
        return None
    found = [
        group
        for match in re.finditer(pattern, lines[-1])
        for group in (match.groups() if match.re.groups else [match.group()])
        if group is not None
    ]
    if not found:
        return None
    values = [value.replace(",", "") for value in found]
    if not all(NUMBER.fullmatch(value) for value in values):
        return None
    numbers = [float(value) for value in values]
    if not all(math.isfinite(scored) for scored in numbers):
        return None
    total = sum(numbers)
    return total if math.isfinite(total) else None


def parse_timeout(values: dict[str, str]) -> float:
    raw = values.get("timeout")
    if raw is None:
        env_raw = os.environ.get("HILLCLIMB_RECEIPT_TIMEOUT", "").strip()
        if not env_raw:
            return float(DEFAULT_TIMEOUT)
        raw = env_raw
    try:
        timeout = float(raw)
    except ValueError:
        raise SystemExit(f"receipt.py: invalid timeout {raw!r}: must be a positive finite number") from None
    if not (math.isfinite(timeout) and timeout > 0):
        raise SystemExit(f"receipt.py: invalid timeout {raw!r}: must be a positive finite number")
    return timeout


def _decode_pipe(data: bytes | str | None) -> str:
    if not data:
        return ""
    text = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else data
    return text.replace("\r\n", "\n")


def main(argv: list[str]) -> int:
    values, command = parse(argv)
    timeout = parse_timeout(values)
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        proc = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            raw_output, _ = proc.communicate(timeout=timeout)
            code = proc.returncode
            output = _decode_pipe(raw_output)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            try:
                partial, _ = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                partial = b""
            code = 124
            output = _decode_pipe(partial) + f"\n[receipt.py: verifier timed out after {timeout:g}s]"
    except FileNotFoundError:
        code, output = 127, f"{command[0]}: command not found"
    except OSError as error:  # permission, ENOMEM, a bad interpreter
        code, output = 126, f"{command[0]}: {error}"

    tail = output[-OUTPUT_TAIL:]
    line = {
        "schema": "hcb/1",
        "runId": values["run_id"],
        "binding": values["binding"],
        "outcome": values["outcome"],
        "version": int(values["version"]),
        "criteria": [part for part in values.get("criteria", "").split(",") if part],
        "engine": values["engine"],
        "track": values.get("track", "main"),
        "command": values["command"],
        "argv": command,
        "scorePattern": values.get("score_pattern"),
        "score": number(values.get("score_pattern"), output),
        "exitCode": code,
        "output": tail,
        "startedAt": started,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    receipt = Path(values["receipt"])
    receipt.parent.mkdir(parents=True, exist_ok=True)
    with receipt.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(line) + "\n")

    verdict = "score" if line["score"] is not None else "no score"
    print(f"receipt {values['run_id']}: {values['command']} -> exit {code}, {verdict}", file=sys.stderr)
    if tail.strip() != "":
        print(tail.rstrip()[-1200:], file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
