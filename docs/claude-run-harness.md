# Claude Run Harness

This repo exposes the shared KT Claude Code long-task harness at:

```bash
python3 scripts/claude_run.py
```

Use it when a Codex session needs to delegate a long implementation, review, or
exploration task to Claude without flooding the Codex context with raw
`stream-json` output.

Start a run:

```bash
python3 scripts/claude_run.py start \
  --name "mvp-slice-review" \
  --task code-review \
  --wait \
  --prompt "Review the current translation MVP plan and identify implementation risks."
```

Use task profiles when Codex delegates work to Claude:

- `--task architect`: Opus 4.8 with `xhigh` effort
- `--task code-review`: Opus 4.8 with `high` effort
- `--task implementation`: Opus 4.8 with `medium` effort
- `--task ba`: Opus 4.8 with `medium` effort

Aliases include `architect-review`, `review`, `implement`, `code-implementation`,
`business-analyst`, and `business-analysis`. Explicit `--model` or `--effort`
flags still override the task profile for one-off cases.

Check progress:

```bash
python3 scripts/claude_run.py status
python3 scripts/claude_run.py list
python3 scripts/claude_run.py wait
```

Use `start --wait` when an orchestrator should launch Claude and remain attached
until the run succeeds, fails, stops, stalls, or surfaces an obstacle. Use
`wait <run-id>` to attach to an already-started run. The default wait mode prints
one compact heartbeat line immediately, then every two minutes while Claude is
still working, plus one final line when Claude finishes or gets stuck. Callers do
not need shell polling loops.

Each run gets its own unique directory under `.claude-runs/`, with an id like
`20260621-101500-review-a1b2c3d4`. Multiple Claude tasks can run in parallel
without sharing state. `start --wait` always follows the run it just created; for
detached runs, capture the printed run id and pass it to `status`, `wait`,
`tail`, or `stop`.

Wait tuning:

```bash
python3 scripts/claude_run.py wait --update-interval 120
python3 scripts/claude_run.py wait --progress silent
python3 scripts/claude_run.py wait --progress changes
python3 scripts/claude_run.py wait --final-status
```

Use `--progress changes` only for debugging; it prints on every visible state
change. Use `--final-status` when the detailed multi-line status dump is needed.

Inspect logs only when needed:

```bash
python3 scripts/claude_run.py tail --kind stderr --lines 40
python3 scripts/claude_run.py tail --kind debug --lines 40
python3 scripts/claude_run.py tail --kind stream --lines 20
```

Stop the latest run:

```bash
python3 scripts/claude_run.py stop
```

The raw run data is stored under `.claude-runs/`, which is intentionally
gitignored. The `status` command summarizes the run state, Claude session id,
task/model/effort, elapsed time, recent event types, final or latest assistant
text, recent tool names, and files changed since the run started. The status
and wait paths classify common obstacles such as API errors, auth errors, rate
limits, network errors, stale workers, and process failures.

This file is a wrapper around:

```text
<path-to-harness>/scripts/claude_run.py
```
