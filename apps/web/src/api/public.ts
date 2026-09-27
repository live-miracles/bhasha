import { ApiClient, apiClient } from './client';

export interface PublicProgramMetadata {
    program: {
        slug: string;
        name: string;
        startDate?: string | null;
        endDate?: string | null;
        listenable: boolean;
        notListenableReason: 'not_started' | 'ended' | null;
        accessControlEnabled: boolean;
    };
    streams: PublicLanguageStream[];
    urls: {
        listenerUrl: string;
        translatorUrl: string;
        approverUrl: string;
    };
}

export interface PublicProgramStatus {
    program: {
        slug: string;
        listenable: boolean;
        notListenableReason: 'not_started' | 'ended' | null;
    };
    streams: Array<{
        id: string;
        languageName: string;
        nativeName: string;
        languageCode: string;
        isActive: boolean;
        relayVersion?: string | null;
        state: 'live' | 'silent' | 'offline';
        publisherVersion?: string | null;
    }>;
    stale: boolean;
    degraded: boolean;
    serverTime: string;
}

export interface PublicLanguageStream {
    id: string;
    languageName: string;
    nativeName: string;
    languageCode: string;
    displayOrder: number;
    isActive: boolean;
}

export interface PublicApi {
    fetchProgram(programSlug: string): Promise<PublicProgramMetadata>;
    fetchProgramStatus(programSlug: string): Promise<PublicProgramStatus>;
}

export function createPublicApi(client: ApiClient = apiClient): PublicApi {
    return {
        fetchProgram(programSlug: string) {
            return client.get<PublicProgramMetadata>(
                `/api/public/programs/${encodeURIComponent(programSlug)}`,
            );
        },
        fetchProgramStatus(programSlug: string) {
            return client.get<PublicProgramStatus>(
                `/api/public/programs/${encodeURIComponent(programSlug)}/status`,
            );
        },
    };
}

export const publicApi = createPublicApi();
