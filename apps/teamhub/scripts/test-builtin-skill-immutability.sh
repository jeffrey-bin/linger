#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
checker="$script_dir/check-builtin-skill-immutability.sh"
work_root=$(mktemp -d)
repo="$work_root/repo"

cleanup() {
	rm -rf -- "$work_root"
}
trap cleanup EXIT

fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

git_in_repo() {
	git -C "$repo" -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false "$@"
}

mkdir -p "$repo/skills/builtin/demo/1.0.0"
git -C "$repo" init -q
base_catalog='schema_version: 1
skills:
  - manifests:
      - package_path: builtin/demo/1.0.0
  - manifests:
      - package_path: builtin/old/1.0.0
'
printf '%s' "$base_catalog" >"$repo/skills/builtin/catalog.yaml"
printf -- '---\nname: demo\ndescription: Demo.\n---\n# Demo 1.0.0\n' >"$repo/skills/builtin/demo/1.0.0/SKILL.md"
printf 'notes\n' >"$repo/skills/builtin/demo/1.0.0/reference notes.md"
mkdir -p "$repo/skills/builtin/old/1.0.0"
printf 'published package\n' >"$repo/skills/builtin/old/1.0.0/SKILL.md"
printf 'published resource\n' >"$repo/skills/builtin/old/1.0.0/reference.md"
git_in_repo add -A
git_in_repo commit -q -m "base built-in Skills"
base=$(git -C "$repo" rev-parse HEAD)

# Each scenario starts from the base commit and records one change as a new commit.
reset_repo() {
	git_in_repo reset -q --hard "$base"
	git_in_repo clean -fdq
}

commit_scenario() {
	git_in_repo add -A
	# Allow an empty commit so a net no-op scenario still records HEAD.
	git_in_repo commit -q --allow-empty -m "scenario"
}

# Base selection comes from the environment. Each scenario sets check_env to the
# variables it needs; the default pins the base to the fixture base commit.
check_env=("BUILTIN_SKILL_BASE_REF=$base")
run_check() {
	(cd "$repo" && env -u BUILTIN_SKILL_BASE_REF \
		${check_env[@]+"${check_env[@]}"} bash "$checker")
}

assert_passes() {
	local name=$1
	local output
	if ! output=$(run_check 2>&1); then
		fail "$name: expected pass, got: $output"
	fi
}

assert_fails() {
	local name=$1
	local offending=$2
	local output
	if output=$(run_check 2>&1); then
		fail "$name: expected failure"
	fi
	grep -F -- "$offending" <<<"$output" >/dev/null || fail "$name: output does not name $offending: $output"
	grep -F -- 'published built-in Skill versions are immutable; add a new version directory and catalog entry' \
		<<<"$output" >/dev/null || fail "$name: output omits the immutability rule"
}

# (a) A new version directory and a catalog edit are allowed, including spaced file names.
reset_repo
mkdir -p "$repo/skills/builtin/demo/1.1.0"
printf -- '---\nname: demo\ndescription: Demo.\n---\n# Demo 1.1.0\n' >"$repo/skills/builtin/demo/1.1.0/SKILL.md"
printf 'notes\n' >"$repo/skills/builtin/demo/1.1.0/reference notes.md"
printf '%s      - package_path: builtin/demo/1.1.0\n' "$base_catalog" >"$repo/skills/builtin/catalog.yaml"
commit_scenario
assert_passes "new version and catalog edit"

# (b) Editing a published version fails.
reset_repo
printf -- '---\nname: demo\ndescription: Edited.\n---\n# Edited\n' >"$repo/skills/builtin/demo/1.0.0/SKILL.md"
commit_scenario
assert_fails "modified published file" "skills/builtin/demo/1.0.0/SKILL.md"

# (c) Deleting a single file from a published version fails.
reset_repo
git_in_repo rm -q "skills/builtin/demo/1.0.0/SKILL.md"
commit_scenario
assert_fails "deleted published file" "skills/builtin/demo/1.0.0/SKILL.md"

# (d) Adding a file to a published version fails.
reset_repo
printf 'extra\n' >"$repo/skills/builtin/demo/1.0.0/extra.md"
commit_scenario
assert_fails "added file to published version" "skills/builtin/demo/1.0.0/extra.md"

# (e) A spaced file name inside a published version is reported intact.
reset_repo
printf 'changed\n' >"$repo/skills/builtin/demo/1.0.0/reference notes.md"
commit_scenario
assert_fails "modified spaced file name" "skills/builtin/demo/1.0.0/reference notes.md"

# (f) Deleting a whole published version that the catalog still lists fails.
reset_repo
git_in_repo rm -rq "skills/builtin/demo/1.0.0"
commit_scenario
assert_fails "deleted published version" "skills/builtin/demo/1.0.0"

# (g) Deleting and re-adding a published version with different content fails.
reset_repo
git_in_repo rm -rq "skills/builtin/demo/1.0.0"
mkdir -p "$repo/skills/builtin/demo/1.0.0"
printf -- '---\nname: demo\ndescription: Replaced.\n---\n# Replaced\n' >"$repo/skills/builtin/demo/1.0.0/SKILL.md"
printf 'notes\n' >"$repo/skills/builtin/demo/1.0.0/reference notes.md"
commit_scenario
assert_fails "re-added published version with different content" "skills/builtin/demo/1.0.0"

# (h) Deleting and re-adding a published version with identical content is a net no-op.
reset_repo
git_in_repo rm -rq "skills/builtin/demo/1.0.0"
mkdir -p "$repo/skills/builtin/demo/1.0.0"
printf -- '---\nname: demo\ndescription: Demo.\n---\n# Demo 1.0.0\n' >"$repo/skills/builtin/demo/1.0.0/SKILL.md"
printf 'notes\n' >"$repo/skills/builtin/demo/1.0.0/reference notes.md"
commit_scenario
assert_passes "re-added published version with identical content"

# A version may be retired only as a complete directory that also leaves the catalog.
reset_repo
git_in_repo rm -rq "skills/builtin/old/1.0.0"
printf 'schema_version: 1\nskills:\n  - manifests:\n      - package_path: builtin/demo/1.0.0\n' >"$repo/skills/builtin/catalog.yaml"
commit_scenario
assert_passes "complete removal with catalog removal"

reset_repo
git_in_repo rm -rq "skills/builtin/old/1.0.0"
commit_scenario
assert_fails "complete removal while catalog still lists it" "skills/builtin/old/1.0.0 (deleted while still in catalog)"

reset_repo
git_in_repo rm -q "skills/builtin/old/1.0.0/reference.md"
printf 'schema_version: 1\nskills:\n  - manifests:\n      - package_path: builtin/demo/1.0.0\n' >"$repo/skills/builtin/catalog.yaml"
commit_scenario
assert_fails "partial file deletion" "skills/builtin/old/1.0.0/reference.md"

reset_repo
printf 'edited\n' >"$repo/skills/builtin/old/1.0.0/SKILL.md"
printf 'schema_version: 1\nskills:\n  - manifests:\n      - package_path: builtin/demo/1.0.0\n' >"$repo/skills/builtin/catalog.yaml"
commit_scenario
assert_fails "modified version" "skills/builtin/old/1.0.0/SKILL.md"

# (i) The base is the merge base with the ref the caller passes. The target has moved
# on to 2.0.0 while the branch forked before it, so the branch does not look like it
# deleted 2.0.0 and passes.
reset_repo
mkdir -p "$repo/skills/builtin/demo/2.0.0"
printf -- '---\nname: demo\ndescription: Demo.\n---\n# Demo 2.0.0\n' >"$repo/skills/builtin/demo/2.0.0/SKILL.md"
git_in_repo add -A
git_in_repo commit -q -m "target gains 2.0.0"
target=$(git -C "$repo" rev-parse HEAD)
git_in_repo reset -q --hard "$base"
git_in_repo clean -fdq
check_env=("BUILTIN_SKILL_BASE_REF=$target")
assert_passes "branch behind its base passes via merge base"

# (j) The merge base is still the base when a branch edits a published version after
# the target has moved on, so the edit fails.
reset_repo
printf -- '---\nname: demo\ndescription: Edited.\n---\n# Edited\n' >"$repo/skills/builtin/demo/1.0.0/SKILL.md"
commit_scenario
assert_fails "modified published file against the merge base" "skills/builtin/demo/1.0.0/SKILL.md"

# (k) Without a base the check fails: the repository assumes no default branch, and an
# origin/dev ref does not stand in for one.
reset_repo
git_in_repo update-ref refs/remotes/origin/dev "$target"
check_env=()
if output=$(run_check 2>&1); then
	fail "no base ref: expected failure"
fi
grep -F -- 'needs a base' <<<"$output" >/dev/null || fail "no base ref: message missing: $output"

# (l) make check runs every target with BASE. The Makefile hands it to this check, so
# a clone without origin/dev still compares against the base the caller chose.
recipe=$(make -s -n -C "$script_dir/.." check-builtin-skill-immutability BASE=fixture-base 2>&1) ||
	fail "make dry run failed: $recipe"
grep -F -- 'BUILTIN_SKILL_BASE_REF="${BUILTIN_SKILL_BASE_REF:-fixture-base}"' <<<"$recipe" >/dev/null ||
	fail "make does not pass BASE to the check: $recipe"

printf '%s\n' 'PASS: built-in Skill immutability script tests'
