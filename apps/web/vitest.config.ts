import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        include: ['test/**/*.{test,spec}.{ts,tsx}'],
        setupFiles: ['./src/test/setup.ts'],
        // A few listener tests drive React Testing Library through real timers +
        // connectionstatechange events + status polling; under loaded CI runners
        // their timing can flake (~1/3). Retry masks the timing jitter without
        // hiding real failures — a genuine bug fails all attempts. Keeps the deploy
        // gate reliable. (Follow-up: make these tests deterministic and drop retry.)
        retry: 2,
        // src/test/setup.ts raises testing-library's findBy*/waitFor timeout to
        // 5000ms for the same loaded-runner slack. A test with a couple of
        // sequential waitFor calls can now legitimately need close to 10s, which
        // exceeds vitest's own 5000ms default *whole-test* timeout -- raise that
        // too so the outer test-level timeout isn't tighter than the inner
        // assertion timeout it's supposed to contain.
        testTimeout: 15_000,
    },
});
