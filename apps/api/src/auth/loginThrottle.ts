import type { Database } from '../db/sqlite';
import { sha256Hex } from './crypto';

const WINDOW_MILLISECONDS = 15 * 60 * 1000;
const IP_FAILURE_THRESHOLD = 5;
const USER_FAILURE_THRESHOLD = 20;
const TRANSLATOR_IP_FAILURE_THRESHOLD = 10;
const TRANSLATOR_USER_FAILURE_THRESHOLD = 10;
const LOCK_MILLISECONDS = 15 * 60 * 1000;

type Bucket = {
    key: string;
    threshold: number;
};

type AttemptRow = {
    window_start: string;
    attempt_count: number;
    locked_until: string | null;
};

export type LoginThrottleResult = {
    locked: boolean;
    retryAfterSeconds: number;
};

export function ensureLoginThrottleTable(
    db: Database,
    tableName: 'admin_login_attempts' | 'translator_login_attempts' = 'admin_login_attempts',
): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          bucket TEXT PRIMARY KEY,
          window_start TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          locked_until TEXT
        )
    `);
}

function retryAfterSeconds(until: string | null, now: Date): number {
    if (!until) {
        return 0;
    }
    return Math.max(1, Math.ceil((new Date(until).getTime() - now.getTime()) / 1000));
}

function normalizedUsername(username: string): string {
    return username.trim().toLowerCase();
}

async function bucketKey(prefix: string, value: string, secret: string): Promise<string> {
    return `${prefix}:${await sha256Hex(`${secret}:${value}`)}`;
}

export async function adminLoginBuckets(
    username: string,
    clientIp: string | null,
    secret: string,
): Promise<Bucket[]> {
    const buckets: Bucket[] = [
        {
            key: await bucketKey('user', normalizedUsername(username), secret),
            threshold: USER_FAILURE_THRESHOLD,
        },
    ];
    if (clientIp) {
        buckets.push({
            key: await bucketKey('ip', clientIp, secret),
            threshold: IP_FAILURE_THRESHOLD,
        });
    }
    return buckets;
}

export async function translatorLoginBuckets(
    programId: string,
    email: string,
    clientIp: string | null,
    secret: string,
): Promise<Bucket[]> {
    const buckets: Bucket[] = [
        {
            key: await bucketKey(
                'translator-user',
                `${programId}:${normalizedUsername(email)}`,
                secret,
            ),
            threshold: TRANSLATOR_USER_FAILURE_THRESHOLD,
        },
    ];
    if (clientIp) {
        buckets.push({
            key: await bucketKey('translator-ip', `${programId}:${clientIp}`, secret),
            threshold: TRANSLATOR_IP_FAILURE_THRESHOLD,
        });
    }
    return buckets;
}

export function loginThrottleStatus(
    db: Database,
    buckets: Bucket[],
    tableName: 'admin_login_attempts' | 'translator_login_attempts' = 'admin_login_attempts',
    now = new Date(),
): LoginThrottleResult {
    const nowIso = now.toISOString();
    const rows = buckets
        .map(
            (bucket) =>
                db
                    .prepare(
                        `SELECT window_start, attempt_count, locked_until
             FROM ${tableName} WHERE bucket = ?`,
                    )
                    .get(bucket.key) as AttemptRow | undefined,
        )
        .filter((row): row is AttemptRow => row !== undefined);
    const lockedUntil = rows
        .map((row) => row.locked_until)
        .filter((value): value is string => value !== null && value > nowIso)
        .sort()
        .at(-1);
    return {
        locked: lockedUntil !== undefined,
        retryAfterSeconds: retryAfterSeconds(lockedUntil ?? null, now),
    };
}

export function recordLoginFailure(
    db: Database,
    buckets: Bucket[],
    tableName: 'admin_login_attempts' | 'translator_login_attempts' = 'admin_login_attempts',
    now = new Date(),
): LoginThrottleResult {
    const nowIso = now.toISOString();
    const windowCutoff = new Date(now.getTime() - WINDOW_MILLISECONDS).toISOString();
    const lockedUntil = new Date(now.getTime() + LOCK_MILLISECONDS).toISOString();

    return db.transaction(() => {
        let latestLock: string | null = null;
        for (const bucket of buckets) {
            const current = db
                .prepare(
                    `SELECT window_start, attempt_count, locked_until
           FROM ${tableName} WHERE bucket = ?`,
                )
                .get(bucket.key) as AttemptRow | undefined;
            const isNewWindow = !current || current.window_start <= windowCutoff;
            const attemptCount = isNewWindow ? 1 : current.attempt_count + 1;
            const currentLock =
                current?.locked_until && current.locked_until > nowIso
                    ? current.locked_until
                    : null;
            const nextLock = currentLock ?? (attemptCount >= bucket.threshold ? lockedUntil : null);
            db.prepare(
                `INSERT INTO ${tableName}
           (bucket, window_start, attempt_count, locked_until)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(bucket) DO UPDATE SET
           window_start = excluded.window_start,
           attempt_count = excluded.attempt_count,
           locked_until = excluded.locked_until`,
            ).run(bucket.key, isNewWindow ? nowIso : current.window_start, attemptCount, nextLock);
            if (nextLock && (!latestLock || nextLock > latestLock)) {
                latestLock = nextLock;
            }
        }
        return {
            locked: latestLock !== null,
            retryAfterSeconds: retryAfterSeconds(latestLock, now),
        };
    })();
}

export function clearLoginFailures(
    db: Database,
    buckets: Bucket[],
    tableName: 'admin_login_attempts' | 'translator_login_attempts' = 'admin_login_attempts',
): void {
    const clear = db.transaction(() => {
        const statement = db.prepare(`DELETE FROM ${tableName} WHERE bucket = ?`);
        for (const bucket of buckets) {
            statement.run(bucket.key);
        }
    });
    clear();
}
