import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { adminCookie, buildTestEnv, seedAdmin, seedProgram, testEnv } from './test-env';

type App = ReturnType<typeof createApp>;

// One app instance per scenario: the limiter lives in createApp's closure, so every request in a
// test must go through the same instance for its counters to accumulate.
function appWith(limits: { ip?: string; subject?: string } = {}): App {
    return createApp({
        ...buildTestEnv(),
        ...(limits.ip !== undefined ? { LISTENER_RATE_LIMIT_IP_PER_MIN: limits.ip } : {}),
        ...(limits.subject !== undefined
            ? { LISTENER_RATE_LIMIT_SUBJECT_PER_MIN: limits.subject }
            : {}),
    });
}

function call(app: App, path: string, init: RequestInit = {}): Promise<Response> {
    return Promise.resolve(app.fetch(new Request(`https://bhasha.test${path}`, init)));
}

async function seedStream(): Promise<{ programId: string; streamId: string }> {
    const cookie = await adminCookie();
    const program = await seedProgram(testEnv, { slug: `rl-${crypto.randomUUID()}` });
    const response = await call(appWith(), `/api/admin/programs/${program.id}/streams`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: JSON.stringify({
            languageName: 'Hindi',
            languageCode: 'hi',
            displayOrder: 1,
            isActive: true,
        }),
    });
    const { id } = (await response.json()) as { id: string };
    return { programId: program.id, streamId: id };
}

describe('listener API rate limiting', () => {
    let fixture: { programId: string; streamId: string };

    beforeEach(async () => {
        await seedAdmin(testEnv);
        fixture = await seedStream();
    });

    function join(
        app: App,
        ip: string,
        clientId: string,
        extraHeaders: Record<string, string> = {},
    ) {
        return call(app, '/api/listeners/request', {
            method: 'POST',
            headers: { 'x-forwarded-for': ip, ...extraHeaders },
            body: JSON.stringify({ ...fixture, clientId }),
        });
    }

    // A connection must be marked connected before it can heartbeat, like a real listener.
    function connected(app: App, ip: string, connectionId: string) {
        return call(app, '/api/listeners/connected', {
            method: 'POST',
            headers: { 'x-forwarded-for': ip },
            body: JSON.stringify({ connectionId }),
        });
    }

    function heartbeat(app: App, ip: string, connectionId: string) {
        return call(app, '/api/listeners/heartbeat', {
            method: 'POST',
            headers: { 'x-forwarded-for': ip },
            body: JSON.stringify({ connectionId }),
        });
    }

    it('limits how fast one client can ask to join, and answers 429 with Retry-After', async () => {
        const app = appWith({ ip: '0', subject: '8' }); // per-client burst of 4

        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
            statuses.push((await join(app, '198.51.100.1', 'client_a')).status);
        }
        expect(statuses).toEqual([201, 201, 201, 201, 429]);

        const refused = await join(app, '198.51.100.1', 'client_a');
        expect(await refused.json()).toEqual({ error: 'rate_limited' });
        expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

        // Another client, even from the same address, is unaffected.
        expect((await join(app, '198.51.100.1', 'client_b')).status).toBe(201);
    });

    it('limits join requests per IP address, and other addresses are unaffected', async () => {
        const app = appWith({ ip: '8', subject: '0' }); // per-IP burst of 4

        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
            statuses.push((await join(app, '198.51.100.1', `client_${i}`)).status);
        }
        expect(statuses).toEqual([201, 201, 201, 201, 429]);

        expect((await join(app, '198.51.100.2', 'client_other')).status).toBe(201);
    });

    it('never throttles heartbeats by IP, so listeners behind a busy address keep playing', async () => {
        const app = appWith({ ip: '8', subject: '0' });
        const first = await join(app, '198.51.100.1', 'client_0');
        const { connectionId } = (await first.json()) as { connectionId: string };
        expect((await connected(app, '198.51.100.1', connectionId)).status).toBe(200);
        for (let i = 1; i < 4; i++) {
            await join(app, '198.51.100.1', `client_${i}`);
        }
        // The address is now out of join budget...
        expect((await join(app, '198.51.100.1', 'client_late')).status).toBe(429);

        // ...but an established listener on it can still heartbeat, repeatedly.
        for (let i = 0; i < 20; i++) {
            expect((await heartbeat(app, '198.51.100.1', connectionId)).status).toBe(200);
        }
    });

    it('limits heartbeats per connection', async () => {
        const app = appWith({ ip: '0', subject: '12' }); // per-connection burst of 6
        const joined = await join(app, '198.51.100.3', 'client_hb');
        const { connectionId } = (await joined.json()) as { connectionId: string };
        // /connected uses one of this connection's 6, leaving 5 heartbeats.
        expect((await connected(app, '198.51.100.3', connectionId)).status).toBe(200);

        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) {
            statuses.push((await heartbeat(app, '198.51.100.3', connectionId)).status);
        }

        expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    });

    it('cannot be dodged by forging CF-Connecting-IP', async () => {
        const app = appWith({ ip: '8', subject: '0' });

        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
            statuses.push(
                (
                    await join(app, '198.51.100.9', `client_${i}`, {
                        'cf-connecting-ip': `203.0.113.${i + 1}`,
                    })
                ).status,
            );
        }

        expect(statuses).toEqual([201, 201, 201, 201, 429]);
    });

    it('lets 1,200 listeners behind one NAT address join with the default limits', async () => {
        const app = appWith(); // defaults

        const statuses = new Set<number>();
        for (let i = 0; i < 1200; i++) {
            statuses.add((await join(app, '203.0.113.200', `venue_client_${i}`)).status);
        }

        expect([...statuses]).toEqual([201]);
    }, 60_000);

    it('does nothing when both layers are disabled', async () => {
        const app = appWith({ ip: '0', subject: '0' });

        const statuses = new Set<number>();
        for (let i = 0; i < 60; i++) {
            statuses.add((await join(app, '198.51.100.4', 'same_client')).status);
        }

        expect([...statuses]).toEqual([201]);
    });

    it('does not touch other routes', async () => {
        const app = appWith({ ip: '1', subject: '1' });

        for (let i = 0; i < 10; i++) {
            expect((await call(app, '/api/health')).status).toBe(200);
        }
    });
});
