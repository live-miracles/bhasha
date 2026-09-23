import { describe, expect, it } from 'vitest';

import { mapUrlSection } from '../src/features/admin/AdminScreen';

describe('admin route URL helpers', () => {
    it('maps a missing section to overview', () => {
        expect(mapUrlSection(undefined)).toBe('overview');
    });

    it('maps legacy report URLs to the internal reports tab', () => {
        expect(mapUrlSection('report')).toBe('reports');
    });

    it.each(['status', 'streams', 'translators', 'overview', 'share', 'readiness', 'reports'])(
        'passes through the %s section',
        (section) => {
            expect(mapUrlSection(section)).toBe(section);
        },
    );
});
