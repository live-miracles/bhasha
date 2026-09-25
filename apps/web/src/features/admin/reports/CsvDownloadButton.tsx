import { useState } from 'react';
import { Alert, Button, Group } from '@mantine/core';

interface CsvDownloadButtonProps {
    onDownload: () => Promise<void>;
}

type DownloadState = 'idle' | 'downloading' | 'ready' | 'failed';

export function CsvDownloadButton({ onDownload }: CsvDownloadButtonProps) {
    const [state, setState] = useState<DownloadState>('idle');

    async function handleClick() {
        setState('downloading');
        try {
            await onDownload();
            setState('ready');
        } catch (_error) {
            setState('failed');
        }
    }

    return (
        <Group>
            <Button
                disabled={state === 'downloading'}
                loading={state === 'downloading'}
                onClick={() => void handleClick()}
                type="button"
                variant="default"
            >
                Download CSV
            </Button>
            {state === 'ready' ? (
                <Alert color="green" role="status">
                    Download ready
                </Alert>
            ) : null}
            {state === 'failed' ? (
                <Alert color="red" role="alert">
                    Download failed
                </Alert>
            ) : null}
        </Group>
    );
}
