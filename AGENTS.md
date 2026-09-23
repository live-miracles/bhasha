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

Follow a TDD-based workflow for all feature and bug-fix work.

Prefer small, reviewable slices. Keep implementation scoped to the active request and avoid unrelated refactors.

If the repo is not initialized as a git repository, do not claim that code was committed. Report that commit steps are blocked until git is initialized or the correct git root is provided.

For long-running Claude Code delegation from Codex, use the repo-local harness:

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

## Codex Load-Split (token conservation)

The inverse delegation path: hand execution legs to Codex to conserve Claude
tokens. The local harness is `scripts/codex_par.py` (drives `codex exec`),
copied verbatim from the audio project. **Default Codex path = this harness, NOT
the codex-companion broker** — the broker is a per-workspace singleton that
serializes to one active turn, while the harness spawns an independent
`codex exec` process per job, giving true parallelism with no BUSY contention.

Split:

- **Codex (`python3 scripts/codex_par.py` → `codex exec`)**: slice
  implementation (in a worktree), adversarial diff review, scoped test runs,
  Playwright E2E authoring.
- **Top-level Claude**: orchestration + gates only. Independently re-verify
  Codex-reported results (scoped tests, zero-new-vs-baseline `tsc`) before
  committing.
- **Fallback**: if Codex fails (CLI absent, auth dead, quota, or a stall after
  one refenced retry), finish with the standard Claude agents. Never block a
  slice on Codex availability.

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
- **Fence check before commit**: set `allowed_files` globs in the spec, then run
  `codex_par.py audit <rundir>` (or read the `⚠FENCE` flag in status/watch). If
  violated, reset and re-fence.
- **Review legs**: commit first, then verify a non-empty diff — a staged-only
  review sees `main...HEAD` = empty and reports a false "clean".
- **Keep git with the orchestrator.** Under the default `danger-full-access`
  sandbox Codex CAN touch `.git`, so this is convention, not a sandbox guarantee:
  tell every agent "SKIP ALL git operations" and have the orchestrator
  reconstruct commits from the reported per-task file groups (single point of
  commit control).
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
ledger is `~/.codex-par/ledger.jsonl`. Codex auth shares `~/.codex/auth.json`.
Full contract: audio memory `project-codex-par-parallel-harness.md`.

## Feature Workflow

For any feature request:

1. Run two background-agent cycles to explore the request, product constraints, existing code, and likely implementation options.
2. Create an implementation plan.
3. Run an architect review in a background agent.
4. Fold the architect review inputs into the plan.
5. Implement using a background agent where practical.
6. Run tests and keep the workflow red/green: write failing tests first, then implement until tests pass.
7. Run a code review on the implementation using a background agent.
8. Fix code review findings using a background agent where practical.
9. Commit the completed work.
10. Run end-to-end tests or report the exact blocker if e2e cannot be run.

## Bug-Fix Workflow

For any bug fix:

1. First understand the cause of the bug using a background debugging agent.
2. Write tests that reproduce the bug.
3. Verify those tests fail before implementation.
4. Implement the fix.
5. Verify the tests pass.
6. Run code review.
7. Fix code review findings.
8. Commit the completed work.

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
