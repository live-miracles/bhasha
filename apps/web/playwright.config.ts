import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:4173",
    ...devices["Desktop Chrome"]
  },
  webServer: {
    // E2E_FAKE_LIVEKIT=1 activates vite.config.ts's alias that substitutes
    // `livekit-client` with e2e/support/fakeLivekitClient.ts for this build
    // only -- see that file for why a real Room can't be used against a
    // mocked (LiveKit-server-less) backend.
    command:
      "E2E_FAKE_LIVEKIT=1 npm run build && npm run preview -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false
  }
});
