export interface TranslatorAccessCredentials {
    streamId: string;
    token: string;
}

/**
 * Reads the credentials from a translator access link's URL fragment
 * (`#s=<streamId>&t=<token>`). They live in the fragment so the browser never sends them to a
 * server. Returns null unless both parts are present.
 */
export function readTranslatorAccessFromHash(hash: string): TranslatorAccessCredentials | null {
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    const streamId = params.get('s')?.trim();
    const token = params.get('t')?.trim();
    return streamId && token ? { streamId, token } : null;
}

/** Removes the fragment so the token does not stay in the address bar or history entry. */
export function clearLocationHash(): void {
    window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search,
    );
}
