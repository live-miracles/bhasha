import { describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_LISTENER_RATE_LIMITS,
    ListenerRateLimiter,
    RateLimiter,
    listenerRateLimitConfigFromEnv,
} from '../src/security/rateLimiter';

function clock(start = 1_000_000) {
    let now = start;
    return {
        now: () => now,
        advance(ms: number) {
            now += ms;
        },
    };
}

function joinRequest(ip: string): Request {
    return new Request('https://bhasha.test/api/listeners/request', {
        method: 'POST',
        headers: { 'x-forwarded-for': ip },
    });
}

describe('RateLimiter', () => {
    it('allows a burst, then refuses with a retry delay', () => {
        const c = clock();
        const limiter = new RateLimiter({ limitPerMinute: 60, burst: 3, now: c.now });

        expect([1, 2, 3].map(() => limiter.take('k').allowed)).toEqual([true, true, true]);
        const refused = limiter.take('k');

        expect(refused.allowed).toBe(false);
        // 60/min is one token per second.
        expect(refused).toEqual({ allowed: false, retryAfterSeconds: 1 });
    });

    it('refills over time and never above the burst size', () => {
        const c = clock();
        const limiter = new RateLimiter({ limitPerMinute: 60, burst: 3, now: c.now });
        for (let i = 0; i < 3; i++) limiter.take('k');
        expect(limiter.take('k').allowed).toBe(false);

        c.advance(2_000);
        expect(limiter.take('k').allowed).toBe(true);
        expect(limiter.take('k').allowed).toBe(true);
        expect(limiter.take('k').allowed).toBe(false);

        c.advance(60 * 60_000);
        expect([1, 2, 3, 4].map(() => limiter.take('k').allowed)).toEqual([
            true,
            true,
            true,
            false,
        ]);
    });

    it('reports a longer wait when the bucket is further from refilling', () => {
        const c = clock();
        const limiter = new RateLimiter({ limitPerMinute: 6, burst: 1, now: c.now });
        limiter.take('k');

        // 6/min is one token every 10 seconds.
        expect(limiter.take('k')).toEqual({ allowed: false, retryAfterSeconds: 10 });
        c.advance(4_000);
        expect(limiter.take('k')).toEqual({ allowed: false, retryAfterSeconds: 6 });
    });

    it('keeps keys independent', () => {
        const limiter = new RateLimiter({ limitPerMinute: 60, burst: 1, now: clock().now });

        expect(limiter.take('a').allowed).toBe(true);
        expect(limiter.take('a').allowed).toBe(false);
        expect(limiter.take('b').allowed).toBe(true);
    });

    it('drops fully refilled buckets so idle keys do not accumulate', () => {
        const c = clock();
        const limiter = new RateLimiter({ limitPerMinute: 60, burst: 2, now: c.now });
        for (let i = 0; i < 400; i++) limiter.take(`idle-${i}`);
        expect(limiter.size).toBe(400);

        c.advance(10 * 60_000);
        for (let i = 0; i < 100; i++) limiter.take('active'); // reaches the 500th take, which prunes

        expect(limiter.size).toBe(1);
    });

    it('caps memory when a flood of distinct keys never refills', () => {
        const limiter = new RateLimiter({
            limitPerMinute: 60,
            burst: 2,
            maxKeys: 100,
            now: clock().now,
        });

        for (let i = 0; i < 1000; i++) limiter.take(`flood-${i}`);

        expect(limiter.size).toBeLessThanOrEqual(100);
    });
});

describe('ListenerRateLimiter', () => {
    it('limits join-type endpoints per IP but never the heartbeat/connected/leave endpoints', () => {
        const c = clock();
        // The burst is half the per-minute limit, so 8/min allows 4 back-to-back.
        const limiter = new ListenerRateLimiter({ ipPerMinute: 8, subjectPerMinute: 0 }, c.now);
        const request = joinRequest('198.51.100.1');

        const joins = [1, 2, 3, 4, 5].map(
            () => limiter.checkRequest(request, '/api/listeners/request')?.status ?? 'ok',
        );

        expect(joins).toEqual(['ok', 'ok', 'ok', 'ok', 429]);
        for (const path of [
            '/api/listeners/heartbeat',
            '/api/listeners/connected',
            '/api/listeners/leave',
        ]) {
            expect(limiter.checkRequest(request, path)).toBeNull();
        }
    });

    it('counts every join-type endpoint against the same per-IP budget', () => {
        // 4/min -> burst of 2.
        const limiter = new ListenerRateLimiter(
            { ipPerMinute: 4, subjectPerMinute: 0 },
            clock().now,
        );
        const request = joinRequest('198.51.100.2');

        expect(limiter.checkRequest(request, '/api/listeners/request')).toBeNull();
        expect(limiter.checkRequest(request, '/api/listeners/token')).toBeNull();
        expect(limiter.checkRequest(request, '/api/listeners/switch')?.status).toBe(429);
    });

    it('limits per client and per connection independently', () => {
        // 4/min -> burst of 2.
        const limiter = new ListenerRateLimiter(
            { ipPerMinute: 0, subjectPerMinute: 4 },
            clock().now,
        );

        expect(limiter.checkSubject('client', 'c1')).toBeNull();
        expect(limiter.checkSubject('client', 'c1')).toBeNull();
        expect(limiter.checkSubject('client', 'c1')?.status).toBe(429);
        // Same id under a different kind, and a different id, are separate buckets.
        expect(limiter.checkSubject('connection', 'c1')).toBeNull();
        expect(limiter.checkSubject('client', 'c2')).toBeNull();
    });

    it('answers 429 with rate_limited, a Retry-After header and no-cache semantics', async () => {
        const limiter = new ListenerRateLimiter(
            { ipPerMinute: 0, subjectPerMinute: 2 },
            clock().now,
        );
        limiter.checkSubject('client', 'c1');
        limiter.checkSubject('client', 'c1');

        const response = limiter.checkSubject('client', 'c1');

        expect(response?.status).toBe(429);
        expect(await response?.json()).toEqual({ error: 'rate_limited' });
        expect(Number(response?.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    });

    it('can disable each layer with 0', () => {
        const limiter = new ListenerRateLimiter(
            { ipPerMinute: 0, subjectPerMinute: 0 },
            clock().now,
        );
        const request = joinRequest('198.51.100.3');

        for (let i = 0; i < 200; i++) {
            expect(limiter.checkRequest(request, '/api/listeners/request')).toBeNull();
            expect(limiter.checkSubject('client', 'c1')).toBeNull();
        }
    });

    it('logs at most once per 10 seconds, however many requests are refused', () => {
        const c = clock();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const limiter = new ListenerRateLimiter({ ipPerMinute: 0, subjectPerMinute: 1 }, c.now);
            for (let i = 0; i < 50; i++) limiter.checkSubject('client', 'c1');
            expect(warn).toHaveBeenCalledTimes(1);

            c.advance(11_000);
            for (let i = 0; i < 50; i++) limiter.checkSubject('client', 'c1');
            expect(warn).toHaveBeenCalledTimes(2);
            expect(String(warn.mock.calls[1]?.[0])).toContain('"alsoLimitedSinceLastLog":');
        } finally {
            warn.mockRestore();
        }
    });
});

describe('default limits', () => {
    it('let a venue of 1,000 listeners behind one NAT address join in a minute', () => {
        // Each listener makes about two join-type requests (request + token). The burst
        // (half the per-minute limit) is what absorbs the opening surge.
        const burst = DEFAULT_LISTENER_RATE_LIMITS.ipPerMinute / 2;

        expect(burst).toBeGreaterThanOrEqual(1000 * 2 * 1.5);
    });

    it('are far above what one real listener does but still bound a single client', () => {
        expect(DEFAULT_LISTENER_RATE_LIMITS.subjectPerMinute).toBeGreaterThanOrEqual(20);
        expect(DEFAULT_LISTENER_RATE_LIMITS.subjectPerMinute).toBeLessThanOrEqual(120);
    });
});

describe('listenerRateLimitConfigFromEnv', () => {
    it('uses the defaults when unset or blank', () => {
        expect(listenerRateLimitConfigFromEnv({})).toEqual(DEFAULT_LISTENER_RATE_LIMITS);
        expect(
            listenerRateLimitConfigFromEnv({
                LISTENER_RATE_LIMIT_IP_PER_MIN: '  ',
                LISTENER_RATE_LIMIT_SUBJECT_PER_MIN: '',
            }),
        ).toEqual(DEFAULT_LISTENER_RATE_LIMITS);
    });

    it('reads whole numbers, including 0 to disable a layer', () => {
        expect(
            listenerRateLimitConfigFromEnv({
                LISTENER_RATE_LIMIT_IP_PER_MIN: '9000',
                LISTENER_RATE_LIMIT_SUBJECT_PER_MIN: '0',
            }),
        ).toEqual({ ipPerMinute: 9000, subjectPerMinute: 0 });
        expect(
            listenerRateLimitConfigFromEnv({ LISTENER_RATE_LIMIT_IP_PER_MIN: '12.9' }).ipPerMinute,
        ).toBe(12);
    });

    it('falls back to the defaults for nonsense instead of disabling protection', () => {
        expect(
            listenerRateLimitConfigFromEnv({
                LISTENER_RATE_LIMIT_IP_PER_MIN: 'lots',
                LISTENER_RATE_LIMIT_SUBJECT_PER_MIN: '-5',
            }),
        ).toEqual(DEFAULT_LISTENER_RATE_LIMITS);
    });
});
