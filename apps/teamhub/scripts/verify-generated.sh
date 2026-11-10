#!/usr/bin/env bash
set -euo pipefail

: "${SQLC_VERSION:?SQLC_VERSION is required}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/teamhub-generated.XXXXXX")"
trap 'rm -rf "$tmp_root"' EXIT

mkdir -p "$tmp_root/migrations" "$tmp_root/internal/store"
cp "$repo_root/sqlc.yaml" "$tmp_root/sqlc.yaml"
cp "$repo_root"/migrations/*.sql "$tmp_root/migrations/"
cp -R "$repo_root/internal/store/queries" "$tmp_root/internal/store/queries"

(
  cd "$tmp_root"
  if [[ -n "${SQLC_BIN:-}" ]]; then
    "$SQLC_BIN" generate
  else
    go run "github.com/sqlc-dev/sqlc/cmd/sqlc@${SQLC_VERSION}" generate
  fi
)

if [[ ${1:-} == --write ]]; then
  cp "$tmp_root"/internal/store/*.go "$repo_root/internal/store/"
  echo "Generated Go files from the public migration plan."
  exit 0
fi

drift=0
list_generated() {
  local root="$1"

  (
    cd "$root"
    find internal/store -maxdepth 1 -type f \
      \( -name '*.sql.go' -o -name 'db.go' -o -name 'models.go' \) -print
  ) | LC_ALL=C sort
}

list_generated "$repo_root" >"$tmp_root/checked-in.list"
list_generated "$tmp_root" >"$tmp_root/generated.list"

if ! diff -u "$tmp_root/checked-in.list" "$tmp_root/generated.list"; then
  drift=1
fi

while IFS= read -r file; do
  checked_in="$repo_root/$file"
  generated="$tmp_root/$file"

  if [[ ! -f "$checked_in" ]] || ! cmp -s "$checked_in" "$generated"; then
    diff -u "$checked_in" "$generated" || true
    drift=1
  fi
done <"$tmp_root/generated.list"

if ((drift != 0)); then
  echo "Generated Go files are out of date. Run 'make generate' and review the diff." >&2
  exit 1
fi

echo "Generated Go file set and contents match their source definitions."
