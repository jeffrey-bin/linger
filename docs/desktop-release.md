# Desktop Release

Linger desktop releases are published in the public
[simplexai-labs/linger](https://github.com/simplexai-labs/linger) repository:
pushing a `desktop-v<version>` tag there runs GitHub Actions
([`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml)),
which builds the packages for Apple silicon, Linux x64 and Windows x64 and
publishes them as the GitHub Release of that tag. The workflow calls
[`scripts/ci/desktop-release.sh`](../scripts/ci/desktop-release.sh), so the
same steps also run on a developer machine.

This is the only release path. The internal GitLab copy of the repository
keeps a manual dry run for test builds (see [GitLab dry run](#gitlab-dry-run-test-builds-only));
it publishes nothing, and a `desktop-v` tag pushed there runs no pipeline.

## Downloads

The newest stable packages are always at
<https://github.com/simplexai-labs/linger/releases/latest>; a prerelease never
becomes the latest release. Link there, not to a version.

## Releasing

In a checkout of simplexai-labs/linger:

```sh
git tag desktop-v0.16.36
git push origin desktop-v0.16.36
```

- The tag is `desktop-v<major>.<minor>.<patch>`, optionally with a suffix such
  as `-rc.1`, beside the `cli-v<version>` tags of the CLI. A version with a
  hyphen is published as a GitHub prerelease whose notes start with
  **Prerelease**; a stable version is marked as the latest release.
- The version comes from the tag. The build writes it into
  `apps/desktop/package.json` for packaging and restores the file afterwards, so
  no version commit is needed.
- The release appears under the repository's Releases with the files listed in
  [Release Files](#release-files).

## How the workflow runs

The workflow runs for `desktop-v*` tags and from Actions → Desktop release →
Run workflow. Its `build` jobs
run on `ubuntu-24.04` (the macOS and Windows runners have no Docker) and keep
the files as workflow artifacts for 14 days; `release` writes `SHA256SUMS.txt`
and creates the GitHub Release, or uploads the files again to an existing one.
A manual run publishes only with `publish` set.

The release goes to `RELEASE_REPO`, `simplexai-labs/linger` by default:

- **In simplexai-labs/linger itself**, the workflow's `GITHUB_TOKEN`
  publishes; no extra secret is needed. The tag is the one pushed, at the
  built commit.
- **In another repository** such as `simplexai-labs/linger9`, it publishes
  across repositories with the `LINGER_RELEASE_TOKEN` secret; `prepare` stops
  at once when that secret is missing. A tag points at a commit of its own
  repository, so the release creates `desktop-v<version>` in
  simplexai-labs/linger at that repository's default branch, and its notes
  name only the version.

simplexai-labs/linger is public, and so are its workflow logs and release
notes. The workflow prints no internal address: `LINGER_NATIVE_DEPS_URL`
comes from settings and is left out of messages, and keeping it as a secret
also masks it. Signing keys are written to files under the runner's temporary
folder, read only by the signing tools and removed after the build.

Set these under Settings → Secrets and variables → Actions of the repository
that runs the workflow:

| Name                            | Kind                 | Required                                  | Purpose                                                                                                                                                 |
| ------------------------------- | -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LINGER_NATIVE_DEPS_URL`        | secret (or variable) | yes                                       | Public HTTPS folder serving the archives that `apps/desktop/distribution/*.json` pin, under their file names. Each download is checked against its pin. |
| `RELEASE_REPO`                  | variable             | no                                        | `owner/name` that receives the release; `simplexai-labs/linger` when unset.                                                                             |
| `LINGER_RELEASE_TOKEN`          | secret               | when `RELEASE_REPO` is another repository | Fine-grained token for `RELEASE_REPO` only, with Contents: read and write. Not needed in simplexai-labs/linger itself.                                  |
| `MACOS_DEVELOPER_ID_P12_BASE64` | secret               | no                                        | Base64 of the Developer ID `.p12`. Without it the app is signed ad hoc.                                                                                 |
| `MACOS_DEVELOPER_ID_PASSWORD`   | secret               | with the `.p12`                           | Password of that `.p12`.                                                                                                                                |
| `MACOS_NOTARY_KEY_JSON`         | secret               | no                                        | App Store Connect API key JSON; needs the Developer ID.                                                                                                 |
| `DESKTOP_UPDATE_KEY_PEM`        | secret               | no                                        | Ed25519 private key (PEM) for the macOS update feed. Without it no feed is built.                                                                       |
| `WINDOWS_SIGNING_P12_BASE64`    | secret               | no                                        | Base64 of an Authenticode `.p12`. Without it the setup program is unsigned.                                                                             |
| `WINDOWS_SIGNING_PASSWORD`      | secret               | with the `.p12`                           | Password of that `.p12`.                                                                                                                                |

### First release in simplexai-labs/linger

1. Put the archives that `apps/desktop/distribution/*.json` pin, under their
   file names, in a public HTTPS folder (for example the assets of a
   `native-deps` prerelease in simplexai-labs/linger, which keeps it from
   becoming the latest release), and set
   `LINGER_NATIVE_DEPS_URL` to it.
2. With the source in simplexai-labs/linger, push a prerelease tag first, then
   the release:

   ```sh
   git tag desktop-v0.16.36-rc.1 && git push origin desktop-v0.16.36-rc.1
   git tag desktop-v0.16.36 && git push origin desktop-v0.16.36
   ```

   From another repository, also set `LINGER_RELEASE_TOKEN` there and push
   the tags to that repository instead.

3. Check the release page, download each file and compare it with
   `SHA256SUMS.txt`. A test release is removed with its tag:
   `gh release delete desktop-v0.16.36-rc.1 --repo simplexai-labs/linger --cleanup-tag`.

## GitLab dry run (test builds only)

The internal GitLab copy of the repository has `.gitlab/ci/desktop-release.yml`
for one purpose: building test packages on the self-hosted Runners without a
GitHub release. It never creates a release or a tag, and `desktop-v` tags get
no pipeline there.

Build → Pipelines → Run pipeline on a branch with the variable
`DESKTOP_RELEASE_MODE` = `dry-run`, and optionally `DESKTOP_RELEASE_VERSION`
(default `0.0.0-dry-run.<pipeline id>`). The three `desktop-build-dry-run`
jobs build one target each and upload their files to the project's generic
package `linger-desktop-dry-run/<version>` with `CI_JOB_TOKEN`; the packages
are larger than the job artifact limit, so the job artifacts hold only
`files-<target>.txt` and `sha256-<target>.txt`. Delete dry-run packages when
done with them (Deploy → Package Registry; needs Maintainer).

Without `LINGER_NATIVE_DEPS_URL`, the jobs download the pinned archives from the
project's generic package `linger-native-deps/1`; upload a new archive there
under its file name when a pin changes. Optional signing material is a
protected, masked **File** CI/CD variable named as the script reads it
(`DESKTOP_UPDATE_KEY`, `MACOS_DEVELOPER_ID_P12`,
`MACOS_DEVELOPER_ID_PASSWORD_FILE`, `MACOS_NOTARY_KEY`, `WINDOWS_SIGNING_P12`,
`WINDOWS_SIGNING_PASSWORD_FILE`).

## Release Files

| File                                        | Contents                                                        |
| ------------------------------------------- | --------------------------------------------------------------- |
| `Linger-<version>-arm64.dmg`                | macOS, Apple silicon                                            |
| `Linger-<version>-linux-x64.tar.gz`         | Linux x64 (glibc 2.35 or newer for the bundled Native services) |
| `Linger-<version>-windows-x64-setup.exe`    | Windows x64 per-user installer                                  |
| `Linger-<version>-windows-x64-portable.zip` | Windows x64 folder to run without installing                    |
| `Linger-<version>-darwin-update-feed.tar`   | only with the update key: the macOS self-update feed            |
| `SHA256SUMS.txt`                            | SHA-256 of every file above                                     |

Each package bundles the source package, PostgreSQL, voice tools, TeamHub and
the Native services as described in
[`apps/desktop/AGENTS.md`](../apps/desktop/AGENTS.md). The update feed holds
`manifest.json`, `manifest.json.sig` and the app archive; unpack it into the
server's `install/desktop/stable/`.

## Local Build

On Linux x64 with Docker, Node, pnpm, Go and Python 3:

```sh
DESKTOP_VERSION=0.16.36-rc.1 RCODESIGN=/path/to/rcodesign \
  scripts/ci/desktop-release.sh build darwin-arm64
scripts/ci/desktop-release.sh checksums .linger-runtime/desktop-release/assets 0.16.36-rc.1
```

With the archives already in `LINGER_NATIVE_POSTGRES_DIR` (default
`~/.cache/linger-desktop`), `LINGER_NATIVE_DEPS_URL` is not needed.
`checksums` refuses a folder without the DMG, the Linux archive and the setup
program of that version.
