#!/bin/sh
# `stack.sh ARGS` runs `localmodels stack ARGS` from the release pinned below. The first run
# downloads that release's self-contained Python + localmodels kit, checks its SHA256 and every
# file it lists, and caches it; later runs start offline. No system Python is needed.
# llm-inference-lab's release pipeline writes the pin; edit the template there, not this copy.
set -eu

# >>> release pin
STACK_VERSION='0.1.0.dev28'
STACK_SOURCE_COMMIT='c77bed6e5b65c30314d96dfe8dc9b7ab964c5332'
STACK_BASE_URL='https://d2ikbbcl3j6jz9.cloudfront.net/cli/localmodels/0.1.0.dev28'
STACK_KIT_darwin_arm64='abd3baeabd3d43bd4a4e5fc3694ed2456d5b32b3b8d0b3805856d9b0a57272c8'
STACK_KIT_darwin_x64='c3aeb71c912948acb2fb8a4ef8a9f278d16a767d34323c655be83801ef1a8789'
STACK_KIT_linux_arm64='feffffef4bdfff3d3aff4f248b1daaf804d5a238c3dc58560b42947cb2ecaa09'
STACK_KIT_linux_x64='2923a04c83c88237814e753cfc3637bdc80545aa77defa669d8ff42cd85d6eb8'
# <<< release pin

die() {
  printf 'stack.sh: %s\n' "$*" >&2
  exit 2
}

[ -n "${STACK_VERSION}" ] ||
  die "this is the unpinned template; run the copy a release wrote to linger scripts/installs"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64 | Linux-amd64) target=linux-x64 kit=${STACK_KIT_linux_x64} ;;
  Linux-aarch64 | Linux-arm64) target=linux-arm64 kit=${STACK_KIT_linux_arm64} ;;
  Darwin-arm64) target=darwin-arm64 kit=${STACK_KIT_darwin_arm64} ;;
  Darwin-x86_64) target=darwin-x64 kit=${STACK_KIT_darwin_x64} ;;
  *) die "no localmodels kit for $(uname -s) $(uname -m); on Windows run stack.ps1" ;;
esac
[ -n "${kit}" ] || die "release ${STACK_VERSION} has no ${target} kit"

# Kits are keyed by archive SHA256, so a new pin never reuses an older kit.
root=${LOCALMODELS_KIT_HOME:-${XDG_CACHE_HOME:-${HOME}/.cache}/linger-localmodels/kits}
final=${root}/${kit}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die "sha256sum or shasum is required"
  fi
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "curl or wget is required"
  fi
}

install_kit() {
  # LOCALMODELS_KIT_BASE_URL serves the same files from a mirror; the pinned SHA256 still applies.
  url=${LOCALMODELS_KIT_BASE_URL:-${STACK_BASE_URL}}/${target}.tgz
  mkdir -p "${root}"
  staging=$(mktemp -d "${root}/.staging.XXXXXX")
  trap 'rm -rf "${staging}"' EXIT
  trap 'exit 130' INT TERM
  printf 'stack.sh: downloading localmodels %s (source %s, %s)\n' \
    "${STACK_VERSION}" "${STACK_SOURCE_COMMIT}" "${target}" >&2
  fetch "${url}" "${staging}/kit.tgz" || die "download failed: ${url}"
  actual=$(sha256_of "${staging}/kit.tgz")
  [ "${actual}" = "${kit}" ] || die "SHA256 mismatch for ${url}: expected ${kit}, got ${actual}"
  mkdir "${staging}/kit"
  tar -xzf "${staging}/kit.tgz" -C "${staging}/kit"
  "${staging}/kit/python/bin/python3" -I -B "${staging}/kit/kit.py" activate \
    "${staging}/kit" "${final}" || die "the downloaded kit failed verification"
  rm -rf "${staging}"
  trap - EXIT INT TERM
}

[ -f "${final}/kit.py" ] || install_kit
[ "$#" -gt 0 ] || set -- --help
exec "${final}/python/bin/python3" -I -B "${final}/kit.py" run stack "$@"
