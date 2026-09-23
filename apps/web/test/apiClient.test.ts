import { describe, expect, it, vi } from 'vitest';

import { ApiClient, ApiError } from '../src/api/client';

describe('ApiClient', () => {
    it('allows only relative /api paths', async () => {
        const client = new ApiClient({ fetch: vi.fn() });

        await expect(client.get('https://bhasha.test/api/health')).rejects.toThrow(
            'ApiClient only accepts relative /api paths',
        );
        await expect(client.get('/public/programs/patna')).rejects.toThrow(
            'ApiClient only accepts relative /api paths',
        );
    });

    it('rejects /api paths that normalize outside the API boundary', async () => {
        const fetch = vi.fn();
        const client = new ApiClient({ fetch });

        await expect(client.get('/api/../admin')).rejects.toThrow(
            'ApiClient only accepts relative /api paths',
        );
        await expect(client.get('/api/%2e%2e/admin')).rejects.toThrow(
            'ApiClient only accepts relative /api paths',
        );
        expect(fetch).not.toHaveBeenCalled();
    });

    it('sends same-origin credentials', async () => {
        const fetch = vi.fn(async () => Response.json({ ok: true }, { status: 200 }));
        const client = new ApiClient({ fetch });

        await expect(client.get('/api/health')).resolves.toEqual({ ok: true });

        expect(fetch).toHaveBeenCalledWith('/api/health', {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
            method: 'GET',
        });
    });

    it('passes custom GET headers through with the default accept header', async () => {
        const fetch = vi.fn(async () => Response.json({ ok: true }, { status: 200 }));
        const client = new ApiClient({ fetch });

        await client.get('/api/listeners/active-publisher', {
            noStore: true,
            headers: { 'x-listener-access-token': 'listener-token' },
        });

        expect(fetch).toHaveBeenCalledWith('/api/listeners/active-publisher', {
            cache: 'no-store',
            credentials: 'same-origin',
            headers: {
                accept: 'application/json',
                'x-listener-access-token': 'listener-token',
            },
            method: 'GET',
        });
    });

    it('posts a JSON body with same-origin credentials', async () => {
        const fetch = vi.fn(async () => Response.json({ ok: true }, { status: 200 }));
        const client = new ApiClient({ fetch });

        await expect(client.post('/api/admin/login', { password: 'admin-pass' })).resolves.toEqual({
            ok: true,
        });

        expect(fetch).toHaveBeenCalledWith('/api/admin/login', {
            body: JSON.stringify({ password: 'admin-pass' }),
            credentials: 'same-origin',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
            },
            method: 'POST',
        });
    });

    it('puts a JSON body with the same request handling and path guard as POST', async () => {
        const fetch = vi.fn(async () => Response.json({ ok: true }, { status: 200 }));
        const client = new ApiClient({ fetch });

        await expect(
            client.put('/api/admin/programs/program_1/volunteer-access', {
                loginId: 'desk-team',
            }),
        ).resolves.toEqual({ ok: true });

        expect(fetch).toHaveBeenCalledWith('/api/admin/programs/program_1/volunteer-access', {
            body: JSON.stringify({ loginId: 'desk-team' }),
            credentials: 'same-origin',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
            },
            method: 'PUT',
        });
        await expect(
            client.put('https://bhasha.test/api/admin/programs/program_1', {}),
        ).rejects.toThrow('ApiClient only accepts relative /api paths');
    });

    it('patches a JSON body with the same path guard and error normalization as GET', async () => {
        const fetch = vi.fn(async () =>
            Response.json({ error: 'program_slug_locked' }, { status: 409 }),
        );
        const client = new ApiClient({ fetch });

        await expect(
            client.patch('/api/admin/programs/program_1', {
                nextSlug: 'renamed-event',
            }),
        ).rejects.toMatchObject({
            status: 409,
            code: 'program_slug_locked',
            body: { error: 'program_slug_locked' },
        });
        await expect(
            client.patch('https://bhasha.test/api/admin/programs/program_1', {}),
        ).rejects.toThrow('ApiClient only accepts relative /api paths');
    });

    it('deletes with same-origin credentials and treats 204 as no content', async () => {
        const fetch = vi.fn(async () => new Response(null, { status: 204 }));
        const client = new ApiClient({ fetch });

        await expect(
            client.delete('/api/admin/programs/program_1/streams/stream_hi'),
        ).resolves.toBeUndefined();

        expect(fetch).toHaveBeenCalledWith('/api/admin/programs/program_1/streams/stream_hi', {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
            method: 'DELETE',
        });
    });

    it('normalizes JSON error responses', async () => {
        const client = new ApiClient({
            fetch: vi.fn(async () =>
                Response.json({ error: 'program_not_found' }, { status: 404 }),
            ),
        });

        await expect(client.get('/api/public/programs/missing')).rejects.toMatchObject({
            name: 'ApiError',
            status: 404,
            code: 'program_not_found',
            body: { error: 'program_not_found' },
        } satisfies Partial<ApiError>);
    });

    it('normalizes non-JSON error responses', async () => {
        const client = new ApiClient({
            fetch: vi.fn(
                async () =>
                    new Response('worker exploded', {
                        status: 502,
                        headers: { 'content-type': 'text/plain' },
                    }),
            ),
        });

        await expect(client.get('/api/public/programs/patna')).rejects.toMatchObject({
            status: 502,
            code: 'http_error',
            body: 'worker exploded',
        });
    });

    it('normalizes malformed JSON success responses', async () => {
        const client = new ApiClient({
            fetch: vi.fn(
                async () =>
                    new Response('{ nope', {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    }),
            ),
        });

        await expect(client.get('/api/public/programs/patna')).rejects.toMatchObject({
            name: 'ApiError',
            status: 200,
            code: 'invalid_json',
            body: expect.objectContaining({
                text: '{ nope',
            }),
        } satisfies Partial<ApiError>);
    });

    it('normalizes malformed JSON error responses', async () => {
        const client = new ApiClient({
            fetch: vi.fn(
                async () =>
                    new Response('{ nope', {
                        status: 502,
                        headers: { 'content-type': 'application/json' },
                    }),
            ),
        });

        await expect(client.get('/api/public/programs/patna')).rejects.toMatchObject({
            name: 'ApiError',
            status: 502,
            code: 'invalid_json',
            body: expect.objectContaining({
                text: '{ nope',
            }),
        } satisfies Partial<ApiError>);
    });

    it('normalizes network failures', async () => {
        const client = new ApiClient({
            fetch: vi.fn(async () => {
                throw new TypeError('fetch failed');
            }),
        });

        await expect(client.get('/api/public/programs/patna')).rejects.toMatchObject({
            status: 0,
            code: 'network_error',
        });
    });
});
