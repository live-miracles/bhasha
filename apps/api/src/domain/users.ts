import type { UserRole } from '../db/usersRepository';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;

export interface CreateOrgInput {
    orgName: string;
    email: string;
    tempPassword: string;
}

export interface UpdateOrgInput {
    name: string;
}

export interface CreateUserInput {
    email: string;
    role: UserRole;
    tempPassword: string;
    orgId: string | null;
}

export interface UpdateUserInput {
    isDisabled?: boolean;
    role?: UserRole;
}

export interface ResetPasswordInput {
    newPassword: string;
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${field} is required`);
    }
    return value.trim();
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${label} input must be an object`);
    }
    return value as Record<string, unknown>;
}

function parseBoolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
        throw new Error(`${field} must be a boolean`);
    }
    return value;
}

function parsePassword(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new Error(`${field} is required`);
    }
    if (value.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`${field} must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    return value;
}

function parseEmail(value: unknown): string {
    const email = requireString(value, 'email').toLowerCase();
    if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
        throw new Error('email must be a valid email address');
    }
    return email;
}

function parseUserRole(value: unknown): UserRole {
    if (value === 'platform_admin' || value === 'org_admin' || value === 'viewer') {
        return value;
    }
    throw new Error('role must be platform_admin, org_admin, or viewer');
}

function parseOrgName(value: unknown): string {
    return requireString(value, 'orgName');
}

export function parseCreateOrgInput(input: unknown): CreateOrgInput {
    const data = requireRecord(input, 'create org');
    return {
        orgName: parseOrgName(data.orgName),
        email: parseEmail(data.email),
        tempPassword: parsePassword(data.tempPassword, 'tempPassword'),
    };
}

export function parseUpdateOrgInput(input: unknown): UpdateOrgInput {
    const data = requireRecord(input, 'update org');
    return { name: requireString(data.name, 'name') };
}

export function parseCreateUserInput(input: unknown): CreateUserInput {
    const data = requireRecord(input, 'create user');
    // orgId may be omitted (undefined) or explicitly null → treated as "no org".
    // A PRESENT non-null value MUST be a non-empty string; reject anything else
    // (e.g. a number) rather than silently coercing it to null.
    const orgIdInput = data.orgId;
    let orgId: string | null = null;
    if (orgIdInput !== undefined && orgIdInput !== null) {
        if (typeof orgIdInput !== 'string' || orgIdInput.trim() === '') {
            throw new Error('orgId must be a non-empty string or null');
        }
        orgId = orgIdInput.trim();
    }

    return {
        email: parseEmail(data.email),
        role: parseUserRole(data.role),
        tempPassword: parsePassword(data.tempPassword, 'tempPassword'),
        orgId,
    };
}

export function parseUpdateUserInput(input: unknown): UpdateUserInput {
    const data = requireRecord(input, 'update user');
    const output: UpdateUserInput = {};

    if (data.isDisabled !== undefined) {
        output.isDisabled = parseBoolean(data.isDisabled, 'isDisabled');
    }
    if (data.role !== undefined) {
        output.role = parseUserRole(data.role);
    }

    return output;
}

export function parseResetPasswordInput(input: unknown): ResetPasswordInput {
    const data = requireRecord(input, 'reset password');
    return { newPassword: parsePassword(data.newPassword, 'newPassword') };
}
