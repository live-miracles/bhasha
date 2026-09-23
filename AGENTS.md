# Repository Instructions

## Project Context

This repo is for a browser-based live translation service for events.

Core product principle:

> One translator publishes. Thousands of people listen.

The system is voice-only. Translators publish microphone audio. Participants are listen-only and must never receive audio/video publishing permissions.

Before planning or implementing product work, read:

- `docs/Requirements.pdf` (original product brief — note its suggested tech stack is
  Cloudflare-based and predates the migration described below)
- `docs/architecture.md`

Use those files as the product and architecture source of truth unless the user gives newer written instructions.

Current stack decision (migrated off Cloudflare — see `docs/archive/` for the pre-migration
Cloudflare Workers/D1/Durable Objects/Realtime docs, kept for historical context):

- React + Vite frontend (`apps/web`), built to static `dist/` and served by the API process.
- Node.js + Hono for the API (`apps/api`).
- better-sqlite3 (one WAL-mode SQLite file) for durable program, stream, translator, listener, and event-log data.
- In-process presence, driven by self-hosted LiveKit's webhooks, for live per-program/per-stream presence and active listener counts.
- Self-hosted LiveKit (one room per language stream) for voice-only audio distribution; LiveKit's built-in TURN server for connection fallback.
- Docker Compose (app + LiveKit + Caddy) for deployment.

Local LiveKit/session-secret credential material must live outside the repository. Treat it as secret material: verify existence when needed, but do not print, copy into repo files, or commit its contents.

## Documentation Lookup

When working with libraries, frameworks, SDKs, APIs, CLI tools, or cloud services, fetch current documentation before answering or implementing.

Use the `ctx7` CLI:

1. Resolve the library first:
   `npx ctx7@latest library "<official library name>" "<user question>"`
2. Fetch docs using the selected `/org/project` ID:
   `npx ctx7@latest docs <libraryId> "<user question>"`

Do not rely on memory for API syntax, LiveKit server-sdk/client-sdk behavior, better-sqlite3 behavior, auth libraries, or deployment tooling (Docker Compose, Caddy).

## Engineering Workflow

Follow a TDD-based workflow for feature and bug-fix work when practical: reproduce the issue or write a failing test first, make the smallest scoped change, then run the relevant tests and type checks. Keep changes reviewable and avoid unrelated refactors.

Claude Code and Codex are both supported as primary implementation and review agents for this repository. The developer may choose either based on preference and task fit. The active agent should inspect the relevant code and documentation, state important assumptions, use the repository's normal editing conventions, and report verification results clearly. Do not delegate routine work merely to satisfy a process rule; delegate when parallel research, an isolated implementation slice, or an independent review will materially improve the result.

If the repo is not initialized as a git repository, do not claim that code was committed. Report that commit steps are blocked until git is initialized or the correct git root is provided. Do not create commits unless the user requests a commit or the active task explicitly requires one.

For optional long-running Claude Code delegation, use the repo-local Claude harness:

```bash
python3 scripts/claude_run.py start --name "<short-name>" --task "<task-profile>" --wait --prompt "<task>"
python3 scripts/claude_run.py status
python3 scripts/claude_run.py list
python3 scripts/claude_run.py wait
```

Task profiles map to Claude Opus 4.8 with fixed effort defaults:
`architect` -> `xhigh`, `code-review` -> `high`, `implementation` -> `medium`,
and `ba` -> `medium`. The harness stores raw Claude logs under `.claude-runs/`
and keeps normal status checks compact. Prefer `start --wait` for delegated
work so the harness, not the orchestrator, handles progress monitoring and
obstacle detection. Default wait output is one line immediately, one line every
two minutes while Claude is still working, and one final finished/stuck line.
Use `--progress changes` only for debugging. Multiple Claude tasks can run in
parallel; each has an isolated `.claude-runs/<run-id>/` directory. For detached
runs, keep and pass the returned run id to `status`, `wait`, `tail`, or `stop`.
See `docs/claude-run-harness.md`.

## Codex Parallel Execution (optional)

For independent slices or reviews, the local harness
`scripts/codex_par.py` can drive multiple independent `codex exec` processes.
Use it when parallelism or isolation helps; direct Codex work is the default.
The codex-companion broker is a per-workspace singleton, while this harness
spawns an independent process per job.

Split:

- **Codex (`python3 scripts/codex_par.py` → `codex exec`)**: slice
  implementation (in a worktree), adversarial diff review, scoped test runs,
  Playwright E2E authoring.
- **Top-level agent**: owns scope, git state, verification, and the final
  handoff. Independently re-verify delegated results before accepting them.
- **Fallback**: if a delegated job fails or stalls, finish the slice directly
  or use the other agent's harness. Never block the task on delegation
  availability.

Subcommands:

- `run` — single `--prompt`, or `--spec jobs.json` for parallel fan-out;
  returns a RUNDIR immediately.
- `status <rundir>` — one compact line per job (state, elapsed, tokens, last
  event); flags a job idle ≥120s as `⚠STUCK`, and out-of-fence edits as `⚠FENCE`.
- `watch <rundir>` — high-signal event stream; point the Monitor tool at it
  (exits when every job finishes).
- `result <label> <rundir>` — a job's final agent message.
- `stop <rundir> [--label X]` — clean process-group kill; resume via
  `codex exec resume <thread_id>` (thread_id is in the JSONL and `stop` output).
- `gate` — content-diff `tsc` gate: PASS only on zero NEW errors vs a baseline.
- `audit <rundir>` — files each job changed outside its `allowed_files` fence.

Rules:

- **Default sandbox is `danger-full-access`** (`DEFAULT_SANDBOX` in
  `scripts/codex_par.py`). Stricter modes block vitest, which writes
  `node_modules/.vite-temp` — a symlink that points outside the worktree cwd, so
  workspace-write rejects it and the test suite can't run. Full access means
  there is no OS sandbox: jobs can read/write/exec/network anywhere. Pass
  `--sandbox read-only` (or `"sandbox": "read-only"` in a spec) for read-only
  review/diagnose legs that don't need to write.
- **Parallel writers need worktree-per-job isolation** (a shared tree corrupts
  concurrent edits). Parallel readers (review/diagnose/research) are safe in one
  tree.
- **Hard-fence every prompt**: absolute worktree path (codex_par paths must be
  absolute), allowed-file list, exact test commands, output format. Free-range
  prompts stall.
- **This repo is TypeScript on both ends** (`apps/api` Node.js/Hono, `apps/web`
  React) — there is NO pyright. For TS/FE slices the dispatched agent MUST run
  `tsc` itself (the sandbox's vitest strips types, so vitest-green ≠ type-clean).
  Gate criterion = `codex_par.py gate --cwd <wt> --cmd "npm run typecheck
--workspace apps/web" --baseline <f>` content-diff (zero NEW errors), NEVER a
  filename grep. `--capture` the baseline before dispatch.
- **Test commands to hand the agent**: `npm test --workspace apps/web` /
  `--workspace apps/api` (vitest), `npm run e2e --workspace apps/web`
  (Playwright). Keep TDD red/green: failing test first.
- **Fence check before accepting changes**: set `allowed_files` globs in the spec, then run
  `codex_par.py audit <rundir>` (or read the `⚠FENCE` flag in status/watch). If
  violated, stop and correct the job scope before accepting the result.
- **Review legs**: verify a non-empty diff in the correct worktree; do not
  assume a delegated report is sufficient.
- **Keep git with the top-level agent.** Tell delegated agents to skip commits,
  rebases, resets, and other history-changing operations. The top-level Codex
  or Claude agent owns any requested commit.
- **GitNexus note**: this repo is indexed (alias `translation`) and `codex exec`
  may load the gitnexus MCP from `~/.codex/config.toml`, but this AGENTS.md has
  no gitnexus rules block, so there is no "MUST run impact" mandate for the
  dispatched agent to override (unlike the audio repo). The orchestrator owns
  impact/gate decisions.
- **Big-file × many-task → timeout.** Set `timeout_min` in the spec, batch ≤3–4
  tasks (never 7), and instruct targeted `sed -n 'A,Bp'` range reads (never
  whole-file) of large files. 2 strikes → escalate to an Opus
  `senior-fullstack-dev`.

Run artifacts land in `tmp/codex-par/` (gitignored); the durable cross-run
ledger is `~/.codex-par/ledger.jsonl`. Codex authentication is managed outside
the repository.

## Codex Working Rules

- Start with a concise progress update when tool work is needed, and keep the user informed during long-running work.
- Read `docs/Requirements.pdf` and `docs/architecture.md` before planning or implementing product work. For library, SDK, API, CLI, or deployment questions, use the current documentation lookup process above rather than relying on memory.
- Prefer `rg`/`rg --files` for repository searches. Use `apply_patch` for local edits. Preserve unrelated user changes in a dirty worktree.
- Use the least powerful tool that can safely complete the task. Read-only investigation does not require delegation or a worktree.
- For direct implementation by Claude Code or Codex, run the narrowest relevant tests first, then type checks and broader checks when appropriate. The canonical workspace commands are:
  `npm test --workspace apps/web`, `npm test --workspace apps/api`,
  `npm run typecheck --workspace apps/web`,
  `npm run typecheck --workspace apps/api`, and
  `npm run e2e --workspace apps/web`.
- Never print, copy, commit, or place LiveKit/session secrets in repository files. Verify only that required secret material exists outside the repository.
- Do not use destructive commands such as `git reset --hard`, broad recursive deletion, or overwriting unrelated files without explicit authorization.
- Before handing off, summarize changed files, tests/checks run, known limitations, and any exact blocker. Include clickable local file links when useful.

## Optional Cross-Agent Delegation

The repo-local Claude and Codex harnesses are available for tasks that benefit from a separate model or long-running background work. Keep git operations with the top-level agent: delegated agents should skip commits and other history-rewriting operations. Inspect delegated changes, rerun relevant checks independently, and do not treat a delegated report as verification by itself.

## Feature Workflow

For a feature request, adapt the depth to the risk and size of the change:

1. Inspect the requirements, architecture, relevant code, and current worktree state.
2. Create a concise implementation plan for non-trivial work.
3. Use a failing test first when behavior is testable, then implement the smallest complete slice.
4. Run focused tests and type checks; run broader regression or end-to-end checks when the change affects integration boundaries, realtime behavior, authentication, or mobile UX.
5. For larger or higher-risk changes, obtain an independent architecture or code review, either directly or through an isolated delegated agent.
6. Address review findings, re-run verification, and report any blocker precisely.
7. Commit only when requested or explicitly required by the task.

## Bug-Fix Workflow

For a bug fix:

1. Reproduce the failure and identify the likely cause before editing.
2. Add or update a regression test and verify it fails when feasible.
3. Implement the focused fix and verify the regression test passes.
4. Run relevant type checks and broader tests as warranted by the affected surface.
5. Use an independent review for security-sensitive, realtime, persistence, or cross-client changes.
6. Commit only when requested or explicitly required by the task.

## Product Guardrails

- Admins can manage programs, language streams, translator access, QR codes, stream status, and listener counts.
- Translators can authenticate, select an assigned language stream, publish microphone audio, mute/unmute, and reconnect.
- Participants can open `/{program_id}`, choose a live language, listen, switch language streams, and reconnect.
- Listener clients must be receive-only.
- Use short-lived server-generated credentials/tokens (LiveKit access tokens) for realtime access.
- Do not count a listener token/request as active. Active listener counts begin only after the listener is connected/subscribed.
- For listener reporting, store listener IP address and user agent only as authenticated admin operational telemetry. Do not write IP data on heartbeats.
- Treat mobile browser behavior as a first-class constraint: audio starts only after a user tap, reconnect controls must remain visible, and iPhone Safari plus Android Chrome must be tested before real events.
- A stream is "Live" only when the translator is connected, an audio track is published, and recent audio activity is detected.
