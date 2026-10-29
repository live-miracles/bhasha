// Captures an audio input (the hall feed from a mixer or interface) and delivers it as 16 kHz
// mono PCM chunks. Processing is deliberately off: echo cancellation, noise suppression and
// automatic gain would all damage a line-level feed that is already clean.
import { PcmResampler, rmsLevel, TARGET_SAMPLE_RATE } from './pcm';

export interface AudioInputDevice {
    deviceId: string;
    label: string;
}

export interface SourceCaptureHandlers {
    onChunk(pcm: Int16Array): void;
    onLevel(level: number): void;
}

export interface SourceCapture {
    stop(): void;
}

const WORKLET_NAME = 'bhasha-source-capture';
// Mono mix-down, forwarded in blocks of 2048 samples (about 43 ms at 48 kHz).
const WORKLET_SOURCE = `
class SourceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(2048); this.filled = 0; }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) { return true; }
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < input.length; c++) { sum += input[c][i]; }
      this.buffer[this.filled++] = sum / input.length;
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', SourceCapture);
`;

export async function listAudioInputs(): Promise<AudioInputDevice[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `Audio input ${index + 1}`,
        }));
}

export async function startSourceCapture(
    deviceId: string | undefined,
    handlers: SourceCaptureHandlers,
): Promise<SourceCapture> {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
        },
    });
    const context = new AudioContext({ latencyHint: 'interactive' });
    const moduleUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
    );
    try {
        await context.audioWorklet.addModule(moduleUrl);
    } finally {
        URL.revokeObjectURL(moduleUrl);
    }

    const resampler = new PcmResampler(context.sampleRate, TARGET_SAMPLE_RATE);
    const node = new AudioWorkletNode(context, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
    });
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        handlers.onLevel(rmsLevel(event.data));
        handlers.onChunk(resampler.process(event.data));
    };
    const source = context.createMediaStreamSource(stream);
    source.connect(node);

    return {
        stop() {
            node.port.onmessage = null;
            source.disconnect();
            stream.getTracks().forEach((track) => track.stop());
            void context.close();
        },
    };
}
