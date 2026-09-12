import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  cloudflareTest,
  readD1Migrations
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const adminTestPassword = `test-admin-password-${randomUUID()}`;
const adminSessionSecret = `test-admin-session-secret-${randomUUID()}`;
const adminPasswordHash = `sha256:${createHash("sha256")
  .update(adminTestPassword + adminSessionSecret)
  .digest("hex")}`;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(__dirname, "migrations");
      const migrations = await readD1Migrations(migrationsPath);

      return {
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_TEST_PASSWORD: adminTestPassword,
            ADMIN_PASSWORD_HASH: adminPasswordHash,
            ADMIN_SESSION_SECRET: adminSessionSecret,
            CLOUDFLARE_REALTIME_APP_ID: "test-realtime-app",
            CLOUDFLARE_REALTIME_APP_SECRET: "test-realtime-secret",
            CLOUDFLARE_REALTIME_BASE_URL: "https://rtc.test/v1",
            TRANSLATOR_PASSWORD_PEPPER: `test-translator-password-pepper-${randomUUID()}`,
            TRANSLATOR_SESSION_SECRET: `test-translator-session-secret-${randomUUID()}`,
            VOLUNTEER_SESSION_SECRET: `test-volunteer-session-secret-${randomUUID()}`
          }
        },
        wrangler: {
          configPath: "./wrangler.jsonc"
        }
      };
    })
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"]
  }
});
