// Turns what the browser captures (float samples at the sound card's rate) into what the
// speech-to-text service wants: 16 kHz, mono, 16-bit little-endian PCM, base64 encoded.

export const TARGET_SAMPLE_RATE = 16_000;

/**
 * Streaming linear-interpolation resampler. It keeps its position between calls, so audio
 * arriving in arbitrary chunks comes out without clicks at the seams.
 */
export class PcmResampler {
    private readonly ratio: number;
    private position = 0;
    private previous = 0;

    constructor(inputRate: number, outputRate = TARGET_SAMPLE_RATE) {
        this.ratio = inputRate / outputRate;
    }

    process(input: Float32Array): Int16Array {
        const count = input.length;
        const out: number[] = [];
        let p = this.position;
        while (p < count - 1) {
            const index = Math.floor(p);
            const fraction = p - index;
            const a = index < 0 ? this.previous : (input[index] ?? 0);
            const b = input[index + 1] ?? 0;
            out.push(floatToInt16(a + (b - a) * fraction));
            p += this.ratio;
        }
        if (count > 0) {
            this.position = p - count;
            this.previous = input[count - 1] ?? 0;
        }
        return Int16Array.from(out);
    }
}

export function floatToInt16(sample: number): number {
    const clamped = Math.max(-1, Math.min(1, sample));
    return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

export function int16ToBase64(samples: Int16Array): string {
    // Always little-endian on the wire, whatever the host byte order.
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
    let binary = '';
    const step = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += step) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
    }
    return btoa(binary);
}

/** Root-mean-square level of float samples, 0 to 1, for the input meter. */
export function rmsLevel(samples: Float32Array): number {
    if (samples.length === 0) {
        return 0;
    }
    let sum = 0;
    for (const sample of samples) {
        sum += sample * sample;
    }
    return Math.sqrt(sum / samples.length);
}
