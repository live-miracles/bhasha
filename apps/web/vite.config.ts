import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Playwright e2e suite (apps/web/e2e/*.spec.ts) mocks the backend's HTTP
// endpoints but cannot mock LiveKit's own WebSocket signaling protocol (see
// apps/web/e2e/support/fakeLivekitClient.ts for the full rationale). Its
// webServer command (apps/web/playwright.config.ts) builds with
// E2E_FAKE_LIVEKIT=1 set, which substitutes the real `livekit-client`
// package for a lightweight double so `Room.connect()`/`publishTrack()`
// resolve without a real transport. Unset (every other build/dev/preview),
// this is a no-op.
const useFakeLiveKit = process.env.E2E_FAKE_LIVEKIT === '1';

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: useFakeLiveKit
            ? [
                  {
                      find: 'livekit-client',
                      replacement: path.resolve(__dirname, 'e2e/support/fakeLivekitClient.ts'),
                  },
              ]
            : [],
    },
    server: {
        proxy: {
            '/api': process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8787',
        },
        // Docker Desktop's bind-mount filesystem events don't reliably reach the
        // container's Linux fs.watch on Windows (and WSL2 generally, per Vite's
        // own docs), so the dev server can silently keep serving stale
        // transforms after a host-side edit. Polling trades some CPU for
        // reliability; only enabled when explicitly opted into (see
        // docker-compose.dev.yml's `web` service). Omitted (rather than set to
        // null/undefined) so default watching is untouched otherwise.
        ...(process.env.VITE_WATCH_USE_POLLING === '1'
            ? { watch: { usePolling: true, interval: 300 } }
            : {}),
    },
});
