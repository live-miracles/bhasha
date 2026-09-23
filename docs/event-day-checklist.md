# Event-Day Checklist

## One Week Before Event

- [ ] Create the program in the admin dashboard with final name, venue, date, and slug.
- [ ] Add every language stream in the admin dashboard.
- [ ] Create translator logins and assign each translator to the correct stream.
- [ ] Verify the listener QR opens the expected public listener URL.
- [ ] Run the realtime smoke test from the target environment.
- [ ] Complete iPhone Safari and Android Chrome checks in `docs/mobile-field-test-report.md`.
- [ ] Run load testing or record the exact blocker (see `docs/archive/load-test-report.md` for the format used by the last Cloudflare-era report; no current-stack load-test report exists yet).
- [ ] Verify current Cloudflare Realtime, Workers, Pages, D1, Durable Objects, and TURN limits in Cloudflare docs/dashboard.

## Day Before Event

- [ ] Print listener QR signage with the program name and help contact.
- [ ] Confirm translator IDs, passwords, and assigned languages.
- [ ] Confirm the readiness panel has no unhandled blocker.
- [ ] Confirm CSV export works for the program.
- [ ] Confirm event feed and listener counts load in the admin dashboard.
- [ ] Prepare backup internet for translator devices and the admin operator.

## Venue Setup

- [ ] Place listener QR signage at entrances and seating areas.
- [ ] Test venue Wi-Fi from listener seating areas.
- [ ] Test mobile data fallback from the venue.
- [ ] Keep the admin dashboard open on a support laptop.
- [ ] Keep the listener counts and event feed visible during doors-open.

## Translator Device Setup

- [ ] Open `/{programSlug}/translate` on each translator device.
- [ ] Log in with the assigned translator ID and password.
- [ ] Select the correct language stream.
- [ ] Confirm the browser requests microphone permission only.
- [ ] Start publishing and confirm the admin dashboard stream state changes to Live.
- [ ] Test mute, unmute, reconnect, and stop before the event starts.

## Listener Support Desk

- [ ] Ask listeners to scan the listener QR and choose a language.
- [ ] Confirm audio starts only after the listener taps a language.
- [ ] Confirm listeners do not receive microphone or camera prompts.
- [ ] Use the reconnect control if a listener loses audio.
- [ ] Use the language buttons to help listeners switch streams.

## During Event Monitoring

- [ ] Watch total active listeners and per-stream listener counts.
- [ ] Watch stream state for Offline, Silent, or Live.
- [ ] Watch the event feed for connection failures and reconnect spikes.
- [ ] Keep translator reconnect instructions ready.
- [ ] Keep backup internet ready for the admin operator and translators.

## Incident Response

- [ ] If a translator stream is Offline, ask the translator to press Reconnect.
- [ ] If a stream is Silent, verify the translator is unmuted and speaking into the selected microphone.
- [ ] If listener counts drop sharply, check venue network and Cloudflare dashboard status.
- [ ] If listeners report no audio, verify they tapped a language and browser audio is not muted.
- [ ] If QR scanning fails, share the listener URL directly.

## Post-Event Export And Archive

- [ ] Download the listener CSV export.
- [ ] Save the event feed summary.
- [ ] Archive the program in the admin dashboard.
- [ ] Run retention processing when the retention window is reached.
- [ ] Record operational notes for the next event.
