#!/usr/bin/env bash
set -euo pipefail

# Local merge-request repository gate. Any future CI adapter resolves its
# platform's target ref and calls this script, or make check-repository-gate.
#
# Inputs (environment):
#   BASE  target ref or diff base commit (required); the gate diffs from
#         merge-base(BASE, HEAD), so a branch tip works locally

if [[ -z "${BASE:-}" ]]; then
  echo "Usage: BASE=<target-ref> $0  (or: make check-repository-gate BASE=<target-ref>)" >&2
  exit 2
fi

script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
head_sha="$(git rev-parse --verify "HEAD^{commit}")"
base_tip="$(git rev-parse --verify "${BASE}^{commit}")"
# A local target tip may have moved past the merge base.
base="$(git merge-base "$base_tip" "$head_sha")"
# The make targets below take no base; keep the caller's value out of them.
unset BASE

if ! git diff --quiet "$base" "$head_sha" -- 'apps/teamhub/migrations/*.sql'; then
  # Compare SQL with the current target tip, not just the old diff base:
  # long-lived branches can otherwise reuse a version added upstream.
  bash "$script_root/../../apps/teamhub/scripts/check-migration-history.sh" \
    "$base_tip" "$head_sha"
fi

pnpm exec commitlint --from "$base" --to "$head_sha" --verbose

# Every variable runtime code reads is documented in .env.example or the inventory.
pnpm env:inventory:check

# Format and lint the files this branch adds or changes. Published built-in
# Skill versions are immutable and never reformatted.
prettier_files=()
eslint_files=()
while IFS= read -r -d '' file; do
  [[ "$file" =~ ^skills/builtin/[^/]+/[^/]+/ ]] && continue
  [[ -f "$file" ]] || continue
  case "$file" in
    *.cjs | *.css | *.html | *.js | *.json | *.jsonc | *.jsx | *.md | *.mdx | *.mjs | *.mts | *.scss | *.ts | *.tsx | *.yaml | *.yml)
      prettier_files+=("$file")
      ;;
  esac
  case "$file" in
    *.cjs | *.cts | *.js | *.jsx | *.mjs | *.mts | *.ts | *.tsx) eslint_files+=("$file") ;;
  esac
done < <(git -c core.quotePath=false diff -z --name-only --no-renames --diff-filter=ACMRT "$base" "$head_sha")
if ((${#prettier_files[@]} > 0)); then
  pnpm exec prettier --check "${prettier_files[@]}"
fi
if ((${#eslint_files[@]} > 0)); then
  pnpm exec eslint "${eslint_files[@]}"
fi

make check-scripts-fast check-docs
