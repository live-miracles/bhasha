import { describe, expect, it } from 'vitest';

import { floatToInt16, int16ToBase64, PcmResampler, rmsLevel } from '../src/lib/transcript/pcm';

function fromBase64(value: string): Int16Array {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    return Int16Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true));
}

describe('floatToInt16', () => {
    it('maps the float range onto 16-bit and clamps overshoot', () => {
        expect(floatToInt16(0)).toBe(0);
        expect(floatToInt16(1)).toBe(32767);
        expect(floatToInt16(-1)).toBe(-32768);
        expect(floatToInt16(3)).toBe(32767);
        expect(floatToInt16(-3)).toBe(-32768);
    });
});

describe('int16ToBase64', () => {
    it('round-trips little-endian samples, including large buffers', () => {
        const samples = Int16Array.from({ length: 50_000 }, (_, i) => ((i * 37) % 65536) - 32768);

        expect(fromBase64(int16ToBase64(samples))).toEqual(samples);
    });

    it('encodes the empty buffer as an empty string', () => {
        expect(int16ToBase64(new Int16Array())).toBe('');
    });
});

describe('PcmResampler', () => {
    it('passes audio through at the target rate', () => {
        const resampler = new PcmResampler(16_000);
        const out = resampler.process(Float32Array.from([0, 0.5, -0.5, 0.25]));

        // The last input sample waits for the next chunk so it can be interpolated.
        expect(Array.from(out)).toEqual([0, floatToInt16(0.5), floatToInt16(-0.5)]);
    });

    it('produces one third of the samples when going from 48 kHz', () => {
        const resampler = new PcmResampler(48_000);
        let total = 0;
        for (let chunk = 0; chunk < 10; chunk++) {
            total += resampler.process(new Float32Array(2048)).length;
        }

        expect(Math.abs(total - (10 * 2048) / 3)).toBeLessThanOrEqual(2);
    });

    it('gives the same result however the audio is chunked', () => {
        const input = Float32Array.from({ length: 4410 }, (_, i) => Math.sin(i / 7));
        const whole = new PcmResampler(44_100).process(input);

        const pieces = new PcmResampler(44_100);
        const parts = [input.slice(0, 1000), input.slice(1000, 1001), input.slice(1001)];
        const joined = parts.flatMap((part) => Array.from(pieces.process(part)));

        expect(joined).toEqual(Array.from(whole));
    });
});

describe('rmsLevel', () => {
    it('is zero for silence and the amplitude for a constant signal', () => {
        expect(rmsLevel(new Float32Array(100))).toBe(0);
        expect(rmsLevel(new Float32Array(100).fill(0.5))).toBeCloseTo(0.5);
        expect(rmsLevel(new Float32Array())).toBe(0);
    });
});
