import { describe, expect, it, vi } from 'vitest';

import { formatLocalTime } from '../src/features/admin/formatTime';

describe('formatLocalTime', () => {
    it('uses the browser local timezone and includes its timezone name', () => {
        const toLocaleTimeString = vi
            .spyOn(Date.prototype, 'toLocaleTimeString')
            .mockReturnValue('12:34:56 PDT');

        expect(formatLocalTime('2026-09-28T19:34:56.000Z')).toBe('12:34:56 PDT');
        expect(toLocaleTimeString).toHaveBeenCalledWith(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZoneName: 'short',
        });

        toLocaleTimeString.mockRestore();
    });
});
