import { describe, expect, it } from 'vitest';

import { parseRoute } from '../src/routes/routeParser';

describe('parseRoute', () => {
    it('matches the public landing page at the root', () => {
        expect(parseRoute('/')).toEqual({ type: 'landing' });
    });

    it('matches the management route before slug routes', () => {
        expect(parseRoute('/manage')).toEqual({ type: 'manage' });
    });

    it('does not reserve the removed admin route as a management route', () => {
        expect(parseRoute('/admin')).toEqual({ type: 'notFound' });
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

    it('matches approver routes with a decoded program slug', () => {
        expect(parseRoute('/patna-event-2026/approver')).toEqual({
            type: 'approver',
            programSlug: 'patna-event-2026',
        });
        expect(parseRoute('/patna%20event%202026/approver')).toEqual({
            type: 'approver',
            programSlug: 'patna event 2026',
        });
    });

    it('keeps the one-segment approver path as a listener slug', () => {
        expect(parseRoute('/approver')).toEqual({
            type: 'listener',
            programSlug: 'approver',
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
