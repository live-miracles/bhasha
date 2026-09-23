import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/env';
import { createApp } from '../src/index';
import { sha256Hex } from '../src/auth/crypto';
import { ListenerAccessRepository } from '../src/db/listenerAccessRepository';
import type { Database } from '../src/db/sqlite';
import { countingDb, targetsTable } from './helpers/countingDb';
import { adminCookie, buildTestEnv, seedAdmin, testEnv } from './test-env';

interface ProgramGraph {
    programId: string;
    programSlug: string;
    hindiStreamId: string;
    englishStreamId: string;
    publisherSessionId?: string;
    publisherTrackName?: string;
}

async function request(
    path: string,
    init: RequestInit = {},
    env: Env = buildTestEnv(),
): Promise<Response> {
    const app = createApp(env);
    return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

async function resetDb(): Promise<void> {
    testEnv.DB.exec('DELETE FROM listener_access');
    testEnv.DB.exec('DELETE FROM listener_realtime_cleanup_targets');
    testEnv.DB.exec('DELETE FROM stream_events');
    testEnv.DB.exec('DELETE FROM listener_connections');
    testEnv.DB.exec('DELETE FROM realtime_publish_sessions');
    testEnv.DB.exec('DELETE FROM translator_sessions');
    testEnv.DB.exec('DELETE FROM translator_stream_assignments');
    testEnv.DB.exec('DELETE FROM translators');
    testEnv.DB.exec('DELETE FROM language_streams');
    testEnv.DB.exec('DELETE FROM programs');
}

async function seedProgramGraph(
    options: {
        accessControlEnabled?: boolean;
        published?: boolean;
    } = {},
): Promise<ProgramGraph> {
    const suffix = crypto.randomUUID();
    const now = new Date().toISOString();
    const programId = `program_${suffix}`;
    const programSlug = `listener-access-${suffix}`;
    const hindiStreamId = `stream_${suffix}_hi`;
    const englishStreamId = `stream_${suffix}_en`;

    testEnv.DB.prepare(
        `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes,
     access_control_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'live', '', ?, ?, ?)`,
    ).run(
        programId,
        programSlug,
        'Listener Access Test',
        'Main Hall',
        '2026-08-26',
        options.accessControlEnabled ? 1 : 0,
        now,
        now,
    );

    for (const [streamId, languageName, languageCode, displayOrder] of [
        [hindiStreamId, 'Hindi', 'hi', 1],
        [englishStreamId, 'English', 'en', 2],
    ] as const) {
        testEnv.DB.prepare(
            `INSERT INTO language_streams
      (id, program_id, language_name, language_code, display_order, is_active,
       is_live, cloudflare_session_id, current_track_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 0, NULL, NULL, ?, ?)`,
        ).run(streamId, programId, languageName, languageCode, displayOrder, now, now);
    }

    if (!options.published) {
        return { programId, programSlug, hindiStreamId, englishStreamId };
    }

    const translatorId = `translator_${suffix}`;
    const publishId = `realtime_publish_session_${suffix}`;
    const publisherSessionId = `cf_publisher_${suffix}`;
    const publisherTrackName = 'mic-track';
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

    testEnv.DB.prepare(
        `INSERT INTO translators
    (id, program_id, name, password_hash, created_at, updated_at)
    VALUES (?, ?, 'Hindi translator', 'sha256:unused', ?, ?)`,
    ).run(translatorId, programId, now, now);

    testEnv.DB.prepare(
        `INSERT INTO realtime_publish_sessions
    (id, program_id, language_stream_id, translator_id, cloudflare_session_id,
     published_track_name, published_track_mid, state, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '0', 'published', ?, ?, ?)`,
    ).run(
        publishId,
        programId,
        hindiStreamId,
        translatorId,
        publisherSessionId,
        publisherTrackName,
        expiresAt,
        now,
        now,
    );

    testEnv.DB.prepare(
        `UPDATE language_streams
    SET is_live = 1, cloudflare_session_id = ?, current_track_id = ?, updated_at = ?
    WHERE id = ?`,
    ).run(publisherSessionId, publisherTrackName, now, hindiStreamId);

    return {
        programId,
        programSlug,
        hindiStreamId,
        englishStreamId,
        publisherSessionId,
        publisherTrackName,
    };
}

async function setAccessControl(programId: string, enabled: boolean): Promise<void> {
    testEnv.DB.prepare('UPDATE programs SET access_control_enabled = ? WHERE id = ?').run(
        enabled ? 1 : 0,
        programId,
    );
}

async function mintAccess(
    graph: ProgramGraph,
    clientId = `client_${crypto.randomUUID()}`,
): Promise<{
    accessToken: string;
    claimId: string;
    claimSecret: string;
    clientId: string;
}> {
    const claimResponse = await request('/api/listeners/access/claim', {
        method: 'POST',
        body: JSON.stringify({ programSlug: graph.programSlug, clientId }),
    });
    expect(claimResponse.status).toBe(201);
    const claim = (await claimResponse.json()) as {
        claimId: string;
        claimSecret: string;
        shortCode: string;
    };

    const repo = new ListenerAccessRepository(testEnv.DB);
    await expect(
        repo.approveClaim(graph.programId, { claimId: claim.claimId }, 'scan'),
    ).resolves.toEqual({ status: 'approved', already: false });

    const statusResponse = await request('/api/listeners/access/status', {
        method: 'POST',
        body: JSON.stringify({
            programSlug: graph.programSlug,
            claimId: claim.claimId,
            claimSecret: claim.claimSecret,
        }),
    });
    expect(statusResponse.status).toBe(200);
    const status = (await statusResponse.json()) as {
        state: string;
        accessToken: string;
    };
    expect(status.state).toBe('approved');
    expect(status.accessToken).toMatch(/^[0-9a-f]{64}$/);

    return {
        accessToken: status.accessToken,
        claimId: claim.claimId,
        claimSecret: claim.claimSecret,
        clientId,
    };
}

function createInput(
    graph: ProgramGraph,
    clientId: string,
    accessToken?: string,
): Record<string, string> {
    return {
        programSlug: graph.programSlug,
        streamId: graph.hindiStreamId,
        clientId,
        ...(accessToken ? { accessToken } : {}),
    };
}

function tokenInput(
    graph: ProgramGraph,
    connectionId: string,
    accessToken?: string,
): Record<string, string> {
    return {
        programSlug: graph.programSlug,
        streamId: graph.hindiStreamId,
        connectionId,
        ...(accessToken ? { accessToken } : {}),
    };
}

async function requestListenerConnection(
    graph: ProgramGraph,
    clientId: string,
    accessToken?: string,
): Promise<string> {
    const response = await request('/api/listeners/request', {
        method: 'POST',
        body: JSON.stringify(createInput(graph, clientId, accessToken)),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { connectionId: string };
    return body.connectionId;
}

describe('ListenerAccessRepository', () => {
    beforeEach(resetDb);

    it('creates hashed Crockford claims and atomically supersedes prior pending claims', async () => {
        const graph = await seedProgramGraph();
        const repo = new ListenerAccessRepository(testEnv.DB);
        const first = await repo.createClaim(graph.programId, 'client_1');

        expect(first.claimId).toMatch(/^listener_access_/);
        expect(first.claimSecret).toMatch(/^[0-9a-f]{64}$/);
        expect(first.shortCode).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);

        const stored = testEnv.DB.prepare(
            `SELECT claim_secret_hash as claimSecretHash, status
      FROM listener_access WHERE id = ?`,
        ).get(first.claimId) as { claimSecretHash: string; status: string } | undefined;
        expect(stored).toEqual({
            claimSecretHash: await sha256Hex(first.claimSecret),
            status: 'pending',
        });

        const second = await repo.createClaim(graph.programId, 'client_1');
        const results = testEnv.DB.prepare(
            `SELECT id, status, superseded_at as supersededAt
      FROM listener_access WHERE program_id = ? AND client_id = ? ORDER BY created_at, id`,
        ).all(graph.programId, 'client_1') as Array<{
            id: string;
            status: string;
            supersededAt: string | null;
        }>;
        expect(results).toEqual([
            {
                id: first.claimId,
                status: 'superseded',
                supersededAt: expect.any(String),
            },
            { id: second.claimId, status: 'pending', supersededAt: null },
        ]);
    });

    it('retries a short-code unique collision without losing the pending claim', async () => {
        const graph = await seedProgramGraph();
        const timestamp = new Date().toISOString();
        const priorClaimId = `listener_access_prior_${crypto.randomUUID()}`;
        testEnv.DB.prepare(
            `INSERT INTO listener_access
      (id, program_id, client_id, short_code, claim_secret_hash, status,
       access_token_hash, created_at, approved_at, approved_via,
       revoked_at, superseded_at)
      VALUES
        (?, ?, 'client_existing', 'AAAAAA', ?, 'pending', NULL, ?, NULL, NULL, NULL, NULL),
        (?, ?, 'client_collision', 'CCCCCC', ?, 'pending', NULL, ?, NULL, NULL, NULL, NULL)`,
        ).run(
            `listener_access_existing_${crypto.randomUUID()}`,
            graph.programId,
            await sha256Hex('existing-claim-secret'),
            timestamp,
            priorClaimId,
            graph.programId,
            await sha256Hex('prior-claim-secret'),
            timestamp,
        );
        const generateShortCode = vi
            .fn<() => string>()
            .mockReturnValueOnce('AAAAAA')
            .mockReturnValueOnce('BBBBBB');
        // better-sqlite3 has no D1-style `.batch()`; the repository instead wraps
        // each create-claim attempt in `db.transaction(fn)()`. Proxy that entry
        // point (instead of `.batch()`) to count attempts and, on the attempt that
        // fails the UNIQUE short-code collision, read the prior claim's status
        // from inside the `catch` -- right after better-sqlite3's automatic
        // ROLLBACK -- to prove the failed attempt's supersede-then-insert was
        // fully undone rather than partially applied.
        let attempts = 0;
        let priorStatusAfterCollision: string | null = null;
        const collisionDb = new Proxy(testEnv.DB, {
            get(target, property, receiver) {
                if (property !== 'transaction') {
                    const value = Reflect.get(target, property, receiver);
                    return typeof value === 'function' ? value.bind(target) : value;
                }

                return (fn: () => void) => {
                    const run = target.transaction(fn);
                    return () => {
                        attempts += 1;
                        try {
                            return run();
                        } catch (error) {
                            priorStatusAfterCollision =
                                (
                                    target
                                        .prepare('SELECT status FROM listener_access WHERE id = ?')
                                        .get(priorClaimId) as { status: string } | undefined
                                )?.status ?? null;
                            throw error;
                        }
                    };
                };
            },
        }) as Database;

        const claim = await new ListenerAccessRepository(
            collisionDb,
            generateShortCode,
        ).createClaim(graph.programId, 'client_collision');

        expect(attempts).toBe(2);
        expect(priorStatusAfterCollision).toBe('pending');
        expect(generateShortCode).toHaveBeenCalledTimes(2);
        expect(claim.shortCode).toBe('BBBBBB');
        const results = testEnv.DB.prepare(
            `SELECT client_id as clientId, short_code as shortCode, status
      FROM listener_access
      WHERE program_id = ?
      ORDER BY short_code`,
        ).all(graph.programId) as Array<{
            clientId: string;
            shortCode: string;
            status: string;
        }>;
        expect(results).toEqual([
            {
                clientId: 'client_existing',
                shortCode: 'AAAAAA',
                status: 'pending',
            },
            {
                clientId: 'client_collision',
                shortCode: 'BBBBBB',
                status: 'pending',
            },
            {
                clientId: 'client_collision',
                shortCode: 'CCCCCC',
                status: 'superseded',
            },
        ]);
    });

    it('preserves approved rows on re-claim and implements guarded transitions', async () => {
        const graph = await seedProgramGraph();
        const repo = new ListenerAccessRepository(testEnv.DB);
        const first = await repo.createClaim(graph.programId, 'client_approved');

        await expect(
            repo.approveClaim(graph.programId, { shortCode: first.shortCode }, 'code'),
        ).resolves.toEqual({ status: 'approved', already: false });
        await expect(
            repo.approveClaim(graph.programId, { claimId: first.claimId }, 'scan'),
        ).resolves.toEqual({ status: 'approved', already: true });

        const next = await repo.createClaim(graph.programId, 'client_approved');
        expect(
            await repo.getClaimForRedeem(graph.programId, first.claimId, first.claimSecret),
        ).toMatchObject({ status: 'approved' });
        expect(
            await repo.getClaimForRedeem(graph.programId, next.claimId, next.claimSecret),
        ).toMatchObject({ status: 'pending' });

        const superseded = await repo.createClaim(graph.programId, 'client_pending');
        await repo.createClaim(graph.programId, 'client_pending');
        await expect(
            repo.approveClaim(graph.programId, { claimId: superseded.claimId }, 'scan'),
        ).resolves.toEqual({ status: 'not_found' });

        await repo.revokeForClient(graph.programId, 'client_approved');
        await expect(
            repo.approveClaim(graph.programId, { claimId: first.claimId }, 'scan'),
        ).resolves.toEqual({ status: 'revoked' });
    });

    it('re-mints with last-write-wins, revokes all client rows, counts, and lists the window', async () => {
        const graph = await seedProgramGraph();
        const repo = new ListenerAccessRepository(testEnv.DB);
        const claim = await repo.createClaim(graph.programId, 'client_remint');
        await repo.approveClaim(graph.programId, { claimId: claim.claimId }, 'scan');

        const firstToken = await repo.mintAccessToken(
            graph.programId,
            claim.claimId,
            claim.claimSecret,
        );
        const secondToken = await repo.mintAccessToken(
            graph.programId,
            claim.claimId,
            claim.claimSecret,
        );
        expect(firstToken).toMatch(/^[0-9a-f]{64}$/);
        expect(secondToken).toMatch(/^[0-9a-f]{64}$/);
        expect(secondToken).not.toBe(firstToken);
        await expect(repo.verifyAccessToken(graph.programId, firstToken ?? '')).resolves.toBe(
            false,
        );
        await expect(repo.verifyAccessToken(graph.programId, secondToken ?? '')).resolves.toBe(
            true,
        );

        expect(
            await repo.listApprovedSince(
                graph.programId,
                new Date(Date.now() - 90_000).toISOString(),
            ),
        ).toContain(claim.claimId);
        expect(await repo.countByStatus(graph.programId)).toEqual({
            pending: 0,
            approved: 1,
            revoked: 0,
        });

        expect(await repo.revokeForClient(graph.programId, 'client_remint')).toBe(1);
        await expect(repo.verifyAccessToken(graph.programId, secondToken ?? '')).resolves.toBe(
            false,
        );
        expect(await repo.countByStatus(graph.programId)).toEqual({
            pending: 0,
            approved: 0,
            revoked: 1,
        });
        expect(
            await repo.listApprovedSince(
                graph.programId,
                new Date(Date.now() - 90_000).toISOString(),
            ),
        ).toEqual([]);
    });
});

describe('listener access claim and status routes', () => {
    beforeEach(resetDb);

    it('creates claims, reports transitions, preserves claim-invalid parity, and re-mints', async () => {
        const graph = await seedProgramGraph({ accessControlEnabled: true });
        const unknownProgram = await request('/api/listeners/access/claim', {
            method: 'POST',
            body: JSON.stringify({ programSlug: 'missing', clientId: 'client_1' }),
        });
        expect(unknownProgram.status).toBe(404);
        expect(unknownProgram.headers.get('cache-control')).toBe('no-store');

        const created = await request('/api/listeners/access/claim', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: graph.programSlug,
                clientId: 'client_1',
            }),
        });
        expect(created.status).toBe(201);
        expect(created.headers.get('cache-control')).toBe('no-store');
        const claim = (await created.json()) as {
            claimId: string;
            claimSecret: string;
            shortCode: string;
        };

        const pending = await request('/api/listeners/access/status', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: graph.programSlug,
                claimId: claim.claimId,
                claimSecret: claim.claimSecret,
            }),
        });
        expect(await pending.json()).toEqual({ state: 'pending' });
        expect(pending.headers.get('cache-control')).toBe('no-store');

        const badSecret = await request('/api/listeners/access/status', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: graph.programSlug,
                claimId: claim.claimId,
                claimSecret: 'wrong-secret',
            }),
        });
        const unknownClaim = await request('/api/listeners/access/status', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: graph.programSlug,
                claimId: 'listener_access_missing',
                claimSecret: 'wrong-secret',
            }),
        });
        expect(badSecret.status).toBe(403);
        expect(unknownClaim.status).toBe(403);
        expect(await badSecret.json()).toEqual({ error: 'claim_invalid' });
        expect(await unknownClaim.json()).toEqual({ error: 'claim_invalid' });
        expect(badSecret.headers.get('cache-control')).toBe('no-store');

        const repo = new ListenerAccessRepository(testEnv.DB);
        await repo.approveClaim(graph.programId, { claimId: claim.claimId }, 'scan');
        const firstMint = await request('/api/listeners/access/status', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: graph.programSlug,
                claimId: claim.claimId,
                claimSecret: claim.claimSecret,
            }),
        });
        const first = (await firstMint.json()) as {
            state: string;
            accessToken: string;
        };
        expect(first.state).toBe('approved');

        const tokenProof = await request('/api/listeners/access/status', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: graph.programSlug,
                accessToken: first.accessToken,
            }),
        });
        expect(await tokenProof.json()).toEqual({ state: 'approved' });

        const secondMint = await request('/api/listeners/access/status', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: graph.programSlug,
                claimId: claim.claimId,
                claimSecret: claim.claimSecret,
            }),
        });
        const second = (await secondMint.json()) as {
            state: string;
            accessToken: string;
        };
        expect(second.accessToken).not.toBe(first.accessToken);
        await expect(repo.verifyAccessToken(graph.programId, first.accessToken)).resolves.toBe(
            false,
        );
        await expect(repo.verifyAccessToken(graph.programId, second.accessToken)).resolves.toBe(
            true,
        );

        await repo.revokeForClient(graph.programId, 'client_1');
        const revokedToken = await request('/api/listeners/access/status', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: graph.programSlug,
                accessToken: second.accessToken,
            }),
        });
        expect(await revokedToken.json()).toEqual({ state: 'revoked' });

        const unknownToken = await request('/api/listeners/access/status', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: graph.programSlug,
                accessToken: 'unknown-token',
            }),
        });
        expect(unknownToken.status).toBe(200);
        expect(await unknownToken.json()).toEqual({ state: 'unknown' });
    });

    it('maps a valid secret for superseded and revoked claims without leaking a token', async () => {
        const graph = await seedProgramGraph({ accessControlEnabled: true });
        const repo = new ListenerAccessRepository(testEnv.DB);
        const superseded = await repo.createClaim(graph.programId, 'client_1');
        await repo.createClaim(graph.programId, 'client_1');

        const supersededStatus = await request('/api/listeners/access/status', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: graph.programSlug,
                claimId: superseded.claimId,
                claimSecret: superseded.claimSecret,
            }),
        });
        expect(await supersededStatus.json()).toEqual({ state: 'unknown' });

        const revoked = await repo.createClaim(graph.programId, 'client_revoked');
        await repo.revokeForClient(graph.programId, 'client_revoked');
        const revokedStatus = await request('/api/listeners/access/status', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: graph.programSlug,
                claimId: revoked.claimId,
                claimSecret: revoked.claimSecret,
            }),
        });
        expect(await revokedStatus.json()).toEqual({ state: 'revoked' });
    });
});

describe('listener access approval broadcast', () => {
    beforeEach(resetDb);

    it('returns recent approvals and edge-caches each flag-specific payload', async () => {
        const enabled = await seedProgramGraph({ accessControlEnabled: true });
        const disabled = await seedProgramGraph({ accessControlEnabled: false });
        const repo = new ListenerAccessRepository(testEnv.DB);
        const recent = await repo.createClaim(enabled.programId, 'client_recent');
        const old = await repo.createClaim(enabled.programId, 'client_old');
        const revoked = await repo.createClaim(enabled.programId, 'client_revoked');
        const other = await repo.createClaim(disabled.programId, 'client_other');
        await repo.approveClaim(enabled.programId, { claimId: recent.claimId }, 'scan');
        await repo.approveClaim(enabled.programId, { claimId: old.claimId }, 'scan');
        await repo.approveClaim(enabled.programId, { claimId: revoked.claimId }, 'scan');
        await repo.approveClaim(disabled.programId, { claimId: other.claimId }, 'scan');
        await repo.revokeForClient(enabled.programId, 'client_revoked');
        testEnv.DB.prepare('UPDATE listener_access SET approved_at = ? WHERE id = ?').run(
            new Date(Date.now() - 120_000).toISOString(),
            old.claimId,
        );

        const enabledSql: string[] = [];
        const enabledPath = `/api/public/programs/${enabled.programSlug}/access/approved`;
        const enabledEnv = buildTestEnv({
            DB: countingDb(testEnv.DB, enabledSql),
        });
        const enabledResponse = await request(enabledPath, {}, enabledEnv);
        expect(enabledResponse.status).toBe(200);
        expect(enabledResponse.headers.get('cache-control')).toBe('public, max-age=10');
        expect(await enabledResponse.json()).toEqual({
            approved: [recent.claimId],
        });
        const firstOriginQueryCount = enabledSql.length;
        expect(
            enabledSql.filter((statement) => targetsTable(statement, 'listener_access')),
        ).toHaveLength(1);

        const cachedEnabledResponse = await request(enabledPath, {}, enabledEnv);
        expect(cachedEnabledResponse.status).toBe(200);
        expect(await cachedEnabledResponse.json()).toEqual({
            approved: [recent.claimId],
        });
        expect(enabledSql).toHaveLength(firstOriginQueryCount);

        const sql: string[] = [];
        const disabledResponse = await request(
            `/api/public/programs/${disabled.programSlug}/access/approved`,
            {},
            buildTestEnv({ DB: countingDb(testEnv.DB, sql) }),
        );
        expect(disabledResponse.status).toBe(200);
        expect(disabledResponse.headers.get('cache-control')).toBe('public, max-age=3600');
        expect(await disabledResponse.json()).toEqual({ approved: [] });
        expect(sql.filter((statement) => targetsTable(statement, 'listener_access'))).toEqual([]);
    });
});

describe('listener approval gate', () => {
    beforeEach(resetDb);

    it('gates listener token minting before stream disclosure and accepts only a current token', async () => {
        const graph = await seedProgramGraph({
            accessControlEnabled: true,
            published: true,
        });
        const access = await mintAccess(graph, 'client_primary');
        // A fabricated connectionId is fine here -- the access gate runs before
        // the connection is ever looked up, which is exactly the precedence this
        // test pins (see handleListenerRealtimeToken in routes/listeners.ts).
        const body = (accessToken?: string) =>
            JSON.stringify(tokenInput(graph, 'listener_connection_placeholder', accessToken));

        const missing = await request('/api/listeners/token', {
            method: 'POST',
            body: body(),
        });
        expect(missing.status).toBe(403);
        expect(await missing.json()).toEqual({ error: 'listener_not_approved' });

        const invalid = await request('/api/listeners/token', {
            method: 'POST',
            body: body('invalid-token'),
        });
        expect(invalid.status).toBe(403);

        // The access gate passes, but the placeholder connectionId doesn't
        // exist -- still proves the gate ran before connection disclosure.
        const approved = await request('/api/listeners/token', {
            method: 'POST',
            body: body(access.accessToken),
        });
        expect(approved.status).toBe(404);
        expect(await approved.json()).toEqual({
            error: 'listener_connection_not_found',
        });

        const repo = new ListenerAccessRepository(testEnv.DB);
        await repo.revokeForClient(graph.programId, access.clientId);
        const revoked = await request('/api/listeners/token', {
            method: 'POST',
            body: body(access.accessToken),
        });
        expect(revoked.status).toBe(403);

        const offlineGraph = await seedProgramGraph({ accessControlEnabled: true });
        const precedence = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify(tokenInput(offlineGraph, 'listener_connection_placeholder')),
        });
        expect(precedence.status).toBe(403);
        expect(await precedence.json()).toEqual({ error: 'listener_not_approved' });
    });

    it('gates all four secondary acquisition paths before stream or connection work', async () => {
        const graph = await seedProgramGraph({ accessControlEnabled: true });
        const cases = [
            ['/api/listeners/request', createInput(graph, 'client_request')],
            ['/api/listeners/token', tokenInput(graph, 'missing-connection')],
            [
                '/api/listeners/switch',
                {
                    ...createInput(graph, 'client_switch'),
                    fromConnectionId: 'missing-connection',
                },
            ],
            [
                '/api/listeners/reconnect',
                {
                    ...createInput(graph, 'client_reconnect'),
                    reconnectOfConnectionId: 'missing-connection',
                },
            ],
        ] as const;

        for (const [path, body] of cases) {
            const response = await request(path, {
                method: 'POST',
                body: JSON.stringify({ ...body, streamId: 'missing-stream' }),
            });
            expect(response.status, path).toBe(403);
            expect(await response.json(), path).toEqual({
                error: 'listener_not_approved',
            });
        }
    });

    it('allows all four secondary acquisition paths with a minted token', async () => {
        const graph = await seedProgramGraph({
            accessControlEnabled: true,
            published: true,
        });
        const access = await mintAccess(graph, 'client_secondary');

        const firstRequest = await request('/api/listeners/request', {
            method: 'POST',
            body: JSON.stringify(createInput(graph, 'client_first', access.accessToken)),
        });
        expect(firstRequest.status).toBe(201);
        const first = (await firstRequest.json()) as { connectionId: string };

        const secondRequest = await request('/api/listeners/request', {
            method: 'POST',
            body: JSON.stringify(createInput(graph, 'client_second', access.accessToken)),
        });
        expect(secondRequest.status).toBe(201);
        const second = (await secondRequest.json()) as { connectionId: string };

        // /token shares the same access-control precondition as the other three
        // endpoints, and (unlike the old subscribe/session stub) actually mints
        // once it passes.
        const tokenResponse = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify(tokenInput(graph, first.connectionId, access.accessToken)),
        });
        expect(tokenResponse.status).toBe(200);
        const tokenBody = (await tokenResponse.json()) as {
            connectionId: string;
            token: string;
        };
        expect(tokenBody.connectionId).toBe(first.connectionId);
        expect(tokenBody.token.split('.')).toHaveLength(3);

        const switched = await request('/api/listeners/switch', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: graph.programSlug,
                streamId: graph.englishStreamId,
                clientId: 'client_first',
                fromConnectionId: first.connectionId,
                accessToken: access.accessToken,
            }),
        });
        expect(switched.status).toBe(201);

        const reconnected = await request('/api/listeners/reconnect', {
            method: 'POST',
            body: JSON.stringify({
                ...createInput(graph, 'client_second', access.accessToken),
                reconnectOfConnectionId: second.connectionId,
            }),
        });
        expect(reconnected.status).toBe(201);
    });

    it('completes approve, admin revoke, grandfather, re-claim, and re-approve lifecycle', async () => {
        const graph = await seedProgramGraph({
            accessControlEnabled: true,
            published: true,
        });
        await seedAdmin(testEnv);
        const cookie = await adminCookie();
        const clientId = 'client_full_lifecycle';
        const access = await mintAccess(graph, clientId);

        // Acquire a connection through /request, then mint a token for it --
        // both endpoints share the same access-control gate.
        const requestedConnection = await request('/api/listeners/request', {
            method: 'POST',
            body: JSON.stringify(createInput(graph, clientId, access.accessToken)),
        });
        expect(requestedConnection.status).toBe(201);
        const { connectionId } = (await requestedConnection.json()) as {
            connectionId: string;
        };

        const tokenBeforeRevoke = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify(tokenInput(graph, connectionId, access.accessToken)),
        });
        expect(tokenBeforeRevoke.status).toBe(200);

        const connected = await request('/api/listeners/connected', {
            method: 'POST',
            body: JSON.stringify({ connectionId }),
        });
        expect(connected.status).toBe(200);

        const revoke = await request(
            `/api/admin/programs/${graph.programId}/listener-access/revoke`,
            {
                method: 'POST',
                headers: { Cookie: cookie },
                body: JSON.stringify({ clientId }),
            },
        );
        expect(revoke.status).toBe(200);
        expect(await revoke.json()).toEqual({ revoked: 1 });

        const tokenAfterRevoke = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify(tokenInput(graph, connectionId, access.accessToken)),
        });
        expect(tokenAfterRevoke.status).toBe(403);

        const heartbeat = await request('/api/listeners/heartbeat', {
            method: 'POST',
            body: JSON.stringify({ connectionId }),
        });
        expect(heartbeat.status).toBe(200);

        const claimResponse = await request('/api/listeners/access/claim', {
            method: 'POST',
            body: JSON.stringify({ programSlug: graph.programSlug, clientId }),
        });
        expect(claimResponse.status).toBe(201);
        const claim = (await claimResponse.json()) as {
            claimId: string;
            claimSecret: string;
        };
        const pendingRows = testEnv.DB.prepare(
            `SELECT COUNT(*) as count FROM listener_access
      WHERE program_id = ? AND client_id = ? AND status = 'pending'`,
        ).get(graph.programId, clientId) as { count: number } | undefined;
        expect(pendingRows?.count).toBe(1);

        const reportResponse = await request(
            `/api/admin/programs/${graph.programId}/listener-report`,
            { headers: { Cookie: cookie } },
        );
        expect(reportResponse.status).toBe(200);
        const report = (await reportResponse.json()) as {
            connections: Array<{
                clientId: string;
                approvalStatus: string | null;
                hasRevokedHistory: boolean;
            }>;
        };
        expect(report.connections.find((row) => row.clientId === clientId)).toMatchObject({
            approvalStatus: 'revoked',
            hasRevokedHistory: true,
        });

        const repo = new ListenerAccessRepository(testEnv.DB);
        await expect(
            repo.approveClaim(graph.programId, { claimId: claim.claimId }, 'scan'),
        ).resolves.toEqual({ status: 'approved', already: false });
        const statusResponse = await request('/api/listeners/access/status', {
            method: 'POST',
            body: JSON.stringify({
                programSlug: graph.programSlug,
                claimId: claim.claimId,
                claimSecret: claim.claimSecret,
            }),
        });
        expect(statusResponse.status).toBe(200);
        const reminted = (await statusResponse.json()) as { accessToken: string };
        const tokenAfterReapprove = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify(tokenInput(graph, connectionId, reminted.accessToken)),
        });
        expect(tokenAfterReapprove.status).toBe(200);
    });

    it('grandfathers heartbeat but blocks the next reconnect after OFF to ON', async () => {
        const graph = await seedProgramGraph({ published: true });
        const initial = await request('/api/listeners/request', {
            method: 'POST',
            body: JSON.stringify(createInput(graph, 'client_toggle_reconnect')),
        });
        expect(initial.status).toBe(201);
        const { connectionId } = (await initial.json()) as {
            connectionId: string;
        };
        const connected = await request('/api/listeners/connected', {
            method: 'POST',
            body: JSON.stringify({ connectionId }),
        });
        expect(connected.status).toBe(200);

        await setAccessControl(graph.programId, true);

        const heartbeat = await request('/api/listeners/heartbeat', {
            method: 'POST',
            body: JSON.stringify({ connectionId }),
        });
        expect(heartbeat.status).toBe(200);

        const reconnect = await request('/api/listeners/reconnect', {
            method: 'POST',
            body: JSON.stringify({
                ...createInput(graph, 'client_toggle_reconnect'),
                reconnectOfConnectionId: connectionId,
            }),
        });
        expect(reconnect.status).toBe(403);
        expect(await reconnect.json()).toEqual({ error: 'listener_not_approved' });
    });

    it('honors approval minted while OFF after access control turns ON', async () => {
        const graph = await seedProgramGraph({ published: true });
        const access = await mintAccess(graph, 'client_prior_approval');
        const connectionId = await requestListenerConnection(graph, 'client_prior_approval');

        await setAccessControl(graph.programId, true);

        const response = await request('/api/listeners/token', {
            method: 'POST',
            body: JSON.stringify(tokenInput(graph, connectionId, access.accessToken)),
        });
        expect(response.status).toBe(200);
    });

    it('adds no listener-access reads and preserves all acquisition paths when disabled', async () => {
        const graph = await seedProgramGraph({ published: true });
        const sql: string[] = [];
        const db = countingDb(testEnv.DB, sql);
        const workerEnv = buildTestEnv({ DB: db });

        const setupConnection = await request(
            '/api/listeners/request',
            {
                method: 'POST',
                body: JSON.stringify(createInput(graph, 'client_token_disabled')),
            },
            workerEnv,
        );
        expect(setupConnection.status).toBe(201);
        const { connectionId: tokenConnectionId } = (await setupConnection.json()) as {
            connectionId: string;
        };

        const tokenResponse = await request(
            '/api/listeners/token',
            {
                method: 'POST',
                body: JSON.stringify(tokenInput(graph, tokenConnectionId)),
            },
            workerEnv,
        );
        expect(tokenResponse.status).toBe(200);

        const firstRequest = await request(
            '/api/listeners/request',
            {
                method: 'POST',
                body: JSON.stringify(createInput(graph, 'client_first')),
            },
            workerEnv,
        );
        const first = (await firstRequest.json()) as { connectionId: string };
        expect(firstRequest.status).toBe(201);

        const secondRequest = await request(
            '/api/listeners/request',
            {
                method: 'POST',
                body: JSON.stringify(createInput(graph, 'client_second')),
            },
            workerEnv,
        );
        const second = (await secondRequest.json()) as { connectionId: string };
        expect(secondRequest.status).toBe(201);

        const switched = await request(
            '/api/listeners/switch',
            {
                method: 'POST',
                body: JSON.stringify({
                    programSlug: graph.programSlug,
                    streamId: graph.englishStreamId,
                    clientId: 'client_first',
                    fromConnectionId: first.connectionId,
                }),
            },
            workerEnv,
        );
        expect(switched.status).toBe(201);

        const reconnected = await request(
            '/api/listeners/reconnect',
            {
                method: 'POST',
                body: JSON.stringify({
                    ...createInput(graph, 'client_second'),
                    reconnectOfConnectionId: second.connectionId,
                }),
            },
            workerEnv,
        );
        expect(reconnected.status).toBe(201);
        expect(sql.filter((statement) => targetsTable(statement, 'listener_access'))).toEqual([]);
    });

    it('never gates grandfathered lifecycle bookkeeping calls', async () => {
        const graph = await seedProgramGraph({ published: true });
        const requested = await request('/api/listeners/request', {
            method: 'POST',
            body: JSON.stringify(createInput(graph, 'client_grandfathered')),
        });
        expect(requested.status).toBe(201);
        const { connectionId } = (await requested.json()) as {
            connectionId: string;
        };
        await setAccessControl(graph.programId, true);

        const sql: string[] = [];
        const workerEnv = buildTestEnv({ DB: countingDb(testEnv.DB, sql) });

        // /connected, /heartbeat, and /leave are generic DB-lifecycle bookkeeping
        // that never consulted listener_access even before this connection
        // existed -- access-control toggling on after the fact can never
        // retroactively block an established connection's bookkeeping calls.
        // (Unlike those three, /token DOES re-check approval on every call --
        // see the "gates ... before stream disclosure" test above -- so it is
        // deliberately not included here.)
        const connected = await request(
            '/api/listeners/connected',
            {
                method: 'POST',
                body: JSON.stringify({ connectionId }),
            },
            workerEnv,
        );
        expect(connected.status).toBe(200);

        const heartbeat = await request(
            '/api/listeners/heartbeat',
            {
                method: 'POST',
                body: JSON.stringify({ connectionId }),
            },
            workerEnv,
        );
        expect(heartbeat.status).toBe(200);

        const leave = await request(
            '/api/listeners/leave',
            {
                method: 'POST',
                body: JSON.stringify({
                    connectionId,
                    reason: 'client_disconnect',
                }),
            },
            workerEnv,
        );
        expect(leave.status).toBe(200);
        expect(sql.filter((statement) => targetsTable(statement, 'listener_access'))).toEqual([]);
    });
});
