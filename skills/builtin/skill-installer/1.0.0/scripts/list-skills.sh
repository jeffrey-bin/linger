#!/usr/bin/env bash
# Print each child directory of a GitHub repository path that contains SKILL.md.
# Requires bash, curl, and python3.
set -euo pipefail

usage() {
  echo "usage: list-skills.sh --repo <owner>/<repo> [--path <dir>] [--ref <ref>]" >&2
  exit 2
}

fail() {
  echo "list-skills: $*" >&2
  exit 1
}

repo="" path="skills" ref=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 || usage ;;
    --path) path="${2:-}"; shift 2 || usage ;;
    --ref) ref="${2:-}"; shift 2 || usage ;;
    -h|--help) usage ;;
    *) echo "list-skills: unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$repo" ] || usage

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
esac
case "$ref" in
  *..*|/*|*" "*) fail "invalid --ref" ;;
esac

token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT

# Fetches the contents listing of one repository path into $body.
fetch_contents() {
  local url="https://api.github.com/repos/$owner/$repo_name/contents/$1"
  [ -z "$ref" ] || url="$url?ref=$ref"
  local args=(-sS -L -H "Accept: application/vnd.github+json" -o "$body" -w '%{http_code}')
  [ -z "$token" ] || args+=(-H "Authorization: Bearer $token")
  local status
  status="$(curl "${args[@]}" "$url")" || fail "request failed: $url"
  case "$status" in
    200) ;;
    404) fail "not found: $repo${ref:+@$ref}:$1 (a private repository also returns 404 without a valid GITHUB_TOKEN/GH_TOKEN)" ;;
    401) fail "GitHub rejected the token (HTTP 401); check GITHUB_TOKEN/GH_TOKEN" ;;
    403|429) fail "GitHub refused the request (HTTP $status): missing permission or rate limit; set GITHUB_TOKEN/GH_TOKEN" ;;
    *) fail "GitHub returned HTTP $status for $url" ;;
  esac
}

# Prints entry names of the given type ("dir" or "file") from $body.
entries() {
  python3 -I -c '
import json, sys
data = json.load(open(sys.argv[1]))
if isinstance(data, list):
    for item in data:
        if item.get("type") == sys.argv[2]:
            print(item["name"])
' "$body" "$1"
}

fetch_contents "$path"
dirs="$(entries dir)"
[ -n "$dirs" ] || exit 0
while IFS= read -r child; do
  fetch_contents "${path:+$path/}$child"
  if entries file | grep -x 'SKILL.md' >/dev/null; then
    echo "$child"
  fi
done <<<"$dirs"
