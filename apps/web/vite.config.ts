import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Playwright e2e suite (apps/web/e2e/*.spec.ts) mocks the backend's HTTP
// endpoints but cannot mock LiveKit's own WebSocket signaling protocol (see
// apps/web/e2e/support/fakeLivekitClient.ts for the full rationale). Its
// webServer command (apps/web/playwright.config.ts) builds with
// E2E_FAKE_LIVEKIT=1 set, which substitutes the real `livekit-client`
// package for a lightweight double so `Room.connect()`/`publishTrack()`
// resolve without a real transport. Unset (every other build/dev/preview),
// this is a no-op.
const useFakeLiveKit = process.env.E2E_FAKE_LIVEKIT === "1";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: useFakeLiveKit
      ? [
          {
            find: "livekit-client",
            replacement: path.resolve(
              __dirname,
              "e2e/support/fakeLivekitClient.ts"
            )
          }
        ]
      : []
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787"
    }
  }
});
