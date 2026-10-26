import { clientIp } from '../auth/clientIp';
import { json } from '../http';

/**
 * In-memory token bucket, one bucket per key. State lives in this process only, like the
 * presence map, which is fine for the single-server deployment; a restart just resets the
 * buckets.
 */
export class RateLimiter {
    private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
    private readonly ratePerMs: number;
    private takes = 0;

    constructor(
        private readonly options: {
            limitPerMinute: number;
            burst: number;
            maxKeys?: number;
            now?: () => number;
        },
    ) {
        this.ratePerMs = options.limitPerMinute / 60_000;
    }

    take(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
        const now = this.options.now?.() ?? Date.now();
        const bucket = this.buckets.get(key);
        let tokens = this.options.burst;
        if (bucket) {
            tokens = Math.min(
                this.options.burst,
                bucket.tokens + (now - bucket.updatedAt) * this.ratePerMs,
            );
        }

        let result: { allowed: true } | { allowed: false; retryAfterSeconds: number };
        if (tokens >= 1) {
            tokens -= 1;
            result = { allowed: true };
        } else {
            result = {
                allowed: false,
                retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / this.ratePerMs / 1000)),
            };
        }

        // Re-insert so Map iteration order stays "least recently used first".
        this.buckets.delete(key);
        this.buckets.set(key, { tokens, updatedAt: now });
        this.takes += 1;
        if (this.takes % 500 === 0) {
            this.prune(now);
        }
        return result;
    }

    get size(): number {
        return this.buckets.size;
    }

    // Drop buckets that have refilled completely (indistinguishable from a fresh key), and cap
    // memory if a flood of distinct keys still gets past that.
    private prune(now: number): void {
        for (const [key, bucket] of this.buckets) {
            const refilled = bucket.tokens + (now - bucket.updatedAt) * this.ratePerMs;
            if (refilled >= this.options.burst) {
                this.buckets.delete(key);
            }
        }
        const maxKeys = this.options.maxKeys ?? 100_000;
        let excess = this.buckets.size - maxKeys;
        for (const key of this.buckets.keys()) {
            if (excess-- <= 0) {
                break;
            }
            this.buckets.delete(key);
        }
    }
}

export interface ListenerRateLimitConfig {
    /** Join-type requests (request/token/switch/reconnect/access) allowed per IP per minute. */
    ipPerMinute: number;
    /** Requests allowed per clientId or connectionId per minute. */
    subjectPerMinute: number;
}

// A venue's listeners usually share ONE public address (NAT). 1,000 people joining within a
// minute is roughly 2,000 join-type requests from that single IP, so the per-IP default has to
// clear that with room for retries, otherwise the audience would lock itself out at the
// start of an event. The per-IP layer only stops a single-source flood; the per-subject layer is
// what stops one client hammering the API. Set a value to 0 to disable that layer.
export const DEFAULT_LISTENER_RATE_LIMITS: ListenerRateLimitConfig = {
    ipPerMinute: 6000,
    subjectPerMinute: 30,
};

const JOIN_PATHS = new Set([
    '/api/listeners/request',
    '/api/listeners/token',
    '/api/listeners/switch',
    '/api/listeners/reconnect',
    '/api/listeners/access/claim',
    '/api/listeners/access/status',
]);

export class ListenerRateLimiter {
    private readonly ipLimiter: RateLimiter | null;
    private readonly subjectLimiter: RateLimiter | null;
    private lastLogAt = 0;
    private suppressed = 0;

    constructor(
        config: ListenerRateLimitConfig = DEFAULT_LISTENER_RATE_LIMITS,
        private readonly now: () => number = Date.now,
    ) {
        this.ipLimiter =
            config.ipPerMinute > 0
                ? new RateLimiter({
                      limitPerMinute: config.ipPerMinute,
                      burst: Math.ceil(config.ipPerMinute / 2),
                      now,
                  })
                : null;
        this.subjectLimiter =
            config.subjectPerMinute > 0
                ? new RateLimiter({
                      limitPerMinute: config.subjectPerMinute,
                      burst: Math.max(1, Math.ceil(config.subjectPerMinute / 2)),
                      now,
                  })
                : null;
    }

    /** Per-IP layer. Only join-type endpoints count; heartbeat/connected/leave are exempt. */
    checkRequest(request: Request, pathname: string): Response | null {
        if (!this.ipLimiter || !JOIN_PATHS.has(pathname)) {
            return null;
        }
        return this.respond(this.ipLimiter.take(`ip:${clientIp(request) ?? 'unknown'}`), 'ip');
    }

    /** Per-subject layer, keyed by a client-chosen id or a server-issued connection id. */
    checkSubject(kind: 'client' | 'connection', id: string): Response | null {
        if (!this.subjectLimiter) {
            return null;
        }
        return this.respond(this.subjectLimiter.take(`${kind}:${id}`), kind);
    }

    private respond(
        result: { allowed: true } | { allowed: false; retryAfterSeconds: number },
        layer: string,
    ): Response | null {
        if (result.allowed) {
            return null;
        }
        this.noteLimited(layer);
        return json(
            { error: 'rate_limited' },
            { status: 429, headers: { 'retry-after': String(result.retryAfterSeconds) } },
        );
    }

    // At most one log line every 10 seconds, so a flood cannot also flood the logs.
    private noteLimited(layer: string): void {
        const now = this.now();
        if (now - this.lastLogAt < 10_000) {
            this.suppressed += 1;
            return;
        }
        console.warn(
            JSON.stringify({
                level: 'warn',
                message: 'listener_rate_limited',
                layer,
                alsoLimitedSinceLastLog: this.suppressed,
            }),
        );
        this.lastLogAt = now;
        this.suppressed = 0;
    }
}

function parseLimit(value: string | undefined, fallback: number): number {
    if (value === undefined || value.trim() === '') {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function listenerRateLimitConfigFromEnv(env: {
    LISTENER_RATE_LIMIT_IP_PER_MIN?: string | undefined;
    LISTENER_RATE_LIMIT_SUBJECT_PER_MIN?: string | undefined;
}): ListenerRateLimitConfig {
    return {
        ipPerMinute: parseLimit(
            env.LISTENER_RATE_LIMIT_IP_PER_MIN,
            DEFAULT_LISTENER_RATE_LIMITS.ipPerMinute,
        ),
        subjectPerMinute: parseLimit(
            env.LISTENER_RATE_LIMIT_SUBJECT_PER_MIN,
            DEFAULT_LISTENER_RATE_LIMITS.subjectPerMinute,
        ),
    };
}
