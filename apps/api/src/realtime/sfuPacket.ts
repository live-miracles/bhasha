/**
 * SFU (Cloudflare Realtime) utilities — copied from cloudflare/realtime-examples
 * ai-tts-stt/src/shared/sfu-utils.ts, with env var names adapted to the spike .env
 * (SFU_BASE / SFU_APP_ID / SFU_APP_SECRET) and the resampling-specific helpers dropped.
 */
import { Packet } from "./packet";

/** Encode raw PCM payload into a buffer-mode Packet (seq/ts = 0). Copied verbatim. */
export function encodePcmForSfu(payload: ArrayBuffer): ArrayBuffer {
  const packet = {
    sequenceNumber: 0,
    timestamp: 0,
    payload: new Uint8Array(payload),
  };
  const bytes = Packet.toBinary(packet);
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

/** Extract PCM from an SFU Packet with the byteOffset + odd-length safety the example documents. */
export function extractPcmFromSfuPacket(packetData: ArrayBuffer): ArrayBuffer | null {
  try {
    const packet = Packet.fromBinary(new Uint8Array(packetData));
    if (!packet.payload) return null;
    let payloadView = packet.payload as Uint8Array;
    if (payloadView.byteLength % 2 !== 0) {
      payloadView = payloadView.subarray(0, payloadView.byteLength - 1);
    }
    const safeCopy = new Uint8Array(payloadView);
    return safeCopy.buffer;
  } catch (error) {
    console.error("Error decoding SFU packet:", error);
    return null;
  }
}
