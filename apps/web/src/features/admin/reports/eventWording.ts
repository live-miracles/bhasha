import type { AdminEventFeedEntry } from '../../../api/admin';

function translatorName(entry: AdminEventFeedEntry): string {
    return entry.translatorName ?? 'Translator';
}

function withReason(label: string, reason: string | undefined): string {
    return reason ? `${label} — ${reason}` : label;
}

export function eventWording(entry: AdminEventFeedEntry): string {
    switch (entry.eventType) {
        case 'translator_connected':
            return `${translatorName(entry)} connected`;
        case 'translator_disconnected':
            return `${translatorName(entry)} disconnected`;
        case 'audio_started':
            return 'Audio started';
        case 'audio_stopped':
            return 'Audio stopped';
        case 'listener_subscribed':
            return 'Listener connected';
        case 'listener_left':
            return withReason('Listener left', entry.metadata.reason);
        case 'listener_switched':
            return 'Listener switched language';
        case 'listener_reconnected':
            return 'Listener reconnected';
        case 'connection_failed':
            if (entry.translatorName) {
                return `Connection failed — ${entry.translatorName}`;
            }
            return withReason('Listener connection failed', entry.metadata.reason);
        default:
            return entry.eventType;
    }
}
