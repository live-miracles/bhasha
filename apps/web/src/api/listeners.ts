import { apiClient, type ApiClient } from './client';
import type { PublicLanguageStream, PublicProgramMetadata, PublicProgramStatus } from './public';

export type ListenerNotListenableReason = 'not_started' | 'ended' | null;

export interface ListenerPublicProgramListenability {
    listenable: boolean;
    notListenableReason: ListenerNotListenableReason;
}

export interface ListenerPublicProgramMetadata extends Omit<PublicProgramMetadata, 'program'> {
    program: PublicProgramMetadata['program'] & ListenerPublicProgramListenability;
    streams: PublicLanguageStream[];
}

export interface ListenerPublicProgramStatus extends Omit<
    PublicProgramStatus,
    'program' | 'streams'
> {
    program: {
        slug: string;
    } & ListenerPublicProgramListenability;
    streams: PublicProgramStatus['streams'];
}

export interface ListenerConnectionInput {
    connectionId: string;
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

// Mints a subscribe-only LiveKit token for a connection already created via
// `requestConnection`/`switch`/`reconnect`. Replaces the deleted `/subscribe/
// session` + `/subscribe/track` + `/subscribe/renegotiate` SDP dance -- see
// apps/api/src/routes/listeners.ts's `handleListenerRealtimeToken` for the
// backend side.
export interface ListenerTokenInput {
    programSlug: string;
    streamId: string;
    connectionId: string;
    accessToken?: string;
}

export interface ListenerTokenResponse {
    connectionId: string;
    token: string;
    url: string;
    roomName: string;
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
    state: 'pending' | 'approved' | 'revoked' | 'unknown';
    accessToken?: string;
}

export interface ListenerApprovedAccessClaimsResponse {
    approved: string[];
}

export interface ListenerApi {
    token(input: ListenerTokenInput): Promise<ListenerTokenResponse>;
    connected(input: ListenerConnectionInput): Promise<ListenerOkResponse>;
    heartbeat(input: ListenerConnectionInput): Promise<ListenerOkResponse>;
    leave(input: ListenerLeaveInput): Promise<ListenerOkResponse>;
    switch(input: ListenerSwitchInput): Promise<ListenerReplacementResponse>;
    reconnect(input: ListenerReconnectInput): Promise<ListenerReplacementResponse>;
    requestConnection(
        input: ListenerRequestConnectionInput,
    ): Promise<ListenerRequestConnectionResponse>;
    claimAccess(input: ListenerAccessClaimInput): Promise<ListenerAccessClaim>;
    accessStatus(input: ListenerAccessStatusInput): Promise<ListenerAccessStatusResponse>;
    approvedAccessClaims(programSlug: string): Promise<ListenerApprovedAccessClaimsResponse>;
}

export function createListenerApi(client: ApiClient = apiClient): ListenerApi {
    return {
        token(input) {
            return client.post<ListenerTokenResponse>('/api/listeners/token', input);
        },
        connected(input) {
            return client.post<ListenerOkResponse>('/api/listeners/connected', input);
        },
        heartbeat(input) {
            return client.post<ListenerOkResponse>('/api/listeners/heartbeat', input);
        },
        leave(input) {
            return client.post<ListenerOkResponse>('/api/listeners/leave', input);
        },
        switch(input) {
            return client.post<ListenerReplacementResponse>('/api/listeners/switch', input);
        },
        reconnect(input) {
            return client.post<ListenerReplacementResponse>('/api/listeners/reconnect', input);
        },
        requestConnection(input) {
            return client.post<ListenerRequestConnectionResponse>('/api/listeners/request', input);
        },
        claimAccess(input) {
            return client.post<ListenerAccessClaim>('/api/listeners/access/claim', input);
        },
        accessStatus(input) {
            return client.post<ListenerAccessStatusResponse>('/api/listeners/access/status', input);
        },
        approvedAccessClaims(programSlug) {
            return client.get<ListenerApprovedAccessClaimsResponse>(
                `/api/public/programs/${encodeURIComponent(programSlug)}/access/approved`,
            );
        },
    };
}
