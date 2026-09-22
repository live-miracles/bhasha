import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // Several admin/translator/volunteer auth suites run real PBKDF2-HMAC-
    // SHA-256 (100,000 iterations) derivations per login/seed call. Running
    // many test files in parallel (Vitest's default) puts real CPU
    // contention on those derivations, which can push a single test well
    // past the 5s default under load even though it's fast in isolation.
    // Give tests real headroom rather than tuning down parallelism (and
    // therefore wall-clock suite time) to compensate.
    testTimeout: 20000
  }
});
