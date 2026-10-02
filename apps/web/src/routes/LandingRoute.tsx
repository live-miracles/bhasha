import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';

export function LandingRoute() {
    const navigate = useNavigate();
    const [slug, setSlug] = useState('');

    function openProgram(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const normalizedSlug = slug.trim().replace(/^\/+|\/+$/g, '');
        if (normalizedSlug) {
            navigate(`/${encodeURIComponent(normalizedSlug)}`);
        }
    }

    return (
        <main aria-label="Bhasha home" className="shell shell-landing">
            <section className="landing-panel">
                <h1 className="landing-title">Bhasha</h1>
                <p>
                    Listen to an event in your language from the event link or QR code provided by
                    the organiser.
                </p>
                <form onSubmit={openProgram}>
                    <label htmlFor="program-slug">Event program slug</label>
                    <input
                        id="program-slug"
                        onChange={(event) => setSlug(event.target.value)}
                        placeholder="e.g. annual-conference"
                        required
                        value={slug}
                    />
                    <button className="landing-action" type="submit">
                        Open program
                    </button>
                </form>
                <p className="landing-note">
                    Enter the program slug provided by the event organiser.
                </p>
            </section>
        </main>
    );
}
