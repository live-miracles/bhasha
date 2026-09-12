/**
 * Build-time feature flags. Vite statically inlines `import.meta.env.VITE_*`
 * at build time, so a disabled implementation can also tree-shake away.
 *
 * `VITE_USE_PARTYTRACKS` selects the realtime client implementation:
 *   - unset / "false" → hand-rolled Cloudflare SFU client (L1/L2). This is the
 *     default and the always-available fallback.
 *   - "true" → partytracks (Cloudflare's official Realtime client library).
 *
 * Flip it via the deploy workflow's web build step. See the migration plan
 * `greedy-waddling-snowflake.md` (Realtime → partytracks).
 */
export const usePartytracks: boolean =
  import.meta.env.VITE_USE_PARTYTRACKS === "true";
