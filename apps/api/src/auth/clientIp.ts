/**
 * Resolve the client address supplied by the trusted edge proxy.
 * The application must not be directly internet-facing; otherwise these
 * headers can be forged and should not be trusted for audit or throttling.
 */
export function clientIp(request: Request): string | null {
    const cloudflareIp = request.headers.get('CF-Connecting-IP')?.trim();
    if (cloudflareIp) {
        return cloudflareIp;
    }

    const forwardedFor = request.headers.get('X-Forwarded-For');
    const firstForwardedIp = forwardedFor?.split(',')[0]?.trim();
    return firstForwardedIp || null;
}
