#!/usr/bin/env bash

set -uo pipefail

if (($# == 0)); then
  printf 'usage: %s command [args...]\n' "$0" >&2
  exit 2
fi

if [[ -n ${TEST_DATABASE_URL:-} ]]; then
  if [[ ${TEAMHUB_ALLOW_EXTERNAL_TEST_DATABASE:-} != 1 ]]; then
    printf 'FAIL: caller-provided TEST_DATABASE_URL requires TEAMHUB_ALLOW_EXTERNAL_TEST_DATABASE=1\n' >&2
    exit 2
  fi
  if [[ -z ${TEAMHUB_TEST_RUN_TOKEN:-} ]]; then
    printf 'FAIL: caller-provided TEST_DATABASE_URL requires TEAMHUB_TEST_RUN_TOKEN\n' >&2
    exit 2
  fi
  printf 'Using explicitly authorized external test control database; lifecycle is caller-managed.\n'
  exec "$@"
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)
compose_file="$repo_root/deployments/compose/docker-compose.test.yml"
run_id="$(date +%s)-$$-$RANDOM"
project_name="teamhub-test-$run_id"
container_name="$project_name-postgres"
network_name="$project_name-network"
requested_postgres_port=${TEAMHUB_TEST_POSTGRES_PORT:-0}
postgres_port=
run_token="$project_name"
command_pid=
shared_mode=0
artifact_storage_root=$(mktemp -d "${TMPDIR:-/tmp}/teamhub-test-artifacts.XXXXXX")

export TEAMHUB_TEST_CONTAINER_NAME=$container_name
export TEAMHUB_TEST_NETWORK_NAME=$network_name
export TEAMHUB_TEST_POSTGRES_PORT=$requested_postgres_port
export TEAMHUB_TEST_RUN_TOKEN=$run_token
export TEAMHUB_ARTIFACT_STORAGE_ROOT=$artifact_storage_root
compose=(docker compose --project-name "$project_name" --file "$compose_file")

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 2
}

if [[ ! $project_name =~ ^teamhub-test-[0-9]+-[0-9]+-[0-9]+$ ]] ||
  [[ $container_name != "$project_name-postgres" ]] ||
  [[ $network_name != "$project_name-network" ]] ||
  [[ $run_token != "$project_name" ]]; then
  fail 'refusing to manage an invalid per-run Compose identity'
fi
if [[ ! $requested_postgres_port =~ ^[0-9]+$ ]] ||
  ((requested_postgres_port < 0 || requested_postgres_port > 65535)); then
  fail 'TEAMHUB_TEST_POSTGRES_PORT must be an integer in 0..65535'
fi
if ((requested_postgres_port == 54339)); then
  fail 'TEAMHUB_TEST_POSTGRES_PORT must not use the default development database port 54339'
fi

validate_compose() {
  local compact_config configured_networks configured_services rendered_config
  "${compose[@]}" config --quiet || return
  configured_services=$("${compose[@]}" config --services | LC_ALL=C sort) || return
  configured_networks=$("${compose[@]}" config --networks) || return
  rendered_config=$("${compose[@]}" config --format json) || return
  compact_config=$(printf '%s' "$rendered_config" | tr -d '[:space:]') || return
  [[ $configured_services == postgres ]] || {
    printf 'FAIL: test Compose file contains unexpected services\n' >&2
    return 1
  }
  [[ $configured_networks == default ]] || {
    printf 'FAIL: test Compose file contains an unexpected network\n' >&2
    return 1
  }
  [[ $compact_config == *\"container_name\":\"$container_name\"* ]] || {
    printf 'FAIL: test Compose file did not render the per-run container name\n' >&2
    return 1
  }
  [[ $compact_config == *\"name\":\"$network_name\"* ]] || {
    printf 'FAIL: test Compose file did not render the per-run network name\n' >&2
    return 1
  }
}

validate_resource_labels() {
  local resource_kind=$1
  local resource_name=$2
  local expected_compose_kind=$3
  local compose_kind label_root managed_label project_label token_label
  if ! docker "$resource_kind" inspect "$resource_name" >/dev/null 2>&1; then
    return 0
  fi
  if [[ $resource_kind == container ]]; then
    label_root=.Config.Labels
  else
    label_root=.Labels
  fi
  project_label=$(docker "$resource_kind" inspect --format "{{ index $label_root \"com.docker.compose.project\" }}" "$resource_name") || return 1
  compose_kind=$(docker "$resource_kind" inspect --format "{{ index $label_root \"com.docker.compose.$expected_compose_kind\" }}" "$resource_name") || return 1
  managed_label=$(docker "$resource_kind" inspect --format "{{ index $label_root \"com.linger.teamhub.test-managed\" }}" "$resource_name") || return 1
  token_label=$(docker "$resource_kind" inspect --format "{{ index $label_root \"com.linger.teamhub.test-run-token\" }}" "$resource_name") || return 1
  if [[ $project_label != "$project_name" || $managed_label != true || $token_label != "$run_token" ]]; then
    printf 'FAIL: refusing to remove %s %s with project=%s managed=%s run_token=%s\n' \
      "$resource_kind" "$resource_name" "$project_label" "$managed_label" "$token_label" >&2
    return 1
  fi
  case "$expected_compose_kind" in
    service) [[ $compose_kind == postgres ]] ;;
    network) [[ $compose_kind == default ]] ;;
    *) return 1 ;;
  esac || {
    printf 'FAIL: refusing to remove %s %s with unexpected Compose %s label %s\n' \
      "$resource_kind" "$resource_name" "$expected_compose_kind" "$compose_kind" >&2
    return 1
  }
}

remove_test_environment() {
  local leftover_volumes resource resource_kind resource_name
  # Inside an EXIT trap, bare return can reuse the pre-trap exit status in Bash.
  # A rejected cleanup must stay a failure on both macOS and Linux.
  validate_resource_labels container "$container_name" service || return 1
  validate_resource_labels network "$network_name" network || return 1
  # The image declares VOLUME, so Compose creates an anonymous Volume for the
  # container. `down --volumes` removes it together with the project.
  "${compose[@]}" down --volumes || return 1
  leftover_volumes=$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project_name") || return 1
  if [[ -n $leftover_volumes ]]; then
    printf 'FAIL: managed anonymous Volume remains after cleanup: %s\n' "$leftover_volumes" >&2
    return 1
  fi
  for resource in "container:$container_name" "network:$network_name"; do
    resource_kind=${resource%%:*}
    resource_name=${resource#*:}
    if docker "$resource_kind" inspect "$resource_name" >/dev/null 2>&1; then
      printf 'FAIL: managed %s %s remains after cleanup\n' "$resource_kind" "$resource_name" >&2
      return 1
    fi
  done
}

cleanup() {
  local command_status=$?
  local cleanup_status=0
  trap - EXIT HUP INT TERM
  if ((shared_mode)); then
    printf 'Keeping shared test database %s running.\n' "$TEAMHUB_TEST_RUN_TOKEN"
  else
    printf 'Cleaning isolated test database project %s...\n' "$project_name"
    remove_test_environment || cleanup_status=$?
  fi
  if [[ $artifact_storage_root == "${TMPDIR:-/tmp}"/teamhub-test-artifacts.* && -d $artifact_storage_root ]]; then
    rm -rf -- "$artifact_storage_root"
  else
    printf 'FAIL: refusing to remove invalid test artifact root %s\n' "$artifact_storage_root" >&2
    cleanup_status=1
  fi
  if ((command_status != 0)); then
    exit "$command_status"
  fi
  exit "$cleanup_status"
}

forward_signal() {
  local signal_name=$1
  local signal_exit_code=$2
  trap - HUP INT TERM
  if [[ -n $command_pid ]] && kill -0 "$command_pid" 2>/dev/null; then
    kill -s "$signal_name" "$command_pid" 2>/dev/null || true
    wait "$command_pid" 2>/dev/null || true
  fi
  exit "$signal_exit_code"
}

trap cleanup EXIT
trap 'forward_signal HUP 129' HUP
trap 'forward_signal INT 130' INT
trap 'forward_signal TERM 143' TERM

# An explicitly started shared database is reused and left running; its
# per-test databases are still isolated by the test helper.
if [[ ${TEAMHUB_TEST_DATABASE:-} != isolated ]] &&
  shared_env=$("$script_dir/shared-test-database.sh" env); then
  shared_mode=1
  export TEST_DATABASE_URL=$(sed -n 's/^TEST_DATABASE_URL=//p' <<<"$shared_env")
  export TEAMHUB_TEST_RUN_TOKEN=$(sed -n 's/^TEAMHUB_TEST_RUN_TOKEN=//p' <<<"$shared_env")
  printf 'Using shared test database %s; stop it with make test-db-down.\n' "$TEAMHUB_TEST_RUN_TOKEN"
  "$@" &
  command_pid=$!
  wait "$command_pid"
  command_status=$?
  command_pid=
  exit "$command_status"
fi

validate_compose || fail 'test Compose identity validation failed'
printf 'Starting isolated Compose project %s on requested PostgreSQL port %s...\n' "$project_name" "$requested_postgres_port"
"${compose[@]}" up -d --wait postgres || exit
published_endpoint=$("${compose[@]}" port postgres 5432) || exit
postgres_port=${published_endpoint##*:}
if [[ ! $postgres_port =~ ^[0-9]+$ ]] || ((postgres_port < 1 || postgres_port > 65535)); then
  fail "Docker returned an invalid PostgreSQL endpoint: $published_endpoint"
fi
if ((postgres_port == 54339)); then
  fail 'managed test database resolved to the development PostgreSQL port 54339'
fi
if ((requested_postgres_port != 0 && postgres_port != requested_postgres_port)); then
  fail "managed test database resolved port $postgres_port instead of requested port $requested_postgres_port"
fi
"${compose[@]}" exec -T postgres psql -U teamhub -d teamhub_test_control -v ON_ERROR_STOP=1 \
  -c 'create table teamhub_test_sentinel(run_token text primary key)' \
  -c "insert into teamhub_test_sentinel(run_token) values ('$run_token')" >/dev/null || exit

export TEST_DATABASE_URL="postgres://teamhub:teamhub@127.0.0.1:$postgres_port/teamhub_test_control?sslmode=disable"
"$@" &
command_pid=$!
wait "$command_pid"
command_status=$?
command_pid=
exit "$command_status"
