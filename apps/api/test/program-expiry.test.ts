import { describe, expect, it } from 'vitest';
import { isProgramExpired } from '../src/domain/programExpiry';

describe('isProgramExpired', () => {
    it('keeps a program available through its end date', () => {
        expect(isProgramExpired('2026-09-21', new Date('2026-09-21T23:59:59.000Z'))).toBe(false);
    });

    it('keeps a program available for one grace day after its end date', () => {
        expect(isProgramExpired('2026-09-21', new Date('2026-09-22T00:00:00.000Z'))).toBe(false);
        expect(isProgramExpired('2026-09-21', new Date('2026-09-22T23:59:59.000Z'))).toBe(false);
    });

    it('expires a program two days after its end date', () => {
        expect(isProgramExpired('2026-09-21', new Date('2026-09-23T00:00:00.000Z'))).toBe(true);
    });

    it('never expires a program with no end date', () => {
        expect(isProgramExpired(null, new Date('2099-01-01T00:00:00.000Z'))).toBe(false);
    });
});
