# TeamHub: Collaboration and persistence authority

Go service owning Human HTTP/SSE, Agent callbacks, and active product state.

## Common Commands

- `go test ./internal/<feature> -run <TestName>`: run one focused Go test from `apps/teamhub`.
- `make -C apps/teamhub check`: run formatting, unit, script, and contract checks
  (doc links run in the root `make check-docs`).
- Before opening a pull request, run `make -C apps/teamhub fmt-check` and
  `go test ./tests/integration/layout -count=1`.
- `make -C apps/teamhub test-integration`: run the default PostgreSQL integration
  suite with plain `go test`. `PARALLEL` overrides go test's `-parallel`
  (default GOMAXPROCS); CI does not run this suite.
- `make -C apps/teamhub test-integration-process` and
  `make -C apps/teamhub test-integration-migrations`: run the build-tagged
  process and fresh-install migration suites.
- `make -C apps/teamhub generate`: regenerate OpenAPI and sqlc outputs after source changes.

## Structure

- `internal/app`: routing, authentication, request decoding, response encoding,
  and error mapping. `app.go` and `feature*.go` build the domain services.
- `internal/<feature>`: business behavior, transactions and data access with
  package tests: `collaboration` (Human Rooms and Messages),
  `agentregistry` (Agents, templates, Skill bindings, Another Me),
  `voice` (voice features), and the older feature packages.
- `internal/store/queries`: sqlc SQL sources; generated files live in `internal/store`.
- `internal/skill`: parses Skill Packages, resolves effective Skill sets, and
  reconciles the repository-level built-in Skill catalog into TeamHub.
- `migrations`: TeamHub-owned schema changes.
- `tests/integration/<feature>`: independent PostgreSQL business test packages.
- `tests/testsupport`: shared database lifecycle and pure harness utilities;
  business fixtures stay in their owning test package.

## Important Conventions

- Room input acceptance: Runtime State validates canonical
  conversation/targeted agent_runtime inputs atomically with Local Run and cursor.
  Document reads are live-latest and mutations retain CAS. CLI business
  operations use current Agent/resource authority, not Context/Run prerequisites.

- Go generates only types for the contracts TeamHub serves. Mount each
  operation in the caller's route table in `internal/app/routes_*.go`;
  `TestRoutesMountEveryContractOperationExactlyOnce` fails on a missing,
  extra, or wrongly bound route. Handlers are `App` methods that read bound
  query and header parameters with `contractParams[T]` and path parameters
  with `c.Param`.
- `internal/app` opens no transaction and calls no store queries: handlers
  call a domain service and map its errors. `TestAppLayerHoldsNoTransactionsOrQueries`
  (`tests/integration/layout`) fails on a transaction, SQL, a `store.Queries` or
  `pgx.Tx` reference, or the pool outside `app.go` and `feature*.go`. The Task
  and Work Item handlers listed in that test are the only exception.
- New data access uses sqlc queries in `internal/store/queries`; do not add
  hand-written SQL.
- `app.New(ctx, cfg, deps)` builds the App from a complete Config and starts
  nothing; `App.StartWorkers(ctx, skip...)` starts background work. Tests use
  `config.ForTest(...)`, inject fakes through `app.Deps`, and skip the
  `app.Worker` parts they drive; do not add per-test options to `app` or
  default-filling to `New`.
- Call Agent management through one handwritten adapter over the generated Go client.
- Keep TeamHub as an independent Go module; do not introduce `go.work` without a
  second handwritten Go module. Use the repository-local `replace` for the
  generated contracts module.
- The generated contracts module ID is
  `github.com/simplexai-labs/linger/contracts-go`; it resolves only
  through that `replace`.
- Commit a persisted collaboration fact and its Room Event in the same transaction.
- PostgreSQL is recovery authority; SSE is a low-latency wake signal.
- PostgreSQL is also the recovery authority for Agent Runtime configuration,
  Execution Context, accepted input, Inbox cursor, Local Run, RuntimeSession,
  Runtime status coordination, and Local Computer state. Expose
  command-oriented generated APIs; never expose generic table CRUD to Agent
  Service.
- Never import another app's source or log Runtime secrets.
- Before opening or updating a long-lived branch with SQL migrations, fetch
  the current target branch, sync its migrations, and run
  `bash apps/teamhub/scripts/check-migration-history.sh <target-ref>` from the
  repository root; the script requires the target ref. The local check includes uncommitted and new SQL files.
  `00852_baseline.sql` is the schema baseline; nothing below it remains. It
  reuses the version of the last migration it replaced, so a database already
  at 852 skips it and an older one must be recreated.
  Target migration filenames, versions and SQL are immutable; add a
  forward migration above the target's latest version instead of rewriting or
  deleting an existing file. Renumber only unpublished branch migrations and
  update their test fixtures and release references.
  Pull request validation checks changed SQL against the current remote target
  tip, not the older diff base. A missing upstream migration requires syncing
  the target; Git conflict resolution alone does not prove version uniqueness.
  The check compares Git trees, not deployment or Goose database state. If a
  deployment has already applied a branch's version, provide a new forward
  repair rather than editing its recorded history.
- Do not add an empty-database goose UpTo/DownTo integration test for every
  migration. Prove current behavior on the template clone. Fresh-install
  tests use `//go:build integration_migration_history` and stay off the
  default pull request suite. The baseline installs only into an empty database and
  refuses a database that already holds a TeamHub schema; databases created
  before the baseline are recreated, not upgraded. Later versions append
  normal forward migrations.
- Ordinary tests in the main integration package use `newIntegrationDatabase(t)`;
  independent business packages use `tests/testsupport/database.Suite` and call
  its `Run` from `TestMain`. Each test owns a private clone; never seed or migrate
  a caller-supplied database. Only
  `integration_migration_history` tests may use `newEmptyDatabase`
  or call goose `Up`, `UpTo`, or `DownTo` directly.
- Keep integration coverage for PostgreSQL transactions, locks, constraints,
  migrations, and HTTP boundaries. Test pure validation, normalization, state
  transitions, and stable ID generation in the owning package instead.
- A top-level `TestXxx` must not invoke another top-level `TestYyy`; extract a
  non-Test helper when scenarios share setup or assertions.
- Every default top-level `TestXxx` in `tests/integration` must start with exactly
  one marker: `allowParallelIntegrationTest(t)` (runs beside other tests under
  go test's `-parallel`) or
  `serialIntegrationTest(t, reason)`, where `reason` is one of the
  `serialIntegrationReason` constants (`processEnv`, `processLogger`,
  `suiteMeta`, `wallClockBound`, `subprocess`). The Go layout
  test (`tests/integration/layout`) enforces the marker, the reason set, and the
  forbidden body patterns; it caps neither the parallel count nor the test count
  and does not match test names.
- The suite is plain `go test`; there is no shard planner, timing file, test
  binary artifact, or database prefetch pipeline.
  The control connection pool is sized from the effective `-parallel` value + 2.
- A parallel test owns its database, HTTP server, temporary object storage, and
  provider fakes. Its object root comes from `integrationArtifactRoot(t)`, a
  per-test directory of hard links to the template Skill objects;
  `integrationSkillArtifactRoot()` is only the template source. A top-level test
  stays parallel unless it (1) mutates process-global state: environment
  variables, the default slog logger, `GOMAXPROCS`, or the integration
  database suite and its template inspection; (2) spawns subprocesses whose CPU load or shared resources matter; or (3) asserts a
  wall-clock upper bound that load can break. Criterion (3) keeps only the tests
  whose bound is the behavior under test, marked `wallClockBound`; a receive or
  poll used only as a hang guard uses a 30s window instead. Test names never
  decide concurrency. Lock and activity introspection (`pg_locks`,
  `pg_stat_activity`, `pg_blocking_pids`, `pg_terminate_backend`) is allowed in
  parallel tests only when scoped to the test's own database
  (`database = (SELECT oid FROM pg_database WHERE datname = current_database())`
  for `pg_locks`, `datname = current_database()` for `pg_stat_activity`) or to
  PIDs taken from the test's own pool. Raw `t.Parallel()` calls are forbidden.
- New asynchronous, retried, or periodic TeamHub work runs on River through
  `internal/jobs`. Enqueue with `jobs.InsertTx` in the transaction that commits
  the fact requiring the work, and use River periodic jobs for sweeps.
- Do not add tables or columns for job leases, attempts, retry schedules, or
  outbox delivery, and do not start new polling goroutines in `app.go`.
  Exceptions need sub-second latency or a long-lived connection (realtime/SSE,
  voice, presentation sequence pacing, the River due notifier);
  state the reason in the pull request. SQL that inserts River rows calls
  `notify_river_queue` so the job does not wait for the queue's poll. Such a
  loop is woken on commit and sleeps until its next due time, with a fallback
  of at least one minute; it never polls on a short fixed interval.
- Do not add write-only audit, event, or provenance tables. A new audit table
  needs a named product or compliance reader in the same pull request.
