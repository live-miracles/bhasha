# Live transcript for translators

Translators see a running transcript of the hall feed, with a translation into their own language
under or above each line. It is for translators only; listeners never receive it.

```
hall feed (mixer / interface)
   │  line input on the operator's computer
   ▼
/{program}/source   (browser, admin sign-in)
   │  16 kHz audio ──────────────► ElevenLabs Scribe v2 Realtime (WebSocket, single-use token)
   │  ◄──────────── partial + finished English text
   ▼
POST /api/admin/transcript/{slug}/events
   │  finished sentence → Claude (Anthropic Messages API), once per language being watched
   ▼
GET /api/translator/transcript/stream   (server-sent events, translator session)
   ▼
translator page: "Live transcript" panel
```

## Decisions

- **The same sound the translators hear.** The hall feed is plugged into the computer that runs the
  source console, from the same mixer output that feeds the translators' headphones. The transcript
  is therefore of exactly what they hear.
- **English source only**, as agreed. A translator whose language is English sees the English
  transcript alone.
- **The target language is automatic.** It is the language of the stream the translator is
  assigned to (`language_streams.language_name` / `language_code`); there is no selector. A
  translator with several streams gets the transcript for the one they have selected.
- **ElevenLabs transcribes, Claude translates.** ElevenLabs offers speech-to-text but not text
  translation, so each finished sentence goes to a Claude model (default `claude-haiku-5-5`) with the
  three previous sentences as context. The segment is quoted as data and the model is told never to
  follow instructions inside it.
- **The browser talks to ElevenLabs directly** with a single-use token our server mints, so the API
  key never leaves the server and the audio does not pass through our VM.
- **Nothing is stored.** The transcript lives in memory: the last 40 sentences are kept so a
  translator who reconnects catches up, and everything is gone when the process restarts. There is
  no database table and nothing in the listener reports.

## Running it

1. Set `ELEVENLABS_API_KEY` (required) and `ANTHROPIC_API_KEY` (for translation) in `.env`, then
   restart the app. With only the ElevenLabs key translators see the English transcript; with
   neither the console reports that transcription is not set up.
2. On the computer with the hall audio, sign in at `/manage`, then open
   `https://<domain>/<program-slug>/source` (the Share / QR section links to it).
3. Pick the audio input that carries the hall feed, check the level bar moves, press
   **Start transcribing**. Allow microphone access when the browser asks.
4. Translators open their normal page; the **Live transcript** panel shows
   "Waiting for the hall feed" until the console is live.

Use a desktop Chrome or Edge for the console. Keep the tab open and the computer awake during the
event; closing it stops the transcript (translators see "Waiting for the hall feed" within
~45 seconds).

## Behaviour worth knowing

- **Several consoles at once are fine.** Open the source page on as many computers as you like
  (a spare, a second operator). Each has its own id. The oldest one sends its text to translators;
  the others show "Standing by", keep transcribing, and take over automatically (within ~30 s, or
  at once if the first is stopped) if it stops, with no repeated or lost numbering. Nothing errors
  and translators never see duplicates. A standby also uses ElevenLabs while it runs, so it costs a
  second stream of transcription time.

- **Reconnects:** if the ElevenLabs connection drops, the console reconnects on its own with a
  fresh token (1 s, 2 s, 5 s, then every 10 s) and says so on screen. Speech during the gap is not
  transcribed.
- **Sentence boundaries** are decided by ElevenLabs' voice activity detection (0.8 s of silence).
  A long uninterrupted passage arrives as one long segment.
- **Translation failures** show "Translation unavailable" on that line; the next line carries on.
- **Language of the audio is fixed to English** (`language_code=en`), which also stops the
  recogniser guessing wrongly on accented speech.
- **Cost** (check current prices): ElevenLabs bills per hour of audio transcribed; Claude bills per
  token, and a Haiku-class model is a few cents per language-hour at speaking pace.
- **Privacy:** the hall audio is sent to ElevenLabs and the English text to Anthropic. Confirm both
  providers' retention terms are acceptable for the event before enabling this.

## Limits and not yet done

- Not tested against real ElevenLabs or Anthropic endpoints from this repository: the code follows
  their current documentation, and unit tests use fakes. Run a rehearsal with real keys and a
  recorded English talk before the event.
- Not tested with a real audio interface or on the translators' real computers. The panel is a
  plain scrolling list; check its size and readability next to the publishing controls on the
  screens they actually use.
- Only the final English text is relayed; there is no speaker labelling.
