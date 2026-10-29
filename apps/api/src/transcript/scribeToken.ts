// Mints the short-lived, single-use token the source console uses to open ElevenLabs'
// realtime speech-to-text WebSocket from the browser, so the API key never leaves the server.

export const SCRIBE_MODEL_ID = 'scribe_v2_realtime';
const SINGLE_USE_TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe';

export type ScribeTokenMinter = () => Promise<string>;

export function createScribeTokenMinter(
    apiKey: string,
    fetchImpl: typeof fetch = fetch,
): ScribeTokenMinter {
    return async () => {
        const response = await fetchImpl(SINGLE_USE_TOKEN_URL, {
            method: 'POST',
            headers: { 'xi-api-key': apiKey },
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
            throw new Error(`scribe_token_http_${response.status}`);
        }
        const body = (await response.json()) as { token?: unknown };
        if (typeof body.token !== 'string' || body.token.length === 0) {
            throw new Error('scribe_token_missing');
        }
        return body.token;
    };
}
