import type { ReactNode } from 'react';
import { Button, MantineProvider } from '@mantine/core';
import { QRCodeSVG } from 'qrcode.react';

import type { ListenerAccessClaim, ListenerPublicProgramMetadata } from '../api/listeners';
import { bhashaTheme } from '../app/theme';

function groupedShortCode(shortCode: string): string {
    return (
        shortCode
            .replace(/\s+/g, '')
            .match(/.{1,2}/g)
            ?.join(' ') ?? shortCode
    );
}

function spelledOutShortCode(shortCode: string): string {
    return shortCode.replace(/\s+/g, '').split('').join(' ');
}

export function ListenerAccessGate({
    metadata,
    claim,
    checking,
    entered,
    error,
    message,
    retrying,
    storageDegraded,
    inAppBrowserBanner,
    onAccess,
}: {
    metadata: ListenerPublicProgramMetadata;
    claim?: ListenerAccessClaim;
    checking?: boolean;
    entered?: boolean;
    error?: string;
    message?: string;
    retrying?: boolean;
    storageDegraded: boolean;
    inAppBrowserBanner?: ReactNode;
    onAccess: () => void;
}) {
    const metaLine = [metadata.program.venue].filter(Boolean).join(' · ');

    return (
        <MantineProvider theme={bhashaTheme} defaultColorScheme="light">
            <section className="listener-screen listener-access-gate">
                <header className="lp-header">
                    <p className="eyebrow">Live translation</p>
                    <h1>{metadata.program.name}</h1>
                    {metaLine ? <p className="listener-meta">{metaLine}</p> : null}
                </header>

                {entered ? (
                    <p
                        className="lp-gate-status listener-access-entered"
                        role="status"
                        aria-live="polite"
                    >
                        You're in!
                    </p>
                ) : error ? (
                    <>
                        <h2 className="lp-gate-status">Couldn't verify access</h2>
                        <p className="listener-alert" role="alert">
                            {error}
                        </p>
                        <Button
                            className="lp-btn listener-access-button"
                            disabled={retrying ?? false}
                            onClick={onAccess}
                            type="button"
                        >
                            {retrying ? 'Retrying…' : 'Retry'}
                        </Button>
                    </>
                ) : claim ? (
                    <>
                        <h2 className="lp-gate-status">Almost there</h2>
                        <p className="lp-gate-subtext listener-access-instruction">
                            Show this screen to a volunteer, or have them scan your code.
                        </p>
                        <div className="listener-access-qr-card">
                            <QRCodeSVG
                                aria-label="Listener access QR"
                                className="listener-access-qr"
                                marginSize={4}
                                size={260}
                                title="Volunteer approval code"
                                value={`${metadata.urls.volunteerUrl}#claim=${claim.claimId}`}
                            />
                        </div>
                        <p
                            aria-label={`Access code ${spelledOutShortCode(claim.shortCode)}`}
                            className="listener-access-code"
                        >
                            {groupedShortCode(claim.shortCode)}
                        </p>
                        <Button
                            className="lp-btn listener-access-button"
                            disabled={checking ?? false}
                            onClick={onAccess}
                            type="button"
                        >
                            {checking ? 'Checking…' : 'Access'}
                        </Button>
                        {message ? (
                            <p className="listener-alert" role="status" aria-live="polite">
                                {message}
                            </p>
                        ) : null}
                        <p className="listener-access-waiting" role="status" aria-live="polite">
                            <span aria-hidden="true" className="listener-access-pulse" />
                            Waiting for a volunteer…
                        </p>
                        {storageDegraded ? (
                            <p className="listener-alert" role="status">
                                This browser can't remember your access — you may need to show this
                                screen again next time.
                            </p>
                        ) : null}
                        {inAppBrowserBanner}
                    </>
                ) : (
                    <p className="lp-info" role="status">
                        Checking access…
                    </p>
                )}
            </section>
        </MantineProvider>
    );
}
