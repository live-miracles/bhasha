import { describe, expect, it, vi } from "vitest";

import { createListenerApi } from "../src/api/listeners";
import type { ApiClient } from "../src/api/client";

describe("listener api", () => {
  it("maps listener access claim, status, and cacheable approval broadcast endpoints", async () => {
    const post = vi.fn(async (path: string) =>
      path.endsWith("/claim")
        ? {
            claimId: "claim_1",
            claimSecret: "claim_secret_1",
            shortCode: "K7XQAF",
          }
        : { state: "pending" as const },
    );
    const get = vi.fn(async () => ({ approved: ["claim_1"] }));
    const api = createListenerApi({ post, get } as unknown as ApiClient);

    await api.claimAccess({
      programSlug: "patna-event-2026",
      clientId: "client_1",
    });
    await api.accessStatus({
      programSlug: "patna-event-2026",
      claimId: "claim_1",
      claimSecret: "claim_secret_1",
    });
    await api.accessStatus({
      programSlug: "patna-event-2026",
      accessToken: "stored-token",
    });
    await api.approvedAccessClaims("patna-event-2026");

    expect(post).toHaveBeenNthCalledWith(1, "/api/listeners/access/claim", {
      programSlug: "patna-event-2026",
      clientId: "client_1",
    });
    expect(post).toHaveBeenNthCalledWith(2, "/api/listeners/access/status", {
      programSlug: "patna-event-2026",
      claimId: "claim_1",
      claimSecret: "claim_secret_1",
    });
    expect(post).toHaveBeenNthCalledWith(3, "/api/listeners/access/status", {
      programSlug: "patna-event-2026",
      accessToken: "stored-token",
    });
    expect(get).toHaveBeenCalledWith(
      "/api/public/programs/patna-event-2026/access/approved",
    );
  });

  it("posts the listener subscribe and control endpoints with program slugs", async () => {
    const post = vi.fn(async (path: string, body?: unknown) => {
      if (path === "/api/listeners/subscribe/session") {
        return {
          connectionId: "listener_connection_1",
          streamId: "stream_hi",
          sessionDescription: { type: "answer", sdp: "answer-sdp" },
          iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
        };
      }

      if (path === "/api/listeners/subscribe/track") {
        return {
          connectionId: "listener_connection_1",
          track: { mid: "0", trackName: "remote-track" },
          requiresImmediateRenegotiation: false,
        };
      }

      if (path === "/api/listeners/switch") {
        return { connectionId: "listener_connection_2" };
      }

      if (path === "/api/listeners/reconnect") {
        return { connectionId: "listener_connection_3" };
      }

      return { ok: true };
    });
    const api = createListenerApi({ post } as unknown as ApiClient);

    await api.subscribeSession({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      connectionId: "listener_connection_existing",
      sessionDescription: { type: "offer", sdp: "offer-sdp" },
    });
    await api.subscribeTrack({ connectionId: "listener_connection_1" });
    await api.subscribeRenegotiate({
      connectionId: "listener_connection_1",
      sessionDescription: { type: "answer", sdp: "renegotiate-answer" },
    });
    await api.connected({ connectionId: "listener_connection_1" });
    await api.heartbeat({ connectionId: "listener_connection_1" });
    await api.leave({
      connectionId: "listener_connection_1",
      reason: "listener_left",
    });
    await api.switch({
      programSlug: "patna-event-2026",
      streamId: "stream_en",
      clientId: "client_1",
      fromConnectionId: "listener_connection_1",
    });
    await api.reconnect({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      reconnectOfConnectionId: "listener_connection_1",
    });

    expect(post).toHaveBeenNthCalledWith(
      1,
      "/api/listeners/subscribe/session",
      {
        programSlug: "patna-event-2026",
        streamId: "stream_hi",
        clientId: "client_1",
        connectionId: "listener_connection_existing",
        sessionDescription: { type: "offer", sdp: "offer-sdp" },
      },
    );
    expect(post).toHaveBeenNthCalledWith(2, "/api/listeners/subscribe/track", {
      connectionId: "listener_connection_1",
    });
    expect(post).toHaveBeenNthCalledWith(
      3,
      "/api/listeners/subscribe/renegotiate",
      {
        connectionId: "listener_connection_1",
        sessionDescription: { type: "answer", sdp: "renegotiate-answer" },
      },
    );
    expect(post).toHaveBeenNthCalledWith(4, "/api/listeners/connected", {
      connectionId: "listener_connection_1",
    });
    expect(post).toHaveBeenNthCalledWith(5, "/api/listeners/heartbeat", {
      connectionId: "listener_connection_1",
    });
    expect(post).toHaveBeenNthCalledWith(6, "/api/listeners/leave", {
      connectionId: "listener_connection_1",
      reason: "listener_left",
    });
    expect(post).toHaveBeenNthCalledWith(7, "/api/listeners/switch", {
      programSlug: "patna-event-2026",
      streamId: "stream_en",
      clientId: "client_1",
      fromConnectionId: "listener_connection_1",
    });
    expect(post).toHaveBeenNthCalledWith(8, "/api/listeners/reconnect", {
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      reconnectOfConnectionId: "listener_connection_1",
    });
  });

  it("threads access tokens only through gated listener acquisition calls", async () => {
    const post = vi.fn(async () => ({ connectionId: "connection_next" }));
    const get = vi.fn(async () => ({
      sessionId: "publisher_session",
      trackName: "publisher_track",
    }));
    const api = createListenerApi({ post, get } as unknown as ApiClient);
    const accessToken = "listener-access-token";

    await api.requestConnection({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      accessToken,
    });
    await api.subscribeSession({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      sessionDescription: { type: "offer", sdp: "offer-sdp" },
      accessToken,
    });
    await api.switch({
      programSlug: "patna-event-2026",
      streamId: "stream_en",
      clientId: "client_1",
      fromConnectionId: "connection_1",
      accessToken,
    });
    await api.reconnect({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      reconnectOfConnectionId: "connection_1",
      accessToken,
    });
    await api.activePublisher({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      accessToken,
    });

    expect(post).toHaveBeenNthCalledWith(1, "/api/listeners/request", {
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      accessToken,
    });
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/api/listeners/subscribe/session",
      {
        programSlug: "patna-event-2026",
        streamId: "stream_hi",
        clientId: "client_1",
        sessionDescription: { type: "offer", sdp: "offer-sdp" },
        accessToken,
      },
    );
    expect(post).toHaveBeenNthCalledWith(3, "/api/listeners/switch", {
      programSlug: "patna-event-2026",
      streamId: "stream_en",
      clientId: "client_1",
      fromConnectionId: "connection_1",
      accessToken,
    });
    expect(post).toHaveBeenNthCalledWith(4, "/api/listeners/reconnect", {
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      reconnectOfConnectionId: "connection_1",
      accessToken,
    });
    expect(get).toHaveBeenCalledWith(
      "/api/listeners/active-publisher?programSlug=patna-event-2026&streamId=stream_hi",
      {
        headers: { "x-listener-access-token": accessToken },
      },
    );
  });

  it("keeps omitted access tokens out of existing wrapper call shapes", async () => {
    const post = vi.fn(async () => ({ connectionId: "connection_next" }));
    const get = vi.fn(async () => ({
      sessionId: "publisher_session",
      trackName: "publisher_track",
    }));
    const api = createListenerApi({ post, get } as unknown as ApiClient);

    await api.requestConnection({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
    });
    await api.activePublisher({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
    });

    expect(post).toHaveBeenCalledWith("/api/listeners/request", {
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
    });
    expect(get).toHaveBeenCalledWith(
      "/api/listeners/active-publisher?programSlug=patna-event-2026&streamId=stream_hi",
    );
  });
});
