import { describe, expect, it } from 'vitest';

import { detectInAppBrowser } from '../src/routes/inAppBrowser';

describe('detectInAppBrowser', () => {
    it('detects Instagram in-app webviews', () => {
        const result = detectInAppBrowser(
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Instagram 309.0.0.41.117 Mobile/15E148 Safari/604.1',
        );

        expect(result).toEqual({ isInApp: true, app: 'Instagram' });
    });

    it('detects Facebook markers', () => {
        const result = detectInAppBrowser(
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/421.0.0.0.0;FB_IAB/Orca-Android]',
        );

        expect(result).toEqual({ isInApp: true, app: 'Facebook' });
    });

    it('detects WhatsApp in-app webviews', () => {
        const result = detectInAppBrowser(
            'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.0.0 Mobile Safari/537.36 WhatsApp/2.23.20.18',
        );

        expect(result).toEqual({ isInApp: true, app: 'WhatsApp' });
    });

    it('detects Line in-app webviews', () => {
        const result = detectInAppBrowser(
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Line/10.17.0',
        );

        expect(result).toEqual({ isInApp: true, app: 'Line' });
    });

    it('does not flag normal Safari and Chrome user agents', () => {
        const safari = detectInAppBrowser(
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
            true,
        );
        const chrome = detectInAppBrowser(
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.69 Safari/537.36',
            true,
        );

        expect(safari).toEqual({ isInApp: false });
        expect(chrome).toEqual({ isInApp: false });
    });

    it('flags missing WebRTC support as unsupported', () => {
        const result = detectInAppBrowser(
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)',
            false,
        );

        expect(result).toEqual({ isInApp: true });
    });
});
