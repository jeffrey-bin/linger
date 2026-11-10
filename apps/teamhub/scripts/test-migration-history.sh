#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
checker="$script_dir/check-migration-history.sh"
fixture_root=$(mktemp -d)
trap 'rm -rf -- "$fixture_root"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

new_repository() {
  fixture_repository="$fixture_root/$1"
  mkdir -p "$fixture_repository/apps/teamhub/migrations"
  git -C "$fixture_repository" init -q
  git -C "$fixture_repository" config user.name Fixture
  git -C "$fixture_repository" config user.email fixture@example.invalid
  printf '%s\n' '-- +goose Up' 'SELECT 1;' >"$fixture_repository/apps/teamhub/migrations/00001_first.sql"
  git -C "$fixture_repository" add .
  git -C "$fixture_repository" commit -qm baseline
  git -C "$fixture_repository" branch target
}

expect_rejected() {
  local expected_message=$1
  local candidate_ref=${2:-}
  if probe_result=$(cd "$fixture_repository" && bash "$checker" target "$candidate_ref" 2>&1); then
    fail "checker accepted $expected_message"
  fi
  if ! grep -F "$expected_message" <<<"$probe_result" >/dev/null; then
    printf '%s\n' "$probe_result" >&2
    fail "checker did not report $expected_message"
  fi
}

new_repository unchanged
(cd "$fixture_repository" && bash "$checker" target) >/dev/null

new_repository rewrite
printf 'SELECT 2;\n' >>"$fixture_repository/apps/teamhub/migrations/00001_first.sql"
expect_rejected 'modified target migration'
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm rewrite
expect_rejected 'modified target migration' HEAD

new_repository deletion
rm "$fixture_repository/apps/teamhub/migrations/00001_first.sql"
expect_rejected 'missing published migration: apps/teamhub/migrations/00001_first.sql; restore the file as it exists at merge-base'
git -C "$fixture_repository" add -u
git -C "$fixture_repository" commit -qm delete
expect_rejected 'missing published migration: apps/teamhub/migrations/00001_first.sql; restore the file as it exists at merge-base' HEAD

new_repository collision
printf 'SELECT 2;\n' >"$fixture_repository/apps/teamhub/migrations/00001_second.sql"
expect_rejected 'duplicate migration version'

new_repository stale_number
printf 'SELECT 0;\n' >"$fixture_repository/apps/teamhub/migrations/00000_old.sql"
expect_rejected 'new migration version must exceed target maximum'

new_repository new_number
printf 'SELECT 2;\n' >"$fixture_repository/apps/teamhub/migrations/00002_second.sql"
(cd "$fixture_repository" && bash "$checker" target) >/dev/null
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm candidate
(cd "$fixture_repository" && bash "$checker" target HEAD) >/dev/null

# Official 379/380 must both remain byte-identical; a stale topic 380 cannot
# be treated as the platform migration or hide behind an older diff base.
new_repository official_379_380
printf 'SELECT 379;\n' >"$fixture_repository/apps/teamhub/migrations/00379_memory_session_facts.sql"
printf 'SELECT 380;\n' >"$fixture_repository/apps/teamhub/migrations/00380_local_computer_platform.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm official-379-380
git -C "$fixture_repository" branch -f target HEAD
printf 'SELECT 381;\n' >"$fixture_repository/apps/teamhub/migrations/00381_forward.sql"
(cd "$fixture_repository" && bash "$checker" target) >/dev/null
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm candidate
(cd "$fixture_repository" && bash "$checker" target HEAD) >/dev/null
printf 'SELECT 380;\n' >"$fixture_repository/apps/teamhub/migrations/00380_topic.sql"
expect_rejected 'duplicate migration version 380'
rm "$fixture_repository/apps/teamhub/migrations/00380_topic.sql"
printf 'SELECT 379;\n' >"$fixture_repository/apps/teamhub/migrations/000379_renamed.sql"
expect_rejected 'duplicate migration version 379'
rm "$fixture_repository/apps/teamhub/migrations/000379_renamed.sql"
printf 'SELECT 379;\n' >>"$fixture_repository/apps/teamhub/migrations/00379_memory_session_facts.sql"
expect_rejected 'modified target migration'
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm rewrite-official-379
expect_rejected 'modified target migration' HEAD
rm "$fixture_repository/apps/teamhub/migrations/00379_memory_session_facts.sql"
expect_rejected 'missing published migration: apps/teamhub/migrations/00379_memory_session_facts.sql; restore the file as it exists at merge-base'

# A target branch can advance after a long-lived source branch was created.
# Missing/modified use merge-base, so a behind branch that did not touch SQL
# is not missing target-tip files. Reused numbers still fail against the tip.
new_repository advanced_target
git -C "$fixture_repository" checkout -q target
printf 'SELECT 2;\n' >"$fixture_repository/apps/teamhub/migrations/00002_upstream.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm upstream
git -C "$fixture_repository" checkout -q -
printf 'SELECT 3;\n' >"$fixture_repository/apps/teamhub/migrations/00002_topic.sql"
expect_rejected 'new migration version must exceed target maximum'
cp "$fixture_root/new_number/apps/teamhub/migrations/00002_second.sql" "$fixture_repository/apps/teamhub/migrations/00002_upstream.sql"
expect_rejected 'duplicate migration version'

new_repository missing_ref
if probe_result=$(cd "$fixture_repository" && bash "$checker" absent 2>&1); then
  fail 'checker accepted a missing target ref'
fi
grep -F 'cannot read migration ref' <<<"$probe_result" >/dev/null || fail 'checker did not fail closed for a missing target ref'
# The repository assumes no default branch, so the caller must name the target.
if probe_result=$(cd "$fixture_repository" && bash "$checker" 2>&1); then
  fail 'checker ran without a target ref'
fi
grep -F 'Usage:' <<<"$probe_result" >/dev/null || fail 'checker did not print usage without a target ref'

# a. Target advanced; the MR did not touch migrations. Merge-base still has
# every published file, so the source branch is not missing SQL.
new_repository behind_without_migration
git -C "$fixture_repository" checkout -q target
printf 'SELECT 2;\n' >"$fixture_repository/apps/teamhub/migrations/00002_upstream.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm upstream
git -C "$fixture_repository" checkout -q -
(cd "$fixture_repository" && bash "$checker" target) >/dev/null
(cd "$fixture_repository" && bash "$checker" target HEAD) >/dev/null

# b. Target advanced; the MR adds a version at or below the target tip maximum.
new_repository behind_stale_number
git -C "$fixture_repository" checkout -q target
printf 'SELECT 2;\n' >"$fixture_repository/apps/teamhub/migrations/00002_upstream.sql"
printf 'SELECT 3;\n' >"$fixture_repository/apps/teamhub/migrations/00003_upstream.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm upstream
git -C "$fixture_repository" checkout -q -
printf 'SELECT 2;\n' >"$fixture_repository/apps/teamhub/migrations/00002_topic.sql"
expect_rejected 'new migration version must exceed target maximum'
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm topic
expect_rejected 'new migration version must exceed target maximum' HEAD

# c. Target advanced with 00002_upstream; the MR adds 00002_topic (same version).
new_repository behind_tip_collision
git -C "$fixture_repository" checkout -q target
printf 'SELECT 2;\n' >"$fixture_repository/apps/teamhub/migrations/00002_upstream.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm upstream
git -C "$fixture_repository" checkout -q -
printf 'SELECT 9;\n' >"$fixture_repository/apps/teamhub/migrations/00002_topic.sql"
expect_rejected 'new migration version must exceed target maximum'
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm topic
expect_rejected 'new migration version must exceed target maximum' HEAD

# d. Deleting SQL that existed at merge-base still fails after the target advances.
new_repository delete_published_while_behind
git -C "$fixture_repository" checkout -q target
printf 'SELECT 2;\n' >"$fixture_repository/apps/teamhub/migrations/00002_upstream.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm upstream
git -C "$fixture_repository" checkout -q -
rm "$fixture_repository/apps/teamhub/migrations/00001_first.sql"
expect_rejected 'missing published migration: apps/teamhub/migrations/00001_first.sql; restore the file as it exists at merge-base'
git -C "$fixture_repository" add -u
git -C "$fixture_repository" commit -qm delete
expect_rejected 'missing published migration: apps/teamhub/migrations/00001_first.sql; restore the file as it exists at merge-base' HEAD

# e. Rewriting SQL that existed at merge-base still fails after the target advances.
new_repository modify_published_while_behind
git -C "$fixture_repository" checkout -q target
printf 'SELECT 2;\n' >"$fixture_repository/apps/teamhub/migrations/00002_upstream.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm upstream
git -C "$fixture_repository" checkout -q -
printf 'SELECT 1 rewritten;\n' >>"$fixture_repository/apps/teamhub/migrations/00001_first.sql"
expect_rejected 'modified target migration'
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm rewrite
expect_rejected 'modified target migration' HEAD

# f. No merge-base: unrelated histories, or a clone too shallow to connect the refs.
new_repository unrelated_histories
git -C "$fixture_repository" checkout -q --orphan unrelated
git -C "$fixture_repository" rm -rfq .
mkdir -p "$fixture_repository/apps/teamhub/migrations"
printf '%s\n' '-- +goose Up' 'SELECT 9;' >"$fixture_repository/apps/teamhub/migrations/00009_other.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm unrelated
expect_rejected 'cannot resolve merge-base' HEAD

new_repository shallow_clone_source
git -C "$fixture_repository" checkout -q target
printf 'SELECT 2;\n' >"$fixture_repository/apps/teamhub/migrations/00002_upstream.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm upstream
for extra in 1 2 3 4 5; do
  printf 'SELECT extra %s;\n' "$extra" >>"$fixture_repository/apps/teamhub/migrations/00002_upstream.sql"
  git -C "$fixture_repository" add .
  git -C "$fixture_repository" commit -qm "target-extra-$extra"
done
git -C "$fixture_repository" checkout -q -
printf 'SELECT topic;\n' >"$fixture_repository/apps/teamhub/migrations/00003_topic.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm topic
for extra in 1 2 3 4 5; do
  printf 'topic %s\n' "$extra" >>"$fixture_repository/apps/teamhub/migrations/00003_topic.sql"
  git -C "$fixture_repository" add .
  git -C "$fixture_repository" commit -qm "topic-extra-$extra"
done
shallow_clone="$fixture_root/shallow_clone"
git clone -q --depth=1 "file://$fixture_repository" "$shallow_clone"
git -C "$shallow_clone" fetch -q --depth=1 origin target:target
fixture_repository=$shallow_clone
expect_rejected 'cannot resolve merge-base' HEAD

# g. After fork, target and MR each add the same filename with different content.
new_repository add_add_divergent
git -C "$fixture_repository" checkout -q target
printf 'SELECT 2;\n' >"$fixture_repository/apps/teamhub/migrations/00501_dev.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm upstream
git -C "$fixture_repository" checkout -q -
printf 'SELECT 99;\n' >"$fixture_repository/apps/teamhub/migrations/00501_dev.sql"
expect_rejected 'modified target migration'
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm topic
expect_rejected 'modified target migration' HEAD

# h. After fork, target and MR each add the same filename with identical content.
new_repository add_add_identical
git -C "$fixture_repository" checkout -q target
printf 'SELECT 2;\n' >"$fixture_repository/apps/teamhub/migrations/00501_dev.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm upstream
git -C "$fixture_repository" checkout -q -
printf 'SELECT 2;\n' >"$fixture_repository/apps/teamhub/migrations/00501_dev.sql"
(cd "$fixture_repository" && bash "$checker" target) >/dev/null
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm topic
(cd "$fixture_repository" && bash "$checker" target HEAD) >/dev/null

# The schema baseline is the sole deletion exception: SQL up to 852 may be
# deleted only in the change that adds the baseline, and never rewritten.
baseline=apps/teamhub/migrations/00852_baseline.sql
new_repository squash_into_baseline
rm "$fixture_repository/apps/teamhub/migrations/00001_first.sql"
printf '%s\n' '-- +goose Up' 'SELECT 852;' >"$fixture_repository/$baseline"
(cd "$fixture_repository" && bash "$checker" target) >/dev/null
git -C "$fixture_repository" add -A
git -C "$fixture_repository" commit -qm squash
(cd "$fixture_repository" && bash "$checker" target HEAD) >/dev/null

# The baseline takes over the version of the last file it replaces, so a
# database already at that version skips it.
new_repository baseline_takes_last_version
printf '%s\n' '-- +goose Up' 'SELECT 852;' >"$fixture_repository/apps/teamhub/migrations/00852_last.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm published-852
git -C "$fixture_repository" branch -f target HEAD
rm "$fixture_repository/apps/teamhub/migrations/00001_first.sql" "$fixture_repository/apps/teamhub/migrations/00852_last.sql"
printf '%s\n' '-- +goose Up' 'SELECT 852;' >"$fixture_repository/$baseline"
(cd "$fixture_repository" && bash "$checker" target) >/dev/null

# A branch that forked before the baseline still carries the files it
# replaced; only its own new SQL must beat the target maximum.
new_repository fork_before_baseline
git -C "$fixture_repository" checkout -q -b topic
printf '%s\n' '-- +goose Up' 'SELECT 853;' >"$fixture_repository/apps/teamhub/migrations/00853_topic.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm topic
git -C "$fixture_repository" checkout -q target
git -C "$fixture_repository" rm -q apps/teamhub/migrations/00001_first.sql
mkdir -p "$fixture_repository/apps/teamhub/migrations"
printf '%s\n' '-- +goose Up' 'SELECT 852;' >"$fixture_repository/$baseline"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm squash
git -C "$fixture_repository" checkout -q topic
(cd "$fixture_repository" && bash "$checker" target HEAD) >/dev/null
printf '%s\n' '-- +goose Up' 'SELECT 851;' >"$fixture_repository/apps/teamhub/migrations/00851_stale.sql"
expect_rejected 'new migration version must exceed target maximum 852'

new_repository rewrite_beside_baseline
printf 'SELECT 2;\n' >>"$fixture_repository/apps/teamhub/migrations/00001_first.sql"
printf '%s\n' '-- +goose Up' 'SELECT 852;' >"$fixture_repository/$baseline"
expect_rejected 'modified target migration'

new_repository delete_after_baseline
printf '%s\n' '-- +goose Up' 'SELECT 852;' >"$fixture_repository/$baseline"
printf '%s\n' '-- +goose Up' 'SELECT 853;' >"$fixture_repository/apps/teamhub/migrations/00853_after.sql"
git -C "$fixture_repository" add .
git -C "$fixture_repository" commit -qm published-853
git -C "$fixture_repository" branch -f target HEAD
rm "$fixture_repository/apps/teamhub/migrations/00853_after.sql"
expect_rejected 'missing published migration: apps/teamhub/migrations/00853_after.sql'

printf 'PASS: migration history preserves target SQL and rejects stale or colliding versions\n'
