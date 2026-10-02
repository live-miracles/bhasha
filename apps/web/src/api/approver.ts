import { ApiError, apiClient } from './client';

export type ApproverApiErrorCode =
    | 'claim_not_found'
    | 'claim_revoked'
    | 'invalid_credentials'
    | 'service_unavailable'
    | 'too_many_attempts'
    | 'approver_auth_required'
    | 'approver_not_configured';

export interface ApproverLoginInput {
    programSlug: string;
    password: string;
}

export interface ApproverSessionResponse {
    program: {
        slug: string;
        name: string;
    };
    approvedCount: number;
}

export type ApproverApproveInput =
    { claimId: string; shortCode?: never } | { shortCode: string; claimId?: never };

export interface ApproverApproveResponse {
    status: 'approved';
    already?: boolean;
}

export interface ApproverApi {
    login(input: ApproverLoginInput): Promise<{ ok: true }>;
    logout(): Promise<{ ok: true }>;
    session(): Promise<ApproverSessionResponse>;
    approve(input: ApproverApproveInput): Promise<ApproverApproveResponse>;
}

export interface ApproverHttpClient {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body?: unknown): Promise<T>;
}

export function isApproverApiError(
    error: unknown,
): error is ApiError & { readonly code: ApproverApiErrorCode } {
    return (
        error instanceof ApiError &&
        APPROVER_API_ERROR_CODES.has(error.code as ApproverApiErrorCode)
    );
}

const APPROVER_API_ERROR_CODES = new Set<ApproverApiErrorCode>([
    'claim_not_found',
    'claim_revoked',
    'invalid_credentials',
    'service_unavailable',
    'too_many_attempts',
    'approver_auth_required',
    'approver_not_configured',
]);

export function createApproverApi(client: ApproverHttpClient = apiClient): ApproverApi {
    return {
        login(input) {
            return client.post<{ ok: true }>('/api/approver/login', input);
        },
        logout() {
            return client.post<{ ok: true }>('/api/approver/logout');
        },
        session() {
            return client.get<ApproverSessionResponse>('/api/approver/session');
        },
        approve(input) {
            return client.post<ApproverApproveResponse>('/api/approver/approve', input);
        },
    };
}

export const approverApi = createApproverApi();
