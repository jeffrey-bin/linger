# Voice Runtime Acceptance

This directory contains opt-in local acceptance runners for the real Voice media stack.

## Structure

- `*.ts`: executable acceptance scenarios run through the Voice Runtime package toolchain.
- `live-scenarios/`: opt-in live mode scenarios against xAI with production instructions and tools and mocked tool results (update timing, answer length, silent material, routing to this app's page, the web, the user's computer and apps, background tasks, personal memory). Dump TeamHub's live context first with `LIVE_CONTEXT_OUT=<file> go test -tags voicelivedump ./internal/voicelive -run TestDumpLiveContext` (from `apps/teamhub`), then `LIVE_CONTEXT_FILE=<file> [LIVE_REASONING=none] [LIVE_CUT_OFF_NOTE=off] pnpm --filter @linger/voice-runtime acceptance:live-scenarios [reps] [filter]` (production reasoning is high; `LIVE_CUT_OFF_NOTE=off` leaves out the note a cut-off reply gets, to compare). It prints aggregated metrics only; transcripts go under `.linger-runtime/live-scenarios/`.
- `live-audio/`: opt-in audio-path scenarios for live mode. Speech synthesized with macOS `say` (Samantha, English) and `ffmpeg` streams in real time into the real LiveVoiceWorker, xAI session, Silero barge-in VAD and Soniox captions; only LiveKit (a real-time playing output) and TeamHub (in-memory tasks, alerts and tool results) are replaced. It measures talk-over and swallowed turns on pauses, barge-in stop time, and when background updates and app events are heard. With the same context dump, `LIVE_CONTEXT_FILE=<file> [LIVE_AUDIO_REPS=n] [LIVE_AUDIO_ONLY=a,b] [LIVE_AUDIO_VAD_MS=ms] pnpm --filter @linger/voice-runtime acceptance:live-audio`. Timelines go under `.linger-runtime/live-audio/`.
- Generated PCM, cookies, logs, and provider responses belong under the ignored root `.linger-runtime/`; never add them here.

## Rules

- Read credentials and input media paths only from environment variables.
- Never print tokens, passwords, transcript text, or raw provider responses.
- Use explicit VoiceSession/Capture APIs and stable assertions; do not mutate PostgreSQL directly.
- A scenario must cleanly disconnect its LiveKit publisher even when an assertion fails.
- Human-facing reports show bounded opening excerpts and audio previews, not complete long transcripts. Full scoring evidence stays private under the ignored runtime root.
- Keep destructive fault injection in a separately named scenario with explicit container targets.
