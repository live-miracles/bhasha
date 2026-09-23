import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import {
    DEFAULT_TEST_ORG_ID,
    ORG_ADMIN_TEST_EMAIL,
    VIEWER_TEST_EMAIL,
    adminCookie,
    buildTestEnv,
    seedOrg,
    seedOrgAdmin,
    seedPlatformAdmin,
    seedProgram,
    seedViewer,
    testEnv,
} from './test-env';

type ProgramIsolationIds = {
    programId: string;
    translatorId: string;
    streamId: string;
    sessionId: string;
    assignmentId: string;
};

type EndpointCase = {
    name: string;
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    write: boolean;
    path: (ids: ProgramIsolationIds) => string;
};

const ENDPOINT_CASES: EndpointCase[] = [
    {
        name: 'GET /api/admin/programs/:id',
        method: 'GET',
        write: false,
        path: ({ programId }) => `/api/admin/programs/${programId}`,
    },
    {
        name: 'PATCH /api/admin/programs/:id',
        method: 'PATCH',
        write: true,
        path: ({ programId }) => `/api/admin/programs/${programId}`,
    },
    {
        name: 'DELETE /api/admin/programs/:id',
        method: 'DELETE',
        write: true,
        path: ({ programId }) => `/api/admin/programs/${programId}`,
    },
    {
        name: 'POST /api/admin/programs/:id/restore',
        method: 'POST',
        write: true,
        path: ({ programId }) => `/api/admin/programs/${programId}/restore`,
    },
    {
        name: 'POST /api/admin/programs/:id/archive',
        method: 'POST',
        write: true,
        path: ({ programId }) => `/api/admin/programs/${programId}/archive`,
    },
    {
        name: 'GET /api/admin/programs/:id/listener-report',
        method: 'GET',
        write: false,
        path: ({ programId }) => `/api/admin/programs/${programId}/listener-report`,
    },
    {
        name: 'GET /api/admin/programs/:id/listener-report.csv',
        method: 'GET',
        write: false,
        path: ({ programId }) => `/api/admin/programs/${programId}/listener-report.csv`,
    },
    {
        name: 'GET /api/admin/programs/:id/report/summary',
        method: 'GET',
        write: false,
        path: ({ programId }) => `/api/admin/programs/${programId}/report/summary`,
    },
    {
        name: 'GET /api/admin/programs/:id/listener-access/summary',
        method: 'GET',
        write: false,
        path: ({ programId }) => `/api/admin/programs/${programId}/listener-access/summary`,
    },
    {
        name: 'POST /api/admin/programs/:id/listener-access/revoke',
        method: 'POST',
        write: true,
        path: ({ programId }) => `/api/admin/programs/${programId}/listener-access/revoke`,
    },
    {
        name: 'GET /api/admin/programs/:id/events',
        method: 'GET',
        write: false,
        path: ({ programId }) => `/api/admin/programs/${programId}/events`,
    },
    {
        name: 'POST /api/admin/programs/:id/readiness/confirm',
        method: 'POST',
        write: true,
        path: ({ programId }) => `/api/admin/programs/${programId}/readiness/confirm`,
    },
    {
        name: 'GET /api/admin/programs/:id/readiness',
        method: 'GET',
        write: false,
        path: ({ programId }) => `/api/admin/programs/${programId}/readiness`,
    },
    {
        name: 'POST /api/admin/programs/:id/retention/run',
        method: 'POST',
        write: true,
        path: ({ programId }) => `/api/admin/programs/${programId}/retention/run`,
    },
    {
        name: 'GET /api/admin/programs/:id/status',
        method: 'GET',
        write: false,
        path: ({ programId }) => `/api/admin/programs/${programId}/status`,
    },
    {
        name: 'GET /api/admin/programs/:id/translators/:tid/sessions',
        method: 'GET',
        write: false,
        path: ({ programId, translatorId }) =>
            `/api/admin/programs/${programId}/translators/${translatorId}/sessions`,
    },
    {
        name: 'DELETE /api/admin/programs/:id/translators/:tid/sessions/:sid',
        method: 'DELETE',
        write: true,
        path: ({ programId, translatorId, sessionId }) =>
            `/api/admin/programs/${programId}/translators/${translatorId}/sessions/${sessionId}`,
    },
    {
        name: 'DELETE /api/admin/programs/:id/translators/:tid/sessions',
        method: 'DELETE',
        write: true,
        path: ({ programId, translatorId }) =>
            `/api/admin/programs/${programId}/translators/${translatorId}/sessions`,
    },
    {
        name: 'POST /api/admin/programs/:id/streams/:sid/kick-publisher',
        method: 'POST',
        write: true,
        path: ({ programId, streamId }) =>
            `/api/admin/programs/${programId}/streams/${streamId}/kick-publisher`,
    },
    {
        name: 'GET /api/admin/programs/:id/streams',
        method: 'GET',
        write: false,
        path: ({ programId }) => `/api/admin/programs/${programId}/streams`,
    },
    {
        name: 'POST /api/admin/programs/:id/streams',
        method: 'POST',
        write: true,
        path: ({ programId }) => `/api/admin/programs/${programId}/streams`,
    },
    {
        name: 'PATCH /api/admin/programs/:id/streams/:sid',
        method: 'PATCH',
        write: true,
        path: ({ programId, streamId }) => `/api/admin/programs/${programId}/streams/${streamId}`,
    },
    {
        name: 'DELETE /api/admin/programs/:id/streams/:sid',
        method: 'DELETE',
        write: true,
        path: ({ programId, streamId }) => `/api/admin/programs/${programId}/streams/${streamId}`,
    },
    {
        name: 'GET /api/admin/programs/:id/translators',
        method: 'GET',
        write: false,
        path: ({ programId }) => `/api/admin/programs/${programId}/translators`,
    },
    {
        name: 'POST /api/admin/programs/:id/translators',
        method: 'POST',
        write: true,
        path: ({ programId }) => `/api/admin/programs/${programId}/translators`,
    },
    {
        name: 'POST /api/admin/programs/:id/translators/:tid/reset-password',
        method: 'POST',
        write: true,
        path: ({ programId, translatorId }) =>
            `/api/admin/programs/${programId}/translators/${translatorId}/reset-password`,
    },
    {
        name: 'POST /api/admin/programs/:id/translators/:tid/assignments',
        method: 'POST',
        write: true,
        path: ({ programId, translatorId }) =>
            `/api/admin/programs/${programId}/translators/${translatorId}/assignments`,
    },
    {
        name: 'DELETE /api/admin/programs/:id/translators/:tid/assignments/:aid',
        method: 'DELETE',
        write: true,
        path: ({ programId, translatorId, assignmentId }) =>
            `/api/admin/programs/${programId}/translators/${translatorId}/assignments/${assignmentId}`,
    },
    {
        name: 'PATCH /api/admin/programs/:id/translators/:tid',
        method: 'PATCH',
        write: true,
        path: ({ programId, translatorId }) =>
            `/api/admin/programs/${programId}/translators/${translatorId}`,
    },
    {
        name: 'DELETE /api/admin/programs/:id/translators/:tid',
        method: 'DELETE',
        write: true,
        path: ({ programId, translatorId }) =>
            `/api/admin/programs/${programId}/translators/${translatorId}`,
    },
];

function pathIds() {
    return {
        programId: '',
        translatorId: 't_x',
        streamId: 's_x',
        sessionId: 'sess_x',
        assignmentId: 'a_x',
    };
}

type RequestInitBody = RequestInit;

async function request(path: string, init: RequestInitBody = {}): Promise<Response> {
    const app = createApp(buildTestEnv());
    return app.fetch(new Request(`https://bhasha.test${path}`, init));
}

describe('program admin endpoint multi-tenant isolation', () => {
    let cookieA = '';
    let cookieV = '';
    let cookieB = '';
    let programId = '';

    beforeEach(async () => {
        await testEnv.DB.exec('DELETE FROM listener_realtime_cleanup_targets');
        await testEnv.DB.exec('DELETE FROM realtime_publish_sessions');
        await testEnv.DB.exec('DELETE FROM translator_sessions');
        await testEnv.DB.exec('DELETE FROM admin_sessions');
        await testEnv.DB.exec('DELETE FROM stream_events');
        await testEnv.DB.exec('DELETE FROM listener_connections');
        await testEnv.DB.exec('DELETE FROM translator_stream_assignments');
        await testEnv.DB.exec('DELETE FROM translators');
        await testEnv.DB.exec('DELETE FROM language_streams');
        await testEnv.DB.exec('DELETE FROM programs');

        await seedPlatformAdmin(testEnv);
        await seedOrgAdmin(testEnv);
        await seedViewer(testEnv);
        await seedOrg(testEnv, { id: 'org_other', name: 'Other Org' });
        await seedOrgAdmin(testEnv, {
            orgId: 'org_other',
            email: 'orgadmin-other@test.local',
        });

        const own = await seedProgram(testEnv, {
            orgId: DEFAULT_TEST_ORG_ID,
            slug: 'iso-own',
        });

        cookieA = await adminCookie(ORG_ADMIN_TEST_EMAIL);
        cookieV = await adminCookie(VIEWER_TEST_EMAIL);
        cookieB = await adminCookie('orgadmin-other@test.local');
        programId = own.id;
    });

    for (const endpoint of ENDPOINT_CASES) {
        it(`cross-org request blocked for ${endpoint.name}`, async () => {
            const ids = { ...pathIds(), programId };
            const init: RequestInitBody = {
                method: endpoint.method,
                headers: { Cookie: cookieB },
            };

            if (endpoint.method === 'POST' || endpoint.method === 'PATCH') {
                init.body = '{}';
            }

            const response = await request(endpoint.path(ids), init);
            expect(response.status).toBe(404);
            // Body MUST be the program-gate 404, not a sub-resource 404
            // (translator_not_found / stream_not_found). A misordered or missing gate
            // on a nested route would 404 on the dummy sub-id and wrongly pass a
            // status-only check — asserting the body proves the org gate fired first.
            expect(await response.json()).toEqual({ error: 'program_not_found' });
        });

        if (endpoint.write) {
            it(`viewer write blocked for ${endpoint.name}`, async () => {
                const ids = { ...pathIds(), programId };
                const init: RequestInitBody = {
                    method: endpoint.method,
                    headers: { Cookie: cookieV },
                };

                if (endpoint.method === 'POST' || endpoint.method === 'PATCH') {
                    init.body = '{}';
                }

                const response = await request(endpoint.path(ids), init);
                expect(response.status).toBe(403);
                // Body MUST be the gate's viewer-write 403, before any body parse.
                expect(await response.json()).toEqual({ error: 'forbidden' });
            });
        }
    }

    const positive = ENDPOINT_CASES.filter(
        (endpoint) =>
            endpoint.method === 'GET' &&
            [
                '/api/admin/programs/:id',
                '/api/admin/programs/:id/status',
                '/api/admin/programs/:id/streams',
                '/api/admin/programs/:id/translators',
                '/api/admin/programs/:id/events',
            ].includes(endpoint.name),
    );

    for (const endpoint of positive) {
        it(`allows same-org admin for ${endpoint.name}`, async () => {
            const ids = { ...pathIds(), programId };
            const response = await request(endpoint.path(ids), {
                method: endpoint.method,
                headers: { Cookie: cookieA },
            });

            expect(response.status).not.toBe(404);
            expect(response.status).not.toBe(403);
        });

        it(`allows same-org viewer for ${endpoint.name}`, async () => {
            const ids = { ...pathIds(), programId };
            const response = await request(endpoint.path(ids), {
                method: endpoint.method,
                headers: { Cookie: cookieV },
            });

            expect(response.status).not.toBe(404);
            expect(response.status).not.toBe(403);
        });
    }
});
