# Node Services Conventions

## Boundary

- This app is one deployable Node process that hosts roles. The roles are `memory`, `llm-wiki`, `agent` (the Agent Service),
  `document`, and `voice`.
- `agent`, `memory`, and `llm-wiki` share one HTTP listener
  (`src/http-host.ts`, `NODE_SERVICES_HTTP_ADDRESS` as `host:port`,
  default `127.0.0.1:4319`; `DOCUMENT_RUNTIME_HTTP_ADDRESS`, default
  `127.0.0.1:4321`, for the Document Runtime). Each role mounts its own path prefixes: Agent
  `/v1/` (plus the `/v1/runner-gateway` WebSocket upgrade),
  Memory `/internal/v1/`, LLM Wiki `/v0/document-normalizations`
  and `/internal/v1/wiki-refreshes/`; the longest prefix wins. Prefixes must
  not collide. The host alone answers `/healthz` (process alive), `/startupz`
  (every selected role started), and `/readyz` (started and every mounted
  role's readiness ok); roles must not register their own probes.
- The `document` role keeps its own port (4321 by default) on its own worker
  thread (`src/document/main.ts`) because it installs jsdom globals and
  replaces the global `Request`/`Response`. The `voice` role supervises separate ASR, recorder and Live child processes (ports 4324–4326); it does not run audio jobs on the main thread. Other roles run on the main thread
  and must not install process globals.
- `NODE_SERVICES_ROLES` selects roles as a comma-separated list. An unset or
  empty value starts every role; an unknown role fails startup. Selected roles
  always start in the order `memory`, `llm-wiki`, `agent`, `voice`, `document`. Shutdown starts media draining immediately while other roles stop in reverse. The shared listener starts only when an HTTP role is selected.
- `src/main.ts` is the only process entrypoint. It owns SIGINT/SIGTERM through
  `src/process-lifecycle.ts`: the first signal aborts startup or starts
  ordered shutdown under the fixed 95-second `SHUTDOWN_TIMEOUT_MS`, later
  signals are ignored, and it is the only caller of `process.exit`.
- A role exports a `start*Service` function that receives the host's seams and
  returns `Promise<{ stop(): Promise<void> }>`. Roles must not register signal
  handlers, call `process.exit`, read `.env` files, or depend on
  `process.cwd()`.
- Role code stays under `src/<role>/`. Do not import another role's runtime
  modules; host-level code shared by roles stays flat under `src/`.
- Roles exchange in-process data only through host-owned seams passed to their
  start functions. The memory role returns its flashback (`src/flashback.ts`),
  and the host passes it to the agent role only when both run in the same
  process; the Agent calls it directly, not over HTTP.

## Configuration and Paths

- Roles read only the process environment. Package scripts load the root `.env`
  through `scripts/with-local-env.mjs`; images set environment variables.
- Resolve relative configured paths with `resolveConfiguredPath` from
  `src/paths.ts`, which uses the repository root. The Agent and Memory roles
  both take the Context Host root from `contextHostRoot` there. Locate
  packaged assets from `packageRoot`: `prompts/memory` and `prompts/llm-wiki`
  through `promptsRoot`. Start workers from `serviceModule`, and guard CLI
  entrypoints with `isMainModule`, never with `import.meta.url` directly: the
  desktop's offline runtime bundles each entry into one file
  (`apps/desktop/scripts/bundle-node-services.mjs`), where every module shares
  the entry's URL and relative paths resolve against the directory it runs in.
- Packages that hold model data (OCR language data, the Voice VAD binding)
  resolve through `src/model-packages.ts`: from node_modules in development
  and images, downloaded on first use where the offline runtime lists them in
  `models.json`.
- Roles log through the `JsonLogger` the host passes to `start*Service`
  (`createJsonLogger` from `@linger/service-kit/node`); the `document` role
  creates its own inside its worker thread, and the `agent` role keeps its own
  file-backed Agent log (`src/agent/observability/`), which the host drains
  on exit. Log events are `<area>.<what>` with snake_case fields; CLIs keep
  plain text. Shared guards and hashing (`isRecord`, `isNodeError`, `sleep`,
  `sha256Hex`) come from `@linger/service-kit`; do not redefine them.

## Structure

- `tests/<role>/` mirrors `src/<role>/`; host-level tests such as
  `tests/main.test.ts` and `tests/http-host.test.ts` stay flat under `tests/`.
- Role-specific rules live in `src/agent/AGENTS.md`, `src/llm-wiki/AGENTS.md`,
  and `src/document/AGENTS.md`. Memory's human-facing behavior and commands
  live in `src/memory/README.md`.
- Vitest projects: `roles` and `agent` run in parallel, `document` runs one
  file at a time after them, and `agent-process`
  (`tests/agent/executor/agent-manager-process.test.ts`, the real process)
  runs alone last.
- `scripts/generate-feature-catalog.ts` generates
  `src/agent/agent-features/catalog.generated.ts`; `typecheck` verifies it.

## Commands

- `pnpm --filter @linger/node-services check`: typecheck and lint
  concurrently, then test. `make check-node-services` runs the same gate.
- `pnpm --filter @linger/node-services exec vitest run <test-file>`: run
  one test.
- `pnpm dev:node-services` (root): start every role through
  `scripts/dev-supervisor.ts`, which waits for TeamHub, regenerates the Agent
  feature catalog, and restarts the process after a crash. It does not watch
  files, so a source change never restarts a running Wiki generation.
- `pnpm --filter @linger/node-services dev`: watch every role during
  focused work; `NODE_SERVICES_ROLES=agent` (or another role) narrows it.
- Memory CLIs: `pnpm --filter @linger/node-services memory:<command>`.

## Image

- The `Dockerfile` builds one image that runs every role: port 4319 for the
  shared listener and 4321 for the Document Runtime. Its health check uses
  both ports' `/healthz`.
