# Translation App — UI Design

Design mockups for the live-translation product. Built in **Pencil**. The editable
Pencil documents live in the Pencil app session (logical path
`docs/design/<name>.pen`); the durable, version-controlled artifacts in this repo
are the exported screens under `exports/`.

> Note: `.pen` files are not auto-written to the repo by the Pencil MCP. Re-export
> from the Pencil session to refresh the images, or save the `.pen` from the Pencil
> app if an encrypted source file is needed in git.

## Listener Page (`/{programSlug}`)

Audience: **1000s of concurrent, mostly-mobile users, low tech-literacy,
vernacular backgrounds**, arriving cold via a venue QR code. The whole job:
_see the program name → tap PLAY for your language → hear audio → adjust volume._

Exports:

- `exports/01-listener-idle.png` — landing after QR scan
- `exports/02-listener-now-playing.png` — a language playing + volume bar
- `exports/03-listener-connection-lost.png` — reconnect / recovery
- `exports/listener-page-screens.pdf` — all three (vector)

### Key decisions

- **Neutral / white-label.** One swappable accent token (`color-accent`, default
  `#1A6DCC`); everything else neutral so any client can rebrand by changing one value.
- **Native script is the hero.** Each language shows its native script large
  (e.g. `हिन्दी`, `தமிழ்`) with small English beneath, in **Noto Sans** (covers
  Devanagari, Tamil, Telugu, etc. in one family).
- **Big tap tiles**, full-width, ~88px. The whole tile is tappable.
- **Status without jargon:** colour + one word — green = live, amber = "PAUSED",
  grey = "WAIT" (offline). No "Silent (no audio)".
- **Big −/+ volume buttons** with a level indicator; no tiny slider.
- **PLAY toggles to STOP on the active card.** "Playing" is a subtle indicator,
  not the primary control — the card's button is always the action the user can take.
- **No listener counts in the participant view.** Active-listener counts are
  operator/admin telemetry only.

### Backend dependency

Native-script labels need a **`nativeName`** field per stream. Today the public
contract only returns English `languageName` + ISO `languageCode`
(`apps/web/src/api/public.ts`). Removing counts and the PLAY/STOP toggle are
front-end-only.

## Translator Console (`/{programSlug}/translate`)

Audience: **translators on phone or laptop, briefed but not techy**, usually
assigned **one** language. Core need: unambiguous reassurance that _"I am ON AIR
and my voice is being heard."_

Exports (full state set):

- `exports/translator-01-login.png` — email + password login
- `exports/translator-02-ready.png` — logged in, assigned language, big Go Live
- `exports/translator-03-live.png` — ON AIR + microphone-level meter + controls
- `exports/translator-04-error.png` — mic blocked / failure recovery
- `exports/translator-05-connecting.png` — acquiring mic + connecting
- `exports/translator-06-reconnecting.png` — re-establishing the session
- `exports/translator-07-muted.png` — live but muted (amber Unmute + "MUTED" pill)
- `exports/translator-08-silent-warning.png` — live but no audio detected
- `exports/translator-09-stopped.png` — stopped, can go live again
- `exports/translator-console-screens.pdf` — all nine (vector)

### Key decisions

- **Login is by email** + password (program comes from the URL).
- **ON AIR = green, not red.** Broadcast convention is red, but red is reserved
  for errors in this system. The live state is a large, animated green "ON AIR"
  badge instead — unmistakable without colliding with error red.
- **Audio meter is the hero feedback** — a segmented microphone-level meter
  (green → amber → red headroom) proves the translator's voice is being captured.
- **Stop is deliberately de-emphasized** (recessed, quietest of the three
  controls) so it isn't hit by accident mid-session; Mute is the prominent action.
- **Muted vs Silent are visually distinct:** muted = amber on the Mute button +
  "MUTED" pill (intentional); silent = amber "check your microphone" banner
  (a problem), Mute stays normal.
- **Microphone only** is stated on login and ready — camera is never accessed.
- Single focused column at all widths (phone + centered on desktop).

### Backend dependency

Login currently takes a **`translatorId`**; this design uses **email**. The
translator login contract (`apps/web/src/api/translator.ts` →
`/api/translator/login`) needs to accept email. Native-script for the assigned
language reuses the same `nativeName` field noted above.

All publish states from the `TranslatorRoute` state machine are now drawn:
`ready`, `connecting`, `live`, `live + muted`, `live + silent-warning`,
`reconnecting`, `stopped`, and `error`.

## Design tokens (shared)

Defined as Pencil variables in the listener `.pen`:

| Token                  | Hex       | Use                                     |
| ---------------------- | --------- | --------------------------------------- |
| `color-bg`             | `#F5F6F8` | page background                         |
| `color-surface`        | `#FFFFFF` | cards / bars                            |
| `color-border`         | `#DDE1E7` | borders                                 |
| `color-text-primary`   | `#111318` | native script, headings                 |
| `color-text-secondary` | `#5A6473` | English sublabels                       |
| `color-text-muted`     | `#8F97A3` | meta                                    |
| `color-accent`         | `#1A6DCC` | **swap per client** — play, active ring |
| `color-live`           | `#16A249` | live state                              |
| `color-silent`         | `#D97706` | paused / silent (amber)                 |
| `color-offline`        | `#C0C7D0` | offline (grey)                          |

Font: **Noto Sans** (weights 400/600), line-height ≥1.4 for Indic scripts.
