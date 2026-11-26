#!/usr/bin/env python3
"""CLI adapter for the latency-cost starter kit. See ../README.md."""
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from kitcore import score_main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(score_main("latency-cost", sys.argv[1:]))
