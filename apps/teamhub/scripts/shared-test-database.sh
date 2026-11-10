#!/usr/bin/env bash

# Optional long-lived PostgreSQL for local TeamHub tests. Test packages isolate
# their own databases (tests/testsupport/database), so concurrent runs may share
# this server. with-test-database.sh uses it while `env` succeeds.

set -uo pipefail

if (($# != 1)); then
  printf 'usage: %s up|down|env\n' "$0" >&2
  exit 2
fi
command_name=$1

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)
compose_file="$repo_root/deployments/compose/docker-compose.test.yml"
project_name=teamhub-test-shared
container_name="$project_name-postgres"
network_name="$project_name-network"
run_token=$project_name

export TEAMHUB_TEST_CONTAINER_NAME=$container_name
export TEAMHUB_TEST_NETWORK_NAME=$network_name
export TEAMHUB_TEST_POSTGRES_PORT=0
export TEAMHUB_TEST_RUN_TOKEN=$run_token
compose=(docker compose --project-name "$project_name" --file "$compose_file")

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 2
}

container_exists() {
  local found
  found=$(docker container ls --all --quiet --filter "name=^${container_name}\$") || fail 'cannot list Docker containers'
  [[ -n $found ]]
}

network_exists() {
  local found
  found=$(docker network ls --quiet --filter "name=^${network_name}\$") || fail 'cannot list Docker networks'
  [[ -n $found ]]
}

# Refuses a resource with the shared name that was not created for this project.
# Prints a FAIL message unless the caller redirects stderr.
check_identity() {
  local resource_kind=$1
  local resource_name label_root service_label project_label managed_label token_label kind_label compose_kind
  if [[ $resource_kind == container ]]; then
    resource_name=$container_name
    label_root=.Config.Labels
    service_label=com.docker.compose.service
    compose_kind=postgres
  else
    resource_name=$network_name
    label_root=.Labels
    service_label=com.docker.compose.network
    compose_kind=default
  fi
  project_label=$(docker "$resource_kind" inspect --format "{{ index $label_root \"com.docker.compose.project\" }}" "$resource_name") || return 1
  managed_label=$(docker "$resource_kind" inspect --format "{{ index $label_root \"com.linger.teamhub.test-managed\" }}" "$resource_name") || return 1
  token_label=$(docker "$resource_kind" inspect --format "{{ index $label_root \"com.linger.teamhub.test-run-token\" }}" "$resource_name") || return 1
  kind_label=$(docker "$resource_kind" inspect --format "{{ index $label_root \"$service_label\" }}" "$resource_name") || return 1
  if [[ $project_label != "$project_name" || $managed_label != true || $token_label != "$run_token" || $kind_label != "$compose_kind" ]]; then
    printf 'FAIL: %s %s is not the shared test database (project=%s managed=%s run_token=%s)\n' \
      "$resource_kind" "$resource_name" "$project_label" "$managed_label" "$token_label" >&2
    return 1
  fi
}

# Succeeds only when the container runs and its healthcheck passes.
container_ready() {
  local state
  state=$(docker container inspect --format '{{.State.Running}} {{.State.Health.Status}}' "$container_name" 2>/dev/null) || return 1
  [[ $state == "true healthy" ]]
}

# Prints the TEST_DATABASE_URL for the published loopback port.
endpoint_url() {
  local published port
  published=$("${compose[@]}" port postgres 5432) || return 1
  port=${published##*:}
  if [[ ! $port =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)) || ((port == 54339)); then
    printf 'FAIL: shared test database endpoint is invalid: %s\n' "$published" >&2
    return 1
  fi
  printf 'postgres://teamhub:teamhub@127.0.0.1:%s/teamhub_test_control?sslmode=disable\n' "$port"
}

# Refuses to create or remove anything while a foreign resource holds a shared name.
check_shared_names() {
  if container_exists; then
    check_identity container || exit 2
  fi
  if network_exists; then
    check_identity network || exit 2
  fi
}

cmd_up() {
  check_shared_names
  if container_exists && container_ready; then
    endpoint_url || exit 2
    exit 0
  fi
  "${compose[@]}" up -d --wait postgres || fail 'shared test database did not become healthy'
  "${compose[@]}" exec -T postgres psql -U teamhub -d teamhub_test_control -v ON_ERROR_STOP=1 \
    -c 'create table if not exists teamhub_test_sentinel(run_token text primary key)' \
    -c "insert into teamhub_test_sentinel(run_token) values ('$run_token') on conflict do nothing" >/dev/null ||
    fail 'cannot write the shared test database sentinel'
  printf 'Shared test database %s is ready: ' "$project_name"
  endpoint_url || exit 2
}

cmd_down() {
  check_shared_names
  if ! container_exists && ! network_exists; then
    printf 'Shared test database %s is not running.\n' "$project_name"
    exit 0
  fi
  "${compose[@]}" down --volumes || fail 'cannot remove the shared test database'
  local leftover_volumes
  leftover_volumes=$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project_name") ||
    fail 'cannot list shared test database volumes'
  [[ -z $leftover_volumes ]] || fail "managed anonymous Volume remains after cleanup: $leftover_volumes"
  if container_exists || network_exists; then
    fail 'shared test database resources remain after cleanup'
  fi
  printf 'Shared test database %s removed.\n' "$project_name"
}

# Silent on failure so with-test-database.sh can fall back to an isolated run.
cmd_env() {
  local url
  check_identity container 2>/dev/null || exit 1
  container_ready || exit 1
  url=$(endpoint_url 2>/dev/null) || exit 1
  printf 'TEST_DATABASE_URL=%s\nTEAMHUB_TEST_RUN_TOKEN=%s\n' "$url" "$run_token"
}

case "$command_name" in
  up) cmd_up ;;
  down) cmd_down ;;
  env) cmd_env ;;
  *)
    printf 'usage: %s up|down|env\n' "$0" >&2
    exit 2
    ;;
esac
