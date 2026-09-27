import { findSupportedLanguage, type SupportedLanguage } from './languages';

export interface CreateProgramInput {
    slug: string;
    name: string;
    startDate?: string;
    endDate?: string;
    accessControlEnabled?: boolean;
}

export interface UpdateProgramInput {
    name?: string;
    startDate?: string;
    endDate?: string;
    accessControlEnabled?: boolean;
    createdBy?: string;
    nextSlug?: string;
}

export interface CreateStreamInput {
    languageName: string;
    nativeName: string;
    languageCode: string;
    displayOrder: number;
    isActive: boolean;
}

export interface UpdateStreamInput {
    languageName?: string;
    nativeName?: string;
    languageCode?: string;
    displayOrder?: number;
    isActive?: boolean;
}

export interface CreateTranslatorInput {
    email: string;
    name: string;
    password: string;
}

export interface UpdateTranslatorInput {
    name: string;
}

export interface ResetTranslatorPasswordInput {
    password: string;
}

export interface CreateTranslatorAssignmentInput {
    streamId: string;
}

const PROGRAM_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Pragmatic email check: requires a single @, no whitespace, and a dotted
// domain. Good enough for an admin-curated translator roster.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;

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

function parseOptionalBoolean(value: unknown, field: string): boolean {
    if (value === undefined) {
        return true;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`${field} must be a boolean`);
    }
    return value;
}

function parseBoolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
        throw new Error(`${field} must be a boolean`);
    }
    return value;
}

function parseDisplayOrder(value: unknown): number {
    if (!Number.isInteger(value) || Number(value) < 0) {
        throw new Error('displayOrder must be a non-negative integer');
    }
    return Number(value);
}

function requireSupportedLanguage(value: unknown): SupportedLanguage {
    const languageCode = requireString(value, 'languageCode');
    const language = findSupportedLanguage(languageCode);
    if (!language) {
        throw new Error('languageCode must be a supported language code');
    }
    return language;
}

function parseProgramSlug(value: unknown, field: string): string {
    const slug = requireString(value, field);
    if (!PROGRAM_SLUG_PATTERN.test(slug)) {
        throw new Error(`${field} must use lowercase letters, numbers, and hyphens`);
    }
    return slug;
}

export function parseEmail(value: unknown): string {
    // Normalize first (trim via requireString, then lowercase) so create and
    // login agree on the stored/looked-up value, then validate.
    const email = requireString(value, 'email').toLowerCase();
    if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
        throw new Error('email must be a valid email address');
    }
    return email;
}

function parseDate(value: unknown, field: string): string {
    const date = requireString(value, field);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`${field} must be YYYY-MM-DD`);
    }
    return date;
}

export function parseCreateProgramInput(input: unknown): CreateProgramInput {
    const data = requireRecord(input, 'program');
    const slug = parseProgramSlug(data.slug, 'slug');
    const startDate = parseDate(data.startDate, 'startDate');
    const endDate = parseDate(data.endDate, 'endDate');
    if (endDate < startDate) {
        throw new Error('endDate must be on or after startDate');
    }

    const program: CreateProgramInput = {
        slug,
        name: requireString(data.name, 'name'),
        startDate,
        endDate,
    };
    if (data.accessControlEnabled !== undefined) {
        program.accessControlEnabled = parseBoolean(
            data.accessControlEnabled,
            'accessControlEnabled',
        );
    }
    return program;
}

export function parseUpdateProgramInput(input: unknown): UpdateProgramInput {
    const data = requireRecord(input, 'program update');
    const update: UpdateProgramInput = {};

    if (data.name !== undefined) {
        update.name = requireString(data.name, 'name');
    }
    if (data.startDate !== undefined) {
        const startDate = parseDate(data.startDate, 'startDate');
        update.startDate = startDate;
    }
    if (data.endDate !== undefined) {
        update.endDate = parseDate(data.endDate, 'endDate');
    }
    if (data.accessControlEnabled !== undefined) {
        update.accessControlEnabled = parseBoolean(
            data.accessControlEnabled,
            'accessControlEnabled',
        );
    }
    if (data.createdBy !== undefined) {
        update.createdBy = requireString(data.createdBy, 'createdBy');
    }
    if (data.nextSlug !== undefined) {
        update.nextSlug = parseProgramSlug(data.nextSlug, 'nextSlug');
    }

    return update;
}

export function parseCreateStreamInput(input: unknown): CreateStreamInput {
    const data = requireRecord(input, 'stream');
    // The language name is server-authoritative: it is derived from the supported
    // code, never trusted from the client (the admin picks a code via a dropdown).
    const language = requireSupportedLanguage(data.languageCode);

    return {
        languageName: language.name,
        nativeName: language.nativeName,
        languageCode: language.code,
        displayOrder: parseDisplayOrder(data.displayOrder),
        isActive: parseOptionalBoolean(data.isActive, 'isActive'),
    };
}

export function parseUpdateStreamInput(input: unknown): UpdateStreamInput {
    const data = requireRecord(input, 'stream update');
    const update: UpdateStreamInput = {};

    if (data.languageCode !== undefined) {
        // Setting the code also sets the derived, authoritative name(s).
        const language = requireSupportedLanguage(data.languageCode);
        update.languageCode = language.code;
        update.languageName = language.name;
        update.nativeName = language.nativeName;
    } else if (data.languageName !== undefined || data.nativeName !== undefined) {
        // The name(s) cannot be set independently — they always follow the code.
        throw new Error('stream language is set via languageCode');
    }
    if (data.displayOrder !== undefined) {
        update.displayOrder = parseDisplayOrder(data.displayOrder);
    }
    if (data.isActive !== undefined) {
        update.isActive = parseBoolean(data.isActive, 'isActive');
    }

    return update;
}

export function parseCreateTranslatorInput(input: unknown): CreateTranslatorInput {
    const data = requireRecord(input, 'translator');

    return {
        email: parseEmail(data.email),
        name: requireString(data.name, 'name'),
        password: requireString(data.password, 'password'),
    };
}

export function parseUpdateTranslatorInput(input: unknown): UpdateTranslatorInput {
    const data = requireRecord(input, 'translator update');

    return {
        name: requireString(data.name, 'name'),
    };
}

export function parseResetTranslatorPasswordInput(input: unknown): ResetTranslatorPasswordInput {
    const data = requireRecord(input, 'translator password reset');

    return {
        password: requireString(data.password, 'password'),
    };
}

export function parseCreateTranslatorAssignmentInput(
    input: unknown,
): CreateTranslatorAssignmentInput {
    const data = requireRecord(input, 'translator assignment');

    return {
        streamId: requireString(data.streamId, 'streamId'),
    };
}
