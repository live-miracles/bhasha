import { describe, expect, it } from "vitest";

import { Packet } from "../src/realtime/packet";
import {
  encodePcmForSfu,
  extractPcmFromSfuPacket
} from "../src/realtime/sfuPacket";

describe("SFU PCM packet helpers", () => {
  it("round-trips PCM payload bytes", () => {
    const payload = new Uint8Array([0, 1, 2, 3, 4, 5, 250, 251, 252, 253]);

    const packetData = encodePcmForSfu(payload.buffer);
    const decoded = extractPcmFromSfuPacket(packetData);

    expect(decoded).not.toBeNull();
    expect(Array.from(new Uint8Array(decoded!))).toEqual(Array.from(payload));
  });

  it("guards odd-length payloads by truncating to even bytes", () => {
    const oddPayload = new Uint8Array([10, 20, 30]);
    const packetData = Packet.toBinary({
      sequenceNumber: 0,
      timestamp: 0,
      payload: oddPayload
    });
    const encodedPacket = packetData.buffer.slice(
      packetData.byteOffset,
      packetData.byteOffset + packetData.byteLength
    ) as ArrayBuffer;

    const decoded = extractPcmFromSfuPacket(encodedPacket);

    expect(decoded).not.toBeNull();
    expect(Array.from(new Uint8Array(decoded!))).toEqual([10, 20]);
  });
});
