import { apiClient, type ApiClient } from "./client";
import type {
  PublicLanguageStream,
  PublicProgramMetadata,
  PublicProgramStatus,
} from "./public";

export type ListenerNotListenableReason = "not_started" | "ended" | null;

export interface ListenerPublicProgramListenability {
  listenable: boolean;
  notListenableReason: ListenerNotListenableReason;
}

export interface ListenerPublicProgramMetadata extends Omit<
  PublicProgramMetadata,
  "program"
> {
  program: PublicProgramMetadata["program"] &
    ListenerPublicProgramListenability;
  streams: PublicLanguageStream[];
}

export interface ListenerPublicProgramStatus extends Omit<
  PublicProgramStatus,
  "program" | "streams"
> {
  program: {
    slug: string;
  } & ListenerPublicProgramListenability;
  streams: PublicProgramStatus["streams"];
}

export interface ListenerSessionDescription {
  type: RTCSdpType;
  sdp: string;
}

export interface ListenerSubscribeSessionInput {
  programSlug: string;
  streamId: string;
  clientId: string;
  connectionId?: string;
  sessionDescription: RTCSessionDescriptionInit;
  accessToken?: string;
}

export interface ListenerSubscribeSessionResponse {
  connectionId: string;
  streamId: string;
  sessionDescription: ListenerSessionDescription;
  iceServers?: RTCIceServer[];
}

export interface ListenerSubscribeTrackResponse {
  connectionId: string;
  track: {
    mid: string;
    trackName?: string;
    sessionId?: string;
  };
  requiresImmediateRenegotiation: boolean;
  sessionDescription?: ListenerSessionDescription;
}

export interface ListenerConnectionInput {
  connectionId: string;
}

export interface ListenerSubscribeRenegotiateInput extends ListenerConnectionInput {
  sessionDescription: RTCSessionDescriptionInit;
}

export interface ListenerLeaveInput extends ListenerConnectionInput {
  reason: string;
}

export interface ListenerSwitchInput {
  programSlug: string;
  streamId: string;
  clientId: string;
  fromConnectionId: string;
  accessToken?: string;
}

export interface ListenerReconnectInput {
  programSlug: string;
  streamId: string;
  clientId: string;
  reconnectOfConnectionId: string;
  accessToken?: string;
}

export interface ListenerReplacementResponse {
  connectionId: string;
}

export interface ListenerOkResponse {
  ok: true;
}

export interface ListenerIceServersInput {
  programSlug: string;
  clientId: string;
}

export interface ListenerIceServersResponse {
  iceServers?: RTCIceServer[];
}

export interface ListenerRequestConnectionInput {
  programSlug: string;
  streamId: string;
  clientId: string;
  accessToken?: string;
}

export interface ListenerRequestConnectionResponse {
  connectionId: string;
}

export interface ListenerActivePublisherInput {
  programSlug: string;
  streamId: string;
  accessToken?: string;
}

export interface ListenerActivePublisherResponse {
  sessionId: string;
  trackName: string;
}

export interface ListenerAccessClaimInput {
  programSlug: string;
  clientId: string;
}

export interface ListenerAccessClaim {
  claimId: string;
  claimSecret: string;
  shortCode: string;
}

export type ListenerAccessStatusInput =
  | {
      programSlug: string;
      accessToken: string;
    }
  | {
      programSlug: string;
      claimId: string;
      claimSecret: string;
    };

export interface ListenerAccessStatusResponse {
  state: "pending" | "approved" | "revoked" | "unknown";
  accessToken?: string;
}

export interface ListenerApprovedAccessClaimsResponse {
  approved: string[];
}

export interface ListenerApi {
  subscribeSession(
    input: ListenerSubscribeSessionInput,
  ): Promise<ListenerSubscribeSessionResponse>;
  subscribeTrack(
    input: ListenerConnectionInput,
  ): Promise<ListenerSubscribeTrackResponse>;
  subscribeRenegotiate(
    input: ListenerSubscribeRenegotiateInput,
  ): Promise<ListenerOkResponse>;
  connected(input: ListenerConnectionInput): Promise<ListenerOkResponse>;
  heartbeat(input: ListenerConnectionInput): Promise<ListenerOkResponse>;
  leave(input: ListenerLeaveInput): Promise<ListenerOkResponse>;
  switch(input: ListenerSwitchInput): Promise<ListenerReplacementResponse>;
  reconnect(
    input: ListenerReconnectInput,
  ): Promise<ListenerReplacementResponse>;
  iceServers(
    input: ListenerIceServersInput,
  ): Promise<ListenerIceServersResponse>;
  requestConnection(
    input: ListenerRequestConnectionInput,
  ): Promise<ListenerRequestConnectionResponse>;
  activePublisher(
    input: ListenerActivePublisherInput,
  ): Promise<ListenerActivePublisherResponse>;
  claimAccess(input: ListenerAccessClaimInput): Promise<ListenerAccessClaim>;
  accessStatus(
    input: ListenerAccessStatusInput,
  ): Promise<ListenerAccessStatusResponse>;
  approvedAccessClaims(
    programSlug: string,
  ): Promise<ListenerApprovedAccessClaimsResponse>;
}

export function createListenerApi(client: ApiClient = apiClient): ListenerApi {
  return {
    subscribeSession(input) {
      return client.post<ListenerSubscribeSessionResponse>(
        "/api/listeners/subscribe/session",
        input,
      );
    },
    subscribeTrack(input) {
      return client.post<ListenerSubscribeTrackResponse>(
        "/api/listeners/subscribe/track",
        input,
      );
    },
    subscribeRenegotiate(input) {
      return client.post<ListenerOkResponse>(
        "/api/listeners/subscribe/renegotiate",
        input,
      );
    },
    connected(input) {
      return client.post<ListenerOkResponse>("/api/listeners/connected", input);
    },
    heartbeat(input) {
      return client.post<ListenerOkResponse>("/api/listeners/heartbeat", input);
    },
    leave(input) {
      return client.post<ListenerOkResponse>("/api/listeners/leave", input);
    },
    switch(input) {
      return client.post<ListenerReplacementResponse>(
        "/api/listeners/switch",
        input,
      );
    },
    reconnect(input) {
      return client.post<ListenerReplacementResponse>(
        "/api/listeners/reconnect",
        input,
      );
    },
    iceServers(input) {
      const query = new URLSearchParams({
        programSlug: input.programSlug,
        clientId: input.clientId,
      });
      return client.get<ListenerIceServersResponse>(
        `/api/listeners/ice-servers?${query.toString()}`,
      );
    },
    requestConnection(input) {
      return client.post<ListenerRequestConnectionResponse>(
        "/api/listeners/request",
        input,
      );
    },
    activePublisher(input) {
      const query = new URLSearchParams({
        programSlug: input.programSlug,
        streamId: input.streamId,
      });
      const path = `/api/listeners/active-publisher?${query.toString()}`;
      return input.accessToken
        ? client.get<ListenerActivePublisherResponse>(path, {
            headers: { "x-listener-access-token": input.accessToken },
          })
        : client.get<ListenerActivePublisherResponse>(path);
    },
    claimAccess(input) {
      return client.post<ListenerAccessClaim>(
        "/api/listeners/access/claim",
        input,
      );
    },
    accessStatus(input) {
      return client.post<ListenerAccessStatusResponse>(
        "/api/listeners/access/status",
        input,
      );
    },
    approvedAccessClaims(programSlug) {
      return client.get<ListenerApprovedAccessClaimsResponse>(
        `/api/public/programs/${encodeURIComponent(programSlug)}/access/approved`,
      );
    },
  };
}
