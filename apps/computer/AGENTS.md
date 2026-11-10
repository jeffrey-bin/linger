# Local Computer Conventions

## Boundary

- This directory owns the resident Local Computer Daemon, its local control
  CLI, outbound Runner Gateway transport, workspace grants, provider process
  supervision, and Runtime execution.
- The Go implementation under `local-daemon/` is the only Local Computer
  Daemon and Runtime execution implementation, and `local-daemon/cmd/linger-computer`
  is the control CLI the release bundle ships as `cli/linger-computer`. The bundled Node runs only the `teamhub` CLI and the managed
  Computer tools.
- The Desktop app (`apps/desktop`) ships the same Daemon and runs it as its
  child. A `desktop` config section selects Desktop mode: no
  self-update, shutdown when stdin closes, status lines on stdout, and the
  app's TeamHub CLI directory.
- It consumes generated Runner Gateway contracts and shared Runtime packages.
  It must not import another `apps/*` source tree or own TeamHub records, Agent
  orchestration, model selection, or Room callback behavior.

## Structure

- `local-daemon/` is a Go module. Its `internal/daemon` owns the daemon
  lifecycle; `internal/process`, `internal/provider`, and `internal/workspace`
  contain local execution mechanics; `internal/linger` contains Linger
  transport, identity, process-instance lease, Registration, Context, Local MCP
  Relay, and Local Skill adapters.
- `internal/computercli` implements the control commands over
  `internal/computerconfig` (the config parser and process environment shared
  with the Daemon), `internal/platform/privatefs`, `internal/provider`
  discovery, and `internal/linger/control` (control client and the Daemon
  owner record). It never re-implements a Daemon mechanism.
- Native provider clients live in `internal/provider/native`; process-tree
  helpers live in `internal/process`; runtime-home helpers live in
  `internal/workspace`. Keep tests next to their implementation.
- Context refresh publishes validated input files atomically into a stable
  workspace and never deletes local writable output or a running provider's cwd.

- `cmd/linger-computer-launcher` is the stable Windows command: as
  `linger-computer-<environment>.exe` it runs the active bundle's CLI, and as
  `cli/teamhub.exe` the bundled Node TeamHub CLI. The Daemon's Windows-only
  `platform` subcommand serves the Windows installer helper (owner-only files,
  process identity, owned-process cleanup); nothing else calls it.
- `scripts/` builds the development bundle, and `tests/` holds the Vitest
  checks of the bundle tools and the Runner Gateway wire against the Go
  Daemon. Do not add a second Runtime detector, Runtime executor, Gateway
  client, operation ledger, or daemon entrypoint outside `local-daemon/`.
- Add grant, runner-supervision, and other CLI feature directories only when
  their behavior and colocated tests are implemented.
- Keep process entrypoints thin over owning modules. Do not add nested
  export-only barrels.
- Do not use `host`, `runtime host`, or `local host` as names for the Go
  process; use `local-daemon` or Local Computer Daemon.

## Runtime And Safety

- Default tests use deterministic providers and real fixture child processes;
  they never call a live model.
- Process-test watchdogs are harness budgets for loaded developer machines, not
  product startup or shutdown SLAs. Do not add retries or weaken lifecycle,
  process-identity, or cleanup assertions to handle timing variance.
- A wire request never supplies a local path, executable, environment, or
  credential. Resolve canonical workspace grants before invoking an
  installed Runtime provider.
- Do not commit runtime state, PID files, sockets, logs, credentials, or build
  output.

## Release Versioning

- A deployment ships the Computer built from its own commit inside the
  node-services image, and a Daemon upgrades whenever its bundle's
  `app-sha256` differs from the Agent's `target_release`. A Daemon
  change therefore needs no version bump to reach Computers.
- Bump `apps/computer/package.json` only when raising the version
  floor. The package version is the source for the bundled CLI and Go Daemon
  `ReleaseVersion`; it is used for display and the floor, never to trigger or
  order upgrades.
- Before reporting a Daemon update as delivered, distinguish an image that
  carries the new build from an existing Computer that has actually upgraded
  (its active bundle's `app-sha256`).

## Verification

- During iteration, run the focused `@linger/computer` test. Before
  delivery, run `make check BASE=<target-branch>` from the repository root; it
  includes `check-computer`. Also run `make check-computer-release` for bundle
  source, package, shared Runtime, or generated Runner Gateway changes. Run `make check-scripts-heavy` only for installer,
  uninstaller, release generator, publish, or image paths;
  ordinary Computer tests, fixtures, documentation, and example configuration
  do not require the full installer lifecycle gate. CI does not replace the
  corresponding local verification.
- When installer or lifecycle behavior changes, verify it under a temporary
  HOME (`make check-scripts-heavy`). Preserve install, safety-failure, rollback, and release
  integrity coverage unless an explicit equivalent replacement is documented.
- Go checks for `local-daemon/` must run from that module with focused tests,
  then through `make check-computer`.
