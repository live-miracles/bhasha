import { AccessToken } from 'livekit-server-sdk';
import type { Env } from '../env';

// Reconnects just mint a fresh token, so a short TTL is fine -- there is no
// need to match the translator's 8h absolute session expiry or a listener's
// connection lifetime.
const TOKEN_TTL = '1h';

export interface MintedToken {
    token: string;
    url: string;
    roomName: string;
}

/** One LiveKit room per language stream -- no sharding/relay (see plan doc). */
export function roomNameForStream(programId: string, streamId: string): string {
    return `program-${programId}-stream-${streamId}`;
}

/**
 * The LiveKit participant identity a translator's token is minted with.
 * Exported so admin.ts's kick-publisher/kick-session endpoints can target
 * the same participant with `RoomServiceClient.removeParticipant` using
 * exactly the identity convention token minting uses.
 */
export function translatorIdentity(translatorId: string): string {
    return `translator:${translatorId}`;
}

/** The LiveKit participant identity a listener's token is minted with. */
export function listenerIdentity(connectionId: string): string {
    return `listener:${connectionId}`;
}

export interface TranslatorTokenInput {
    translatorId: string;
    publishSessionId: string;
    programId: string;
    streamId: string;
}

export async function mintTranslatorToken(
    env: Env,
    input: TranslatorTokenInput,
): Promise<MintedToken> {
    const roomName = roomNameForStream(input.programId, input.streamId);
    const accessToken = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
        identity: translatorIdentity(input.translatorId),
        ttl: TOKEN_TTL,
        metadata: JSON.stringify({
            role: 'translator',
            programId: input.programId,
            streamId: input.streamId,
            translatorId: input.translatorId,
            publishSessionId: input.publishSessionId,
        }),
    });
    accessToken.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: false,
        canPublishData: false,
    });

    return {
        token: await accessToken.toJwt(),
        url: env.LIVEKIT_URL ?? '',
        roomName,
    };
}

export interface ListenerTokenInput {
    connectionId: string;
    programId: string;
    streamId: string;
}

export async function mintListenerToken(env: Env, input: ListenerTokenInput): Promise<MintedToken> {
    const roomName = roomNameForStream(input.programId, input.streamId);
    const accessToken = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
        identity: listenerIdentity(input.connectionId),
        ttl: TOKEN_TTL,
        metadata: JSON.stringify({
            role: 'listener',
            programId: input.programId,
            streamId: input.streamId,
            connectionId: input.connectionId,
        }),
    });
    accessToken.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: false,
        canSubscribe: true,
        canPublishData: false,
    });

    return {
        token: await accessToken.toJwt(),
        url: env.LIVEKIT_URL ?? '',
        roomName,
    };
}
