import { describe, expect, it, vi } from 'vitest';

import { createApproverApi, type ApproverHttpClient } from '../src/api/approver';

describe('approver api', () => {
    it('calls the approver endpoints with typed login and approval payloads', async () => {
        const get = vi.fn(async () => ({
            program: { slug: 'patna-event-2026', name: 'Patna Event 2026' },
            approvedCount: 12,
        }));
        const post = vi.fn(async (path: string, _body?: unknown) => {
            if (path === '/api/approver/approve') {
                return { status: 'approved', already: false };
            }
            return { ok: true };
        });
        const api = createApproverApi({ get, post } as ApproverHttpClient);

        await expect(
            api.login({
                programSlug: 'patna-event-2026',
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

        expect(post).toHaveBeenNthCalledWith(1, '/api/approver/login', {
            programSlug: 'patna-event-2026',
            password: 'secret-pass',
        });
        expect(get).toHaveBeenCalledWith('/api/approver/session');
        expect(post).toHaveBeenNthCalledWith(2, '/api/approver/approve', {
            claimId: 'claim_123',
        });
        expect(post).toHaveBeenNthCalledWith(3, '/api/approver/approve', {
            shortCode: 'ABC234',
        });
        expect(post).toHaveBeenNthCalledWith(4, '/api/approver/logout');
    });
});
