import { ApiError, apiClient } from './client';

export type VolunteerApiErrorCode =
    | 'claim_not_found'
    | 'claim_revoked'
    | 'invalid_credentials'
    | 'service_unavailable'
    | 'too_many_attempts'
    | 'volunteer_auth_required'
    | 'volunteer_not_configured';

export interface VolunteerLoginInput {
    programSlug: string;
    loginId: string;
    password: string;
}

export interface VolunteerSessionResponse {
    program: {
        slug: string;
        name: string;
    };
    approvedCount: number;
}

export type VolunteerApproveInput =
    { claimId: string; shortCode?: never } | { shortCode: string; claimId?: never };

export interface VolunteerApproveResponse {
    status: 'approved';
    already?: boolean;
}

export interface VolunteerApi {
    login(input: VolunteerLoginInput): Promise<{ ok: true }>;
    logout(): Promise<{ ok: true }>;
    session(): Promise<VolunteerSessionResponse>;
    approve(input: VolunteerApproveInput): Promise<VolunteerApproveResponse>;
}

export interface VolunteerHttpClient {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body?: unknown): Promise<T>;
}

export function isVolunteerApiError(
    error: unknown,
): error is ApiError & { readonly code: VolunteerApiErrorCode } {
    return (
        error instanceof ApiError &&
        VOLUNTEER_API_ERROR_CODES.has(error.code as VolunteerApiErrorCode)
    );
}

const VOLUNTEER_API_ERROR_CODES = new Set<VolunteerApiErrorCode>([
    'claim_not_found',
    'claim_revoked',
    'invalid_credentials',
    'service_unavailable',
    'too_many_attempts',
    'volunteer_auth_required',
    'volunteer_not_configured',
]);

export function createVolunteerApi(client: VolunteerHttpClient = apiClient): VolunteerApi {
    return {
        login(input) {
            return client.post<{ ok: true }>('/api/volunteer/login', input);
        },
        logout() {
            return client.post<{ ok: true }>('/api/volunteer/logout');
        },
        session() {
            return client.get<VolunteerSessionResponse>('/api/volunteer/session');
        },
        approve(input) {
            return client.post<VolunteerApproveResponse>('/api/volunteer/approve', input);
        },
    };
}

export const volunteerApi = createVolunteerApi();
