# Local installation core

This package owns instance state, the Native service lifecycle, local account
provisioning and Computer enrollment. The installer service
(`apps/linger-installer`) adapts its structured inputs and redacted events;
the core must not import app source or depend on browser/terminal UI.

Keep instance mutations locked and private state owner-only. Never infer real
Room execution from readiness. Do not reset existing accounts or Computer IDs,
stop unrelated processes, pull mutable images, or delete volumes as recovery.
Every installation runs natively from a Linger source checkout; Docker is not
used.

Each instance directory holds `user.env` (0600), the only file a person edits:
`COMPOSIO_API_KEY`, `SONIOX_API_KEY`, `XAI_API_KEY` and `TZ`
(`user-environment.ts`). Every mode merges it into the generated
`compose.env` / `native.env` over a developer checkout's `.env` and under the
installer's own values; other names are ignored with a warning, and the file
is created from a template once and never rewritten. The desktop source
package's `.env` is not read. In a release, a voice key turns on the Compose
`voice` profile, which runs LiveKit (pinned by digest, pulled only then) with
the key pair and media ports in the instance's `livekit.env`; the gateway
forwards `/rtc` to it. `compose up` recreates what a changed `user.env`
touches; a native process restarts when its generated environment changes.
Every update or recreate path stops node-services on its own, right before
the recreate and while TeamHub is still up, so its graceful shutdown requeues
in-flight Agent Runs instead of failing them.

Move a freshly downloaded or unpacked file or folder into place with
`renameRetrying` from `fs-retry.ts`: on Windows antivirus and indexing hold
new files for a moment, and a plain rename then fails with EPERM.

Run `pnpm --filter @linger/local-installation check`; `make check-installer`
also runs its consumer, the installer, and applies to changes that affect its
public behavior.
