export function LandingRoute() {
    return (
        <main aria-label="Bhasha home" className="shell shell-landing">
            <section className="landing-panel">
                <p className="eyebrow">Bhasha</p>
                <h1>Live translation for events</h1>
                <p>
                    Listen to an event in your language from the event link or QR code provided by
                    the organiser.
                </p>
                <a className="landing-action" href="/manage">
                    Manage an event
                </a>
                <p className="landing-note">
                    Organisers and program managers can sign in to create and manage events.
                </p>
            </section>
        </main>
    );
}
