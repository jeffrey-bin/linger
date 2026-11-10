#!/usr/bin/env bash
set -euo pipefail

# Builds the desktop release files for one target and publishes a release.
# The packaging scripts make the macOS DMG and the Windows installer on Linux
# (Docker images for the disk image and NSIS, rcodesign for signatures), so
# every target builds on a Linux x64 host. .github/workflows/desktop-release.yml
# calls this to publish releases in simplexai-labs/linger; the GitLab manual
# dry run (.gitlab/ci/desktop-release.yml, test builds only) calls it too.
# docs/desktop-release.md describes both.
#
#   desktop-release.sh version <tag>              print tag=, version= and prerelease= lines
#   desktop-release.sh fetch-native <target>      put the pinned PostgreSQL and voice tools
#                                                 archives in LINGER_NATIVE_POSTGRES_DIR
#   desktop-release.sh compile <target>           node build.mjs for the target (Node, pnpm, Go)
#   desktop-release.sh package <target>           package.py for the target (Python, Docker)
#   desktop-release.sh build <target>             fetch-native, compile and package
#   desktop-release.sh checksums <dir> <version>  write <dir>/SHA256SUMS.txt
#   desktop-release.sh gitlab-upload <dir> <version>
#                                                 upload <dir>'s files to a GitLab generic
#                                                 package (dry-run test builds only)
#   desktop-release.sh github-release <dir> <tag> <version>
#                                                 create or update the GitHub Release of <tag>
#                                                 in RELEASE_REPO with <dir>'s files (gh)
#
# Inputs (environment):
#   DESKTOP_VERSION              release version, as printed by `version` (compile, package)
#   LINGER_NATIVE_POSTGRES_DIR   where build.mjs reads the bundled archives
#                                (~/.cache/linger-desktop)
#   LINGER_NATIVE_DEPS_URL       folder serving those archives by file name; in GitLab CI
#                                it defaults to this project's linger-native-deps package
#   RELEASE_OUT                  output root (.linger-runtime/desktop-release); release
#                                files go to $RELEASE_OUT/assets/
#   RCODESIGN                    rcodesign executable for darwin-arm64 (PATH)
#   MACOS_DEVELOPER_ID_P12, MACOS_DEVELOPER_ID_PASSWORD_FILE
#                                Developer ID Application .p12 and a file with its
#                                password; without them the app is signed ad hoc
#   MACOS_NOTARY_KEY             App Store Connect API key JSON; notarizes and staples
#   DESKTOP_UPDATE_KEY           Ed25519 PEM file that signs the macOS update feed
#   WINDOWS_SIGNING_P12, WINDOWS_SIGNING_PASSWORD_FILE
#                                Authenticode .p12 and a file with its password for
#                                the setup program (osslsigncode); unsigned without
#   CI_API_V4_URL, CI_PROJECT_ID, CI_JOB_TOKEN
#                                GitLab CI's own variables for gitlab-upload
#   DESKTOP_PACKAGE_NAME         generic package of the dry-run files (linger-desktop-dry-run)
#   RELEASE_REPO                 GitHub repository of the release (simplexai-labs/linger)
#   GITHUB_REPOSITORY, GITHUB_SHA, GH_TOKEN
#                                the workflow's repository and commit, and the token gh
#                                publishes with

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
desktop="$repo_root/apps/desktop"
version_pattern='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$'
targets='darwin-arm64 linux-x64 win32-x64'
package_name="${DESKTOP_PACKAGE_NAME:-linger-desktop-dry-run}"
default_release_repo=simplexai-labs/linger

die() {
  echo "desktop-release: $*" >&2
  exit 1
}

usage() {
  echo "Usage: $0 version <tag> | fetch-native|compile|package|build <target>" \
    "| checksums <dir> <version> | github-release <dir> <tag> <version>" \
    "| gitlab-upload <dir> <version>" >&2
  exit 2
}

sha256_of() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

check_target() {
  [[ " $targets " == *" ${1:-} "* ]] || die "needs one of: $targets"
}

release_version() {
  [[ "${DESKTOP_VERSION:-}" =~ $version_pattern ]] ||
    die "set DESKTOP_VERSION to the release version (see: $0 version <tag>)"
  echo "$DESKTOP_VERSION"
}

# Tags are desktop-v<semver>, beside the cli-v<semver> tags of the CLI.
# A bare version (a manual run) gets the tag it would be released under.
cmd_version() {
  local input="${1:-}" version
  [[ -n "$input" ]] || die "version needs a tag such as desktop-v0.16.36"
  version="${input#desktop-v}"
  if [[ "$version" == "$input" && "$input" == *-v* ]]; then
    die "$input is not a desktop tag; use desktop-v<version>"
  fi
  [[ "$version" =~ $version_pattern ]] || die "$input does not hold a version like 0.16.36 or 0.16.36-rc.1"
  echo "tag=desktop-v$version"
  echo "version=$version"
  if [[ "$version" == *-* ]]; then
    echo "prerelease=true"
  else
    echo "prerelease=false"
  fi
}

native_dir() {
  echo "${LINGER_NATIVE_POSTGRES_DIR:-$HOME/.cache/linger-desktop}"
}

# build.mjs bundles every PostgreSQL and voice tools archive that
# distribution/<target>.json pins by `file`; a download is checked against the
# pinned size and sha256 before it is kept.
cmd_fetch_native() {
  local target="${1:-}" dir base name sha bytes path part pins header=()
  check_target "$target"
  dir="$(native_dir)"
  base="${LINGER_NATIVE_DEPS_URL:-}"
  if [[ -z "$base" && -n "${CI_API_V4_URL:-}" && -n "${CI_PROJECT_ID:-}" ]]; then
    base="$CI_API_V4_URL/projects/$CI_PROJECT_ID/packages/generic/linger-native-deps/1"
  fi
  if [[ -n "${CI_JOB_TOKEN:-}" && -n "${CI_API_V4_URL:-}" && "$base" == "$CI_API_V4_URL"/* ]]; then
    header=(--header "JOB-TOKEN: $CI_JOB_TOKEN")
  fi
  pins="$(node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const s of [...d.nativeSources, ...(d.voiceTools ?? [])])
      if (s.file) console.log(require("path").basename(s.file), s.sha256, s.bytes);
  ' "$desktop/distribution/$target.json")"
  mkdir -p "$dir"
  while read -r name sha bytes; do
    [[ -n "$name" ]] || continue
    path="$dir/$name"
    if [[ -f "$path" && "$(wc -c <"$path" | tr -d ' ')" == "$bytes" && "$(sha256_of "$path")" == "$sha" ]]; then
      echo "desktop-release: $name is cached"
      continue
    fi
    [[ -n "$base" ]] ||
      die "$name is not in $dir; set LINGER_NATIVE_DEPS_URL to the folder that serves it (docs/desktop-release.md)"
    part="$path.part.$$"
    echo "desktop-release: downloading $name"
    # The folder's address stays out of the log, which a public repository shows to anyone.
    curl -fsSL --retry 3 "${header[@]}" -o "$part" "${base%/}/$name" 2>/dev/null ||
      { rm -f "$part"; die "cannot download $name from LINGER_NATIVE_DEPS_URL (upload it there; see docs/desktop-release.md)"; }
    if [[ "$(wc -c <"$part" | tr -d ' ')" != "$bytes" || "$(sha256_of "$part")" != "$sha" ]]; then
      rm -f "$part"
      die "$name from LINGER_NATIVE_DEPS_URL does not match distribution/$target.json"
    fi
    mv "$part" "$path"
  done <<<"$pins"
}

# package.json carries the version into the app; the commit keeps its own.
saved_package_json=""
restore_package_json() {
  if [[ -n "$saved_package_json" ]]; then
    mv "$saved_package_json" "$desktop/package.json"
    saved_package_json=""
  fi
}
set_package_version() {
  if [[ -z "$saved_package_json" ]]; then
    saved_package_json="$(mktemp)"
    cp "$desktop/package.json" "$saved_package_json"
    trap restore_package_json EXIT
  fi
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.version = process.argv[2];
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' "$desktop/package.json" "$1"
}

out_dir() {
  echo "${RELEASE_OUT:-$repo_root/.linger-runtime/desktop-release}"
}

cmd_compile() {
  local target="${1:-}" version out source
  check_target "$target"
  version="$(release_version)"
  out="$(out_dir)"
  rm -rf "$out/source"
  mkdir -p "$out"
  node "$repo_root/scripts/prepare-source-archive.mjs" --ref HEAD --output "$out/source"
  source="$(find "$out/source" -maxdepth 1 -name '*.tar.gz' | head -1)"
  [[ -n "$source" ]] || die "prepare-source-archive.mjs wrote no archive"
  set_package_version "$version"
  (
    cd "$desktop"
    rm -rf dist
    LINGER_NATIVE_POSTGRES_DIR="$(native_dir)" \
      LINGER_SOURCE_ARCHIVE_FILE="$source" \
      LINGER_DESKTOP_DAEMON_TARGETS="$target" \
      node build.mjs
  )
}

package_darwin() {
  local version="$1" pkg="$2" assets="$3" args=()
  docker build -q -t dmgtool "$desktop/packaging/mac" >/dev/null
  args+=(--arch arm64 --rcodesign "${RCODESIGN:-rcodesign}" --out "$pkg")
  if [[ -n "${MACOS_DEVELOPER_ID_P12:-}" ]]; then
    args+=(--developer-id "$MACOS_DEVELOPER_ID_P12" --developer-id-password "${MACOS_DEVELOPER_ID_PASSWORD_FILE:?MACOS_DEVELOPER_ID_PASSWORD_FILE is required with MACOS_DEVELOPER_ID_P12}")
    [[ -n "${MACOS_NOTARY_KEY:-}" ]] && args+=(--notary-key "$MACOS_NOTARY_KEY")
  else
    echo "desktop-release: no Developer ID; the app gets an ad-hoc signature" >&2
  fi
  if [[ -n "${DESKTOP_UPDATE_KEY:-}" ]]; then
    args+=(--update-key "$DESKTOP_UPDATE_KEY")
  else
    echo "desktop-release: no DESKTOP_UPDATE_KEY; no macOS update feed" >&2
  fi
  (cd "$desktop" && python3 packaging/mac/package.py "${args[@]}")
  mv "$pkg/Linger-$version-arm64.dmg" "$assets/"
  # The feed's three files go to the server's install/desktop/stable/ as they are.
  if [[ -d "$pkg/update" ]]; then
    tar -cf "$assets/Linger-$version-darwin-update-feed.tar" -C "$pkg/update" .
  fi
}

package_linux() {
  local version="$1" pkg="$2" assets="$3"
  (cd "$desktop" && python3 packaging/linux/package.py --out "$pkg")
  mv "$pkg/Linger-$version-linux-x64.tar.gz" "$assets/"
}

package_windows() {
  local version="$1" pkg="$2" assets="$3" setup
  docker build -q -t wintool "$desktop/packaging/win" >/dev/null
  (cd "$desktop" && python3 packaging/win/package.py --out "$pkg")
  setup="$pkg/Linger-$version-x64-setup.exe"
  if [[ -n "${WINDOWS_SIGNING_P12:-}" ]]; then
    command -v osslsigncode >/dev/null || die "WINDOWS_SIGNING_P12 is set but osslsigncode is not installed"
    osslsigncode sign -pkcs12 "$WINDOWS_SIGNING_P12" \
      -readpass "${WINDOWS_SIGNING_PASSWORD_FILE:?WINDOWS_SIGNING_PASSWORD_FILE is required with WINDOWS_SIGNING_P12}" \
      -n Linger -h sha256 -ts http://timestamp.digicert.com \
      -in "$setup" -out "$setup.signed"
    mv "$setup.signed" "$setup"
  else
    echo "desktop-release: no Authenticode certificate; the setup program is unsigned" >&2
  fi
  mv "$setup" "$assets/Linger-$version-windows-x64-setup.exe"
  mv "$pkg/Linger-$version-x64.zip" "$assets/Linger-$version-windows-x64-portable.zip"
}

cmd_package() {
  local target="${1:-}" version out pkg assets
  check_target "$target"
  version="$(release_version)"
  [[ -d "$desktop/dist/installer" ]] || die "run '$0 compile $target' first"
  out="$(out_dir)"
  pkg="$out/package-$target"
  assets="$out/assets"
  rm -rf "$pkg"
  mkdir -p "$assets"
  set_package_version "$version"
  case "$target" in
    darwin-arm64) package_darwin "$version" "$pkg" "$assets" ;;
    linux-x64) package_linux "$version" "$pkg" "$assets" ;;
    win32-x64) package_windows "$version" "$pkg" "$assets" ;;
  esac
  rm -rf "$pkg"
  ls -l "$assets"
}

cmd_build() {
  cmd_fetch_native "$@"
  cmd_compile "$@"
  cmd_package "$@"
}

# Every release ships the three installers; SHA256SUMS.txt covers each file
# of the version, extra ones such as the portable zip and update feed included.
cmd_checksums() {
  local dir="${1:-}" version="${2:-}" required file files=()
  [[ -d "$dir" ]] || die "checksums needs the folder holding the release files"
  [[ "$version" =~ $version_pattern ]] || die "checksums needs the release version"
  for required in arm64.dmg linux-x64.tar.gz windows-x64-setup.exe; do
    [[ -f "$dir/Linger-$version-$required" ]] || die "$dir has no Linger-$version-$required"
  done
  while IFS= read -r file; do
    files+=("$(basename "$file")")
  done < <(find "$dir" -maxdepth 1 -type f -name "Linger-$version-*" | LC_ALL=C sort)
  : >"$dir/SHA256SUMS.txt.part"
  for file in "${files[@]}"; do
    printf '%s  %s\n' "$(sha256_of "$dir/$file")" "$file" >>"$dir/SHA256SUMS.txt.part"
  done
  mv "$dir/SHA256SUMS.txt.part" "$dir/SHA256SUMS.txt"
  cat "$dir/SHA256SUMS.txt"
}

gitlab_env() {
  local name
  for name in CI_API_V4_URL CI_PROJECT_ID CI_JOB_TOKEN; do
    [[ -n "${!name:-}" ]] || die "$name is not set; gitlab-upload runs in GitLab CI"
  done
}

package_url() {
  echo "$CI_API_V4_URL/projects/$CI_PROJECT_ID/packages/generic/$package_name/$1"
}

# Uploading a file name again adds a newer copy that the same URL then serves,
# so a retried job replaces what it published before.
cmd_gitlab_upload() {
  local dir="${1:-}" version="${2:-}" file
  [[ -d "$dir" ]] || die "gitlab-upload needs the folder holding the release files"
  [[ "$version" =~ $version_pattern ]] || die "gitlab-upload needs the release version"
  gitlab_env
  for file in "$dir"/*; do
    [[ -f "$file" ]] || continue
    echo "desktop-release: uploading $(basename "$file")"
    curl -fsS --retry 3 --header "JOB-TOKEN: $CI_JOB_TOKEN" --upload-file "$file" \
      "$(package_url "$version/$(basename "$file")")" >/dev/null
  done
}

# RELEASE_REPO defaults to the public simplexai-labs/linger. In that
# repository the workflow's own GITHUB_TOKEN publishes; from any other one,
# such as linger9, GH_TOKEN must be LINGER_RELEASE_TOKEN with contents write
# access there. A tag must point at a commit of the repository holding it, so
# only a release in the workflow's own repository is tied to GITHUB_SHA; in
# another one gh creates the tag at that repository's default branch.
cmd_github_release() {
  local dir="${1:-}" tag="${2:-}" version="${3:-}" repo notes flags=()
  [[ -d "$dir" && "$tag" == "desktop-v$version" && "$version" =~ $version_pattern ]] ||
    die "github-release needs the folder of release files, a desktop-v<version> tag and its version"
  [[ -f "$dir/SHA256SUMS.txt" ]] || die "run '$0 checksums $dir $version' first"
  repo="${RELEASE_REPO:-$default_release_repo}"
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "RELEASE_REPO must be owner/name, not $repo"
  if [[ -z "${GH_TOKEN:-}" ]]; then
    if [[ "$repo" == "${GITHUB_REPOSITORY:-}" ]]; then
      die "GH_TOKEN is not set; the workflow passes GITHUB_TOKEN"
    fi
    die "publishing to $repo from ${GITHUB_REPOSITORY:-this repository} needs the LINGER_RELEASE_TOKEN secret: a token with contents write access to $repo (docs/desktop-release.md)"
  fi
  command -v gh >/dev/null || die "github-release needs the GitHub CLI (gh)"
  notes="Linger desktop $version. Check downloads against SHA256SUMS.txt."
  if [[ "$repo" == "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_SHA:-}" ]]; then
    notes="Linger desktop $version, built from $GITHUB_SHA. Check downloads against SHA256SUMS.txt."
    flags+=(--target "$GITHUB_SHA")
  fi
  if [[ "$version" == *-* ]]; then
    notes="**Prerelease** for testing, not for general use. $notes"
    flags+=(--prerelease)
  else
    # releases/latest, which the download links use, follows this flag.
    flags+=(--latest)
  fi
  if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    gh release upload "$tag" "$dir"/* --repo "$repo" --clobber
    echo "desktop-release: updated the $tag release of $repo"
  else
    gh release create "$tag" "$dir"/* --repo "$repo" --title "Linger Desktop $version" --notes "$notes" "${flags[@]}"
    echo "desktop-release: created the $tag release of $repo"
  fi
  echo "desktop-release: https://github.com/$repo/releases/tag/$tag"
}

command="${1:-}"
shift || true
case "$command" in
  version) cmd_version "$@" ;;
  fetch-native) cmd_fetch_native "$@" ;;
  compile) cmd_compile "$@" ;;
  package) cmd_package "$@" ;;
  build) cmd_build "$@" ;;
  checksums) cmd_checksums "$@" ;;
  gitlab-upload) cmd_gitlab_upload "$@" ;;
  github-release) cmd_github_release "$@" ;;
  *) usage ;;
esac
