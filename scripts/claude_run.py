#!/usr/bin/env python3
"""Repo-local entrypoint for the shared Claude Code long-task harness."""

from __future__ import annotations

import runpy
import sys
import os
from pathlib import Path


HARNESS = Path(os.environ.get("CLAUDE_RUN_HARNESS", ""))


if not HARNESS.exists():
    raise SystemExit(
        "Set CLAUDE_RUN_HARNESS to the path of the shared Claude harness."
    )

sys.argv[0] = str(HARNESS)
runpy.run_path(str(HARNESS), run_name="__main__")
