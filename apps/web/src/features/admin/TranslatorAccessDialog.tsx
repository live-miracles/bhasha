import { useEffect, useState } from 'react';
import { Alert, Button, Group, NativeSelect, Paper, Stack, Text, TextInput } from '@mantine/core';
import { QRCodeSVG } from 'qrcode.react';

import type { AdminStream, AdminTranslator, TranslatorAccessLink } from '../../api/admin';
import { AdminDialog } from './AdminDialog';
import { formatISTDateTime } from './formatTime';

const LIFETIME_OPTIONS_HOURS = [1, 3, 6, 12, 24, 48, 72];
const DEFAULT_LIFETIME_HOURS = 12;

export interface TranslatorAccessApi {
    createTranslatorAccess(
        programId: string,
        streamId: string,
        expiresInHours: number,
    ): Promise<TranslatorAccessLink>;
    revokeTranslatorAccess(programId: string, streamId: string): Promise<void>;
}

interface TranslatorAccessDialogProps {
    programId: string;
    /** The language to manage; null keeps the dialog closed. */
    stream: AdminStream | null;
    translator: AdminTranslator | undefined;
    /** True while the language is broadcasting: replacing the credential ends that broadcast. */
    isLive: boolean;
    api: TranslatorAccessApi;
    onClose: () => void;
    /** Called after a link is generated or revoked so the caller can refresh its data. */
    onChanged: () => void | Promise<void>;
}

function lifetimeLabel(hours: number): string {
    return hours === 1 ? '1 hour' : `${hours} hours`;
}

function statusText(translator: AdminTranslator | undefined, now: number): string {
    const expiresAt = translator?.accessExpiresAt;
    if (!expiresAt) {
        return 'Sign-in currently uses a password set by an admin.';
    }
    return Date.parse(expiresAt) > now
        ? `An access link is active until ${formatISTDateTime(expiresAt)}.`
        : 'The last access link has expired or was revoked.';
}

export function TranslatorAccessDialog({
    programId,
    stream,
    translator,
    isLive,
    api,
    onClose,
    onChanged,
}: TranslatorAccessDialogProps) {
    const [hours, setHours] = useState(String(DEFAULT_LIFETIME_HOURS));
    const [link, setLink] = useState<TranslatorAccessLink | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const streamId = stream?.id ?? null;
    useEffect(() => {
        // Never carry a link (a secret) from one language's dialog into another's.
        setLink(null);
        setError(null);
        setNotice(null);
        setCopied(false);
        setHours(String(DEFAULT_LIFETIME_HOURS));
    }, [streamId]);

    if (!stream) {
        return (
            <AdminDialog onClose={onClose} open={false}>
                {null}
            </AdminDialog>
        );
    }

    const hasActiveLink =
        link !== null ||
        (translator?.accessExpiresAt ? Date.parse(translator.accessExpiresAt) > Date.now() : false);

    async function generate() {
        if (!stream) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        setCopied(false);
        try {
            setLink(await api.createTranslatorAccess(programId, stream.id, Number(hours)));
            await onChanged();
        } catch (generateError) {
            setError(
                generateError instanceof Error ? generateError.message : 'Could not generate link.',
            );
        } finally {
            setBusy(false);
        }
    }

    async function revoke() {
        if (!stream) return;
        setBusy(true);
        setError(null);
        try {
            await api.revokeTranslatorAccess(programId, stream.id);
            setLink(null);
            setCopied(false);
            setNotice('Access revoked. The translator can no longer sign in.');
            await onChanged();
        } catch (revokeError) {
            setError(
                revokeError instanceof Error ? revokeError.message : 'Could not revoke access.',
            );
        } finally {
            setBusy(false);
        }
    }

    async function copy() {
        if (!link) return;
        try {
            await navigator.clipboard.writeText(link.url);
            setCopied(true);
        } catch {
            // Clipboard can be unavailable (insecure origin, permissions); the link stays
            // selectable in the field above.
            setCopied(false);
            setError('Could not copy automatically. Select the link and copy it manually.');
        }
    }

    return (
        <AdminDialog onClose={onClose} open title={`${stream.languageName} translator access`}>
            <Stack gap="md">
                <Text size="sm">{statusText(translator, Date.now())}</Text>

                {link ? (
                    <Stack gap="sm">
                        <TextInput
                            aria-label="Translator access link"
                            onFocus={(event) => event.currentTarget.select()}
                            readOnly
                            value={link.url}
                        />
                        <Group>
                            <Button onClick={() => void copy()} type="button" variant="default">
                                {copied ? 'Copied' : 'Copy link'}
                            </Button>
                        </Group>
                        <Paper bg="white" p="sm" radius="md" style={{ alignSelf: 'center' }}>
                            <QRCodeSVG
                                aria-label="Translator access QR"
                                marginSize={2}
                                size={176}
                                title="Translator access link"
                                value={link.url}
                            />
                        </Paper>
                        <Text c="dimmed" size="xs">
                            This link is shown only once — copy it now.
                        </Text>
                    </Stack>
                ) : null}

                <NativeSelect
                    data={LIFETIME_OPTIONS_HOURS.map((option) => ({
                        value: String(option),
                        label: lifetimeLabel(option),
                    }))}
                    disabled={busy}
                    label="Valid for"
                    onChange={(event) => setHours(event.currentTarget.value)}
                    value={hours}
                />

                <Alert color={isLive ? 'red' : 'yellow'}>
                    {isLive
                        ? 'This language is live. Generating a new link ends the current broadcast and signs the translator out.'
                        : 'Generating a new link replaces the current password or link and signs the translator out.'}
                </Alert>

                {error ? <Alert color="red">{error}</Alert> : null}
                {notice ? <Alert color="green">{notice}</Alert> : null}

                <Group justify="space-between">
                    <Button
                        {...(isLive ? { color: 'red' } : {})}
                        disabled={busy}
                        onClick={() => void generate()}
                        type="button"
                    >
                        {link ? 'Generate new link' : 'Generate link'}
                    </Button>
                    {hasActiveLink ? (
                        <Button
                            color="red"
                            disabled={busy}
                            onClick={() => void revoke()}
                            type="button"
                            variant="subtle"
                        >
                            Revoke access
                        </Button>
                    ) : null}
                </Group>
            </Stack>
        </AdminDialog>
    );
}
