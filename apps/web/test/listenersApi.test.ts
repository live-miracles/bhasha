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

  it("posts the listener token and control endpoints with program slugs", async () => {
    const post = vi.fn(async (path: string, body?: unknown) => {
      if (path === "/api/listeners/token") {
        return {
          connectionId: "listener_connection_1",
          token: "livekit-jwt",
          url: "wss://livekit.example.test",
          roomName: "program_1-stream_hi",
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

    await api.token({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      connectionId: "listener_connection_existing",
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

    expect(post).toHaveBeenNthCalledWith(1, "/api/listeners/token", {
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      connectionId: "listener_connection_existing",
    });
    expect(post).toHaveBeenNthCalledWith(2, "/api/listeners/connected", {
      connectionId: "listener_connection_1",
    });
    expect(post).toHaveBeenNthCalledWith(3, "/api/listeners/heartbeat", {
      connectionId: "listener_connection_1",
    });
    expect(post).toHaveBeenNthCalledWith(4, "/api/listeners/leave", {
      connectionId: "listener_connection_1",
      reason: "listener_left",
    });
    expect(post).toHaveBeenNthCalledWith(5, "/api/listeners/switch", {
      programSlug: "patna-event-2026",
      streamId: "stream_en",
      clientId: "client_1",
      fromConnectionId: "listener_connection_1",
    });
    expect(post).toHaveBeenNthCalledWith(6, "/api/listeners/reconnect", {
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      reconnectOfConnectionId: "listener_connection_1",
    });
  });

  it("threads access tokens only through gated listener acquisition calls", async () => {
    const post = vi.fn(async () => ({ connectionId: "connection_next" }));
    const api = createListenerApi({ post } as unknown as ApiClient);
    const accessToken = "listener-access-token";

    await api.requestConnection({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      accessToken,
    });
    await api.token({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      connectionId: "connection_1",
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

    expect(post).toHaveBeenNthCalledWith(1, "/api/listeners/request", {
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
      accessToken,
    });
    expect(post).toHaveBeenNthCalledWith(2, "/api/listeners/token", {
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      connectionId: "connection_1",
      accessToken,
    });
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
  });

  it("keeps omitted access tokens out of existing wrapper call shapes", async () => {
    const post = vi.fn(async () => ({ connectionId: "connection_next" }));
    const api = createListenerApi({ post } as unknown as ApiClient);

    await api.requestConnection({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
    });
    await api.token({
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      connectionId: "connection_1",
    });

    expect(post).toHaveBeenCalledWith("/api/listeners/request", {
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      clientId: "client_1",
    });
    expect(post).toHaveBeenCalledWith("/api/listeners/token", {
      programSlug: "patna-event-2026",
      streamId: "stream_hi",
      connectionId: "connection_1",
    });
  });
});
