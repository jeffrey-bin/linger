# Desktop: Electron client for private deployments

The Electron main process hosts the desktop modules: it loads the
remote Web SPA, enrolls the computer and runs the Go Local Computer daemon
(`apps/computer/local-daemon`) as its child, which connects to the Runner
Gateway and runs Agents. The daemon exits with the app.

## Common Commands

- `pnpm --filter @linger/desktop test`: unit tests (no Electron binary needed).
- `pnpm --filter @linger/desktop typecheck`: typecheck the app.
- `pnpm --filter @linger/desktop build`: bundle `dist/` with esbuild and
  build the Go daemon for this machine into `dist/computer/<platform>-<arch>/`
  (needs Go). `LINGER_DESKTOP_DAEMON_TARGETS=darwin-arm64,darwin-x64` (or
  `win32-x64`) builds the targets a package needs;
  `node scripts/build-daemon.mjs --all` builds every shipped target.
- `pnpm --filter @linger/desktop electron:install`: download the Electron
  binary; pnpm does not run its install script. Set `ELECTRON_MIRROR` when the
  default host is unreachable.
- `pnpm --filter @linger/desktop start`: build and run from source.
- `python3 packaging/mac/package.py [--arch arm64|x64]`: build
  `out/Linger-<version>-<arch>.dmg` for Apple silicon and Intel on Linux
  after `node build.mjs` with the darwin daemon targets. The daemon is signed
  with the app. Needs the `dmgtool` image from
  `packaging/mac/Dockerfile` and `rcodesign` (ad-hoc signature). Add
  `--developer-id P12 --developer-id-password FILE` for a Developer ID
  signature with the hardened runtime, and `--notary-key JSON` to notarize and
  staple; see the script's docstring.
- `python3 packaging/win/package.py`: build
  `out/Linger-<version>-x64-setup.exe` (per-user NSIS installer) and
  `out/Linger-<version>-x64.zip` on Linux after `node build.mjs` with the
  `win32-x64` daemon target. Needs the
  `wintool` image from `packaging/win/Dockerfile`. Neither is
  Authenticode-signed and Windows has no self-update yet.
- `python3 packaging/linux/package.py`: build
  `out/Linger-<version>-linux-x64.tar.gz` (one folder with the `linger`
  executable) after `node build.mjs` with the `linux-x64` daemon target.

## Structure

- `src/main/modules.ts`: `Module` interface, typed bus and the host that starts
  modules in dependency layers and stops them in reverse.
- `src/main/*.ts`: one file per module (Enrollment, WorkspaceGrants,
  ComputerDaemon, Status, PowerGuard, WindowManager, Tray, DesktopIpc). `status.ts`, `tray-menu.ts` and `tray-icon.ts` hold the pure
  status summary, tray menu and tray icons, drawn from the logo PNGs in
  `resources/tray/` with a status badge.
- `src/main/local-server.ts`: LocalServer, the setup page's Quick Install
  path. It fetches the pinned Node runtime and unpacks the linger source package
  into the install location (the default home, or a folder picked under
  Customize; tar runs inside the target with relative paths, and the
  finished folder is moved into place with `renameRetrying`, which waits out
  Windows' short-lived locks on new files) and starts the bundled
  `dist/installer/installer.js` headless (`--no-open`), which runs every
  service natively. It drives the installer's local API itself (`InstallerApi`):
  the session from `installer/launch.html`, one job for instance `desktop`
  with the chosen AI runtime and local models, then the job's progress, which
  the setup page shows as five steps. Each Install or Try Again is a new attempt: its timers and bar
  start over, and the bar never moves back within one. There is no
  installer window. When the job waits for the runtime sign-in (its
  `runtime` stage `waiting_user`, or `RUNTIME_AUTH_REQUIRED`), it asks the
  installer (`GET /api/runtime-login`) whether the runtime is signed in
  after all; only when it is not does a "Sign in to <Runtime>" step show,
  with a dialog. Authorize starts the runtime's own login through the
  installer (`POST /api/runtime-login`), which opens the browser on its
  localhost callback page itself; Desktop opens only a Codex device page.
  The dialog waits, checks every few seconds and closes once signed in. The
  printed link and Claude Code's paste-code form sit behind "Having
  trouble?"; Cancel stops the login (`DELETE /api/runtime-login`); the
  dialog also offers installing another runtime instead (a new job with
  that `setupChoice`). No secret passes through the page. Then it saves the
  installed runtime's executable and profile paths
  (`GET /api/instances/desktop/runtime`) as `runtimeEnvironment` in the
  Desktop config, signs in with the local owner account, switches the window
  to the server and enrolls this computer, so setup ends on "Linger is
  ready". That screen shows the owner account from the instance's
  owner-only `local-account.json` (`setup-account.ts`): the email, the
  password masked until Show, Copy (the main process writes the clipboard
  and clears it after 60 s if it still holds the password) and "Open account
  file location" (`shell.showItemInFolder`); an unreadable file shows why
  instead. Only the email and file are kept; Show and Copy read the file
  again, and closing the setup window hides the password. After a logout
  the SPA's login page asks `window.lingerDesktop.localAccount.available()`,
  which is true only while the window shows the origin in
  `local-server.json` and the services are `ready`, and offers "Sign in
  with this computer's account": `localAccount.signIn()` reads the file in
  the main process and signs the window's session in with
  `signInWithPassword`, which posts to `127.0.0.1:<port>` (what the
  services bind) and sets the cookies for the origin; the page gets only
  `{ ok }` or the reason it failed (mapped by status and error kind by
  `signInFailure`), never the password. The default AI runtime is the
  installer's recommendation, or Codex when the installer cannot inspect the
  computer. It records the install location, source, origin and engine in
  `desktop/local-server.json` under the default home and, while the window
  still uses that origin, restarts the services on launch with
  `installer.js --resume`, which also restarts them when the instance's
  `user.env` changed. Before installing or resuming it moves the
  `COMPOSIO_API_KEY`, `SONIOX_API_KEY`, `XAI_API_KEY` and `TZ` of an unpacked
  source package's `.env` into `<home>/instances/desktop/user.env` once and
  deletes that `.env` (never a `LINGER_CHECKOUT`'s), logging only the names
  of other values it drops; the installer reads only `user.env` for the
  desktop. Setup then waits up to five minutes for the
  server to create the Another Me; on timeout it reads `local-computers` and
  says what is missing (offline computer, no writable folder, or no signed-in
  runtime with each runtime's reported state) and logs
  `local_server.another_me_missing`. Customize → API keys takes the
  Composio, Soniox and xAI keys (`provider-keys.ts`); Install saves the edits
  before the installer starts (`installer.js --instance desktop --user-keys`,
  the keys on stdin) into the owner-only `instances/desktop/user.env` of the
  install location, and the page only learns which keys are saved. Both
  engines pass them to the services whenever they are configured (an edit
  runs a new job even after a finished one); Native also starts its bundled
  LiveKit when a voice key is set (see Release). There is no settings page
  after setup yet: keys change on the next Install or Try Again.
- `src/main/diagnostics.ts`: Diagnostics, "Show Logs" (opens
  `<userData>/logs`) and "Save Diagnostics" (a redacted
  `linger-diagnostics-<time>.zip` in Downloads) for the setup page's failed
  step, the start failure page and the tray. The zip holds the Desktop logs
  and `config.json`, the installer job JSON and logs, the instance JSON and
  service logs under each install home. Credential files (`gateway.json`, `caller.key`,
  `control.key`, `credential.json`, `launch.html`, `*.env`, `*.input.json`,
  keys, cookies, databases) never go in, every saved voice key is replaced
  wherever a log printed it, and every text passes through `redact` plus a
  secret-key JSON filter. It imports no Electron API, so it is
  tested with Windows paths on any platform.
- `src/main/window-manager.ts`: one `BaseWindow` with two views, the title bar
  (`app://shell/titlebar`) and the SPA. macOS keeps native traffic lights,
  Windows uses `titleBarOverlay`, Linux draws its own controls. Closing hides
  the window to the tray.
- `src/shell/*.html`: app-owned pages (title bar, offline/setup page). They
  have no network access and talk to the main process via `src/preload/shell.ts`.
- `src/preload/index.ts`: the only SPA API, `window.lingerDesktop`.
- `src/shared/api.ts`, `src/shared/shell.ts`: preload contract types and IPC
  channel names.
- `src/main/computer-daemon.ts`: ComputerDaemon. While the computer is
  enrolled it writes `<userData>/computer/config.json` (owner-only; Computer
  id, name, Gateway URL, workspace grants and the bundled teamhub CLI
  directory) and starts `linger-computer-daemon --config <file>` with the
  credential in `LINGER_COMPUTER_TOKEN` (`gateway.token_env`). The config's
  `desktop` section puts the daemon in Desktop mode: no self-update, it exits
  when its stdin closes, and it reports `{"type":"status",...}` lines on
  stdout, which drive the tray and the SPA status. Its log goes to
  `<userData>/logs/computer-daemon.log`. Crashes restart with backoff; new
  folders or a new name restart it once tasks finish.
  On macOS it writes `{"type":"hello","features":["permissions.v1"]}` to
  the daemon's stdin after spawn and answers `permission.request` lines with
  `permission.response` from `src/main/system-permissions.ts` (the app's
  own Screen Recording and Accessibility, which shell commands of Agents
  are attributed to); a `relaunch` request is answered, then quits and
  relaunches the app. The permission card in the SPA running this
  computer's own Computer takes Linger's steps (prompt, System Settings,
  relaunch) and opens CuaDriver's System Settings pane through
  `lingerDesktop.permissions.act` instead; CuaDriver's prompt and restart,
  and every step from another page, go through TeamHub to the daemon.
- `src/main/computer-credential.ts`: the Gateway credential in
  `<userData>/computer/credential.json` (0600).
- `src/main/legacy-migration.ts`: on start, stops a bridge an older version
  left running and moves its credential and the Desktop 0.16 daemon identity
  into the daemon layout, so the computer keeps its id.
  `src/main/legacy-bridge.ts` keeps only the old bridge paths and the socket
  handshake that this needs; the bridge itself was deleted.
- `scripts/build-daemon.mjs`: cross-compiles the daemon, stamped with the
  `apps/computer` release the Gateway checks.

## Important Conventions

- Brand artwork lives in `apps/assets/logo`. Its exporter synchronizes desktop
  resources; macOS tray assets contain only the monochrome L and dot, while
  other platforms use the full-color dark tile with runtime status badges.

- Business logic stays in the main process or the backend. The daemon only
  executes Runner commands.
- The gateway credential lives only in the credential file and the daemon's
  environment, never in `config.json` or logs. Never log cookies, credentials
  or channel bodies.
- Every IPC handler checks that the sender frame is on the configured server
  origin and validates input with zod. The SPA cannot change the server URL.
- Keep Electron imports out of files with unit tests; inject Electron APIs.

## Local Full Stack

1. In the repository root, start everything with `pnpm dev` against your
   PostgreSQL (the Web dev server on `http://127.0.0.1:3000`, TeamHub, the
   Agent Service and the rest), or with `docker compose up --build`.
2. Install the DMG from `packaging/mac/package.py` (or run
   `pnpm --filter @linger/desktop start`) and enter
   `http://127.0.0.1:3000` as the server address during setup. That is the
   only value the user enters; enrollment returns the rest.
3. With the default local configuration the computer connects to the Agent
   Service at `ws://127.0.0.1:4319/v1/runner-gateway` and the bundled teamhub
   CLI talks to `TEAMHUB_BASE_URL`. When these services are not reachable from
   the computer at those addresses (another host, a tunnel), set
   `AGENT_RUNNER_PUBLIC_GATEWAY_URL` and `TEAMHUB_CLI_BASE_URL` to origins the
   computer can reach.
4. The computer needs Codex or Claude Code installed and signed in; the
   daemon finds them through the login shell PATH. The teamhub CLI runs on
   the app's own Node (`ELECTRON_RUN_AS_NODE`) in packaged builds and on the
   `node` in PATH from source.

## Source Package

Release builds set `LINGER_SOURCE_ARCHIVE_URL` (https) and
`LINGER_SOURCE_ARCHIVE_SHA256` before `node build.mjs`. Produce them from the
release tag in the repository root:

```sh
SOURCE_ARCHIVE_REF=v1.2.3 \
SOURCE_ARCHIVE_URL_BASE=https://github.com/simplexai-labs/linger/releases/download/v1.2.3 \
  make source-archive
```

Upload `.linger-runtime/source-archive/linger-v1.2.3.tar.gz` to that release
and take both values from `source-archive.json` next to it. One commit always
gives the same digest. To ship the package inside the app instead (about
45 MB more, no hosting needed), set `LINGER_SOURCE_ARCHIVE_FILE` to the
archive; the build copies it beside the installer and pins its digest. Without
either (and without `LINGER_CHECKOUT`) the build does not offer a
local install.

A downloaded source package can have a dependency store for each platform
beside it, so the native install of its packages needs no registry. Build it
from the same tag, on the platform it serves, and set
`LINGER_SOURCE_DEPENDENCIES_URL` and `LINGER_SOURCE_DEPENDENCIES_SHA256` from
`source-dependencies-<target>.json` for that platform's build:

```sh
SOURCE_ARCHIVE_REF=v1.2.3 \
SOURCE_ARCHIVE_URL_BASE=https://github.com/simplexai-labs/linger/releases/download/v1.2.3 \
  make source-dependencies
```

`SOURCE_DEPENDENCIES_TARGET` builds another platform's store instead (the
`source-dependencies` CI job does this on Linux). Such a store skips install
scripts, so the install still compiles or downloads native modules such as
better-sqlite3. The desktop downloads the store after the source package
(resuming an interrupted download) and unpacks it into
`.linger-runtime/pnpm-store` of the source; when that fails it logs
`local_server.dependencies_failed` and the installer downloads the packages
itself.

`LINGER_SOURCE_ARCHIVE_MIRRORS` and `LINGER_SOURCE_DEPENDENCIES_MIRRORS` list
other https hosts serving the same files, separated by spaces. The desktop moves
to the next one when a host fails or stalls, and the SHA-256 still decides.

Native installs also need the publisher's pinned localmodels tool and native
PostgreSQL package for the target. They are pinned in
`distribution/<target>.json`, in the shape `packages/local-installation/src/native-dependencies.ts` reads
(`platform`, `arch`, `localmodelsTool`, `nativeSources`, `voiceTools`, each
source with an optional `mirrors` list of https URLs for the same file). The build copies the
file of its target (`LINGER_DESKTOP_DAEMON_TARGETS`, else this machine) beside
the bundled installer, which reads it at start; `LINGER_DESKTOP_DISTRIBUTION`
names another file instead. A source with `file` (Windows) instead of `url`
names an archive the app ships: the build copies it from
`LINGER_NATIVE_POSTGRES_DIR` (default `~/.cache/linger-desktop`) to
`dist/installer/native/` after checking its size and sha256, and the installer
checks them again before extracting it, as it does for a download. Where the
file has no PostgreSQL for the computer, or the bundled archive is missing,
the setup page does not offer installing on this computer. `src/main/distribution.test.ts` checks that each file holds its
target's PostgreSQL and the localmodels release `scripts/installs/stack.sh`
pins.

## Release

Each desktop target (`darwin-arm64`, `linux-x64`) gets its own distribution
file and build. For one release:

1. Make the source package as above and upload it. On a host of each target,
   make its dependency store and upload it beside the package.
2. On a host of each target, build the PostgreSQL package with
   `node scripts/prepare-native-postgres.mjs --output DIR --base-url URL`; it
   refuses to cross-build. Before uploading, check `initdb`, a connection and
   `CREATE EXTENSION vector` against a private data directory. Upload the
   `.tar.gz` to `URL` and keep `postgres-<target>.json` from `DIR`. Windows
   repackages the pinned EDB binaries, builds only pgvector and adds the
   Visual C++ runtime the EDB zip leaves out, so run it there from an x64
   Native Tools Command Prompt for Visual Studio. The installer accepts only
   credential-free HTTPS URLs, so `URL` must be the HTTPS CDN.
3. For a new PostgreSQL or localmodels release, update
   `distribution/<target>.json`: `localmodelsTool` for the localmodels
   release `scripts/installs/stack.sh` pins, and `nativeSources` holding that target's
   `postgres-<target>.json` object.
4. Build with `LINGER_DESKTOP_DAEMON_TARGETS` set to the target and the source package
   (`LINGER_SOURCE_ARCHIVE_FILE`, or the URL and SHA256, plus the target's
   `LINGER_SOURCE_DEPENDENCIES_URL` and SHA256) set, then package (`packaging/mac/package.py
--arch arm64` for macOS, `packaging/linux/package.py` for Linux).
5. Check the package on a clean computer: Quick Install with the default
   source ends on "Linger is ready" and Open Linger shows the local server,
   signed in, with this computer connected.

Official releases come from the public simplexai-labs/linger repository: a
`desktop-v<version>` tag pushed there runs steps 4 and the packaging for
`darwin-arm64`, `linux-x64` and `win32-x64` in GitHub Actions and publishes a
linger GitHub Release with `SHA256SUMS.txt`; see
[`docs/desktop-release.md`](../../docs/desktop-release.md). The workflow
fetches the bundled archives from the assets of the `native-deps` prerelease
there, so upload a new pinned archive to it before tagging.

Windows, Linux x64 and Apple silicon bundle PostgreSQL in the app instead
(`file` in `distribution/<target>.json`; 35 MB on Windows, 10–12 MB
elsewhere), so Native works without the CDN. Put the pinned archives in
`LINGER_NATIVE_POSTGRES_DIR` before `node build.mjs`; the build fails without
them. To download it instead, replace `file` with the HTTPS `url` once it is on
the CDN. Native PostgreSQL refuses an elevated Linger ("Run as
administrator"), as it refuses root elsewhere.

Every target also bundles the voice tools (`voiceTools`, about 40 MB each):
the official LiveKit server release (Apple silicon: built from the tagged
source with the pinned Go, since LiveKit publishes no macOS binary; without
cgo, so its vendored go-osstat reports an idle CPU, which only matters when
LiveKit spreads rooms over several servers) and a
static LGPL ffmpeg/ffprobe (Linux and Windows: built from the FFmpeg release
in the pinned Alpine image, Windows with MinGW-w64; Apple silicon: the
pinned serversideup LGPL build, which links OpenSSL statically). Make them on
Linux with `node scripts/prepare-native-voice-tools.mjs --target <target>
--output DIR` (Docker; Go for Apple silicon), copy the archive to
`LINGER_NATIVE_POSTGRES_DIR` and `voice-tools-<target>.json` from `DIR` into
`voiceTools`. The build is reproducible except for the Go toolchain download,
and it checks the versions, the ffmpeg components the voice workers use,
static linking and the Mach-O signatures. Licenses ship in `licenses/` of the
archive. When a voice key is saved, Native extracts the archive into
`tools/native/components`, puts its `bin` first on the services' `PATH`
(TeamHub and the voice workers run `ffmpeg`/`ffprobe` from it) and runs
`livekit-server` as the `livekit` Native service: loopback only, HTTP and
WebSocket on one free port and media on one free UDP port, both kept with
the generated API key and secret in the owner-only `livekit.env` of the
instance, logs in `native/logs/livekit.log`. ICE over TCP stays off because
LiveKit binds it on every interface. Without the tools for the computer
Native keeps voice off. The macOS tools are ad-hoc signed by their linker and
live in the archive, outside the app's signature, like PostgreSQL.

A build with a source package for `win32-x64`, `linux-x64` or `darwin-arm64`
also ships TeamHub prebuilt (`scripts/build-teamhub.mjs`): build.mjs
cross-compiles `teamhub`, `migrate` and `account` from that package (`go` in
PATH, `CGO_ENABLED=0`) into `dist/installer/native/teamhub-<target>/` with a
`manifest.json` of their sha256, the package's sha256 and the commit
`git archive` recorded in it; a downloaded package
(`LINGER_SOURCE_ARCHIVE_URL`) is fetched for this. The package scripts
refuse binaries that do not match the manifest or the bundled package
(`packaging/native_bundle.py`). The desktop copies them into the unpacked source
(`.simplexai-runtime/prebuilt/`), the installer checks them again and then
skips the Go download, and `scripts/source-native.mjs` runs them (checking the
sha256 before each start) instead of `go run` / `go build`. Without them, or
when they do not verify, Native downloads Go and compiles as before.

The same targets ship the services Native runs, built from that package
(`scripts/build-native-runtime.mjs`): Web's production files, Node
Services bundled with esbuild beside the node_modules it loads at runtime,
and the pinned Node.js, in `dist/installer/native/runtime-<target>/` with a
`manifest.json` (schema 1). Windows and Linux ship `runtime.tar.zst` beside
the Node.js release archive. Apple silicon ships the `runtime/` folder and
`node/bin/node` unpacked instead, because the app's signature must cover
every Mach-O file: `packaging/mac/package.py` signs them with the app (Node.js
with `node-entitlements.plist`: JIT, and native modules under the hardened
runtime its release signature keeps), records the signed bytes in the
manifests and seals them with a shallow signature. The desktop unpacks or
copies the services into `.simplexai-runtime/offline/` of the source and
Node.js into its own folder, removing `com.apple.quarantine` on macOS;
`checkNativeRuntime` then verifies every file, and Native installs no
packages and needs no registry. On Linux the services need glibc 2.35
(Ubuntu 22.04, Debian 12), like the PostgreSQL build; with an older glibc the
desktop leaves them out and Native installs from the network. Model data
(OCR, Voice) is not bundled: Node Services downloads it on first use.
Intel Macs have none of this and install from the network.

## Development Environment

- `LINGER_SERVER_URL`: initial server origin.
- `LINGER_CHECKOUT`: a linger checkout that local installs use instead of
  the source package; the setup page does not show it. Keys come from the
  instance's `user.env` there too: the checkout's `.env` is not read.
- `LINGER_DESKTOP_USER_DATA`: separate user data directory.
- `LINGER_COMPUTER_DAEMON`: daemon executable to run instead of the bundled
  one (`resources/computer/` when packaged, `dist/computer/` from source).
- `LINGER_BRIDGE_STATE_DIR`: where an older version's bridge kept its state,
  for the one-time migration.
- `LINGER_CODEX_PATH`, `LINGER_CLAUDE_PATH`, `LINGER_PI_PATH`: absolute
  runtime paths for the daemon config. Other `LINGER_*`, the retired `SIMPLEX*` and
  `ELECTRON_*` variables do not reach the daemon. The config's
  `runtimeEnvironment` (the local server's runtime: these paths plus
  `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`) replaces them,
  names compared case-insensitively for Windows.
- Without a display, run with `--ozone-platform=headless --disable-gpu`. The
  tray and native menus are skipped in that mode; use Xvfb to check them.
