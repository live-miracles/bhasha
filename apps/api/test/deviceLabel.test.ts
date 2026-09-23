import { describe, expect, it } from 'vitest';
import { deviceLabelFromUserAgent } from '../src/domain/deviceLabel';

describe('deviceLabelFromUserAgent', () => {
    it.each([
        [
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/117.0.0.0 Mobile/15E148 Safari/604.1',
            'Chrome on iPhone',
        ],
        [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Chrome on Windows',
        ],
        [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Chrome on macOS',
        ],
        [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
            'Safari on macOS',
        ],
        [
            'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            'Safari on iPad',
        ],
        [
            'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/117.0.0.0 Mobile/15E148 Safari/604.1',
            'Chrome on iPad',
        ],
        [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0',
            'Firefox on Windows',
        ],
        [
            'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36',
            'Chrome on Android',
        ],
        [
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
            'Safari on iPhone',
        ],
        [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/117.0.0.0 Safari/537.36',
            'Edge on Windows',
        ],
        [null, 'Unknown device'],
        ['', 'Unknown device'],
        ['Totally random user agent string', 'Unknown device'],
    ] as const)('%s -> %s', (userAgent, expected) => {
        expect(deviceLabelFromUserAgent(userAgent)).toBe(expected);
    });
});
