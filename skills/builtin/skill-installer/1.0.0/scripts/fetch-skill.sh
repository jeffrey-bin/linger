#!/usr/bin/env bash
# Download one Skill directory from a GitHub repository into <dest>/<name>.
# Requires bash, curl, tar, and python3.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  fetch-skill.sh --url https://github.com/<owner>/<repo>/tree/<ref>/<path> --dest <dir> [--name <skill-name>]
  fetch-skill.sh --repo <owner>/<repo> --path <dir> [--ref <ref>] --dest <dir> [--name <skill-name>]
EOF
  exit 2
}

fail() {
  echo "fetch-skill: $*" >&2
  exit 1
}

url="" repo="" path="" ref="" dest="" name=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) url="${2:-}"; shift 2 || usage ;;
    --repo) repo="${2:-}"; shift 2 || usage ;;
    --path) path="${2:-}"; shift 2 || usage ;;
    --ref) ref="${2:-}"; shift 2 || usage ;;
    --dest) dest="${2:-}"; shift 2 || usage ;;
    --name) name="${2:-}"; shift 2 || usage ;;
    -h|--help) usage ;;
    *) echo "fetch-skill: unknown argument: $1" >&2; usage ;;
  esac
done

if [ -n "$url" ]; then
  [ -z "$repo" ] && [ -z "$path" ] && [ -z "$ref" ] || fail "--url cannot be combined with --repo, --path, or --ref"
  rest="${url#https://github.com/}"
  [ "$rest" != "$url" ] || fail "--url must start with https://github.com/"
  IFS=/ read -r url_owner url_repo url_tree url_ref url_path <<<"$rest"
  [ "${url_tree:-}" = "tree" ] && [ -n "${url_ref:-}" ] && [ -n "${url_path:-}" ] \
    || fail "--url must look like https://github.com/<owner>/<repo>/tree/<ref>/<path>"
  repo="$url_owner/$url_repo"
  ref="$url_ref"
  path="${url_path%/}"
fi

[ -n "$repo" ] && [ -n "$path" ] && [ -n "$dest" ] || usage

owner="${repo%%/*}"
repo_name="${repo#*/}"
valid_segment='^[A-Za-z0-9._-]+$'
[[ "$repo" == */* && "$repo_name" != */* ]] || fail "--repo must be <owner>/<repo>"
[[ "$owner" =~ $valid_segment && "$repo_name" =~ $valid_segment ]] \
  || fail "owner and repository may contain only letters, digits, '.', '_' and '-'"

path="${path%/}"
case "$path" in
  /*) fail "--path must be relative to the repository root" ;;
  *..*) fail "--path must not contain '..'" ;;
  "") fail "--path must not be empty" ;;
esac
if [ -n "$ref" ]; then
  case "$ref" in
    *..*|/*|*" "*) fail "invalid --ref" ;;
  esac
fi

[ -n "$name" ] || name="${path##*/}"
case "$name" in
  *..*|/*) fail "--name must not contain '..' or start with '/'" ;;
esac
[[ "$name" =~ $valid_segment ]] || fail "--name may contain only letters, digits, '.', '_' and '-'"

mkdir -p "$dest"
target="$dest/$name"
[ ! -e "$target" ] || fail "destination already exists: $target"

work="$(mktemp -d "$dest/.fetch-skill.XXXXXX")"
trap 'rm -rf "$work"' EXIT

api="https://api.github.com/repos/$owner/$repo_name/tarball"
[ -z "$ref" ] || api="$api/$ref"
curl_args=(-sS -L -H "Accept: application/vnd.github+json" -o "$work/archive.tar.gz" -w '%{http_code}')
token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
[ -z "$token" ] || curl_args+=(-H "Authorization: Bearer $token")

status="$(curl "${curl_args[@]}" "$api")" || fail "download failed: $api"
case "$status" in
  200) ;;
  404) fail "repository or ref not found: $repo${ref:+@$ref} (a private repository also returns 404 without a valid GITHUB_TOKEN/GH_TOKEN)" ;;
  401) fail "GitHub rejected the token (HTTP 401); check GITHUB_TOKEN/GH_TOKEN" ;;
  403|429) fail "GitHub refused the request (HTTP $status): missing permission or rate limit; set GITHUB_TOKEN/GH_TOKEN" ;;
  *) fail "GitHub returned HTTP $status for $api" ;;
esac

# GitHub archives have a single top-level directory such as owner-repo-<sha>/.
top="$(tar -tzf "$work/archive.tar.gz" | sed -n 1p)"
top="${top%%/*}"
[ -n "$top" ] || fail "downloaded archive is empty"
member="$top/$path"

listing="$(tar -tvzf "$work/archive.tar.gz" "$member" 2>/dev/null)" \
  || fail "path not found in $repo${ref:+@$ref}: $path"
if printf '%s\n' "$listing" | grep -q '^[lh]'; then
  fail "refusing $path: it contains symbolic or hard links"
fi

mkdir "$work/extract"
tar -xzf "$work/archive.tar.gz" -C "$work/extract" "$member"
staged="$work/extract/$member"
[ -d "$staged" ] || fail "path is not a directory: $path"
[ -z "$(find "$staged" -type l -print -quit)" ] || fail "refusing $path: it contains symbolic links"
[ -f "$staged/SKILL.md" ] || fail "no SKILL.md at the root of $path"

[ ! -e "$target" ] || fail "destination already exists: $target"
mv "$staged" "$target"
echo "$target"
