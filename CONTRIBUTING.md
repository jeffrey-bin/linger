# Contributing

Thanks for helping improve Linger. This guide covers setting up a
development checkout, the checks to run before a pull request, and how
changes are reviewed. Repository-wide conventions live in
[AGENTS.md](AGENTS.md); read the nearest `AGENTS.md` before changing an app.

## Prerequisites

- Node.js 26.5.x (see `.node-version`) and pnpm 11.7.0
- Go 1.26.5
- PostgreSQL 17 with the pgvector extension, running on your machine
- FFmpeg (`ffmpeg` and `ffprobe` on `PATH`) if you work on voice recording
- Docker with Docker Compose, only for the Compose setup and for TeamHub
  integration tests

## Run it locally

From the repository root:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

`pnpm dev` starts no containers. It migrates the PostgreSQL that
`TEAMHUB_DATABASE_URL` names, then runs Web, TeamHub and the node-services
process on your machine with hot reload, plus a LiveKit server while a voice
key is set. Set `TEAMHUB_DATABASE_URL` in `.env`
to your database; the default matches the `postgres` service of the root
`docker-compose.yml`. `.env.example` holds every other value `pnpm dev` needs;
only optional personal keys (Composio, Soniox) are left empty. Check the
services with `pnpm dev:check`, and open <http://localhost:3000>.

Voice: set `SONIOX_API_KEY` (recording and dictation) or `XAI_API_KEY` (Grok
Live) in `.env`. `pnpm dev` then runs `livekit-server` from `PATH` on the ports
and keys `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` name, and
node-services starts the voice workers. Install it with `brew install livekit`
on macOS or `curl -sSL https://get.livekit.io | bash` on Linux; recording also
needs `ffmpeg` and `ffprobe`. Point `LIVEKIT_URL` at another host to use a
LiveKit server you run elsewhere instead.

To run everything in containers instead, voice included, follow
[Self-hosting](docs/self-hosting.md#build-from-source).

## Before you open a pull request

Run the focused tests for what you changed, then the fast checks for every app
you touched. None of these need a database or containers.

| Change           | Command                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Anything         | `make check BASE=origin/<target-branch>` runs every app's fast check in parallel                      |
| Web              | `make check-web`                                                                                      |
| TeamHub          | `make -C apps/teamhub fmt-check` and `cd apps/teamhub && go test ./tests/integration/layout -count=1` |
| Other apps       | the matching `make check-<app>`                                                                       |
| Contracts        | edit `contracts/openapi/`, then `pnpm contracts:generate && pnpm contracts:verify`                    |
| Repository rules | `make check-repository-gate BASE=origin/<target-branch>`                                              |

Single tests:

- Web: `pnpm --filter @linger/web test <test-file>`
- Node services: `pnpm --filter @linger/node-services exec vitest run <test-file>`
- TeamHub package: `cd apps/teamhub && go test ./internal/<pkg>`

### TeamHub integration tests

Integration tests need Docker; unit tests do not.

- All unit tests: `make -C apps/teamhub test`.
- All integration tests: `make -C apps/teamhub test-integration` (about three
  minutes).
- Only related cases:
  `cd apps/teamhub && ./scripts/with-test-database.sh go test ./tests/integration -run <Pattern>`.
- Optional shared test database: `make -C apps/teamhub test-db-up` starts one
  PostgreSQL that later runs reuse, with a separate database per test. Stop it
  with `make -C apps/teamhub test-db-down`. Set
  `TEAMHUB_TEST_DATABASE=isolated` to ignore it for one run.

Run the related integration tests when a change touches database, process,
concurrency or recovery behavior that a unit test cannot prove.

### Acceptance checks for documents and Computers

| Journey             | What to verify                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Standalone document | Mention an Agent with read access in a comment. Verify it receives the comment without joining a Room. Append a block and reopen the original comment anchor.                                                                        |
| Room and task       | Reopen a Room with history, open and close the sidebar, and check the unsent draft. Complete a task and open its delivered file through the public Web origin.                                                                       |
| Wiki                | Check first publication, then trigger a controlled generation failure. Waiting for a current publication must report failure; waiting for work to stop must not invent a published document.                                         |
| Computer            | Reconnect the same Computer and read an existing run's history. On Windows, use a uniquely named disposable file. Verify the target window before typing; separately test whether the daemon survives closing the launching session. |
| Backup and restore  | Restore a database with a message attachment into a disposable instance. Open the original message and retrieve its attachment.                                                                                                      |

Record the revision, the steps, and what the user could observe. A cross-build
does not verify a real Windows desktop; a simulated failure does not verify a
successful Wiki publication.

## Commits and pull requests

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/),
  for example `fix(web): keep the composer draft across Rooms`. A commit hook
  runs commitlint and formats staged files.
- Keep one pull request to one change. Describe what changed, why, and how you
  verified it; the pull request template lists what reviewers expect.
- Update the nearest `AGENTS.md` or README in the same pull request when
  behavior, ownership, contracts or file paths change.
- Code, comments, docs, tests and user-facing strings are English.
- Never commit secrets. Keep them in the ignored root `.env`.

## License of contributions

By contributing, you agree to the contributor terms in [LICENSE](LICENSE): the
producer may make the license stricter or more relaxed, and your contributed
code may be used commercially, including in its cloud business.
