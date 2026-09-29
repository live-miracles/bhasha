import type { Env } from '../env';

export function publicOrigin(env: Pick<Env, 'PUBLIC_APP_URL'>, requestUrl: URL): string {
    const configuredOrigin = env.PUBLIC_APP_URL?.trim();
    if (!configuredOrigin) {
        return requestUrl.origin;
    }

    return new URL(configuredOrigin).origin;
}
