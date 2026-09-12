#!/usr/bin/env bash
# codex-par-health.sh — OS-level 12h ledger health report (systemd user timer driven).
#
# Runs independently of any Claude session (the session won't be open for weeks).
# Reads the DURABLE ledger (~/.codex-par/ledger.jsonl, written at dispatch time by
# codex_par.py's watch / run --wait / status) and:
#   - appends a timestamped `ledger --stats` snapshot to a rolling log
#   - refreshes latest.txt (so a later Claude session can read the newest findings)
#   - best-effort desktop notification if something is actionable (timeouts / out-of-fence)
#
# It does NOT sweep ephemeral per-project run dirs (those live under each project's
# gitignored tmp/ and are wiped) — the durable ledger is the source of truth.
set -uo pipefail

SCRIPT="${CODEX_PAR_SCRIPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/codex_par.py}"
HEALTH_DIR="${CODEX_PAR_HEALTH:-$HOME/.codex-par/health}"
LOG="$HEALTH_DIR/ledger-health.log"
LATEST="$HEALTH_DIR/latest.txt"
mkdir -p "$HEALTH_DIR"

TS="$(date '+%Y-%m-%d %H:%M:%S %Z')"
STATS="$(python3 "$SCRIPT" ledger --stats 2>&1)"

{
  echo "===== $TS ====="
  echo "$STATS"
  echo
} >> "$LOG"
printf '# %s\n%s\n' "$TS" "$STATS" > "$LATEST"

# Quick actionable check parsed from the stats "totals" line.
to="$(printf '%s\n' "$STATS" | grep -oE 'timeouts=[0-9]+' | grep -oE '[0-9]+' | head -1)"
fence="$(printf '%s\n' "$STATS" | grep -oE 'out-of-fence files=[0-9]+' | grep -oE '[0-9]+' | head -1)"
to="${to:-0}"; fence="${fence:-0}"

if command -v notify-send >/dev/null 2>&1; then
  if [ "$to" -gt 0 ] 2>/dev/null || [ "$fence" -gt 0 ] 2>/dev/null; then
    notify-send "codex_par ledger" "actionable: timeouts=$to out-of-fence=$fence — see $LATEST" 2>/dev/null || true
  fi
fi

echo "$TS  ledger health written -> $LOG (timeouts=$to out-of-fence=$fence)"
