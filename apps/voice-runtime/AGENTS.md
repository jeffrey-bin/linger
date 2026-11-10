# Voice Runtime: LiveKit audio subscription and normalized ASR observations

## Boundary

- This directory is the worker package used by the node-services voice supervisor; it has no standalone deployment image.
- It subscribes to LiveKit microphone tracks, runs the configured streaming ASR adapter, and reports normalized observations through the generated TeamHub Voice Runtime client.
- ASR serves `hardware_control` and `chat_dictation` and publishes no audio or data tracks. The dedicated `--live` worker serves `chat_live` and publishes its reply audio and structured events.
- The supervisor starts isolated LiveKit workers: `start` (`linger-voice-runtime`) transcribes; `start --recorder` (`linger-voice-recorder`) records Capture media. While the Room metadata names an epoch, the recorder encodes the publisher track into AAC HLS segments with ffmpeg and uploads them and its state to TeamHub. It holds no object-store credentials.
- It owns no product database, Room permission, Capture classification, command execution, Artifact, Document, or Message state.
- Do not import source from another `apps/*` directory. Cross-process calls use generated contracts.

## Structure

- `src/config.ts`: validated environment configuration without logging secrets, including `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` with defaults for the LiveKit service of the root `docker-compose.yml` on its published port (TeamHub uses the same defaults), health port, session limit, Soniox model and language hints.
- `src/livekit-worker.ts`: Room/track lifecycle and bounded audio consumption.
- `src/asr.ts`: small provider interface and shared event helpers; `src/soniox.ts` is the only streaming adapter; the ASR worker requires `SONIOX_API_KEY`. The Live worker requires only `XAI_API_KEY` and shows the live model's own input transcript; it never uses Soniox. Recording always diarizes speakers; dictation does not. TeamHub reads the same key for archive recovery.
- `src/dictation-asr.ts`: `chat_dictation` turn segmentation over one Soniox connection; turns end on Soniox utterance endpoints or on a manual commit's non-closing finalization.
- `src/main.ts`: process lifecycle, health/readiness endpoints, and graceful shutdown.
- `src/recorder-agent.ts`: the recorder worker's job entry; follows the publisher track and Room metadata.
- `src/capture-recorder.ts`: Capture recording. Follows the Room metadata directive, reads the track at 48 kHz independently of ASR, pads silence to wall-clock time, uploads contiguous segments then the playlist, and reports active, available, or failed (including `recorder_handover` on shutdown).
- Tests stay beside the owning module as `*.test.ts`.

## Commands

- `pnpm --filter @linger/voice-runtime typecheck`
- `pnpm --filter @linger/voice-runtime test`
- `pnpm --filter @linger/voice-runtime build`

## Invariants

- Never log audio bytes, transcript text, LiveKit tokens, TeamHub tokens, or provider credentials.
- Partial observations are transient; TeamHub decides which final observations become product truth.
- A duplicated provider event reuses the same stable `event_id`.
- Backpressure is bounded. Failure must stop or reconnect the affected track instead of accumulating unbounded PCM.
- Shutdown waits for accepted final/progress callbacks up to a fixed deadline and then exits non-zero if state is uncertain.
- Never move recording back into the ASR job process; ASR load or failure must never stall the Capture recorder. A recorder never extends an epoch it did not start; TeamHub rejects the conflicting segment and the recorder reports failure.
