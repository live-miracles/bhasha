import { RETENTION_DAYS } from './reports';

export interface RetentionFailure {
    programId: string;
    phase: 'prune' | 'redact';
    reason: string;
}

export interface RunScheduledRetentionResult {
    pruned: number;
    redacted: number;
    failures: RetentionFailure[];
}

export interface RetentionDeps {
    listProgramsToPrune(beforeIso: string): Promise<Array<{ id: string }>>;
    listProgramsToRedact(beforeIso: string): Promise<Array<{ id: string }>>;
    pruneProgram(programId: string, beforeIso: string): Promise<boolean>;
    anonymizeProgramTelemetry(programId: string, now: Date): Promise<number>;
    markRetentionProcessed(programId: string, retentionProcessedAt: string): Promise<void>;
}

const GRACE_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILURE_REASONS = 20;

function capFailure(failures: RetentionFailure[], failure: RetentionFailure): void {
    if (failures.length >= MAX_FAILURE_REASONS) {
        return;
    }
    failures.push(failure);
}

export async function runScheduledRetention(
    deps: RetentionDeps,
    now: Date,
): Promise<RunScheduledRetentionResult> {
    const beforePrune = new Date(now.getTime() - GRACE_DAYS_MS).toISOString();
    const beforeRetention = new Date(
        now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    let pruned = 0;
    let redacted = 0;
    const failures: RetentionFailure[] = [];

    const pruneCandidates = await deps.listProgramsToPrune(beforePrune);
    for (const candidate of pruneCandidates) {
        try {
            const prunedThisProgram = await deps.pruneProgram(candidate.id, beforePrune);
            if (prunedThisProgram) {
                pruned += 1;
            }
        } catch (error) {
            capFailure(failures, {
                programId: candidate.id,
                phase: 'prune',
                reason: errorToReason(error),
            });
        }
    }

    const redactCandidates = await deps.listProgramsToRedact(beforeRetention);
    for (const candidate of redactCandidates) {
        try {
            await deps.anonymizeProgramTelemetry(candidate.id, now);
            await deps.markRetentionProcessed(candidate.id, now.toISOString());
            redacted += 1;
        } catch (error) {
            capFailure(failures, {
                programId: candidate.id,
                phase: 'redact',
                reason: errorToReason(error),
            });
        }
    }

    return { pruned, redacted, failures };
}

function errorToReason(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
