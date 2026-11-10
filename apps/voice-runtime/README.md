# Voice Runtime

Voice Runtime is a TypeScript worker package: it subscribes to LiveKit microphone tracks, runs the streaming ASR adapter and reports normalized recognition observations through the generated TeamHub client.

The LiveKit SDK code is mostly Apache-2.0.
The models inside `@livekit/local-inference` are also bound by a proprietary model license:
they may be used only with LiveKit Agents,
and neither the models nor their output may be used to develop other models.
The image keeps the notices and full license texts in `/app/NOTICE` and `/app/third_party/licenses/`.
The components and their sources are listed in the root [NOTICE](../../NOTICE).

Commands, conventions and boundaries are in [AGENTS.md](./AGENTS.md).

## Running and configuration

- `node dist/main.js start` starts the ASR worker; `start --recorder` starts the recording worker from the same image. Set the log level with the LiveKit CLI's `--log-level`; `start` defaults to `info`.
- Required environment variables: `TEAMHUB_BASE_URL`, `LINGER_SECRET_SEED`. `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are optional and have defaults. The transcription workers need `SONIOX_API_KEY`, and ASR uses Soniox only; the Live worker needs only `XAI_API_KEY`, and the user's captions come from Grok's own transcription, not from Soniox. Recording transcripts always separate speakers; dictation does not.
- The health port is fixed at `4324`: in the image (`NODE_ENV=production`) it listens on every interface, and when run directly on a machine only on loopback. Each worker takes at most 16 sessions. The LiveKit address and key pair come from `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`; unset, they default to the local deployment in `apps/teamhub/deployments/voice` (`ws://127.0.0.1:17880`, `devkey` and its development secret), the same as TeamHub's defaults. In Compose, `LIVEKIT_URL` is `ws://livekit:7880`. The Soniox model and language hints are code constants.
