export type InAppBrowserDetectionResult = {
    isInApp: boolean;
    app?: string;
};

const APP_MARKERS: Array<{ marker: string; app: string }> = [
    { marker: 'FBAN', app: 'Facebook' },
    { marker: 'FBAV', app: 'Facebook' },
    { marker: 'FB_IAB', app: 'Facebook' },
    { marker: 'Instagram', app: 'Instagram' },
    { marker: 'Line', app: 'Line' },
    { marker: 'WhatsApp', app: 'WhatsApp' },
    { marker: 'WeChat', app: 'WeChat' },
    { marker: 'MicroMessenger', app: 'WeChat' },
    { marker: 'Snapchat', app: 'Snapchat' },
    { marker: 'Twitter', app: 'Twitter' },
    { marker: 'TwitterAndroid', app: 'Twitter' },
];

export function detectInAppBrowser(
    ua: string = navigator.userAgent,
    hasRTCPeerConnection: boolean = typeof RTCPeerConnection !== 'undefined',
): InAppBrowserDetectionResult {
    const normalized = ua.toLowerCase();
    const detected = APP_MARKERS.find(({ marker }) => normalized.includes(marker.toLowerCase()));
    if (detected) {
        return { isInApp: true, app: detected.app };
    }

    if (hasRTCPeerConnection === false) {
        return { isInApp: true };
    }

    return { isInApp: false };
}
