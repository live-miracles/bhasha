export type ApiFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
    fetch?: ApiFetch;
}

export interface ApiGetOptions {
    noStore?: boolean;
    headers?: Record<string, string>;
}

const API_PATH_BASE = 'https://bhasha.local';
const API_PATH_ERROR = 'ApiClient only accepts relative /api paths';

export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly body: unknown;

    constructor(params: { status: number; code: string; body: unknown }) {
        super(params.code);
        this.name = 'ApiError';
        this.status = params.status;
        this.code = params.code;
        this.body = params.body;
    }
}

export class ApiClient {
    private readonly fetchImpl: ApiFetch;

    constructor(options: ApiClientOptions = {}) {
        this.fetchImpl =
            options.fetch ??
            ((input, init) => {
                return fetch(input, init);
            });
    }

    async get<T>(path: string, options: ApiGetOptions = {}): Promise<T> {
        return this.request<T>(path, 'GET', undefined, options);
    }

    async post<T>(path: string, body?: unknown): Promise<T> {
        return this.request<T>(path, 'POST', body);
    }

    async put<T>(path: string, body?: unknown): Promise<T> {
        return this.request<T>(path, 'PUT', body);
    }

    async patch<T>(path: string, body?: unknown): Promise<T> {
        return this.request<T>(path, 'PATCH', body);
    }

    async delete<T = void>(path: string): Promise<T> {
        return this.request<T>(path, 'DELETE');
    }

    async getBlob(path: string): Promise<Blob> {
        this.assertApiPath(path);

        let response: Response;
        try {
            response = await this.fetchImpl(path, {
                credentials: 'same-origin',
                headers: { accept: 'text/csv' },
                method: 'GET',
            });
        } catch (error) {
            if (error instanceof ApiError) {
                throw error;
            }
            throw new ApiError({ status: 0, code: 'network_error', body: error });
        }

        if (!response.ok) {
            throw new ApiError({
                status: response.status,
                code: 'http_error',
                body: await response.text(),
            });
        }

        return response.blob();
    }

    private async request<T>(
        path: string,
        method: string,
        body?: unknown,
        options: ApiGetOptions = {},
    ): Promise<T> {
        this.assertApiPath(path);

        let response: Response;
        try {
            const headers: Record<string, string> = {
                accept: 'application/json',
                ...options.headers,
            };
            const init: RequestInit = {
                credentials: 'same-origin',
                headers,
                method,
            };
            if (options.noStore) {
                init.cache = 'no-store';
            }

            if (body !== undefined) {
                headers['content-type'] = 'application/json';
                init.body = JSON.stringify(body);
            }

            response = await this.fetchImpl(path, {
                ...init,
                headers,
            });
        } catch (error) {
            if (error instanceof ApiError) {
                throw error;
            }
            throw new ApiError({
                status: 0,
                code: 'network_error',
                body: error,
            });
        }

        return this.readResponse<T>(response);
    }

    private assertApiPath(path: string): void {
        if (!path.startsWith('/') || path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
            throw new Error(API_PATH_ERROR);
        }

        const normalized = new URL(path, API_PATH_BASE);
        if (normalized.pathname !== '/api' && !normalized.pathname.startsWith('/api/')) {
            throw new Error(API_PATH_ERROR);
        }
    }

    private async readResponse<T>(response: Response): Promise<T> {
        const contentType = response.headers.get('content-type') ?? '';
        const isJson = contentType.toLowerCase().includes('application/json');

        if (response.ok) {
            if (!isJson) {
                return undefined as T;
            }
            return (await parseJsonResponse(response)) as T;
        }

        if (isJson) {
            const body = await parseJsonResponse(response);
            throw new ApiError({
                status: response.status,
                code: extractErrorCode(body),
                body,
            });
        }

        throw new ApiError({
            status: response.status,
            code: 'http_error',
            body: await response.text(),
        });
    }
}

async function parseJsonResponse(response: Response): Promise<unknown> {
    const text = await response.text();

    try {
        return JSON.parse(text) as unknown;
    } catch (error) {
        throw new ApiError({
            status: response.status,
            code: 'invalid_json',
            body: {
                text,
                parseError: error instanceof Error ? error.message : String(error),
            },
        });
    }
}

function extractErrorCode(body: unknown): string {
    if (
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof body.error === 'string'
    ) {
        return body.error;
    }

    return 'http_error';
}

export const apiClient = new ApiClient();
