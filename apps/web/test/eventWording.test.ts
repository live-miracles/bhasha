import { describe, expect, it } from 'vitest';

import type { AdminEventFeedEntry } from '../src/api/admin';
import { eventWording } from '../src/features/admin/reports/eventWording';

function entry(eventType: string, options: Partial<AdminEventFeedEntry> = {}): AdminEventFeedEntry {
    return {
        id: 'event_1',
        eventType,
        occurredAt: '2026-06-21T10:00:00.000Z',
        stream: null,
        metadata: {},
        translatorName: null,
        translatorDeviceLabel: null,
        ...options,
    };
}

describe('eventWording', () => {
    it.each([
        [
            'translator_connected',
            entry('translator_connected', { translatorName: 'Anita' }),
            'Anita connected',
        ],
        [
            'translator_disconnected',
            entry('translator_disconnected', {
                translatorName: 'Anita',
                metadata: { reason: 'network_lost' },
            }),
            'Anita disconnected',
        ],
        ['listener_left without reason', entry('listener_left'), 'Listener left'],
        [
            'listener_left with reason',
            entry('listener_left', { metadata: { reason: 'tab_closed' } }),
            'Listener left — tab_closed',
        ],
        ['listener_switched', entry('listener_switched'), 'Listener switched language'],
        ['listener_reconnected', entry('listener_reconnected'), 'Listener reconnected'],
        [
            'connection_failed for translator',
            entry('connection_failed', {
                translatorName: 'Anita',
                metadata: { reason: 'ice_failed' },
            }),
            'Connection failed — Anita',
        ],
        [
            'connection_failed for listener without reason',
            entry('connection_failed'),
            'Listener connection failed',
        ],
        [
            'connection_failed for listener with reason',
            entry('connection_failed', { metadata: { reason: 'ice_failed' } }),
            'Listener connection failed — ice_failed',
        ],
        ['unknown event', entry('future_event'), 'future_event'],
    ])('%s', (_label, input, expected) => {
        expect(eventWording(input)).toBe(expected);
    });

    describe('legacy event rows (no longer written)', () => {
        it.each([
            ['audio_started', entry('audio_started'), 'Audio started'],
            ['audio_stopped', entry('audio_stopped'), 'Audio stopped'],
            ['listener_subscribed', entry('listener_subscribed'), 'Listener connected'],
        ])('%s', (_label, input, expected) => {
            expect(eventWording(input)).toBe(expected);
        });
    });
});
