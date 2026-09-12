#!/usr/bin/env bash
#
# set-access-control-secrets.sh
# ---------------------------------------------------------------------------
# Stages the two Cloudflare Worker secrets the listener-access-control go-live
# needs, BEFORE `gh workflow run Deploy` (multi-tenant rollout runbook §2 + the
# access-control S6.6 step).
#
#   1. VOLUNTEER_SESSION_SECRET  (NEW — this feature)
#         HMAC salt for volunteer_session cookies. Fail-closed: every volunteer
#         route returns 503 until this is set. The value is a server-side salt —
#         no human ever needs to know it. Rotating it just logs out volunteers.
#         Generated here with a CSPRNG; never printed, never stored.
#
#   2. PLATFORM_ADMIN_EMAIL      (multi-tenant rollout, runbook §2)
#         Read by POST /api/admin/bootstrap to resolve/create the platform_admin.
#         Harmless on today's Worker (it doesn't read it); persists across deploy.
#
# SAFETY:
#   - Touches PRODUCTION secrets. Prompts for explicit confirmation first.
#   - Does NOT deploy, migrate, or bootstrap — only sets the two secrets.
#   - Idempotent: re-running overwrites the same secrets (a new
#     VOLUNTEER_SESSION_SECRET logs out any volunteers; fine pre-go-live).
#   - Never echoes the volunteer secret; passes it via stdin, not argv.
#
# USAGE:
#   ./scripts/deploy/set-access-control-secrets.sh
#   PLATFORM_ADMIN_EMAIL=someone@example.com ./scripts/deploy/set-access-control-secrets.sh
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="apps/api/wrangler.jsonc"
DEFAULT_ADMIN_EMAIL="admin@example.com"

cd "$REPO_ROOT"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: $CONFIG not found (run from the bhasha repo root)." >&2
  exit 1
fi

# --- resolve the platform-admin email -------------------------------------
ADMIN_EMAIL="${PLATFORM_ADMIN_EMAIL:-}"
if [[ -z "$ADMIN_EMAIL" ]]; then
  read -r -p "PLATFORM_ADMIN_EMAIL [$DEFAULT_ADMIN_EMAIL]: " ADMIN_EMAIL
  ADMIN_EMAIL="${ADMIN_EMAIL:-$DEFAULT_ADMIN_EMAIL}"
fi
if [[ ! "$ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  echo "ERROR: '$ADMIN_EMAIL' does not look like an email address." >&2
  exit 1
fi

# --- confirm (this writes to PROD) ----------------------------------------
cat <<EOF

About to set TWO production Worker secrets on config: $CONFIG
  • VOLUNTEER_SESSION_SECRET  = <freshly generated 48-byte random, not shown>
  • PLATFORM_ADMIN_EMAIL      = $ADMIN_EMAIL

This does NOT deploy or migrate — it only stages the secrets.
EOF
read -r -p "Proceed? [y/N] " CONFIRM
if [[ "${CONFIRM,,}" != "y" && "${CONFIRM,,}" != "yes" ]]; then
  echo "Aborted. No secrets were changed."
  exit 0
fi

# --- generate the volunteer session secret with a CSPRNG -------------------
if command -v openssl >/dev/null 2>&1; then
  VOLUNTEER_SESSION_SECRET="$(openssl rand -hex 48)"
else
  # Node is always available in this repo; fall back to its CSPRNG.
  VOLUNTEER_SESSION_SECRET="$(node -e 'process.stdout.write(require("crypto").randomBytes(48).toString("hex"))')"
fi

# --- set the secrets (values via stdin, never argv/logs) -------------------
echo
echo "→ Setting VOLUNTEER_SESSION_SECRET ..."
printf '%s' "$VOLUNTEER_SESSION_SECRET" | npx wrangler secret put VOLUNTEER_SESSION_SECRET --config "$CONFIG"
unset VOLUNTEER_SESSION_SECRET

echo
echo "→ Setting PLATFORM_ADMIN_EMAIL ..."
printf '%s' "$ADMIN_EMAIL" | npx wrangler secret put PLATFORM_ADMIN_EMAIL --config "$CONFIG"

# --- verify ----------------------------------------------------------------
echo
echo "→ Current secrets on the prod Worker:"
npx wrangler secret list --config "$CONFIG" | grep -E "VOLUNTEER_SESSION_SECRET|PLATFORM_ADMIN_EMAIL|ADMIN_PASSWORD_HASH|ADMIN_SESSION_SECRET|TRANSLATOR_" || true

cat <<'EOF'

Done. Both secrets are staged. Next steps (multi-tenant rollout runbook):
  gh workflow run Deploy --ref main      # applies migrations 0017-0021 + deploys
  # then runbook §4-§6: backfill, bootstrap platform admin, set real admin password.
EOF
