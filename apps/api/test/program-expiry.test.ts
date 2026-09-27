import { describe, expect, it } from 'vitest';
import { isProgramExpired } from '../src/domain/programExpiry';

describe('isProgramExpired', () => {
    it('keeps a program available through its end date', () => {
        expect(isProgramExpired('2026-09-27', new Date('2026-09-27T23:59:59.000Z'))).toBe(false);
    });

    it('expires a program after its end date', () => {
        expect(isProgramExpired('2026-09-27', new Date('2026-09-28T00:00:00.000Z'))).toBe(true);
    });
});
