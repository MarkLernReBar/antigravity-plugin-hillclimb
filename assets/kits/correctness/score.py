#!/usr/bin/env python3
"""CLI adapter for the correctness starter kit. See ../README.md."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from kitcore import score_main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(score_main("correctness", sys.argv[1:]))
