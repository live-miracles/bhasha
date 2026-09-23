import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Default findBy*/waitFor timeout (1000ms) is tuned for an idle machine. Under
// a fully loaded CI/parallel-worker run (many jsdom+React test files racing
// for CPU), some real-timer-driven assertions can legitimately need longer to
// settle even though nothing is actually broken. Give them more slack instead
// of masking the flake with retries (see vitest.config.ts).
configure({ asyncUtilTimeout: 5000 });

if (!globalThis.MediaStream) {
    class TestMediaStream {
        private tracks: MediaStreamTrack[] = [];

        addTrack(track: MediaStreamTrack) {
            this.tracks.push(track);
        }

        removeTrack(track: MediaStreamTrack) {
            this.tracks = this.tracks.filter((existing) => existing !== track);
        }

        getTracks() {
            return this.tracks;
        }
    }

    Object.defineProperty(globalThis, 'MediaStream', {
        configurable: true,
        value: TestMediaStream,
    });
}
