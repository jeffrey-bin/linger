# Agent Service: Agent lifecycle and Runtime execution

The `agent` role of Node Services: Hono/TypeScript Agent
management and TeamHub callbacks. `src/agent/main.ts` exports
`startAgentService`, which mounts the Agent routes and the Runner Gateway
WebSocket on the host's shared listener. Host rules live in
`apps/node-services/AGENTS.md`; paths below are relative to
`apps/node-services`.

## Active Execution Context V0 Authority

Ordinary Room execution uses Local Run plus live-latest reads, without
Invocation admission or exact Document input staging. Preserve the current
orchestration and Human notification prompts. Dedicated delegated actions remain
separate; their Invocation identities must not enter the ordinary Room path.

Never restore Room-owned Artifact identity, per-replacement automatic Version
creation, or an Artifact write authority beside the unified Document module.

When older Agent documentation conflicts with the records above, the records
take precedence.

## Common Commands

- `pnpm --filter @linger/node-services exec vitest run <test-file>`: run
  one test.
- `pnpm --filter @linger/node-services exec vitest run --project agent`:
  run the Agent suite; `--project agent-process` runs the real process suite.
- `pnpm --filter @linger/node-services typecheck`: typecheck Node Services,
  including the Agent feature catalog check.
- `make check-node-services`: run the boundary gate.

- Keep model/provider behavior behind the existing runtime interfaces. The only
  exception is `src/runtime-model-call.ts`: a stateless prompt on the owner's
  Agent Runtime (Codex or Claude, the Runtime's default model) through the
  Daemon's one-shot `model.invoke`, for tool-less service work such as Agent
  Memory, also used by Memory, by the LLM Wiki (workspace mode), and exposed
  to TeamHub as `POST /v1/model-calls`.
  It is not a Runtime turn and never creates a Context, Local Run, or
  Operation. Callers name an owner (or an Agent placement) and a reasoning
  effort; never add a model name, gateway, or model environment variable.
- TeamHub owns persisted Agent Runtime configuration, Execution Context,
  accepted input, Inbox cursor, Local Run, RuntimeSession, Runtime status,
  Local Computer and Agent placement state. Agent Runners and Operations live
  only in the Runner Gateway's memory. Agent
  Service accesses it only through generated domain APIs and must not create a
  second production persistence authority.
- Persisted Agent configuration contains canonical serializable JSON only.
  Never persist archives, secrets, live clients, callbacks, or caller-owned host
  paths. Existing inline tools remain a process-local test seam and are not
  accepted by the Agent Management HTTP protocol.
- The executor registry (`ExecutorRegistry`, behind the `AgentManager`
  contract) owns Agent identities, restore, preparation, deletion, and the
  per-Context-key state that outlives one Context instance. Each Context
  instance is one `ContextExecutor`: its residency transitions, feature
  composition, serialized admission boundary, and Runtime. A configuration or
  Runtime change replaces the whole executor. The registry consumes TeamHub
  configuration/Context snapshots; an executor reaches registry state only
  through `ExecutorHost`.
- AgentContextHost owns Context workspace and Runtime View plans, including the
  dedicated Document Comment input. Ordinary product resources use the CLI.
  TeamHub owns message bodies, stable Message identities, database Inbox state,
  product authorization and Context availability.
- The `ContextExecutor` and its Run loop (`run-loop.ts`) own the durable
  Local Run queue, active execution, steer,
  cancellation, and the only Runtime execution path. Do not add a second
  scheduler, execution store, or Runtime executor beside it, and do not
  restore TeamHub Run admission.
- Ordinary Room/Meta execution reads effective Agent configuration before a new
  Local Run. Skill saves do not activate idle Contexts. If versions changed,
  reuse graceful activation to resume the same native history; running/steered
  and recovered executions retain their exact versions in RuntimeSession
  metadata. This metadata is not a resource grant. Contexts other than ordinary
  Meta run one read-only Context resolve before a Run; it issues no session or
  credential.
- Fixed Context activation prepares the Context workspace, publishes the
  Context View, configures CLI, and creates or resumes the Provider Runtime.
  When the Computer does not offer the Agent's model or reasoning effort,
  activation finishes every queued Run as failed with `model_not_offered`, so
  the Room shows the cause; the next input activates again. Ordinary
  resource reads do not repeat activation or replace filesystem policy. Keep
  this a fixed pipeline, not a dynamic hook registry.
- A Context View is named by the SHA-256 of its content manifest. The manifest
  names each Skill by its TeamHub package manifest and digest; the Computer
  daemon fetches the package from TeamHub with the Agent CLI credential,
  verifies the digest and projects it read-only into the Context workspace.
  Agent Service stores no Skill bytes. TeamHub configuration still selects
  versions; cached bytes confer no authority. Do not reintroduce Run Tokens,
  Run grants, Run-scoped resource snapshots, staging, or checkpoint hooks.
- Local Runner Runtimes read collaboration resources through the
  standalone TeamHub CLI, authorized by current Agent identity on each request.
  Tenant workers, resource roots, file deltas, topology registration and
  transferManifest are retired. Do not restore members/team.md/documents/fragment
  mounts or per-Run Tenant reconciliation. Keep Context-owned Skill installations, Memory,
  Playground and native Provider state; Document Comment retains its trusted
  comments.md snapshot. First use of a new view deletes only known retired Tenant
  entries, preserving user files and the other owned resources.
- Agents execute only on the user's own Local Computer over the Runner
  Gateway; each Computer owns its native Runtime home. There is no
  platform-managed cloud Computer. Never restore in-pod Host execution, a
  service-wide native home or shared app-server, E2B, or the Kubernetes cloud
  sandbox. Every Agent registration, update, and stored Ghost carries a Local
  placement; one without it is rejected.
- Default unit, integration, and fixture smoke tests use deterministic adapters
  and do not call a live model provider. Explicitly named live suites such as
  `smoke:local-runner:live` may use an authenticated provider and must remain
  outside the default gate.

## Structure

- `src/agent/executor`: the Agent executor. The process assembly
  (`application.ts`) builds the registry (`registry.ts`), which creates one
  `ContextExecutor` (`context-executor.ts`) per Context instance; the
  executor composes its features (`context-features.ts`), reaches registry
  state through `executor-host.ts`, and runs its Run loop (`run-loop.ts`).
  Around them: Context identity (`context-ref.ts`), domain types, Ghost
  configuration, the Provider seam, Runtime History, the public contract
  (`agent-manager-api.ts`), lifecycle locks (`lifecycle-coordinator.ts`),
  restart restore (`restart-restore.ts`), the TeamHub Runtime State layer
  (`teamhub-runtime-state-client.ts`, `context-store.ts`, `ghost-store.ts`,
  `context-runtime-state.ts`, `runtime-status.ts`), the activation layer
  (`workspace.ts`, `activation.ts`, `local-backend.ts`,
  `teamhub-context-resolvers.ts`), and the HTTP adapters (`http/`).
  Internal business operations use the standalone TeamHub CLI.
- `src/agent/agent-features`: feature declarations, the generated static catalog,
  scope composition, and the explicit builtin assembly; Context-bound sources
  and interaction features live here.
- `src/agent/prompt`: Agent Service-owned prompt templates and pure prompt rendering.
- `tests/agent/executor`: tests of the executor modules, the public
  AgentManager behavior, and the real process test.
- `tests/agent/executor-hook-trace.test.ts`: golden traces of feature hook
  timing against the executor's own steps, in `tests/agent/__golden__/`.

## Important Conventions

- Implement generated Agent management routes and use one handwritten adapter
  over the generated TeamHub callback client.
- TeamHub configuration snapshots contain JSON Agent configuration only.
  Canonical V0 Skill/MCP descriptors may enter the generated protocol; Skill
  archives, secrets, live objects, and caller-owned host paths may not.
- Resolve immutable Skill archives below the trusted Agent dependency root,
  then project verified independent copies into the Runtime workspace. Never
  expose cache directories as writable mounts or share mutable projections.
- Default tests use deterministic providers and fake model calls, and never
  call a live model.
- A structural executor change must reproduce the hook-trace goldens exactly;
  update them with `-u` only for an intended behavior change and say so in
  the commit.
- Keep `agent-manager-process.test.ts` in the `agent-process` Vitest project,
  which runs alone after every other project. It starts the real host with
  `NODE_SERVICES_ROLES=agent`. Its startup wait is a test watchdog, not a
  product SLA; do not mask load contention with retries or by changing product
  Runner, MCP, or WebSocket deadlines.
- Runtime secrets stay in process environment and must not be logged.
