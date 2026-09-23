import QrScanner from 'qr-scanner';

export interface QrScannerHandle {
    start(): Promise<void>;
    destroy(): void;
}

export interface CreateQrScannerOptions {
    video: HTMLVideoElement;
    onScan(value: string): void;
}

export type QrScannerErrorKind = 'permission-denied' | 'not-available';

export type QrScannerError = Error & {
    readonly kind: QrScannerErrorKind;
};

export function normalizeQrScannerError(error: unknown): QrScannerError {
    if (isQrScannerError(error)) {
        return error;
    }

    const name = errorName(error);
    const message = errorMessage(error);
    const searchable = `${name} ${message}`.toLowerCase();
    const kind: QrScannerErrorKind =
        name === 'NotAllowedError' ||
        name === 'SecurityError' ||
        (name !== 'NotFoundError' && /permission|denied|not.?allowed|security/.test(searchable))
            ? 'permission-denied'
            : 'not-available';
    const normalized = new Error(message || 'Camera not available.') as QrScannerError;
    normalized.name = 'QrScannerError';
    Object.defineProperty(normalized, 'kind', { enumerable: true, value: kind });
    return normalized;
}

export function createQrScanner({ video, onScan }: CreateQrScannerOptions): QrScannerHandle {
    const scanner = new QrScanner(video, (result) => onScan(result.data), {
        preferredCamera: 'environment',
        maxScansPerSecond: 12,
        highlightScanRegion: true,
        highlightCodeOutline: true,
        returnDetailedScanResult: true,
    });

    return {
        async start() {
            try {
                await scanner.start();
            } catch (error) {
                throw normalizeQrScannerError(error);
            }
        },
        destroy() {
            scanner.destroy();
        },
    };
}

function isQrScannerError(error: unknown): error is QrScannerError {
    return (
        error instanceof Error &&
        (error as Partial<QrScannerError>).name === 'QrScannerError' &&
        ((error as Partial<QrScannerError>).kind === 'permission-denied' ||
            (error as Partial<QrScannerError>).kind === 'not-available')
    );
}

function errorName(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'name' in error) {
        return String(error.name);
    }
    return '';
}

function errorMessage(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'message' in error) {
        return String(error.message);
    }
    return String(error);
}
