#!/usr/bin/env python3
"""codex_par — run many independent `codex exec` sessions in parallel with
orchestrator-friendly visibility.

WHY THIS EXISTS
---------------
The codex-companion plugin shares ONE `codex app-server` per workspace, fronted
by a broker (`app-server-broker.mjs`) that serializes to a single active turn.
A second concurrent caller in the same git root gets JSON-RPC error
`BROKER_BUSY_RPC_CODE` -> "Shared Codex broker is busy." That design is
single-conversation by construction.

`codex exec` spawns a fresh, independent process per invocation -- no app-server,
no broker, no BUSY. N of them run truly concurrently. With `--json` each emits a
JSONL event stream we can capture per job and surface compactly to the
orchestrator thread.

This tool launches a fleet of detached `codex exec --json` jobs, captures each
job's JSONL + final message + exit code under a run directory, and provides a
compact status digest and a high-signal streaming `watch` (for the Monitor tool)
so the orchestrator keeps visibility without drowning in reasoning tokens.

SAFETY
------
Default sandbox is `danger-full-access` (full access, no OS sandbox): vitest
writes `node_modules/.vite-temp`, a symlink that points outside the job cwd in a
worktree, so stricter sandboxes block the test run. Pass `--sandbox read-only`
(or `"sandbox": "read-only"` in a spec) for read-only review/diagnose legs.
Parallel WRITERS that touch the same files will conflict -- give each writer its
own git worktree (`cwd`), same rule as /ship-slice worktree isolation. Parallel
readers are safe in one tree.

SUBCOMMANDS
-----------
  run     Launch one or more jobs (detached); returns immediately. Prints RUNDIR.
  status  One compact line per job: state, elapsed, turns, tokens, items, last event.
  watch   Stream high-signal events across all jobs (designed for the Monitor tool).
  result  Print a job's final agent message (the -o last-message file).
  list    List run directories under the base dir.

QUICKSTART
----------
  # launch a fleet from a JSON spec (or '-' for stdin)
  python3 scripts/codex_par.py run --spec jobs.json
  # ...or a single job inline
  python3 scripts/codex_par.py run --label review --cwd /path/wt --prompt "Review the diff for bugs."

  # snapshot
  python3 scripts/codex_par.py status <RUNDIR>
  # live stream for the Monitor tool (exits when every job is done):
  python3 scripts/codex_par.py watch <RUNDIR>
  # final answers
  python3 scripts/codex_par.py result review <RUNDIR>

JOB SPEC JSON
-------------
  {"jobs": [
    {"label": "auth-review",
     "cwd": "<absolute-worktree-path>",
     "prompt": "Review the auth changes for security bugs.",
     "sandbox": "read-only",         # read-only|workspace-write|danger-full-access; default danger-full-access
     "model": null,                   # e.g. "gpt-5.3-codex-spark"; null = default
     "effort": null,                  # none|minimal|low|medium|high|xhigh; null = default
     "prompt_file": null,             # alternative to inline prompt (path)
     "skip_git_check": true,          # add --skip-git-repo-check
     "config": [],                    # extra raw `-c key=value` overrides
     "allowed_files": [],             # fence: globs (rel. to cwd) the job may touch; out-of-fence flagged in status/watch/audit
     "timeout_min": null              # hard wall-clock cap (min); auto-stops a runaway job -> state 'timeout'
    }
  ]}

GATES (mechanize the recurring Codex dispatch failures — see memory
feedback-codex-frontend-tsc-gate.md):
  # capture the type-baseline at Phase 1b (pre-existing errors live here, so
  # they never trap the agent):
  python3 scripts/codex_par.py gate --cwd <wt> --cmd "npx tsc -p tsconfig.app.json" \
      --baseline /tmp/tsc-baseline.txt --capture
  # post-impl backstop — PASS only on ZERO new error signatures (NOT a file-name grep):
  python3 scripts/codex_par.py gate --cwd <wt> --cmd "npx tsc -p tsconfig.app.json" \
      --baseline /tmp/tsc-baseline.txt        # works for pyright too: --cmd "pyright"
  # fence audit — files a job changed outside its allowed_files:
  python3 scripts/codex_par.py audit <RUNDIR>
  # stop a runaway/wedged job (clean process-group kill; resume via thread_id):
  python3 scripts/codex_par.py stop <RUNDIR> --label <slice>

LEDGER (durable outcome record — the evaluation / self-improvement substrate):
  # one JSONL record per finished job at ~/.codex-par/ledger.jsonl (override via
  # CODEX_PAR_LEDGER); survives tmp cleanup, accumulates across runs/projects.
  # auto-written by `watch` and `run --wait`; sweep un-watched runs explicitly:
  python3 scripts/codex_par.py ledger <RUNDIR>      # or --all to sweep every run
  python3 scripts/codex_par.py ledger --stats       # state/timeout/tokens by sandbox+model
  python3 scripts/codex_par.py ledger --show 50     # last 50 raw records

Stdlib only. Python 3.9+.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

# ----------------------------------------------------------------------------
# paths / base dir
# ----------------------------------------------------------------------------

SANDBOXES = ("read-only", "workspace-write", "danger-full-access")
# Default to full access: vitest writes node_modules/.vite-temp, which in a
# worktree is a symlink pointing outside the job cwd — workspace-write blocks
# that write, so the test suite cannot run under anything stricter. Override
# per-job with `--sandbox read-only` (CLI) or `"sandbox": "read-only"` (spec)
# for read-only review/diagnose legs.
DEFAULT_SANDBOX = "danger-full-access"


def base_dir() -> Path:
    env = os.environ.get("CODEX_PAR_HOME")
    if env:
        return Path(env).expanduser()
    return Path.cwd() / "tmp" / "codex-par"


def resolve_run_dir(arg: str | None, *, create: bool = False) -> Path:
    """Resolve a RUNDIR. Accepts an absolute/relative path or a bare run-id
    under the base dir."""
    base = base_dir()
    if arg:
        p = Path(arg).expanduser()
        if p.is_absolute() or os.sep in arg or arg.startswith("."):
            run = p
        else:
            run = base / arg
    else:
        run = base / f"run-{int(time.time())}"
    if create:
        run.mkdir(parents=True, exist_ok=True)
    return run


# ----------------------------------------------------------------------------
# job spec loading
# ----------------------------------------------------------------------------


def _norm_job(raw: dict, idx: int) -> dict:
    label = str(raw.get("label") or f"job{idx + 1}").strip()
    safe = "".join(c if (c.isalnum() or c in "._-") else "-" for c in label).strip("-") or f"job{idx + 1}"
    sandbox = raw.get("sandbox") or DEFAULT_SANDBOX
    if sandbox not in SANDBOXES:
        raise SystemExit(f"job '{label}': invalid sandbox '{sandbox}' (expected one of {SANDBOXES})")
    prompt = raw.get("prompt")
    prompt_file = raw.get("prompt_file")
    if not prompt and not prompt_file:
        raise SystemExit(f"job '{label}': needs 'prompt' or 'prompt_file'")
    return {
        "label": safe,
        "cwd": str(raw.get("cwd") or os.getcwd()),
        "sandbox": sandbox,
        "model": raw.get("model"),
        "effort": raw.get("effort"),
        "prompt": prompt,
        "prompt_file": prompt_file,
        "skip_git_check": bool(raw.get("skip_git_check", True)),
        "config": list(raw.get("config") or []),
        # fence: file globs (relative to cwd) this job is allowed to touch.
        # Empty/None = no fence audit.
        "allowed_files": list(raw.get("allowed_files") or []),
        # hard wall-clock cap in minutes (auto-stop runaway jobs). None = no cap.
        "timeout_min": raw.get("timeout_min"),
    }


def load_jobs_from_spec(spec_arg: str) -> list[dict]:
    if spec_arg == "-":
        data = json.load(sys.stdin)
    else:
        data = json.loads(Path(spec_arg).expanduser().read_text())
    jobs = data.get("jobs") if isinstance(data, dict) else data
    if not isinstance(jobs, list) or not jobs:
        raise SystemExit("spec must contain a non-empty 'jobs' array")
    return [_norm_job(j, i) for i, j in enumerate(jobs)]


# ----------------------------------------------------------------------------
# run
# ----------------------------------------------------------------------------


def _build_codex_cmd(job: dict, run: Path) -> list[str]:
    label = job["label"]
    cmd = ["codex", "exec", "--json", "-s", job["sandbox"]]
    if job["skip_git_check"]:
        cmd.append("--skip-git-repo-check")
    if job["model"]:
        cmd += ["-m", str(job["model"])]
    if job["effort"]:
        cmd += ["-c", f"model_reasoning_effort={job['effort']}"]
    for c in job["config"]:
        cmd += ["-c", str(c)]
    cmd += ["-o", str(run / f"{label}.last.md")]
    # NOTE: no prompt arg -- prompt is fed via stdin (the prompt file). Passing
    # both an arg and stdin makes codex append stdin as a <stdin> block.
    return cmd


def launch_job(job: dict, run: Path) -> dict:
    label = job["label"]
    jsonl = run / f"{label}.jsonl"
    stderr = run / f"{label}.stderr"
    donef = run / f"{label}.done.json"
    promptf = run / f"{label}.prompt.txt"

    if job["prompt_file"]:
        promptf.write_text(Path(job["prompt_file"]).expanduser().read_text())
    else:
        promptf.write_text(str(job["prompt"]))

    # snapshot pre-existing dirty files so the fence audit only judges what THIS
    # job changed (not edits already in the worktree).
    allowed = job.get("allowed_files") or []
    pre_dirty = sorted(_git_changed_files(job["cwd"])) if allowed else []

    codex_cmd = _build_codex_cmd(job, run)
    codex_str = " ".join(shlex.quote(a) for a in codex_cmd)
    # optional hard wall-clock cap: `timeout` SIGTERMs codex at the limit, then
    # SIGKILLs 30s later. Exit 124 == timed out (recorded in the sentinel).
    tmo = job.get("timeout_min")
    run_str = f"timeout --signal=TERM -k 30s {tmo}m {codex_str}" if tmo else codex_str
    # wrapper: cd into the job cwd, run codex with prompt on stdin, then record
    # exit code + end time + timeout flag so `status`/`watch` can detect terminal
    # state even after this launcher process has exited.
    wrapped = (
        f"cd {shlex.quote(job['cwd'])} || exit 97; "
        f"{run_str} "
        f"> {shlex.quote(str(jsonl))} 2> {shlex.quote(str(stderr))} "
        f"< {shlex.quote(str(promptf))}; "
        f"c=$?; to=false; [ \"$c\" = \"124\" ] && to=true; "
        f"printf '{{\"exit\":%s,\"end\":%s,\"timeout\":%s}}\\n' \"$c\" \"$(date +%s)\" \"$to\" > {shlex.quote(str(donef))}"
    )

    # Detach fully: start_new_session=True calls setsid(2) in the child, giving
    # it no controlling tty so it survives the launcher (and the Bash tool call)
    # exiting. We deliberately do NOT also exec the `setsid` binary -- that forks
    # and exits immediately, which would make proc.pid ephemeral and break
    # liveness checks. With plain bash here, proc.pid IS the wrapper, which waits
    # on codex, so pid-alive == job-running.
    proc = subprocess.Popen(
        ["bash", "-c", wrapped],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        cwd=str(run),
    )

    meta = {
        "label": label,
        "cwd": job["cwd"],
        "sandbox": job["sandbox"],
        "model": job["model"],
        "effort": job["effort"],
        "codex_cmd": codex_cmd,
        "pid": proc.pid,
        "start": int(time.time()),
        "jsonl": str(jsonl),
        "stderr": str(stderr),
        "done_file": str(donef),
        "last_msg": str(run / f"{label}.last.md"),
        "prompt_file": str(promptf),
        "allowed_files": allowed,
        "pre_dirty": pre_dirty,
        "timeout_min": tmo,
    }
    (run / f"{label}.meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    return meta


def cmd_run(args: argparse.Namespace) -> int:
    if args.spec:
        jobs = load_jobs_from_spec(args.spec)
    elif args.prompt or args.prompt_file:
        jobs = [
            _norm_job(
                {
                    "label": args.label,
                    "cwd": args.cwd,
                    "sandbox": args.sandbox,
                    "model": args.model,
                    "effort": args.effort,
                    "prompt": args.prompt,
                    "prompt_file": args.prompt_file,
                    "skip_git_check": not args.no_skip_git_check,
                    "config": args.config or [],
                    "allowed_files": args.allowed or [],
                    "timeout_min": args.timeout_min,
                },
                0,
            )
        ]
    else:
        raise SystemExit("run: provide --spec, or --prompt / --prompt-file for a single job")

    labels = [j["label"] for j in jobs]
    if len(set(labels)) != len(labels):
        raise SystemExit(f"duplicate job labels: {labels}")

    run = resolve_run_dir(args.dir, create=True)
    metas = [launch_job(j, run) for j in jobs]

    print(f"RUNDIR  {run}")
    print(f"LAUNCHED {len(metas)} job(s):")
    for m in metas:
        print(f"  {m['label']:<24} pid={m['pid']:<8} sandbox={m['sandbox']:<16} cwd={m['cwd']}")
    print()
    print("Visibility:")
    print(f"  snapshot : python3 {_self()} status {run}")
    print(f"  result   : python3 {_self()} result <label> {run}")
    print("  monitor  : DEFAULT = one-shot completion waiter (ONE notification when done, no per-event noise).")
    print(f"             Bash run_in_background:  until python3 {_self()} status {run} 2>/dev/null | grep -qE 'summary:.*0 running'; do sleep 15; done; python3 {_self()} status {run} | tail -6; python3 {_self()} result <label> {run} | tail -40")
    print(f"             (liveness already covered: status flags idle>=120s as STUCK + --timeout-min auto-stops a runaway leg.)")
    print(f"  stream   : python3 {_self()} watch {run}   # OPT-IN ONLY via the Monitor tool — emits a notification PER codex action (file read, sed, test run), which FLOODS the conversation. Use only to babysit a stalling leg, then TaskStop it. NOT the default.")

    if args.wait:
        print("\nwaiting for all jobs to finish...", flush=True)
        _wait_all(run, metas)
        for m in metas:
            record_ledger_entry(m, run)
        print()
        return cmd_status(argparse.Namespace(dir=str(run), json=False, verbose=False, stuck_after=120.0))
    return 0


def _self() -> str:
    return os.path.relpath(os.path.abspath(__file__))


def _wait_all(run: Path, metas: list[dict], poll: float = 1.0) -> None:
    pending = {m["label"] for m in metas}
    while pending:
        time.sleep(poll)
        for label in list(pending):
            if (run / f"{label}.done.json").exists():
                pending.discard(label)


# ----------------------------------------------------------------------------
# jsonl parsing / aggregation
# ----------------------------------------------------------------------------

TRANSIENT_ERR_MARKERS = ("reconnecting", "request timed out", "retrying", "stream disconnected")


def is_transient_error(msg: str) -> bool:
    m = (msg or "").lower()
    return any(k in m for k in TRANSIENT_ERR_MARKERS)


def iter_events(jsonl: Path):
    if not jsonl.exists():
        return
    with jsonl.open("r", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                # partial trailing line during a live write; skip
                continue


def _item_type(ev: dict) -> str | None:
    it = ev.get("item")
    if isinstance(it, dict):
        return it.get("type")
    return None


def _short(text, n: int = 140) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


def render_item(it: dict) -> str:
    """Best-effort one-line rendering of an item.* payload. Item sub-shapes vary
    by codex version; we pick the most informative known field, else fall back."""
    t = it.get("type", "item")
    if t == "agent_message":
        return "💬 " + _short(it.get("text", ""))
    if t == "reasoning":
        return "… " + _short(it.get("text") or it.get("summary") or "")
    if t == "command_execution":
        c = it.get("command") or it.get("cmd") or it.get("text") or ""
        ec = it.get("exit_code")
        suffix = f" (exit={ec})" if ec is not None else ""
        return "⚙ $ " + _short(c, 120) + suffix
    if t == "file_change":
        path = it.get("path") or it.get("file")
        if not path and isinstance(it.get("changes"), list):
            paths = [c.get("path") for c in it["changes"] if isinstance(c, dict)]
            path = ", ".join(p for p in paths if p) or f"{len(it['changes'])} change(s)"
        return "✎ " + _short(str(path or "file change"), 120)
    if t == "mcp_tool_call":
        name = it.get("tool") or it.get("name") or it.get("server") or "tool"
        return "🔧 " + _short(str(name), 80)
    if t == "web_search":
        return "🔎 " + _short(str(it.get("query") or it.get("text") or ""), 100)
    if t == "todo_list":
        return "🗒 plan update"
    return f"• {t}"


def aggregate(meta: dict) -> dict:
    jsonl = Path(meta["jsonl"])
    agg = {
        "thread_id": None,
        "turns_started": 0,
        "turns_completed": 0,
        "turns_failed": 0,
        "out_tokens": 0,
        "in_tokens": 0,
        "cached_tokens": 0,
        "items": {},  # item.type -> count
        "transient": 0,
        "errors": [],  # real (non-transient) error/failure messages
        "last": None,  # compact last-event string
    }
    for ev in iter_events(jsonl):
        t = ev.get("type")
        if t == "thread.started":
            agg["thread_id"] = ev.get("thread_id")
            agg["last"] = "thread started"
        elif t == "turn.started":
            agg["turns_started"] += 1
            agg["last"] = "▶ turn started"
        elif t == "turn.completed":
            agg["turns_completed"] += 1
            u = ev.get("usage") or {}
            agg["out_tokens"] += int(u.get("output_tokens") or 0)
            agg["in_tokens"] = int(u.get("input_tokens") or agg["in_tokens"])
            agg["cached_tokens"] = int(u.get("cached_input_tokens") or agg["cached_tokens"])
            agg["last"] = f"✓ turn done (out={u.get('output_tokens')})"
        elif t == "turn.failed":
            agg["turns_failed"] += 1
            msg = ((ev.get("error") or {}).get("message")) if isinstance(ev.get("error"), dict) else ev.get("error")
            msg = msg or ev.get("message") or "turn failed"
            agg["errors"].append(str(msg))
            agg["last"] = f"✗ TURN FAILED: {_short(msg, 80)}"
        elif t in ("item.completed", "item.started", "item.updated"):
            it = ev.get("item") or {}
            itype = it.get("type", "item")
            if t == "item.completed":
                agg["items"][itype] = agg["items"].get(itype, 0) + 1
            agg["last"] = render_item(it)
        elif t == "error":
            msg = ev.get("message") or ""
            if is_transient_error(msg):
                agg["transient"] += 1
                agg["last"] = f"⚠ retry: {_short(msg, 60)}"
            else:
                agg["errors"].append(str(msg))
                agg["last"] = f"⚠ error: {_short(msg, 80)}"
    return agg


def read_done(meta: dict) -> dict | None:
    p = Path(meta["done_file"])
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def jsonl_mtime(meta: dict) -> float | None:
    """Wall-clock mtime of the job's JSONL = time of its last emitted event.
    Used as the staleness proxy for stuck detection (codex --json events carry
    no timestamps, but every event line bumps the file mtime)."""
    try:
        return Path(meta["jsonl"]).stat().st_mtime
    except OSError:
        return None


def pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _git_changed_files(cwd: str) -> set[str]:
    """Tracked-modified + staged + untracked-not-ignored paths (relative to cwd).
    The union of what a job could have touched, for the allowed-files fence."""
    files: set[str] = set()
    for sub in (["diff", "--name-only"], ["diff", "--cached", "--name-only"],
                ["ls-files", "--others", "--exclude-standard"]):
        try:
            out = subprocess.run(["git", "-C", cwd, *sub], capture_output=True, text=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            continue
        for line in out.stdout.splitlines():
            line = line.strip()
            if line:
                files.add(line)
    return files


def out_of_fence(meta: dict) -> list[str]:
    """Files this job changed that fall OUTSIDE its allowed_files globs. Empty
    when no fence is set. Subtracts the worktree's pre-existing dirty set so only
    THIS job's edits are judged."""
    allowed = meta.get("allowed_files") or []
    if not allowed:
        return []
    changed = _git_changed_files(meta["cwd"]) - set(meta.get("pre_dirty") or [])
    return [f for f in sorted(changed) if not any(fnmatch.fnmatch(f, pat) for pat in allowed)]


def job_state(meta: dict, done: dict | None) -> str:
    if done is not None:
        if done.get("timeout"):
            return "timeout"
        if done.get("stopped"):
            return "stopped"
        return "done" if done.get("exit") == 0 else f"failed({done.get('exit')})"
    if pid_alive(meta.get("pid")):
        return "running"
    return "dead"  # pid gone but no done sentinel -> crashed/killed


def fmt_elapsed(secs: float) -> str:
    secs = int(secs)
    if secs < 60:
        return f"{secs}s"
    if secs < 3600:
        return f"{secs // 60}m{secs % 60:02d}s"
    return f"{secs // 3600}h{(secs % 3600) // 60:02d}m"


# ----------------------------------------------------------------------------
# durable outcome ledger (the evaluation / self-improvement substrate)
# ----------------------------------------------------------------------------
# One JSONL record per FINISHED job, appended to a file OUTSIDE the ephemeral
# run dirs so it survives `tmp` cleanup and accumulates across runs/projects.
# Populated by `watch`, `run --wait`, and the explicit `ledger` sweep. Idempotent
# via a per-job O_EXCL sentinel so concurrent recorders never double-write.


def ledger_path() -> Path:
    env = os.environ.get("CODEX_PAR_LEDGER")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".codex-par" / "ledger.jsonl"


def _build_ledger_entry(meta: dict, run: Path, done: dict | None, state: str) -> dict:
    agg = aggregate(meta)
    start = meta.get("start")
    start = start if isinstance(start, (int, float)) else 0
    end = (done or {}).get("end") or jsonl_mtime(meta) or start
    end = end if isinstance(end, (int, float)) else 0
    elapsed = int(end - start) if (end and start) else None
    return {
        "ts": int(end) if end else None,
        "run": run.name,
        "label": meta.get("label"),
        "cwd": meta.get("cwd"),
        "sandbox": meta.get("sandbox"),
        "model": meta.get("model"),
        "effort": meta.get("effort"),
        "timeout_min": meta.get("timeout_min"),
        "state": state,
        "exit": (done or {}).get("exit"),
        "elapsed_s": elapsed,
        "out_tokens": agg["out_tokens"],
        "in_tokens": agg["in_tokens"],
        "cached_tokens": agg["cached_tokens"],
        "turns_completed": agg["turns_completed"],
        "turns_started": agg["turns_started"],
        "items": agg["items"],
        "transient_retries": agg["transient"],
        "out_of_fence": len(out_of_fence(meta)),
        "thread_id": agg["thread_id"],
    }


def record_ledger_entry(meta: dict, run: Path) -> bool:
    """Append a ledger record for a finished job. Idempotent (O_EXCL sentinel).
    Returns True if a new record was written."""
    done = read_done(meta)
    state = job_state(meta, done)
    if state == "running":
        return False  # not terminal yet
    sentinel = run / f"{meta.get('label', 'job')}.ledgered"
    try:
        fd = os.open(str(sentinel), os.O_CREAT | os.O_WRONLY | os.O_EXCL)
        os.close(fd)
    except FileExistsError:
        return False  # already ledgered (this run dir)
    except OSError:
        return False
    entry = _build_ledger_entry(meta, run, done, state)
    led = ledger_path()
    try:
        led.parent.mkdir(parents=True, exist_ok=True)
        with led.open("a") as fh:  # O_APPEND single small write -> atomic on POSIX
            fh.write(json.dumps(entry) + "\n")
    except OSError:
        return False
    return True


# ----------------------------------------------------------------------------
# status
# ----------------------------------------------------------------------------


def load_metas(run: Path) -> list[dict]:
    metas = []
    for mp in sorted(run.glob("*.meta.json")):
        try:
            metas.append(json.loads(mp.read_text()))
        except (json.JSONDecodeError, OSError):
            continue
    return metas


def cmd_status(args: argparse.Namespace) -> int:
    run = resolve_run_dir(args.dir)
    if not run.exists():
        raise SystemExit(f"run dir not found: {run}")
    metas = load_metas(run)
    if not metas:
        print(f"(no jobs in {run})")
        return 0

    rows = []
    summary = {"running": 0, "done": 0, "failed": 0, "dead": 0, "stalled": 0, "out_of_fence": 0, "out_tokens": 0}
    now = time.time()
    stuck_after = args.stuck_after
    for meta in metas:
        agg = aggregate(meta)
        done = read_done(meta)
        state = job_state(meta, done)
        if state != "running":
            record_ledger_entry(meta, run)  # idempotent; keeps the durable ledger filled even without watch/--wait
        end = done.get("end") if done else now
        elapsed = fmt_elapsed(end - meta.get("start", now))
        # staleness: a running job whose JSONL has not grown is the "stuck" signal
        idle = None
        if state == "running":
            mt = jsonl_mtime(meta)
            idle = now - mt if mt else now - meta.get("start", now)
        stalled = idle is not None and idle >= stuck_after
        key = "failed" if state.startswith("failed") or state == "dead" else state
        summary[key if key in summary else "failed"] = summary.get(key, 0) + 1
        if state == "dead":
            summary["dead"] += 1
        if stalled:
            summary["stalled"] += 1
        summary["out_tokens"] += agg["out_tokens"]
        items = agg["items"]
        item_str = "/".join(
            f"{items.get(k, 0)}{abbr}"
            for k, abbr in (
                ("command_execution", "cmd"),
                ("file_change", "file"),
                ("mcp_tool_call", "mcp"),
                ("web_search", "web"),
            )
            if items.get(k)
        ) or "-"
        fence = out_of_fence(meta)
        if fence:
            summary["out_of_fence"] += 1
        rows.append(
            {
                "meta": meta,
                "agg": agg,
                "state": state,
                "elapsed": elapsed,
                "item_str": item_str,
                "idle": idle,
                "stalled": stalled,
                "fence": fence,
            }
        )

    if args.json:
        out = []
        for r in rows:
            out.append(
                {
                    "label": r["meta"]["label"],
                    "state": r["state"],
                    "elapsed": r["elapsed"],
                    "thread_id": r["agg"]["thread_id"],
                    "turns": [r["agg"]["turns_completed"], r["agg"]["turns_started"]],
                    "out_tokens": r["agg"]["out_tokens"],
                    "in_tokens": r["agg"]["in_tokens"],
                    "items": r["agg"]["items"],
                    "transient_retries": r["agg"]["transient"],
                    "errors": r["agg"]["errors"],
                    "last": r["agg"]["last"],
                    "idle_secs": round(r["idle"], 1) if r["idle"] is not None else None,
                    "stalled": r["stalled"],
                    "out_of_fence": r["fence"],
                }
            )
        print(json.dumps({"run": str(run), "summary": summary, "jobs": out}, indent=2))
        return 0

    print(f"RUN {run}")
    print(
        f"{'LABEL':<22} {'STATE':<11} {'ELAPSED':<8} {'TURNS':<6} "
        f"{'OUT_TOK':<8} {'ITEMS':<16} LAST"
    )
    print("-" * 110)
    for r in rows:
        agg = r["agg"]
        turns = f"{agg['turns_completed']}/{agg['turns_started']}"
        retry = f" [{agg['transient']}r]" if agg["transient"] else ""
        last = _short((agg["last"] or "-") + retry, 44)
        if r["stalled"]:
            last += f"  ⚠STUCK? idle {int(r['idle'])}s"
        elif r["idle"] is not None:
            last += f"  (idle {int(r['idle'])}s)"
        if r["fence"]:
            last += f"  ⚠FENCE:{len(r['fence'])}"
        print(
            f"{r['meta']['label']:<22} {r['state']:<11} {r['elapsed']:<8} {turns:<6} "
            f"{agg['out_tokens']:<8} {r['item_str']:<16} {last}"
        )
        if args.verbose and agg["errors"]:
            for e in agg["errors"][:5]:
                print(f"    ! {_short(e, 100)}")
        if args.verbose and r["fence"]:
            for f in r["fence"][:8]:
                print(f"    ⚠ out-of-fence: {f}")
    print("-" * 110)
    stalled_str = f" · {summary['stalled']} ⚠STALLED" if summary["stalled"] else ""
    fence_str = f" · {summary['out_of_fence']} ⚠OUT-OF-FENCE" if summary["out_of_fence"] else ""
    print(
        f"summary: {summary['running']} running · {summary['done']} done · "
        f"{summary['failed']} failed · {summary['dead']} dead{stalled_str}{fence_str} · "
        f"{summary['out_tokens']} out tokens total"
    )
    return 0


# ----------------------------------------------------------------------------
# watch (streaming, for the Monitor tool)
# ----------------------------------------------------------------------------

# Only these high-signal events are streamed (reasoning + transient retries are
# suppressed so the orchestrator does not drown). Coverage includes every
# terminal signal (turn.completed / turn.failed / job exit / real error) so
# silence genuinely means "still working", per Monitor's "silence is not
# success" rule.
WATCH_ITEM_TYPES = {"command_execution", "file_change", "mcp_tool_call", "web_search", "agent_message"}


def _watch_line(ev: dict) -> str | None:
    t = ev.get("type")
    if t == "turn.started":
        return "▶ turn started"
    if t == "turn.completed":
        u = ev.get("usage") or {}
        return f"✓ turn done · out={u.get('output_tokens')} in={u.get('input_tokens')}"
    if t == "turn.failed":
        err = ev.get("error")
        msg = err.get("message") if isinstance(err, dict) else (err or ev.get("message") or "turn failed")
        return f"✗ TURN FAILED: {_short(msg, 100)}"
    if t in ("item.completed", "item.started"):
        it = ev.get("item") or {}
        if it.get("type") in WATCH_ITEM_TYPES:
            prefix = "" if t == "item.completed" else "(start) "
            return prefix + render_item(it)
        return None
    if t == "error":
        msg = ev.get("message") or ""
        if is_transient_error(msg):
            return None  # suppress reconnect noise
        return f"⚠ error: {_short(msg, 100)}"
    return None


def cmd_watch(args: argparse.Namespace) -> int:
    run = resolve_run_dir(args.dir)
    if not run.exists():
        raise SystemExit(f"run dir not found: {run}")

    poll = args.poll
    stuck_after = args.stuck_after
    offsets: dict[str, int] = {}
    buffers: dict[str, str] = {}
    done_emitted: set[str] = set()
    last_activity: dict[str, float] = {}
    stall_warned: set[str] = set()
    started = time.time()

    def metas_now() -> list[dict]:
        return load_metas(run)

    print(f"[watch] {run}", flush=True)
    while True:
        now = time.time()
        metas = metas_now()
        labels = [m["label"] for m in metas]
        for meta in metas:
            label = meta["label"]
            last_activity.setdefault(label, now)
            jp = Path(meta["jsonl"])
            if not jp.exists():
                continue
            try:
                size = jp.stat().st_size
            except OSError:
                continue
            off = offsets.get(label, 0)
            if size < off:  # truncated/rotated
                off = 0
            if size > off:
                last_activity[label] = now
                stall_warned.discard(label)  # re-arm: progress resumed
                with jp.open("r", errors="replace") as fh:
                    fh.seek(off)
                    chunk = fh.read()
                    offsets[label] = fh.tell()
                data = buffers.get(label, "") + chunk
                lines = data.split("\n")
                buffers[label] = lines.pop()  # keep partial tail
                for line in lines:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    rendered = _watch_line(ev)
                    if rendered:
                        print(f"{label}: {rendered}", flush=True)
            # emit terminal exit once
            if label not in done_emitted:
                done = read_done(meta)
                if done is not None:
                    code = done.get("exit")
                    mark = "⏱" if done.get("timeout") else ("✅" if code == 0 else "❌")
                    extra = " (TIMEOUT)" if done.get("timeout") else ""
                    print(f"{label}: {mark} EXITED code={code}{extra}", flush=True)
                    fence = out_of_fence(meta)
                    if fence:
                        print(f"{label}: ⚠ OUT-OF-FENCE — {len(fence)} file(s) outside allowed: {', '.join(fence[:5])}", flush=True)
                    record_ledger_entry(meta, Path(run))
                    done_emitted.add(label)
                # stall warning: running job whose JSONL has gone quiet too long.
                # One-shot per episode (re-arms when new data arrives above).
                elif label not in stall_warned and (now - last_activity[label]) >= stuck_after:
                    if pid_alive(meta.get("pid")):
                        idle = int(now - last_activity[label])
                        print(f"{label}: ⚠ idle {idle}s — possibly stuck (pid {meta.get('pid')} alive, no new events)", flush=True)
                        stall_warned.add(label)

        # natural end: every known job has exited
        if labels and all(lb in done_emitted for lb in labels):
            print(f"[watch] all {len(labels)} job(s) finished after {fmt_elapsed(time.time()-started)}", flush=True)
            if not args.forever:
                return 0
        time.sleep(poll)


# ----------------------------------------------------------------------------
# result / list
# ----------------------------------------------------------------------------


def cmd_result(args: argparse.Namespace) -> int:
    run = resolve_run_dir(args.dir)
    last = run / f"{args.label}.last.md"
    if not last.exists():
        # fall back to the agent_message item if -o file is missing
        meta_p = run / f"{args.label}.meta.json"
        if meta_p.exists():
            meta = json.loads(meta_p.read_text())
            msgs = [
                ev["item"]["text"]
                for ev in iter_events(Path(meta["jsonl"]))
                if _item_type(ev) == "agent_message" and ev.get("item", {}).get("text")
            ]
            if msgs:
                print(msgs[-1])
                return 0
        raise SystemExit(f"no result for '{args.label}' in {run}")
    sys.stdout.write(last.read_text())
    return 0


def _terminate_group(pid: int, grace: float = 3.0) -> bool:
    """SIGTERM the job's process group, escalating to SIGKILL after `grace`s.
    Targeting the group (the wrapper is its session/group leader thanks to
    start_new_session=True) takes down codex + any shell commands it spawned;
    a bare kill on the wrapper pid would orphan them. Returns True if it died on
    SIGTERM, False if SIGKILL was required."""
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        return True
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    deadline = time.time() + grace
    while time.time() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.2)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return False


def cmd_stop(args: argparse.Namespace) -> int:
    run = resolve_run_dir(args.dir)
    if not run.exists():
        raise SystemExit(f"run dir not found: {run}")
    metas = load_metas(run)
    if args.label:
        metas = [m for m in metas if m["label"] == args.label]
        if not metas:
            raise SystemExit(f"no job '{args.label}' in {run}")
    for meta in metas:
        label = meta["label"]
        pid = meta.get("pid")
        if read_done(meta) is not None:
            print(f"{label}: already finished — nothing to stop")
            continue
        if not isinstance(pid, int) or not pid_alive(pid):
            print(f"{label}: not running (pid {pid} gone)")
            continue
        killed_hard = not _terminate_group(pid, grace=args.grace)
        # write a stop sentinel so status/watch report it deterministically as
        # 'stopped' rather than 'dead'. thread_id (if captured) enables resume.
        agg = aggregate(meta)
        try:
            Path(meta["done_file"]).write_text(
                json.dumps({"exit": -int(signal.SIGTERM), "end": int(time.time()), "stopped": True}) + "\n"
            )
        except OSError:
            pass
        how = "SIGKILL (escalated)" if killed_hard else "SIGTERM"
        resume = f"  resume: codex exec resume {agg['thread_id']}" if agg.get("thread_id") else ""
        print(f"{label}: stopped via {how} (pid {pid}){resume}")
    return 0


# ----------------------------------------------------------------------------
# gate (content-diff "no NEW errors vs baseline" — the tsc/pyright gate)
# ----------------------------------------------------------------------------

# strip line:col coordinates so a diagnostic's identity is file+code+message,
# not its position (which shifts as unrelated edits move lines).
_COORD_RE = re.compile(r"\(\d+,\d+\)|:\d+:\d+")


def _normalize_diag(text: str, error_pattern: str) -> set[str]:
    pat = re.compile(error_pattern)
    out: set[str] = set()
    for line in text.splitlines():
        s = line.strip()
        if not s or not pat.search(s):
            continue
        out.add(_COORD_RE.sub("", s))
    return out


def cmd_gate(args: argparse.Namespace) -> int:
    """Run a check command (tsc/pyright/lint) and compare its diagnostics to a
    baseline by CONTENT — PASS only when there are ZERO new error signatures.
    This is the correct TS/type gate: pre-existing errors live in the baseline so
    they never trap the agent; a file-name grep (the wrong gate) does. Reusable
    for any line-oriented checker via --cmd / --error-pattern."""
    cwd = args.cwd or os.getcwd()
    proc = subprocess.run(args.cmd, shell=True, cwd=cwd, capture_output=True, text=True)
    current_raw = (proc.stdout or "") + (proc.stderr or "")
    baseline = Path(args.baseline).expanduser() if args.baseline else None

    if args.capture:
        if not baseline:
            raise SystemExit("--capture requires --baseline <file>")
        baseline.write_text(current_raw)
        n = len(_normalize_diag(current_raw, args.error_pattern))
        print(f"baseline captured -> {baseline}  ({n} diagnostic signature(s); check exit={proc.returncode})")
        return 0

    base_raw = ""
    if baseline and baseline.exists():
        base_raw = baseline.read_text()
    elif baseline:
        print(f"⚠ baseline {baseline} missing — treating ALL current diagnostics as NEW", file=sys.stderr)

    base_set = _normalize_diag(base_raw, args.error_pattern)
    cur_set = _normalize_diag(current_raw, args.error_pattern)
    new = sorted(cur_set - base_set)
    if new:
        print(f"FAIL: {len(new)} NEW error signature(s) vs baseline (check exit={proc.returncode}):")
        for line in new[:50]:
            print(f"  + {line}")
        if len(new) > 50:
            print(f"  … +{len(new) - 50} more")
        return 2
    print(f"PASS: 0 new error signatures (baseline={len(base_set)}, current={len(cur_set)}; check exit={proc.returncode})")
    return 0


def cmd_audit(args: argparse.Namespace) -> int:
    """Report files each job changed that fall OUTSIDE its allowed_files fence."""
    run = resolve_run_dir(args.dir)
    if not run.exists():
        raise SystemExit(f"run dir not found: {run}")
    metas = load_metas(run)
    if args.label:
        metas = [m for m in metas if m["label"] == args.label]
    any_bad = False
    for meta in metas:
        if not (meta.get("allowed_files")):
            print(f"{meta['label']}: (no fence — allowed_files not set)")
            continue
        bad = out_of_fence(meta)
        if bad:
            any_bad = True
            print(f"{meta['label']}: ⚠ {len(bad)} OUT-OF-FENCE (allowed: {meta['allowed_files']}):")
            for f in bad:
                print(f"    {f}")
        else:
            print(f"{meta['label']}: ✓ in fence")
    return 2 if any_bad else 0


def _state_bucket(state: str) -> str:
    return "failed" if state.startswith("failed") else state


def _print_ledger_stats(rows: list[dict], led: Path) -> None:
    print(f"LEDGER {led}  ({len(rows)} job record(s))")
    if not rows:
        return
    states = Counter(_state_bucket(str(r.get("state", "?"))) for r in rows)
    print("  by state : " + " · ".join(f"{k}={v}" for k, v in sorted(states.items())))
    tos = sum(1 for r in rows if r.get("state") == "timeout")
    fence = sum(int(r.get("out_of_fence") or 0) for r in rows)
    tot_out = sum(int(r.get("out_tokens") or 0) for r in rows)
    els = [r["elapsed_s"] for r in rows if isinstance(r.get("elapsed_s"), int)]
    mean_el = int(sum(els) / len(els)) if els else 0
    print(f"  totals   : timeouts={tos} · out-of-fence files={fence} · out_tokens={tot_out} · mean elapsed={mean_el}s")

    def group(key: str) -> dict[str, list[dict]]:
        g: dict[str, list[dict]] = {}
        for r in rows:
            g.setdefault(str(r.get(key) or "default"), []).append(r)
        return g

    for dim in ("sandbox", "model"):
        print(f"  by {dim}:")
        for k, grp in sorted(group(dim).items()):
            to = sum(1 for r in grp if r.get("state") == "timeout")
            gels = [r["elapsed_s"] for r in grp if isinstance(r.get("elapsed_s"), int)]
            me = int(sum(gels) / len(gels)) if gels else 0
            ot = sum(int(r.get("out_tokens") or 0) for r in grp)
            print(f"    {k:<24} n={len(grp):<4} timeout={to:<3} mean_elapsed={me}s  out_tokens={ot}")


def cmd_ledger(args: argparse.Namespace) -> int:
    led = ledger_path()

    if args.show is not None or args.stats:
        if not led.exists():
            print(f"(no ledger yet at {led})")
            return 0
        rows = [json.loads(line) for line in led.read_text().splitlines() if line.strip()]
        if args.stats:
            _print_ledger_stats(rows, led)
        else:
            n = args.show or 20
            for r in rows[-n:]:
                print(json.dumps(r))
        return 0

    # sweep mode: record finished-but-not-yet-ledgered jobs
    if args.all:
        base = base_dir()
        runs = [p for p in base.iterdir() if p.is_dir()] if base.exists() else []
    else:
        run = resolve_run_dir(args.dir)
        if not run.exists():
            raise SystemExit(f"run dir not found: {run}")
        runs = [run]
    added = 0
    for run in runs:
        for meta in load_metas(run):
            if record_ledger_entry(meta, run):
                added += 1
    print(f"recorded {added} new entry(ies) -> {led}")
    return 0


def cmd_list(_args: argparse.Namespace) -> int:
    base = base_dir()
    if not base.exists():
        print(f"(no runs under {base})")
        return 0
    runs = sorted([p for p in base.iterdir() if p.is_dir()], key=lambda p: p.stat().st_mtime, reverse=True)
    if not runs:
        print(f"(no runs under {base})")
        return 0
    for r in runs:
        metas = load_metas(r)
        n_done = sum(1 for m in metas if read_done(m) is not None)
        print(f"{r.name:<28} {len(metas)} job(s), {n_done} finished   {r}")
    return 0


# ----------------------------------------------------------------------------
# cli
# ----------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="codex_par", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("run", help="launch one or more codex exec jobs (detached)")
    pr.add_argument("--spec", help="path to a jobs JSON spec, or '-' for stdin")
    pr.add_argument("--dir", help="run dir (path or bare run-id under base); default tmp/codex-par/run-<epoch>")
    pr.add_argument("--wait", action="store_true", help="block until all jobs finish, then print status")
    # single-job convenience flags
    pr.add_argument("--label", default="job1")
    pr.add_argument("--cwd", default=os.getcwd())
    pr.add_argument("--sandbox", default=DEFAULT_SANDBOX, choices=SANDBOXES)
    pr.add_argument("--model", default=None)
    pr.add_argument("--effort", default=None)
    pr.add_argument("--prompt", default=None)
    pr.add_argument("--prompt-file", default=None)
    pr.add_argument("--config", action="append", help="extra raw -c key=value (repeatable)")
    pr.add_argument("--no-skip-git-check", action="store_true", help="do NOT pass --skip-git-repo-check")
    pr.add_argument("--allowed", action="append", help="allowed-file glob the job may touch (repeatable); enables fence audit")
    pr.add_argument("--timeout-min", type=float, default=None, dest="timeout_min",
                    help="hard wall-clock cap in minutes (auto-stop runaway job)")
    pr.set_defaults(func=cmd_run)

    ps = sub.add_parser("status", help="compact per-job digest")
    ps.add_argument("dir", nargs="?", help="run dir (default: newest under base)")
    ps.add_argument("--json", action="store_true")
    ps.add_argument("--verbose", action="store_true", help="also print real error messages")
    ps.add_argument("--stuck-after", type=float, default=120.0, dest="stuck_after",
                    help="flag a running job as ⚠STUCK if its JSONL has been idle this many seconds (default 120)")
    ps.set_defaults(func=cmd_status)

    pw = sub.add_parser("watch", help="stream high-signal events (for the Monitor tool)")
    pw.add_argument("dir", nargs="?", help="run dir (default: newest under base)")
    pw.add_argument("--poll", type=float, default=1.0, help="poll interval seconds (default 1.0)")
    pw.add_argument("--forever", action="store_true", help="keep following after all jobs finish")
    pw.add_argument("--stuck-after", type=float, default=120.0, dest="stuck_after",
                    help="emit a one-shot stall warning if a running job's JSONL goes idle this many seconds (default 120)")
    pw.set_defaults(func=cmd_watch)

    prs = sub.add_parser("result", help="print a job's final agent message")
    prs.add_argument("label")
    prs.add_argument("dir", nargs="?")
    prs.set_defaults(func=cmd_result)

    pst = sub.add_parser("stop", help="terminate running job(s) + their process group")
    pst.add_argument("dir", nargs="?", help="run dir (default: newest under base)")
    pst.add_argument("--label", help="single job label to stop (default: all running jobs)")
    pst.add_argument("--grace", type=float, default=3.0, help="seconds to wait after SIGTERM before SIGKILL")
    pst.set_defaults(func=cmd_stop)

    pg = sub.add_parser("gate", help="content-diff check gate: PASS only on zero NEW errors vs baseline (tsc/pyright)")
    pg.add_argument("--cwd", help="dir to run the check in (default: cwd)")
    pg.add_argument("--cmd", required=True, help="check command, e.g. 'npx tsc -p tsconfig.app.json' or 'pyright'")
    pg.add_argument("--baseline", help="baseline file (captured at Phase 1b); compared by content")
    pg.add_argument("--capture", action="store_true", help="write the current check output to --baseline and exit")
    pg.add_argument("--error-pattern", default=r"error TS\d+|error:", dest="error_pattern",
                    help=r"regex selecting diagnostic lines (default matches tsc 'error TS\\d+' and pyright 'error:')")
    pg.set_defaults(func=cmd_gate)

    pa = sub.add_parser("audit", help="report files each job changed outside its allowed_files fence")
    pa.add_argument("dir", nargs="?", help="run dir (default: newest under base)")
    pa.add_argument("--label", help="single job label (default: all jobs)")
    pa.set_defaults(func=cmd_audit)

    plg = sub.add_parser("ledger", help="append finished-job outcome records to a durable ledger; --show/--stats to read")
    plg.add_argument("dir", nargs="?", help="run dir to sweep (default newest); ignored with --all/--show/--stats")
    plg.add_argument("--all", action="store_true", help="sweep all run dirs under base")
    plg.add_argument("--show", nargs="?", type=int, const=20, help="print last N raw ledger entries (default 20)")
    plg.add_argument("--stats", action="store_true", help="aggregate stats over the ledger (state/timeout/tokens by sandbox+model)")
    plg.set_defaults(func=cmd_ledger)

    pl = sub.add_parser("list", help="list run dirs under the base dir")
    pl.set_defaults(func=cmd_list)
    return p


def _resolve_default_dir(args: argparse.Namespace) -> None:
    """For status/watch with no dir, default to the newest run under base."""
    if getattr(args, "dir", None):
        return
    base = base_dir()
    if not base.exists():
        return
    runs = sorted([p for p in base.iterdir() if p.is_dir()], key=lambda p: p.stat().st_mtime, reverse=True)
    if runs:
        args.dir = str(runs[0])


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd in ("status", "watch", "stop", "audit"):
        _resolve_default_dir(args)
    elif args.cmd == "ledger" and not (args.all or args.show is not None or args.stats):
        _resolve_default_dir(args)
    # restore default SIGPIPE so piping `status` into head/grep doesn't traceback
    try:
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    except (ValueError, AttributeError):
        pass
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
