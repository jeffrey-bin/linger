#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
runner="$script_dir/with-test-database.sh"
compose_file="$script_dir/../deployments/compose/docker-compose.test.yml"
work_dir=$(mktemp -d)
fake_bin="$work_dir/bin"
resource_dir="$work_dir/resources"
run_dir="$work_dir/runs"
docker_log="$work_dir/docker.log"

grep -F 'image: "pgvector/pgvector:0.8.6-pg17-bookworm@sha256:' "$compose_file" >/dev/null || {
  printf 'FAIL: integration PostgreSQL must use the pinned pgvector image\n' >&2
  exit 1
}
if grep -F 'pg_textsearch' "$compose_file" >/dev/null; then
  printf 'FAIL: integration PostgreSQL must not load the retired pg_textsearch extension\n' >&2
  exit 1
fi
grep -F 'timescaledb.max_background_workers=0' "$compose_file" >/dev/null || {
  printf 'FAIL: integration PostgreSQL must keep legacy-image background workers disabled\n' >&2
  exit 1
}

cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  if [[ -d ${run_dir:-} ]]; then
    find "$run_dir" -name '*.log' -type f -maxdepth 2 -exec sh -c 'printf -- "--- %s ---\n" "$1"; cat "$1"' _ {} \; >&2 || true
  fi
  if [[ -f ${docker_log:-} ]]; then
    printf '%s\n' '--- docker.log ---' >&2
    cat "$docker_log" >&2
  fi
  exit 1
}

wait_for_file() {
  local target_file=$1
  local attempt
  for attempt in $(seq 1 300); do
    [[ -e $target_file ]] && return
    sleep 0.05
  done
  fail "timed out waiting for $target_file"
}

wait_for_exit() {
  local child_pid=$1
  local expected_exit=$2
  local child_exit
  set +e
  wait "$child_pid"
  child_exit=$?
  set -e
  [[ $child_exit -eq $expected_exit ]] || fail "process $child_pid exited $child_exit, expected $expected_exit"
}

assert_no_managed_resources() {
  local leftovers
  leftovers=$(find "$resource_dir" -type f -print)
  [[ -z $leftovers ]] || fail "managed resources remain: $leftovers"
}

mkdir -p "$fake_bin" "$resource_dir" "$run_dir"

cat >"$fake_bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"

resource_file() {
  printf '%s/%s--%s\n' "$FAKE_RESOURCE_DIR" "$1" "$2"
}

resource_value() {
  local resource_kind=$1
  local resource_name=$2
  local key=$3
  sed -n "s/^${key}=//p" "$(resource_file "$resource_kind" "$resource_name")"
}

inspect_resource() {
  local resource_kind=$1
  local resource_name=$2
  shift 2
  local resource_state
  resource_state=$(resource_file "$resource_kind" "$resource_name")
  [[ -f $resource_state ]] || exit 1
  [[ ${1:-} == --format ]] || exit 0
  if [[ $resource_kind == container ]]; then
    [[ ${2:-} == *.Config.Labels* ]] || exit 89
  else
    [[ ${2:-} == *.Labels* && ${2:-} != *.Config.Labels* ]] || exit 89
  fi
  case "${2:-}" in
    *com.docker.compose.project*) resource_value "$resource_kind" "$resource_name" project ;;
    *com.docker.compose.service*) resource_value "$resource_kind" "$resource_name" compose_kind ;;
    *com.docker.compose.volume*) resource_value "$resource_kind" "$resource_name" compose_kind ;;
    *com.docker.compose.network*) resource_value "$resource_kind" "$resource_name" compose_kind ;;
    *com.linger.teamhub.test-managed*) resource_value "$resource_kind" "$resource_name" managed ;;
    *com.linger.teamhub.test-run-token*) resource_value "$resource_kind" "$resource_name" token ;;
    *) exit 90 ;;
  esac
}

if [[ ${1:-} == volume && ${2:-} == ls ]]; then
  project_filter=${5#label=com.docker.compose.project=}
  for volume_state in "$FAKE_RESOURCE_DIR"/volume--*; do
    [[ -f $volume_state ]] || continue
    volume_name=${volume_state##*/volume--}
    if [[ $(resource_value volume "$volume_name" project) == "$project_filter" ]]; then
      printf '%s\n' "$volume_name"
    fi
  done
  exit 0
fi

if [[ ${1:-} == container || ${1:-} == volume || ${1:-} == network ]]; then
  resource_kind=$1
  [[ ${2:-} == inspect ]] || exit 91
  shift 2
  if [[ ${1:-} == --format ]]; then
    inspect_format=$2
    resource_name=$3
    inspect_resource "$resource_kind" "$resource_name" --format "$inspect_format"
  else
    resource_name=$1
    inspect_resource "$resource_kind" "$resource_name"
  fi
  exit
fi

if [[ ${1:-} != compose ]]; then
  exit 92
fi

shift
project_name=
while (($#)); do
  case "$1" in
    --project-name)
      project_name=$2
      shift 2
      ;;
    --file)
      shift 2
      ;;
    *) break ;;
  esac
done
[[ -n $project_name ]] || exit 93

case " $* " in
  *" config --quiet "*) exit 0 ;;
  *" config --services "*) printf 'postgres\n'; exit 0 ;;
  *" config --networks "*) printf 'default\n'; exit 0 ;;
  *" config --format json "*)
    printf '{"services":{"postgres":{"container_name":"%s"}},"networks":{"default":{"name":"%s"}}}\n' \
      "$TEAMHUB_TEST_CONTAINER_NAME" "$TEAMHUB_TEST_NETWORK_NAME"
    exit 0
    ;;
  *" up -d --wait postgres "*)
    printf 'project=%s\ncompose_kind=postgres\nmanaged=true\ntoken=%s\n' \
      "$project_name" "$TEAMHUB_TEST_RUN_TOKEN" >"$(resource_file container "$TEAMHUB_TEST_CONTAINER_NAME")"
    printf 'project=%s\n' "$project_name" >"$(resource_file volume "anonymous-$project_name")"
    printf 'project=%s\ncompose_kind=default\nmanaged=true\ntoken=%s\n' \
      "$project_name" "$TEAMHUB_TEST_RUN_TOKEN" >"$(resource_file network "$TEAMHUB_TEST_NETWORK_NAME")"
    exit 0
    ;;
  *" port postgres 5432 "*)
    if [[ $TEAMHUB_TEST_POSTGRES_PORT == 0 ]]; then
      runner_pid=${project_name%-*}
      runner_pid=${runner_pid##*-}
      printf '127.0.0.1:%s\n' "$((40000 + runner_pid % 20000))"
    else
      printf '127.0.0.1:%s\n' "$TEAMHUB_TEST_POSTGRES_PORT"
    fi
    exit 0
    ;;
  *" exec -T postgres psql "*) exit 0 ;;
  *" down --volumes "*)
    rm -f -- \
      "$(resource_file container "$TEAMHUB_TEST_CONTAINER_NAME")" \
      "$(resource_file network "$TEAMHUB_TEST_NETWORK_NAME")"
    # FAKE_LEAK_ANONYMOUS_VOLUME simulates a Compose down that leaves the image VOLUME behind.
    if [[ -z ${FAKE_LEAK_ANONYMOUS_VOLUME:-} ]]; then
      rm -f -- "$(resource_file volume "anonymous-$project_name")"
    fi
    exit 0
    ;;
esac

printf 'unexpected fake compose command: %s\n' "$*" >&2
exit 94
FAKE_DOCKER

cat >"$fake_bin/test-command" <<'FAKE_COMMAND'
#!/usr/bin/env bash
set -euo pipefail

run_name=$1
run_root="$FAKE_RUN_DIR/$run_name"
mkdir -p "$run_root"
printf '%s\n' "$TEST_DATABASE_URL" >"$run_root/url"
printf '%s\n' "$TEAMHUB_TEST_RUN_TOKEN" >"$run_root/token"
touch "$run_root/ready"

case "$run_name" in
  success-*)
    while [[ ! -e $run_root/release ]]; do sleep 0.02; done
    ;;
  failure)
    while [[ ! -e $run_root/release ]]; do sleep 0.02; done
    exit 7
    ;;
  signal)
    trap 'exit 143' TERM
    while :; do sleep 0.1; done
    ;;
  external) ;;
  *) exit 95 ;;
esac
FAKE_COMMAND

chmod +x "$fake_bin/docker" "$fake_bin/test-command"
export PATH="$fake_bin:$PATH"
export FAKE_DOCKER_LOG=$docker_log
export FAKE_RESOURCE_DIR=$resource_dir
export FAKE_RUN_DIR=$run_dir

external_url='postgres://caller:secret@db.example/teamhub?sslmode=require'
set +e
TEST_DATABASE_URL=$external_url "$runner" test-command external >/dev/null 2>&1
external_exit=$?
set -e
[[ $external_exit -eq 2 ]] || fail 'unauthorized caller-provided TEST_DATABASE_URL was accepted'
[[ ! -e $run_dir/external/ready ]] || fail 'unauthorized external database ran the command'

TEAMHUB_ALLOW_EXTERNAL_TEST_DATABASE=1 TEAMHUB_TEST_RUN_TOKEN=external-run \
  TEST_DATABASE_URL=$external_url "$runner" test-command external
[[ $(<"$run_dir/external/url") == "$external_url" ]] || fail 'authorized external TEST_DATABASE_URL was not preserved'
[[ $(<"$run_dir/external/token") == external-run ]] || fail 'authorized external run token was not preserved'
[[ ! -e $docker_log ]] || fail 'authorized external database unexpectedly invoked Docker'

set +e
TEST_DATABASE_URL= TEAMHUB_TEST_POSTGRES_PORT=54339 "$runner" test-command success-unsafe >/dev/null 2>&1
unsafe_exit=$?
set -e
[[ $unsafe_exit -eq 2 ]] || fail 'development PostgreSQL port was not rejected'
[[ ! -e $docker_log ]] || fail 'unsafe development port invoked Docker'

TEST_DATABASE_URL= TEAMHUB_TEST_POSTGRES_PORT=55440 "$runner" test-command success-a >"$run_dir/success-a.log" 2>&1 &
success_a_pid=$!
TEST_DATABASE_URL= "$runner" test-command success-b >"$run_dir/success-b.log" 2>&1 &
success_b_pid=$!
wait_for_file "$run_dir/success-a/ready"
wait_for_file "$run_dir/success-b/ready"
success_a_token=$(<"$run_dir/success-a/token")
success_b_token=$(<"$run_dir/success-b/token")
success_a_url=$(<"$run_dir/success-a/url")
success_b_url=$(<"$run_dir/success-b/url")
[[ $success_a_token != "$success_b_token" ]] || fail 'concurrent runs reused a run token'
[[ $success_a_url != "$success_b_url" ]] || fail 'concurrent runs reused a PostgreSQL port'
[[ $success_a_url == 'postgres://teamhub:teamhub@127.0.0.1:55440/teamhub_test_control?sslmode=disable' ]] || \
  fail 'explicit managed PostgreSQL port was not preserved'
[[ $(find "$resource_dir" -type f | wc -l | tr -d ' ') == 6 ]] || fail 'concurrent success runs did not own six resources'
touch "$run_dir/success-a/release"
wait_for_exit "$success_a_pid" 0
[[ $(find "$resource_dir" -type f | wc -l | tr -d ' ') == 3 ]] || fail 'first success run changed the second run resources'
[[ -f $resource_dir/container--$success_b_token-postgres ]] || fail 'first success run removed the second run container'
[[ -f $resource_dir/network--$success_b_token-network ]] || fail 'first success run removed the second run network'
[[ -f $resource_dir/volume--anonymous-$success_b_token ]] || fail 'first success run removed the second run anonymous Volume'
touch "$run_dir/success-b/release"
wait_for_exit "$success_b_pid" 0
assert_no_managed_resources

TEST_DATABASE_URL= "$runner" test-command failure >"$run_dir/failure.log" 2>&1 &
failure_pid=$!
TEST_DATABASE_URL= "$runner" test-command signal >"$run_dir/signal.log" 2>&1 &
signal_pid=$!
wait_for_file "$run_dir/failure/ready"
wait_for_file "$run_dir/signal/ready"
[[ $(find "$resource_dir" -type f | wc -l | tr -d ' ') == 6 ]] || fail 'failure/signal runs did not own six resources'
touch "$run_dir/failure/release"
wait_for_exit "$failure_pid" 7
[[ $(find "$resource_dir" -type f | wc -l | tr -d ' ') == 3 ]] || fail 'failed run changed the signal run resources'
kill -TERM "$signal_pid"
wait_for_exit "$signal_pid" 143
assert_no_managed_resources

TEST_DATABASE_URL= "$runner" test-command success-label-mismatch >"$run_dir/label-mismatch.log" 2>&1 &
label_mismatch_pid=$!
wait_for_file "$run_dir/success-label-mismatch/ready"
label_mismatch_token=$(<"$run_dir/success-label-mismatch/token")
label_mismatch_container="$resource_dir/container--$label_mismatch_token-postgres"
[[ -f $label_mismatch_container ]] || fail 'label-mismatch run did not create its container'
sed -i.bak 's/^managed=true$/managed=false/' "$label_mismatch_container"
rm -f -- "$label_mismatch_container.bak"
touch "$run_dir/success-label-mismatch/release"
wait_for_exit "$label_mismatch_pid" 1
[[ -f $label_mismatch_container ]] || fail 'fail-closed cleanup removed a mislabeled container'
[[ $(find "$resource_dir" -type f | wc -l | tr -d ' ') == 3 ]] || fail 'fail-closed cleanup changed managed resources'
rm -f -- "$resource_dir"/*

TEST_DATABASE_URL= FAKE_LEAK_ANONYMOUS_VOLUME=1 "$runner" test-command success-leaked-volume >"$run_dir/leaked-volume.log" 2>&1 &
leaked_volume_pid=$!
wait_for_file "$run_dir/success-leaked-volume/ready"
touch "$run_dir/success-leaked-volume/release"
wait_for_exit "$leaked_volume_pid" 1
[[ -f $resource_dir/volume--anonymous-$(<"$run_dir/success-leaked-volume/token") ]] || \
  fail 'cleanup did not report a leaked anonymous Volume'
rm -f -- "$resource_dir"/*

grep -F -- 'create table teamhub_test_sentinel' "$docker_log" >/dev/null || fail 'managed runs did not create a sentinel'
grep -F -- 'down --volumes' "$docker_log" >/dev/null || fail 'cleanup did not remove anonymous Volumes with down --volumes'
grep -F -- 'volume ls --quiet --filter label=com.docker.compose.project=' "$docker_log" >/dev/null || \
  fail 'cleanup did not verify that no project Volume remains'
grep -F -- 'com.linger.teamhub.test-run-token' "$docker_log" >/dev/null || fail 'cleanup did not validate run-token labels'

printf 'PASS: concurrent managed test databases isolate and clean success, failure, and signal lifecycles\n'
