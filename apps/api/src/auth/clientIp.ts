/**
 * Resolve the client address supplied by the trusted edge proxy.
 *
 * The application must not be directly internet-facing; otherwise these headers can be
 * forged and should not be trusted for audit or throttling.
 *
 * Behind this deployment's Caddy, `X-Forwarded-For` is trustworthy: Caddy replaces any
 * value the client sent with the real connecting address (verified against the pinned
 * Caddy image). `CF-Connecting-IP` is NOT: Caddy forwards it untouched, so with DNS-only
 * (grey-cloud) Cloudflare any client can set it and pick its own "IP", which would defeat
 * every per-IP throttle. It is therefore ignored unless TRUST_CF_CONNECTING_IP=1, which
 * must only be set when all traffic really arrives through Cloudflare's proxy.
 */
export function clientIp(request: Request): string | null {
    if (process.env.TRUST_CF_CONNECTING_IP === '1') {
        const cloudflareIp = request.headers.get('CF-Connecting-IP')?.trim();
        if (cloudflareIp) {
            return cloudflareIp;
        }
    }

    const forwardedFor = request.headers.get('X-Forwarded-For');
    const firstForwardedIp = forwardedFor?.split(',')[0]?.trim();
    return firstForwardedIp || null;
}
