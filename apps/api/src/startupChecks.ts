// Refuses to boot a public deployment that still uses the placeholder secrets from
// `.env.example` (or ones too short to be random). Local development is exempt: it is
// recognised by PUBLIC_APP_URL being unset or pointing at a loopback host.
//
// Only variable NAMES appear in the messages -- never the values.

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const MIN_SECRET_LENGTH = 32;
const DEV_LIVEKIT_KEY = 'bhasha-dev-key';
const DEV_LIVEKIT_SECRET_PREFIX = 'bhasha-dev-secret';

type EnvVars = Record<string, string | undefined>;

function hostnameOf(value: string | undefined): string | null {
    if (!value) {
        return null;
    }
    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return null;
    }
}

export function isLocalDeployment(publicAppUrl: string | undefined): boolean {
    const hostname = hostnameOf(publicAppUrl);
    if (hostname === null) {
        return true;
    }
    return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');
}

function isPlaceholder(value: string): boolean {
    return value.startsWith('replace-');
}

function isExampleDomain(hostname: string | null): boolean {
    return hostname === 'example.com' || (hostname?.endsWith('.example.com') ?? false);
}

export function deploymentProblems(env: EnvVars, options: { adminExists: boolean }): string[] {
    if (isLocalDeployment(env.PUBLIC_APP_URL)) {
        return [];
    }

    const problems: string[] = [];

    for (const name of [
        'ADMIN_SESSION_SECRET',
        'TRANSLATOR_PASSWORD_PEPPER',
        'TRANSLATOR_SESSION_SECRET',
    ]) {
        const value = env[name];
        if (!value || isPlaceholder(value)) {
            problems.push(`${name} is missing or still the .env.example placeholder`);
        } else if (value.length < MIN_SECRET_LENGTH) {
            problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
        }
    }

    // Optional (approver login is disabled when unset), but a placeholder must never be live.
    const approverSecret = env.APPROVER_SESSION_SECRET;
    if (
        approverSecret &&
        (isPlaceholder(approverSecret) || approverSecret.length < MIN_SECRET_LENGTH)
    ) {
        problems.push(
            `APPROVER_SESSION_SECRET is still the placeholder or shorter than ${MIN_SECRET_LENGTH} characters`,
        );
    }

    // Only consulted when the first admin account is created.
    if (
        !options.adminExists &&
        env.ADMIN_INITIAL_PASSWORD &&
        isPlaceholder(env.ADMIN_INITIAL_PASSWORD)
    ) {
        problems.push('ADMIN_INITIAL_PASSWORD is still the .env.example placeholder');
    }

    // LiveKit may be left unconfigured (the app boots before it is provisioned), but if it is
    // configured it must not use the published development credentials.
    if (env.LIVEKIT_API_KEY === DEV_LIVEKIT_KEY) {
        problems.push('LIVEKIT_API_KEY is still the development key');
    }
    if (env.LIVEKIT_API_SECRET?.startsWith(DEV_LIVEKIT_SECRET_PREFIX)) {
        problems.push('LIVEKIT_API_SECRET is still the development secret');
    }

    if (isExampleDomain(hostnameOf(env.PUBLIC_APP_URL))) {
        problems.push('DOMAIN / PUBLIC_APP_URL still points at example.com');
    }
    if (isExampleDomain(hostnameOf(env.LIVEKIT_URL))) {
        problems.push('LIVEKIT_URL still points at example.com');
    }

    return problems;
}

export function assertSafeDeployment(env: EnvVars, options: { adminExists: boolean }): void {
    const problems = deploymentProblems(env, options);
    if (problems.length > 0) {
        throw new Error(
            `Refusing to start: this looks like a public deployment (PUBLIC_APP_URL=${env.PUBLIC_APP_URL}) ` +
                `but the configuration is not safe:\n - ${problems.join('\n - ')}\n` +
                'Generate secrets with `openssl rand -hex 32` and set real values in .env (see .env.example).',
        );
    }
}
