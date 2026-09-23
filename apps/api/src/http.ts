/**
 * Replaces Cloudflare Workers' `ExecutionContext` for route handlers that
 * used to call `ctx.waitUntil(promise)` to run background work without
 * blocking the response. A long-running Node process has no isolate
 * lifecycle to extend, so `waitUntil` here is just "run this promise to
 * completion and log if it rejects" — a plain fire-and-forget.
 */
export interface WaitUntilCtx {
    waitUntil(promise: Promise<unknown>): void;
}

export function createFireAndForgetCtx(): WaitUntilCtx {
    return {
        waitUntil(promise: Promise<unknown>) {
            promise.catch((error: unknown) => {
                console.error(
                    JSON.stringify({
                        level: 'error',
                        message: 'background_task_failed',
                        error: error instanceof Error ? error.message : String(error),
                    }),
                );
            });
        },
    };
}

export function json(data: unknown, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    return Response.json(data, { ...init, headers });
}

export function notFound(): Response {
    return json({ error: 'not_found' }, { status: 404 });
}

export async function readJson<T>(request: Request): Promise<T> {
    return (await request.json()) as T;
}
