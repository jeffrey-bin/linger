#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

assert_expands_to() {
	local target=$1
	local expected=$2
	local output
	output=$(CI=false make --no-print-directory -n -C "$repo_root" LOCAL_ENV_FILE=apps/teamhub/deployments/compose/.env.example "$target")
	grep -F -- "$expected" <<<"$output" >/dev/null || fail "make $target did not expand to: $expected"
}

assert_expands_to dev-migrate "node ../../scripts/with-local-env.mjs -- go run ./cmd/migrate"
dev_migrate=$(CI=false make --no-print-directory -n -C "$repo_root" dev-migrate)
if grep -F -- 'docker compose' <<<"$dev_migrate" >/dev/null; then
	fail 'make dev-migrate must not start a database'
fi
assert_expands_to test-integration "./scripts/with-test-database.sh go test ./tests/integration/... -count=1 -timeout 15m"
assert_expands_to test-integration-process "go test -tags=integration_process ./tests/integration -count=1 -timeout 15m -run"
assert_expands_to test-integration-migrations "go test -tags=integration_migration_history ./tests/integration -count=1 -timeout 15m -run"
parallel_output=$(CI=false make --no-print-directory -n -C "$repo_root" PARALLEL=4 test-integration)
grep -F -- '-parallel 4' <<<"$parallel_output" >/dev/null || fail 'PARALLEL override did not reach go test -parallel'
assert_expands_to test-integration "go test ./tests/integration/layout -count=1"


grep -F -- 'down -v --remove-orphans' "$repo_root/scripts/lib/compose-cleanup.sh" >/dev/null || \
	fail 'shared Compose cleanup does not remove declared Volumes'
grep -F -- 'com.docker.compose.project' "$repo_root/scripts/lib/compose-cleanup.sh" >/dev/null || \
	fail 'shared Compose cleanup does not remove label-matched orphan Volumes'
grep -F -- 'cleanup_isolated_compose_project' "$repo_root/scripts/smoke-agent-compose.sh" >/dev/null || \
	fail "smoke-agent-compose.sh does not use isolated Compose cleanup"

printf 'PASS: development targets and smoke cleanup match the documented isolation boundaries\n'
