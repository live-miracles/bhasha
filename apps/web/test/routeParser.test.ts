import { describe, expect, it } from 'vitest';

import { parseRoute } from '../src/routes/routeParser';

describe('parseRoute', () => {
    it('matches the admin route before slug routes', () => {
        expect(parseRoute('/admin')).toEqual({ type: 'admin' });
    });

    it('matches listener routes with a decoded program slug', () => {
        expect(parseRoute('/patna-event-2026')).toEqual({
            type: 'listener',
            programSlug: 'patna-event-2026',
        });
    });

    it('matches translator routes with a decoded program slug', () => {
        expect(parseRoute('/patna-event-2026/translate')).toEqual({
            type: 'translator',
            programSlug: 'patna-event-2026',
        });
    });

    it('matches volunteer routes with a decoded program slug', () => {
        expect(parseRoute('/patna-event-2026/volunteer')).toEqual({
            type: 'volunteer',
            programSlug: 'patna-event-2026',
        });
        expect(parseRoute('/patna%20event%202026/volunteer')).toEqual({
            type: 'volunteer',
            programSlug: 'patna event 2026',
        });
    });

    it('keeps the one-segment volunteer path as a listener slug', () => {
        expect(parseRoute('/volunteer')).toEqual({
            type: 'listener',
            programSlug: 'volunteer',
        });
    });

    it('decodes percent-encoded slugs', () => {
        expect(parseRoute('/patna%20event%202026')).toEqual({
            type: 'listener',
            programSlug: 'patna event 2026',
        });
    });

    it('returns notFound for extra path segments', () => {
        expect(parseRoute('/patna-event-2026/translate/extra')).toEqual({
            type: 'notFound',
        });
        expect(parseRoute('/missing/path')).toEqual({ type: 'notFound' });
    });
});
