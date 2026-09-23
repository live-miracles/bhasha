import { describe, expect, it } from 'vitest';

import { deviceModelNameFromCode } from '../src/domain/deviceModelName';

describe('deviceModelNameFromCode', () => {
    it('returns a non-empty mapped name for known Android device codes', () => {
        expect(deviceModelNameFromCode('M2101K7BI')).toMatch(/\S/);
    });

    it('falls back to an Android label for present but unmapped codes', () => {
        expect(deviceModelNameFromCode('UNKNOWN_ANDROID_MODEL')).toMatch(
            /^Android \(UNKNOWN_ANDROID_MODEL\)$/,
        );
    });

    it('returns null for absent or blank codes', () => {
        expect(deviceModelNameFromCode(null)).toBeNull();
        expect(deviceModelNameFromCode('')).toBeNull();
        expect(deviceModelNameFromCode('   ')).toBeNull();
    });
});
