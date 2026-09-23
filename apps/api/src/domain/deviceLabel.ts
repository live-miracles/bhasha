export const DEVICE_LABELS = [
    'Edge on Windows',
    'Chrome on iPhone',
    'Chrome on iPad',
    'Chrome on Windows',
    'Chrome on macOS',
    'Chrome on Android',
    'Firefox on Windows',
    'Safari on iPhone',
    'Safari on iPad',
    'Safari on macOS',
    'Unknown device',
] as const;

export function deviceLabelFromUserAgent(ua: string | null): string {
    if (!ua || ua.trim() === '') {
        return DEVICE_LABELS[10];
    }

    const normalized = ua.toLowerCase();

    const isEdge = normalized.includes('edg/') || normalized.includes('edge/');
    if (isEdge && normalized.includes('windows')) {
        return DEVICE_LABELS[0];
    }

    const isIPhone = normalized.includes('iphone') || normalized.includes('ipod');
    const isIPad =
        normalized.includes('ipad') ||
        (normalized.includes('macintosh') && normalized.includes('touch'));
    const isAndroid = normalized.includes('android');
    const isWindows = normalized.includes('windows');
    const isMac = normalized.includes('macintosh') || normalized.includes('mac os x');
    const isFirefox = normalized.includes('firefox');
    const isChrome =
        normalized.includes('chrome/') ||
        normalized.includes('crios/') ||
        normalized.includes('chrome');
    const isSafari =
        (normalized.includes('safari/') || normalized.includes('safari')) && !isChrome && !isEdge;

    if (isChrome && isIPhone) {
        return DEVICE_LABELS[1];
    }

    if (isChrome && isIPad) {
        return DEVICE_LABELS[2];
    }

    if (isChrome && isWindows) {
        return DEVICE_LABELS[3];
    }

    if (isChrome && isMac) {
        return DEVICE_LABELS[4];
    }

    if (isChrome && isAndroid) {
        return DEVICE_LABELS[5];
    }

    if (isFirefox && isWindows) {
        return DEVICE_LABELS[6];
    }

    if (isSafari && isIPhone) {
        return DEVICE_LABELS[7];
    }

    if (isSafari && isIPad) {
        return DEVICE_LABELS[8];
    }

    if (isSafari && isMac) {
        return DEVICE_LABELS[9];
    }

    return DEVICE_LABELS[10];
}
