import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Paper, Select, Stack, Text, Title } from '@mantine/core';

import { ApiError } from '../api/client';
import { transcriptSourceApi, type TranscriptSourceApi } from '../api/transcript';
import { ScribeSession } from '../lib/transcript/scribeSession';
import { listAudioInputs, startSourceCapture } from '../lib/transcript/sourceCapture';
import {
    SourceRelay,
    type RelaySnapshot,
    type SourceRelayDeps,
} from '../lib/transcript/sourceRelay';

export interface SourceConsoleRouteProps {
    programSlug: string;
    api?: TranscriptSourceApi;
    /** Test seams; the defaults use the real microphone and ElevenLabs. */
    capture?: Pick<SourceRelayDeps, 'startCapture'> & { listInputs?: typeof listAudioInputs };
    connectScribe?: SourceRelayDeps['connectScribe'];
}

const STATUS_LABEL: Record<RelaySnapshot['status'], string> = {
    idle: 'Not transcribing',
    starting: 'Starting…',
    live: 'Transcribing the hall feed',
    reconnecting: 'Reconnecting…',
    error: 'Stopped',
};

function newSourceId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `console-${Math.random().toString(36).slice(2)}`;
}

const IDLE: RelaySnapshot = {
    status: 'idle',
    level: 0,
    partial: '',
    segments: [],
    error: null,
    translationEnabled: false,
    standby: false,
};

export function SourceConsoleRoute({
    programSlug,
    api = transcriptSourceApi,
    capture,
    connectScribe = (config, listener) => new ScribeSession(config, listener),
}: SourceConsoleRouteProps) {
    const [snapshot, setSnapshot] = useState<RelaySnapshot>(IDLE);
    const [inputs, setInputs] = useState<Array<{ value: string; label: string }>>([]);
    const [deviceId, setDeviceId] = useState<string | null>(null);
    const [needsLogin, setNeedsLogin] = useState(false);
    const [fatal, setFatal] = useState<string | null>(null);
    const startCapture = capture?.startCapture ?? startSourceCapture;
    const listInputs = capture?.listInputs ?? listAudioInputs;

    // One id per open page: several consoles can run at once and the server tells them apart.
    const [sourceId] = useState(newSourceId);
    const relay = useMemo(
        () =>
            new SourceRelay({ programSlug, sourceId, api, startCapture, connectScribe }, (next) =>
                setSnapshot(next),
            ),
        // The seams are fixed for the page's lifetime.
        [programSlug],
    );
    const relayRef = useRef(relay);
    relayRef.current = relay;

    useEffect(() => () => void relayRef.current.stop(), [programSlug]);

    // Device names are hidden until the browser has been given microphone access once.
    async function refreshInputs() {
        try {
            const found = await listInputs();
            setInputs(found.map((device) => ({ value: device.deviceId, label: device.label })));
            setDeviceId((current) => current ?? found[0]?.deviceId ?? null);
        } catch {
            setInputs([]);
        }
    }

    useEffect(() => {
        void refreshInputs();
    }, []);

    async function handleStart() {
        setFatal(null);
        try {
            // Fail early, and visibly, if this is not a signed-in admin or nothing is configured.
            await api.send(programSlug, { type: 'state', active: false }, sourceId);
        } catch (error) {
            if (error instanceof ApiError && error.status === 401) {
                setNeedsLogin(true);
            } else if (error instanceof ApiError && error.status === 404) {
                setFatal('This program does not exist, or you do not have access to it.');
            } else {
                setFatal('Could not reach the server.');
            }
            return;
        }
        await relay.start(deviceId ?? undefined);
        void refreshInputs();
    }

    const running = snapshot.status !== 'idle' && snapshot.status !== 'error';

    return (
        <main className="source-console">
            <Stack gap="md">
                <div>
                    <Title order={2}>Hall feed transcript</Title>
                    <Text c="dimmed" size="sm">
                        Program: {programSlug}
                    </Text>
                </div>

                {needsLogin ? (
                    <Alert color="yellow" title="Sign in first">
                        This page needs an admin sign-in. <a href="/manage">Open the admin page</a>,
                        sign in, then come back.
                    </Alert>
                ) : null}
                {fatal ? <Alert color="red">{fatal}</Alert> : null}
                {snapshot.error ? (
                    <Alert color={snapshot.status === 'error' ? 'red' : 'yellow'}>
                        {snapshot.error}
                    </Alert>
                ) : null}

                {snapshot.standby && running ? (
                    <Alert color="blue" title="Standing by">
                        Another console is already sending the transcript to translators. This one
                        keeps transcribing as a spare and takes over automatically if the other one
                        stops.
                    </Alert>
                ) : null}

                <Paper p="md" withBorder>
                    <Stack gap="sm">
                        <Text size="sm">
                            Choose the input that carries the same feed the translators hear in
                            their headphones (for example the mixer output on an audio interface).
                            The English transcript goes to translators only, never to listeners
                            {snapshot.translationEnabled
                                ? ', together with a translation into each translator’s language.'
                                : '.'}
                        </Text>
                        <Select
                            allowDeselect={false}
                            data={inputs}
                            disabled={running}
                            label="Audio input"
                            onChange={setDeviceId}
                            placeholder="Default input"
                            value={deviceId}
                        />
                        <div
                            aria-label="Input level"
                            aria-valuemax={100}
                            aria-valuemin={0}
                            aria-valuenow={Math.min(100, Math.round(snapshot.level * 300))}
                            className="source-level"
                            role="meter"
                        >
                            <div
                                className="source-level-fill"
                                style={{ width: `${Math.min(100, snapshot.level * 300)}%` }}
                            />
                        </div>
                        <Text fw={600} role="status">
                            {STATUS_LABEL[snapshot.status]}
                        </Text>
                        {running ? (
                            <Button color="red" onClick={() => void relay.stop()}>
                                Stop
                            </Button>
                        ) : (
                            <Button onClick={() => void handleStart()}>Start transcribing</Button>
                        )}
                    </Stack>
                </Paper>

                <Paper p="md" withBorder>
                    <Text fw={600} mb="xs" size="sm">
                        What is being sent to translators
                    </Text>
                    {snapshot.segments.length === 0 && !snapshot.partial ? (
                        <Text c="dimmed" size="sm">
                            Nothing yet.
                        </Text>
                    ) : null}
                    {snapshot.segments.map((text, index) => (
                        <Text key={`${index}-${text}`} size="sm">
                            {text}
                        </Text>
                    ))}
                    {snapshot.partial ? (
                        <Text c="dimmed" fs="italic" size="sm">
                            {snapshot.partial}
                        </Text>
                    ) : null}
                </Paper>
            </Stack>
        </main>
    );
}
