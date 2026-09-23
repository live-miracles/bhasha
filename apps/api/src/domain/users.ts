import type { UserRole } from '../db/usersRepository';

// Letters, digits, underscore, hyphen and dot — no whitespace, no '@'. Kept
// deliberately permissive; the DB's case-insensitive unique index is the real
// duplicate guard.
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 8;

export interface CreateUserInput {
    username: string;
    role: UserRole;
    tempPassword: string;
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

export function parseUsername(value: unknown): string {
    const username = requireString(value, 'username').toLowerCase();
    if (
        username.length < USERNAME_MIN_LENGTH ||
        username.length > USERNAME_MAX_LENGTH ||
        !USERNAME_PATTERN.test(username)
    ) {
        throw new Error(
            `username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters and contain only letters, digits, '.', '_' or '-'`,
        );
    }
    return username;
}

function parseUserRole(value: unknown): UserRole {
    if (value === 'admin' || value === 'user') {
        return value;
    }
    throw new Error('role must be admin or user');
}

export function parseCreateUserInput(input: unknown): CreateUserInput {
    const data = requireRecord(input, 'create user');
    return {
        username: parseUsername(data.username),
        role: parseUserRole(data.role),
        tempPassword: parsePassword(data.tempPassword, 'tempPassword'),
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
