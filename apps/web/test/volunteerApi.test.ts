import { describe, expect, it, vi } from 'vitest';

import { createVolunteerApi, type VolunteerHttpClient } from '../src/api/volunteer';

describe('volunteer api', () => {
    it('calls the volunteer endpoints with typed login and approval payloads', async () => {
        const get = vi.fn(async () => ({
            program: { slug: 'patna-event-2026', name: 'Patna Event 2026' },
            approvedCount: 12,
        }));
        const post = vi.fn(async (path: string, body?: unknown) => {
            if (path === '/api/volunteer/approve') {
                return { status: 'approved', already: false };
            }
            return { ok: true };
        });
        const api = createVolunteerApi({ get, post } as VolunteerHttpClient);

        await expect(
            api.login({
                programSlug: 'patna-event-2026',
                loginId: 'front-gate',
                password: 'secret-pass',
            }),
        ).resolves.toEqual({ ok: true });
        await expect(api.session()).resolves.toEqual({
            program: { slug: 'patna-event-2026', name: 'Patna Event 2026' },
            approvedCount: 12,
        });
        await expect(api.approve({ claimId: 'claim_123' })).resolves.toEqual({
            status: 'approved',
            already: false,
        });
        await api.approve({ shortCode: 'ABC234' });
        await expect(api.logout()).resolves.toEqual({ ok: true });

        expect(post).toHaveBeenNthCalledWith(1, '/api/volunteer/login', {
            programSlug: 'patna-event-2026',
            loginId: 'front-gate',
            password: 'secret-pass',
        });
        expect(get).toHaveBeenCalledWith('/api/volunteer/session');
        expect(post).toHaveBeenNthCalledWith(2, '/api/volunteer/approve', {
            claimId: 'claim_123',
        });
        expect(post).toHaveBeenNthCalledWith(3, '/api/volunteer/approve', {
            shortCode: 'ABC234',
        });
        expect(post).toHaveBeenNthCalledWith(4, '/api/volunteer/logout');
    });
});
