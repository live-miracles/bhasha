export async function sha256Hex(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Formerly lived in the (now-deleted) relay/relayAuth.ts, which minted HMAC
// tokens for the Cloudflare-Realtime-specific StreamRelay Durable Object.
// This constant-time hex compare has nothing to do with the relay itself —
// it's shared, general-purpose auth plumbing — so it moved here rather than
// being deleted along with the relay.
export async function timingSafeEqualHex(a: string, b: string): Promise<boolean> {
    const maxLength = Math.max(a.length, b.length);
    let mismatch = 0;
    mismatch |= a.length ^ b.length;
    for (let i = 0; i < maxLength; i += 1) {
        const aCode = i < a.length ? a.charCodeAt(i) : 0;
        const bCode = i < b.length ? b.charCodeAt(i) : 0;
        mismatch |= aCode ^ bCode;
    }

    return mismatch === 0;
}
