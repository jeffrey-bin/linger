# Install scripts

This directory holds only the entry scripts of the local model stack, plus this
README. Its release pipeline generates the scripts with pinned versions; source,
tests and release tools stay in their own repository, and the pipeline rewrites
only its scripts and its marked section below.

## Your own API keys: `user.env`

The Linger app keeps the keys you supply in `user.env` in its instance
folder, `~/.simplexai/instances/desktop/user.env` (`LINGER_HOME` replaces
`~/.simplexai`). The installer creates the file with comments on first start;
starting the services never changes it after that (the app's setup page
saves the keys typed there into it), and upgrades and reinstalls keep it. It
must stay private to you (`chmod 600`); otherwise the app stops and says how
to fix it. Docker Compose and `pnpm dev` read these keys from the root `.env`
instead.

| Name               | Turns on                                                |
| ------------------ | ------------------------------------------------------- |
| `COMPOSIO_API_KEY` | Connected apps such as Gmail, GitHub and Slack          |
| `SONIOX_API_KEY`   | Recording, dictation and meeting transcripts            |
| `XAI_API_KEY`      | Grok Live voice mode, without Soniox                    |
| `TZ`               | The services' time zone, for example `America/New_York` |

```sh
XAI_API_KEY=xai-...
SONIOX_API_KEY=...
```

Quit and reopen the Linger app after editing it: services whose configuration
changed restart, and LiveKit runs only while a voice key is set. Other names,
such as `LINGER_SECRET_SEED` or ports, are ignored with a warning, because the
installer manages them. Keys never appear in installer logs or the app's
diagnostics.

<!-- >>> llm-inference-lab: stack -->

## Local model stack: `stack.sh` / `stack.ps1`

`stack.sh` (Linux, macOS) and `stack.ps1` (Windows) run a pinned version of `localmodels stack`.
Both scripts hold only the version pin, no source: the first run downloads that version's
self-contained Python + localmodels kit for the platform from the CDN, checks the archive SHA256
pinned in the script and every file listed in the kit's `tool.json`, then caches it; later runs start
offline and need no system Python.

```sh
scripts/installs/stack.sh --help
scripts/installs/stack.sh capabilities --json
scripts/installs/stack.sh plan --offline
scripts/installs/stack.sh apply "/path/to/plan.json" --approve CONFIRMATION_ID
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\installs\stack.ps1 --help
```

Arguments pass unchanged to `localmodels stack`; with no arguments it shows the help. Where the CLI
hints say `python3 -m localmodels stack`, use `stack.sh` here. `apply` still needs the full
confirmation ID the plan prints; the scripts never plan or install on their own.

Environment variables:

- `LOCALMODELS_KIT_HOME`: kit cache directory, default `~/.cache/linger-localmodels/kits` (on Windows `%LOCALAPPDATA%\linger-localmodels\kits`).
- `LOCALMODELS_KIT_BASE_URL`: download the same files from an internal mirror; SHA256 is still checked against the pin in the script.

The Linger installer does not go through `stack.sh`; it calls the same kind of localmodels kit
directly and by convention pins the same version as here.

The same script also runs without cloning the repository: `curl -fsSL https://d2ikbbcl3j6jz9.cloudfront.net/cli/localmodels/<version>/stack.sh | sh -s -- --help`.
To follow the latest main build, use `…/cli/localmodels/mac-main/stack.sh` or `…/cli/localmodels/lin-main/stack.sh`
on macOS and Linux (the two are the same file and run on both), and `…/cli/localmodels/win-main/stack.ps1` on Windows.

The localmodels release process publishes each version's kits, both scripts and `release.json` under
`https://d2ikbbcl3j6jz9.cloudfront.net/cli/localmodels/<version>/`, and rewrites `stack.sh`, `stack.ps1` and this section
with the new pin. Do not edit them by hand. The version pin only says which published CLI runs; it does not state which
platforms or GPUs are supported.

<!-- <<< llm-inference-lab: stack -->
