#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SOAK_ONLY="${LINGER_LOCAL_RUNNER_SOAK_ONLY:-0}"
if [[ "${LINGER_LIVE_LOCAL_CODEX:-0}" != "1" && "$SOAK_ONLY" != "1" ]]; then
  printf 'Refusing to run a billable live Codex smoke. Set LINGER_LIVE_LOCAL_CODEX=1 explicitly.\n' >&2
  exit 2
fi

RECOVERY_DELAY_SECONDS="${LINGER_LOCAL_RUNNER_RECOVERY_DELAY_SECONDS:-0}"
if [[ ! "$RECOVERY_DELAY_SECONDS" =~ ^[0-9]+$ ]] || ((RECOVERY_DELAY_SECONDS > 600)) || { [[ "$SOAK_ONLY" != "1" ]] && ((RECOVERY_DELAY_SECONDS > 0)); }; then
  printf 'Recovery delay must be 0-600 seconds and is supported only by the deterministic soak.\n' >&2
  exit 2
fi
SOAK_COMPLETION_DELAY_MS=25
if ((RECOVERY_DELAY_SECONDS > 0)); then SOAK_COMPLETION_DELAY_MS=10000; fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "/tmp/sx-lr-live.XXXXXX")"
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
LIVE_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
AUTH_FILE="${LINGER_CODEX_AUTH_FILE:-$LIVE_CODEX_HOME/auth.json}"
LIVE_MODEL="${LINGER_LIVE_CODEX_MODEL:-}"
LIVE_REASONING_EFFORT="${LINGER_LIVE_CODEX_REASONING_EFFORT:-}"
RECONNECT_ONLY="${LINGER_LIVE_LOCAL_CODEX_RECONNECT_ONLY:-0}"
RESTART_ONLY="${LINGER_LIVE_LOCAL_CODEX_RESTART_ONLY:-0}"
# The Agent Service derives its credentials from this seed.
SECRET_SEED="local-runner-live-secret-seed-0123456789"
# SERVICE_TOKEN is what the Agent Service presents to the TeamHub fixture;
# NODE_SERVICES_TOKEN is what TeamHub presents to the Agent Service.
SERVICE_TOKEN="$(node -e 'const { hkdfSync } = require("node:crypto"); process.stdout.write(Buffer.from(hkdfSync("sha256", process.argv[1], "simplexai/service-credential/v1", "teamhub-internal", 32)).toString("base64url"));' "$SECRET_SEED")"
NODE_SERVICES_TOKEN="$(node -e 'const { hkdfSync } = require("node:crypto"); process.stdout.write(Buffer.from(hkdfSync("sha256", process.argv[1], "simplexai/service-credential/v1", "node-services-internal", 32)).toString("base64url"));' "$SECRET_SEED")"
TENANT_ID="tenant-live"
OWNER_ACTOR_ID="human-live"
ROOM_ID="room-live"
TASK_ID="task-live"
TASK_ROOM_ID="room-task-live"
# Enrollment assigns the Computer ID and writes its Runner credential.
COMPUTER_ID=""
RUNNER_TOKEN_FILE="$TMP_ROOT/runner-token"
CODEX_EXECUTABLE="${LINGER_CODEX_PATH:-}"
CONFIG="$TMP_ROOT/computer.json"
FIXTURE_REPORT="$TMP_ROOT/fixture-report.ndjson"
PROXY_EVENTS="$TMP_ROOT/proxy-events.ndjson"
ROOM_MESSAGES="$TMP_ROOT/room-messages.json"
TASK_MESSAGES="$TMP_ROOT/task-messages.json"
FIXTURE_PID=""
PROXY_PID=""
AGENT_PID=""
DAEMON_PID=""
HOLD_PID=""
HOLD_PID_FILE=""
AGENT_ID=""
ACTOR_ID=""
REVISION=1
FAILED_LINE=""
SOAK_RUNTIME_PID_DIR="$TMP_ROOT/runtime-pids"

mkdir -p "$TMP_ROOT/workspace" "$TMP_ROOT/artifact-publications" "$SOAK_RUNTIME_PID_DIR"
printf '[]\n' >"$ROOM_MESSAGES"
printf '[]\n' >"$TASK_MESSAGES"
touch "$FIXTURE_REPORT" "$PROXY_EVENTS"

free_port() {
  node -e 'const net=require("node:net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close();});'
}

computer() {
  CODEX_HOME="$LIVE_CODEX_HOME" "$ROOT/apps/computer/dist/cli/linger-computer" "$@" --config "$CONFIG"
}

api() {
  local method=$1
  local route=$2
  local args=(
    --fail-with-body --silent --show-error --max-time 10
    -X "$method"
    "http://127.0.0.1:$AGENT_PORT$route"
    -H "Authorization: Bearer $NODE_SERVICES_TOKEN"
  )
  curl "${args[@]}"
}

# Register the Computer as production does: TeamHub's enrollment exchange
# records it at credential generation 0 and signs its Runner credential with
# the `runner-signing` key derived from the seed. The fixture plays TeamHub.
enroll_computer() {
  local display_name=$1
  COMPUTER_ID="computer_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
  curl --fail --silent --show-error --max-time 10 \
    -X POST "http://127.0.0.1:$FIXTURE_PORT/__test__/local-computers" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -cn \
      --arg computer "$COMPUTER_ID" \
      --arg name "$display_name" \
      --arg tenant "$TENANT_ID" \
      --arg owner "$OWNER_ACTOR_ID" \
      '{computer_id: $computer, display_name: $name, owner: {tenant_id: $tenant, owner_actor_id: $owner}}')" \
    >/dev/null
  node -e '
    const crypto = require("node:crypto");
    const [seed, computerId, tenantId, ownerActorId] = process.argv.slice(1);
    const key = Buffer.from(crypto.hkdfSync("sha256", seed, "simplexai/service-credential/v1", "runner-signing", 32)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const claims = { credential_generation: 0, exp: now + 86400, iat: now, runner_id: computerId,
      tenant_owners: [{ owner_actor_id: ownerActorId, tenant_id: tenantId }], v: 1 };
    const unsigned = "sr1." + Buffer.from(JSON.stringify(claims)).toString("base64url");
    process.stdout.write(unsigned + "." + crypto.createHmac("sha256", Buffer.from(key, "utf8")).update(unsigned).digest("base64url"));
  ' "$SECRET_SEED" "$COMPUTER_ID" "$TENANT_ID" "$OWNER_ACTOR_ID" >"$RUNNER_TOKEN_FILE"
}

runtime_state_to_file() {
  local output_file=$1
  curl --fail-with-body --silent --show-error --max-time 10 \
    "http://127.0.0.1:$FIXTURE_PORT/__test__/runtime-state" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    --output "$output_file"
}

cleanup() {
  local exit_code=$?
  local cleanup_failed=0
  trap - ERR EXIT INT TERM
  set +e
  if [[ -S "$TMP_ROOT/computer-state/control.sock" ]]; then
    computer daemon stop >/dev/null 2>&1
  fi
  for pid in "$DAEMON_PID" "$PROXY_PID" "$AGENT_PID" "$FIXTURE_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
    fi
  done
  for pid in "$DAEMON_PID" "$PROXY_PID" "$AGENT_PID" "$FIXTURE_PID"; do
    [[ -z "$pid" ]] || wait "$pid" 2>/dev/null
  done
  if [[ -n "$HOLD_PID" ]] && kill -0 "$HOLD_PID" 2>/dev/null; then
    kill "$HOLD_PID" 2>/dev/null
  fi
  if [[ -S "$TMP_ROOT/computer-state/control.sock" ]]; then
    cleanup_failed=1
    printf 'Daemon control socket remains after cleanup\n' >&2
  fi
  if find "$TMP_ROOT/computer-state/runner-processes" -type f -name '*.json' -print -quit 2>/dev/null | grep -q .; then
    cleanup_failed=1
    printf 'Runner ownership records remain after cleanup\n' >&2
  fi
  if [[ $exit_code -ne 0 ]]; then
    printf '\nLive Local Runner smoke failed near line %s. Agent diagnostics:\n' \
      "${FAILED_LINE:-unknown}" >&2
    tail -80 "$TMP_ROOT/agent.log" >&2 2>/dev/null
    printf '\nDaemon diagnostics:\n' >&2
    tail -80 "$TMP_ROOT/computer-state/daemon.log" >&2 2>/dev/null
    printf '\nFixture report:\n' >&2
    tail -80 "$FIXTURE_REPORT" >&2 2>/dev/null
  fi
  if [[ "${KEEP_LOCAL_RUNNER_LIVE_SMOKE:-0}" == "1" || $exit_code -ne 0 || $cleanup_failed -ne 0 ]]; then
    printf 'Live smoke artifacts retained at %s\n' "$TMP_ROOT" >&2
  else
    chmod -R u+rwX "$TMP_ROOT" 2>/dev/null || true
    rm -rf "$TMP_ROOT"
  fi
  [[ $cleanup_failed -eq 0 ]] || exit_code=1
  exit "$exit_code"
}
trap cleanup EXIT
trap 'FAILED_LINE=$LINENO' ERR
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_file() {
  local file=$1
  for _ in {1..200}; do
    [[ -s "$file" ]] && return 0
    sleep 0.05
  done
  printf 'Timed out waiting for %s\n' "$file" >&2
  return 1
}

wait_for_http() {
  local url=$1
  for _ in {1..600}; do
    curl --fail --silent --show-error --max-time 1 "$url" >/dev/null 2>&1 && return 0
    sleep 0.05
  done
  printf 'Timed out waiting for %s\n' "$url" >&2
  return 1
}

wait_for_gateway_ready() {
  for _ in {1..400}; do
    if computer daemon status --json 2>/dev/null | jq -e '.daemon.gateway_state == "connected"' >/dev/null; then
      return 0
    fi
    sleep 0.05
  done
  printf 'Computer daemon did not connect to the Runner Gateway\n' >&2
  return 1
}

wait_for_runtime_ready() {
  local runtime_type=$1
  for _ in {1..2400}; do
    if computer daemon status --json 2>/dev/null | jq -e \
      --arg type "$runtime_type" \
      'any(.runtimes[]; .type == $type and .status == "ready")' \
      >/dev/null; then
      return 0
    fi
    sleep 0.05
  done
  printf 'Runtime %s did not become ready\n' "$runtime_type" >&2
  return 1
}

wait_for_daemon_exit() {
  local pid=$1
  for _ in {1..200}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.05
  done
  printf 'Computer daemon %s did not stop\n' "$pid" >&2
  return 1
}

stop_agent_service() {
  [[ -n "$AGENT_PID" ]] || return 0
  kill "$AGENT_PID"
  for _ in {1..200}; do
    if ! kill -0 "$AGENT_PID" 2>/dev/null; then
      local exit_code=0
      wait "$AGENT_PID" 2>/dev/null || exit_code=$?
      AGENT_PID=""
      if (( exit_code != 0 )); then
        printf 'Agent Service exited with code %s during graceful shutdown\n' "$exit_code" >&2
      fi
      return "$exit_code"
    fi
    sleep 0.05
  done
  printf 'Agent Service %s did not stop\n' "$AGENT_PID" >&2
  return 1
}

start_agent_service() {
  env \
    TEAMHUB_BASE_URL="http://127.0.0.1:$FIXTURE_PORT" \
    LINGER_SECRET_SEED="$SECRET_SEED" \
    NODE_SERVICES_ROLES="agent" NODE_SERVICES_HTTP_ADDRESS="127.0.0.1:$AGENT_PORT" \
    AGENT_HOME="$TMP_ROOT/agent-home" \
    AGENT_RUNNER_PUBLIC_GATEWAY_URL="ws://127.0.0.1:$AGENT_PORT/v1/runner-gateway" \
    CODEX_HOME="$LIVE_CODEX_HOME" \
    CODEX_CLI_PATH="$CODEX_EXECUTABLE" \
    AGENT_LOG_LEVEL="debug" \
    node --conditions=linger-production \
      "$ROOT/apps/node-services/dist/main.js" \
      >>"$TMP_ROOT/agent.log" 2>&1 &
  AGENT_PID=$!
  wait_for_http "http://127.0.0.1:$AGENT_PORT/startupz"
}

wait_for_runner_state() {
  local agent_id=$1
  local expected_state=$2
  for _ in {1..400}; do
    if computer daemon runners --json 2>/dev/null | jq -e \
      --arg agent "$agent_id" \
      --arg state "$expected_state" \
      'any(.runners[]; .agent_id == $agent and .state == $state)' \
      >/dev/null; then
      return 0
    fi
    sleep 0.05
  done
  printf 'Agent Runner %s did not reach %s\n' "$agent_id" "$expected_state" >&2
  return 1
}

wait_for_gateway_connection_count() {
  local minimum=$1
  for _ in {1..400}; do
    if [[ "$(jq -s '[.[] | select(.type == "connection")] | length' "$PROXY_EVENTS")" -ge "$minimum" ]]; then
      return 0
    fi
    sleep 0.05
  done
  printf 'Gateway did not establish %s connections\n' "$minimum" >&2
  return 1
}

enable_ack_drop() {
  local before
  before="$(jq -s '[.[] | select(.type == "block_agent_to_daemon")] | length' "$PROXY_EVENTS")"
  kill -USR2 "$PROXY_PID"
  for _ in {1..400}; do
    if [[ "$(jq -s '[.[] | select(.type == "block_agent_to_daemon" and .mode == "operation_ack_only")] | length' "$PROXY_EVENTS")" -gt "$before" ]]; then
      return 0
    fi
    sleep 0.05
  done
  printf 'ACK fault was not armed\n' >&2
  return 1
}

reconnect_after_dropped_ack() {
  local operation_id=$1
  local minimum_sequence=${2:-1}
  local observed=0 connections_before
  for _ in {1..400}; do
    if jq -s -e --arg operation "$operation_id" --argjson minimum "$minimum_sequence" \
      'any(.[]; .type == "blocked_agent_to_daemon" and .message_type == "operation.ack" and .operation_id == $operation and .through_seq >= $minimum)' \
      "$PROXY_EVENTS" >/dev/null; then
      observed=1
      break
    fi
    sleep 0.05
  done
  [[ "$observed" == "1" ]] || { printf 'No matching ACK was actually dropped\n' >&2; return 1; }
  connections_before="$(jq -s '[.[] | select(.type == "connection")] | length' "$PROXY_EVENTS")"
  kill -USR1 "$PROXY_PID"
  wait_for_gateway_connection_count "$((connections_before + 1))"
  wait_for_gateway_ready
}

wait_for_unacknowledged_terminal() {
  local operation_id=$1
  local output_file=$2
  for _ in {1..400}; do
    if node - "$TMP_ROOT/computer-state/operations.sqlite" "$operation_id" >"$output_file" <<'NODE'
import { DatabaseSync } from "node:sqlite";
const [filename, operationId] = process.argv.slice(2);
const database = new DatabaseSync(filename, { readOnly: true });
let row;
try {
  row = database.prepare(`SELECT status, last_emitted_seq, last_acked_seq,
    CAST(terminal_event_json AS TEXT) AS terminal_event_json
    FROM operations WHERE operation_id = ?`).get(operationId);
} finally {
  database.close();
}
if (!row || row.status !== "terminal" || row.last_acked_seq >= row.last_emitted_seq) process.exit(1);
const terminal = JSON.parse(row.terminal_event_json);
if (terminal.type !== "operation.cancelled" || terminal.operation_id !== operationId || terminal.seq !== row.last_emitted_seq) process.exit(1);
process.stdout.write(JSON.stringify({ operation_id: operationId, through_seq: terminal.seq }));
NODE
    then
      return 0
    fi
    sleep 0.05
  done
  printf 'Canceled Operation terminal was not persisted before its ACK\n' >&2
  return 1
}

append_message() {
  local state_file=$1
  local message_id=$2
  local text=$3
  node - "$state_file" "$message_id" "$text" "$ACTOR_ID" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const [statePath, messageId, text, actorId] = process.argv.slice(2);
const messages = JSON.parse(readFileSync(statePath, "utf8"));
if (!messages.some((message) => message.message_id === messageId)) {
  messages.push({
    sequence: messages.length + 1,
    message_id: messageId,
        sender: { actor_id: "user-live-harness", type: "user" },
    segments: [
      {
        type: "reference",
        content: "@LiveLocalCodex",
        target: actorId,
        target_type: "agent",
      },
      { type: "text", content: ` ${text}` },
    ],
  });
  writeFileSync(statePath, `${JSON.stringify(messages)}\n`);
}
NODE
}

publish_inbox_state() {
  local revision=$1
  local actor_id=${2:-}
  local include_task=${3:-1}
  node - "$TMP_ROOT/inbox-state.json" "$TENANT_ID" "$ROOM_ID" "$TASK_ID" "$TASK_ROOM_ID" "$revision" "$actor_id" "$include_task" "$ROOM_MESSAGES" "$TASK_MESSAGES" <<'NODE'
import { readFileSync, renameSync, writeFileSync } from "node:fs";
const [filename,tenantId,roomId,taskId,taskRoomId,revision,actorId,includeTask,roomMessagesFile,taskMessagesFile]=process.argv.slice(2);
const actorIds=actorId?[actorId]:[];
const inboxes=[{inbox_id:`room:${roomId}`,kind:"room",room_id:roomId,actor_ids:actorIds,messages:JSON.parse(readFileSync(roomMessagesFile,"utf8"))}];
const documents=[];
if(includeTask==="1") {
 inboxes.push({inbox_id:`task:${taskId}`,kind:"task",room_id:taskRoomId,task_id:taskId,actor_ids:actorIds,messages:JSON.parse(readFileSync(taskMessagesFile,"utf8"))});
 documents.push({id:"document_live_input",inbox_id:`task:${taskId}`,filename:"input.txt",content:"ARTIFACT_INPUT_MARKER=stage-c-authorized-CLI-download\n"});
}
// Atomic fixture publication keeps polling readers from observing partial JSON.
writeFileSync(filename+".pending",JSON.stringify({tenant_id:tenantId,revision,inboxes,documents}),{mode:0o600});
renameSync(filename+".pending",filename);
NODE
  if [[ -n "$FIXTURE_PID" ]]; then
    curl --fail-with-body --silent --show-error --max-time 10 -X POST \
      "http://127.0.0.1:$FIXTURE_PORT/__test__/inbox-wake" \
      -H "Authorization: Bearer $SERVICE_TOKEN" -H 'Content-Type: application/json' --data '{}'
  fi
}

deliver_message() {
  local room_id=$1
  local message_id=$2
  local text=$3
  if [[ "$room_id" != "$ROOM_ID" ]]; then
    printf 'Live fixture Room target is not authorized\n' >&2
    return 1
  fi
  append_message "$ROOM_MESSAGES" "$message_id" "$text"
  publish_inbox_state "$REVISION" "$ACTOR_ID"
}

queue_task_turn() {
  local message_id=$1
  local text=$2
  curl --fail-with-body --silent --show-error --max-time 10 \
    -X POST \
    "http://127.0.0.1:$FIXTURE_PORT/__test__/task-turn" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn \
      --arg agent_id "$AGENT_ID" \
      --arg actor_id "$ACTOR_ID" \
      --arg task_id "$TASK_ID" \
      --arg room_id "$TASK_ROOM_ID" \
      --arg message_id "$message_id" \
      --arg text "$text" \
      '{agent_id: $agent_id, actor_id: $actor_id, task_id: $task_id,
        room_id: $room_id, message_id: $message_id, text: $text}')"
}

wait_for_local_run_terminal() {
  local kind=$1
  local run_ordinal=$2
  local expected_status=$3
  local expected_response_prefix=${4:-}
  local run_status state_file="$TMP_ROOT/runtime-state.json"
  for _ in {1..3600}; do
    runtime_state_to_file "$state_file"
    if node - "$state_file" "$kind" "$run_ordinal" "$expected_status" "$expected_response_prefix" <<'NODE'
import { readFileSync } from "node:fs";

const [statePath, kind, runOrdinalText, expectedStatus, responsePrefix] = process.argv.slice(2);
const runs = JSON.parse(readFileSync(statePath, "utf8")).runs.filter((run) => run.context_kind === kind);
const run = runs[Number(runOrdinalText) - 1];
if (!run || run.terminal_type === null) process.exit(1);
if (
  run.status === expectedStatus &&
  run.terminal_type === expectedStatus &&
  (responsePrefix === "" || run.final_response?.includes(responsePrefix))
) process.exit(0);
process.stderr.write(
  `Local Run ${runOrdinalText} reached status ${run.status} while waiting for ${expectedStatus}\n`,
);
process.exit(2);
NODE
    then
      return 0
    else
      run_status=$?
      if (( run_status == 2 )); then
        return 1
      fi
    fi
    sleep 0.1
  done
  printf 'Local Run %s did not reach state %s\n' "$run_ordinal" "$expected_status" >&2
  return 1
}

wait_for_operation_receipt() {
  local kind=$1
  local run_ordinal=$2
  local terminal=${3:-1}
  local output_file=$4
  local state_file="$TMP_ROOT/runtime-state.json"
  for _ in {1..3600}; do
    runtime_state_to_file "$state_file"
    if node - \
      "$state_file" \
      "$TMP_ROOT/computer-state/operations.sqlite" \
      "$kind" "$AGENT_ID" "$run_ordinal" "$terminal" "$output_file" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [
  statePath,
  ledgerPath,
  kind,
  agentId,
  runOrdinalText,
  terminalText,
  outputPath,
] = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const run = state.runs
  .filter((candidate) => candidate.context_kind === kind)[Number(runOrdinalText) - 1];
if (!run) process.exit(1);
const runId = run.run_id;
const expectedTerminal = Number(terminalText);
const receipts = expectedTerminal === 1 ? state.operation_receipts :
  [...new Map(state.execution_receipts.map(receipt => [receipt.operation_id, receipt])).values()];
const starts = receipts.filter(
  (receipt) => receipt.agent_id === agentId && receipt.run_id === runId,
);
if (starts.length !== 1) process.exit(1);
const ledger = new DatabaseSync(ledgerPath, { readOnly: true });
const operation = ledger.prepare(`
  SELECT operation_id, status, last_acked_seq, terminal_event_json
  FROM operations WHERE operation_id = ?
`).get(starts[0].operation_id);
ledger.close();
if (!operation) process.exit(1);
if (expectedTerminal === 1) {
  if (operation.status !== "terminal" || !operation.terminal_event_json) process.exit(1);
  const terminalJson =
    typeof operation.terminal_event_json === "string"
      ? operation.terminal_event_json
      : Buffer.from(operation.terminal_event_json).toString("utf8");
  const terminal = JSON.parse(terminalJson);
  if (terminal.seq !== operation.last_acked_seq) process.exit(1);
} else if (operation.status !== "running" || operation.terminal_event_json !== null) {
  process.exit(1);
}
writeFileSync(outputPath, JSON.stringify({
  operation_id: operation.operation_id,
  run_id: runId,
  connection_epoch: starts[0].connection_epoch,
}));
NODE
    then
      return 0
    fi
    sleep 0.1
  done
  printf 'Local Run %s did not produce exactly one matching run.start receipt\n' "$run_ordinal" >&2
  return 1
}

# A running Operation has no terminal receipt yet: read its run.start
# execution receipt, then the daemon ledger row, whose identity keeps the
# connection epoch the Operation started on.
wait_for_active_operation() {
  local kind=$1
  local run_ordinal=$2
  local output_file=$3
  local state_file="$TMP_ROOT/runtime-state.json"
  for _ in {1..1200}; do
    runtime_state_to_file "$state_file"
    if node - \
      "$state_file" \
      "$TMP_ROOT/computer-state/operations.sqlite" \
      "$kind" "$AGENT_ID" "$run_ordinal" "$output_file" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [statePath, ledgerPath, kind, agentId, runOrdinalText, outputPath] =
  process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const run = state.runs
  .filter((candidate) => candidate.context_kind === kind)[Number(runOrdinalText) - 1];
if (!run) process.exit(1);
const operationIds = [...new Set(state.execution_receipts
  .filter((receipt) => receipt.agent_id === agentId && receipt.run_id === run.run_id)
  .map((receipt) => receipt.operation_id))];
if (operationIds.length !== 1) process.exit(1);
const ledger = new DatabaseSync(ledgerPath, { readOnly: true });
const operation = ledger.prepare(`
  SELECT operation_id, CAST(identity_json AS TEXT) AS identity_json, status
  FROM operations WHERE operation_id = ?
`).get(operationIds[0]);
ledger.close();
if (!operation || operation.status !== "running") process.exit(1);
writeFileSync(outputPath, JSON.stringify({
  operation_id: operation.operation_id,
  run_id: run.run_id,
  connection_epoch: JSON.parse(operation.identity_json).connection_epoch,
}));
NODE
    then
      return 0
    fi
    sleep 0.1
  done
  printf 'Local Run %s did not keep one running Operation\n' "$run_ordinal" >&2
  return 1
}

# The hold command writes its shell PID, then execs sleep under that PID.
wait_for_hold_command() {
  local pid_file
  for _ in {1..1200}; do
    pid_file="$(find "$TMP_ROOT" -type f -name stage-c-hold.pid -print -quit 2>/dev/null || true)"
    if [[ -n "$pid_file" ]]; then
      HOLD_PID="$(tr -d '[:space:]' <"$pid_file")"
      if [[ "$HOLD_PID" =~ ^[0-9]+$ ]] && kill -0 "$HOLD_PID" 2>/dev/null; then
        HOLD_PID_FILE="$pid_file"
        return 0
      fi
    fi
    sleep 0.1
  done
  HOLD_PID=""
  printf 'The native hold command did not start\n' >&2
  return 1
}

wait_for_hold_command_exit() {
  for _ in {1..600}; do
    if ! kill -0 "$HOLD_PID" 2>/dev/null; then
      HOLD_PID=""
      return 0
    fi
    sleep 0.1
  done
  printf 'Canceled hold command %s is still running\n' "$HOLD_PID" >&2
  return 1
}

# A long native command keeps the Task Run's Operation open: a dropped ACK
# forces a Gateway reconnect that must not re-execute it, and the cancellation
# must persist operation.cancelled and stop the command.
verify_hold_reconnect_cancel() {
  local run_ordinal=$1
  local hold_message="live-task-reconnect-cancel"
  local hold_prompt="This is an in-progress Task cancellation checkpoint, not a Task completion. The current working directory is the Context View root. Run exactly one shell command: mkdir -p ./playground && echo \$\$ > ./playground/stage-c-hold.pid && exec sleep 3600 . It never finishes on its own. While it runs, only keep waiting on that same running command without sending it input; do not run any other command or tool, do not stop it, and do not end the turn until it is canceled."
  local hold_run_id hold_operation_id
  append_message "$TASK_MESSAGES" "$hold_message" "$hold_prompt"
  REVISION=$((REVISION + 1))
  publish_inbox_state "$REVISION" "$ACTOR_ID"
  enable_ack_drop
  queue_task_turn "$hold_message" "$hold_prompt" >"$TMP_ROOT/hold-delivery.json"
  wait_for_hold_command
  wait_for_active_operation alter_ego "$run_ordinal" "$TMP_ROOT/hold-operation.json"
  hold_run_id="$(jq -er '.run_id' "$TMP_ROOT/hold-operation.json")"
  hold_operation_id="$(jq -er '.operation_id' "$TMP_ROOT/hold-operation.json")"
  reconnect_after_dropped_ack "$hold_operation_id"
  wait_for_active_operation alter_ego "$run_ordinal" "$TMP_ROOT/hold-operation-after-reconnect.json"
  cmp "$TMP_ROOT/hold-operation.json" "$TMP_ROOT/hold-operation-after-reconnect.json"
  # A re-executed command would rewrite the PID file.
  [[ "$(tr -d '[:space:]' <"$HOLD_PID_FILE")" == "$HOLD_PID" ]]
  kill -0 "$HOLD_PID"

  enable_ack_drop
  curl --fail-with-body --silent --show-error --max-time 10 \
    -X POST \
    "http://127.0.0.1:$FIXTURE_PORT/__test__/task-cancel" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn \
      --arg agent_id "$AGENT_ID" \
      --arg actor_id "$ACTOR_ID" \
      --arg task_id "$TASK_ID" \
      --arg run_id "$hold_run_id" \
      '{agent_id: $agent_id, actor_id: $actor_id, task_id: $task_id, run_id: $run_id}')" \
    >"$TMP_ROOT/hold-cancel.json"
  wait_for_local_run_terminal alter_ego "$run_ordinal" canceled
  wait_for_unacknowledged_terminal "$hold_operation_id" "$TMP_ROOT/hold-terminal-before-ack.json"
  reconnect_after_dropped_ack "$hold_operation_id" "$(jq -er '.through_seq' "$TMP_ROOT/hold-terminal-before-ack.json")"
  wait_for_operation_receipt alter_ego "$run_ordinal" 1 "$TMP_ROOT/hold-operation-terminal.json"
  jq -e \
    --arg operation "$hold_operation_id" \
    --arg run "$hold_run_id" \
    '.operation_id == $operation and .run_id == $run' \
    "$TMP_ROOT/hold-operation-terminal.json" >/dev/null
  wait_for_hold_command_exit
}

wait_for_report_count() {
  local event_type=$1
  local expected=$2
  for _ in {1..1200}; do
    if [[ "$(jq -s --arg type "$event_type" '[.[] | select(.type == $type)] | length' "$FIXTURE_REPORT")" -ge "$expected" ]]; then
      return 0
    fi
    sleep 0.1
  done
  printf 'Fixture report %s did not reach count %s\n' "$event_type" "$expected" >&2
  return 1
}

assert_unique_final_message() {
  local run_id=$1
  local operation_id=$2
  local room_id=$3
  local final_message=$4
  local runtime_file="$TMP_ROOT/message-runtime-$run_id.json"
  runtime_state_to_file "$runtime_file"
  node "$ROOT/scripts/local-runner-message-evidence.mjs" \
    "$FIXTURE_REPORT" "$runtime_file" "$AGENT_ID" "$room_id" \
    "$run_id" "$operation_id" "$final_message" \
    >"$TMP_ROOT/message-proof-$run_id.json"
}

resolve_live_codex_home() {
  if [[ "$AUTH_FILE" = /* && -f "$AUTH_FILE" ]]; then
    AUTH_FILE="$(realpath "$AUTH_FILE")"
    LIVE_CODEX_HOME="$(dirname "$AUTH_FILE")"
  elif [[ -z "${LINGER_CODEX_AUTH_FILE:-}" && "$LIVE_CODEX_HOME" = /* && -r "$LIVE_CODEX_HOME/config.toml" ]]; then
    # Custom providers may authenticate through existing config. The real
    # daemon account/read probe and model execution still verify usability.
    LIVE_CODEX_HOME="$(realpath "$LIVE_CODEX_HOME")"
    AUTH_FILE=""
  else
    printf 'Codex configuration unavailable; set an existing absolute LINGER_CODEX_AUTH_FILE or CODEX_HOME with config.toml.\n' >&2
    return 2
  fi
}

command -v jq >/dev/null
command -v curl >/dev/null
if [[ "$SOAK_ONLY" == "1" ]]; then
  LIVE_MODEL="codex-default"
  LIVE_REASONING_EFFORT="medium"
  AUTH_FILE="$TMP_ROOT/fixture-codex-home/auth.json"
  CODEX_EXECUTABLE="$TMP_ROOT/codex-fixture"
  mkdir -p "$(dirname "$AUTH_FILE")"
  printf '{}\n' >"$AUTH_FILE"
  cat >"$CODEX_EXECUTABLE" <<EOF
#!/usr/bin/env bash
if [[ "\$PWD" == "$TMP_ROOT"/* ]]; then
  printf 'Local Runner smoke user workspace\n' > .issue159-smoke-workspace
fi
exec "$(command -v node)" \
  "$ROOT/scripts/test-fixtures/codex-app-server-fixture.mjs" \
  "\$@" \
  --persist-threads \
  --empty-thread-history \
  --pid-dir "$SOAK_RUNTIME_PID_DIR" \
  --completion-delay-ms "$SOAK_COMPLETION_DELAY_MS" \
  --post-delta-delay-ms 25 \
  --workspace-marker .issue159-smoke-workspace
EOF
  chmod 0700 "$CODEX_EXECUTABLE"
else
  if [[ -z "$CODEX_EXECUTABLE" ]]; then
    CODEX_EXECUTABLE="$(command -v codex || true)"
  fi
  [[ -n "$CODEX_EXECUTABLE" ]] || {
    printf 'Codex is unavailable; set LINGER_CODEX_PATH or install codex on PATH\n' >&2
    exit 2
  }
  CODEX_EXECUTABLE="$(realpath "$CODEX_EXECUTABLE")"
  [[ -x "$CODEX_EXECUTABLE" ]] || {
    printf 'Codex executable is not executable: %s\n' "$CODEX_EXECUTABLE" >&2
    exit 2
  }
fi
resolve_live_codex_home

FIXTURE_PORT="$(free_port)"
AGENT_PORT="$(free_port)"
PROXY_PORT="$(free_port)"
cd "$ROOT"

printf 'Building current Local Runner process boundaries...\n'
pnpm --filter @linger/node-services... --filter @linger/teamhub-cli... build >/dev/null
node "$ROOT/apps/computer/scripts/bundle-teamhub-cli.mjs"
mkdir -p "$ROOT/apps/computer/dist/cli"
cp "$ROOT/apps/computer/dist/bundle/cli/teamhub" \
  "$ROOT/apps/computer/dist/bundle/cli/teamhub.js" \
  "$ROOT/apps/computer/dist/bundle/cli/teamhub-assets.json" \
  "$ROOT/apps/computer/dist/bundle/cli/teamhub-commands.json" "$ROOT/apps/computer/dist/cli/"
rm -rf "$ROOT/apps/computer/dist/cli/teamhub-chunks"
cp -R "$ROOT/apps/computer/dist/bundle/cli/teamhub-chunks" "$ROOT/apps/computer/dist/cli/"
mkdir -p "$ROOT/apps/computer/dist/daemon" "$ROOT/apps/computer/dist/runtime/bin"
ln -sfn "$(command -v node)" "$ROOT/apps/computer/dist/runtime/bin/node"
(
  cd "$ROOT/apps/computer/local-daemon"
  go build -o ../dist/daemon/linger-computer-daemon \
    ./cmd/linger-computer-daemon
  go build -o ../dist/cli/linger-computer ./cmd/linger-computer
)

publish_inbox_state "$REVISION"
node "$ROOT/apps/node-services/tests/agent/fixtures/local-runner-stage-c-teamhub-fixture.mjs" \
  --port "$FIXTURE_PORT" \
  --ready-file "$TMP_ROOT/fixture.ready" \
  --report-file "$FIXTURE_REPORT" \
  --artifact-directory "$TMP_ROOT/artifact-publications" \
  --service-token "$SERVICE_TOKEN" \
  --tenant-id "$TENANT_ID" \
  --inbox-state-file "$TMP_ROOT/inbox-state.json" \
  >"$TMP_ROOT/fixture.log" 2>&1 &
FIXTURE_PID=$!
wait_for_file "$TMP_ROOT/fixture.ready"
wait_for_http "http://127.0.0.1:$FIXTURE_PORT/health"

node "$ROOT/apps/node-services/tests/agent/fixtures/runner-gateway-proxy.mjs" \
  --listen-port "$PROXY_PORT" \
  --target-port "$AGENT_PORT" \
  --ready-file "$TMP_ROOT/proxy.ready" \
  --events-file "$PROXY_EVENTS" \
  >"$TMP_ROOT/proxy.log" 2>&1 &
PROXY_PID=$!
wait_for_file "$TMP_ROOT/proxy.ready"

: >"$TMP_ROOT/agent.log"
start_agent_service
enroll_computer "Live Local Computer"

jq -n \
  --arg computer "$COMPUTER_ID" \
  --arg gateway "ws://127.0.0.1:$PROXY_PORT/v1/runner-gateway" \
  --arg token "$RUNNER_TOKEN_FILE" \
  --arg state "$TMP_ROOT/computer-state" \
  --arg auth "$AUTH_FILE" \
  --arg codex "$CODEX_EXECUTABLE" \
  --arg soak "$SOAK_ONLY" \
  --arg tenant "$TENANT_ID" \
  --arg workspace "$TMP_ROOT/workspace" \
  '{
    runner_id: $computer,
    display_name: "Live Local Computer",
    gateway: {url: $gateway, token_file: $token},
    max_concurrent_operations: 2,
    state_directory: $state,
    runtime_paths: ({codex: $codex} + if $soak == "1" then {
      claude: ($state + "/not-installed/claude"),
      pi: ($state + "/not-installed/pi")
    } else {} end),
    workspace_grants: [{
      grant_id: "grant-live",
      tenant_id: $tenant,
      root_path: $workspace,
      mode: "workspace-write",
      scope: "owner"
    }]
  } + if $auth == "" then {} else {codex: {auth_file: $auth}} end' >"$CONFIG"

# Explicit account auth should not inherit API-key overrides. Config-only
# providers keep their required environment; actual Runtime discovery validates it.
if [[ -n "$AUTH_FILE" ]]; then
  unset OPENAI_ORGANIZATION OPENAI_PROJECT OPENAI_BASE_URL OPENAI_API_KEY
fi
computer daemon start >"$TMP_ROOT/computer-start.json"
DAEMON_PID="$(computer daemon status --json | jq -er '.daemon.pid')"
wait_for_gateway_ready
wait_for_runtime_ready codex

if [[ -n "$LIVE_MODEL" ]]; then
  if ! selected_runtime_model="$(computer daemon status --json | jq -ce --arg model "$LIVE_MODEL" \
    '[.runtimes[] | select(.type == "codex" and .status == "ready") | .models[] | select(.id == $model)] | select(length == 1) | .[0]')"; then
    printf 'Selected live Codex model is unavailable in this Computer Runtime catalog: %s\n' "$LIVE_MODEL" >&2
    exit 1
  fi
  if [[ -z "$LIVE_REASONING_EFFORT" ]] && jq -e '(.allowed_reasoning_effort // [] | length) > 0' <<<"$selected_runtime_model" >/dev/null; then
    if ! LIVE_REASONING_EFFORT="$(jq -er '.default_reasoning_effort as $effort | select(.allowed_reasoning_effort | index($effort)) | $effort | select(type == "string" and length > 0)' <<<"$selected_runtime_model")"; then
      printf 'Selected live Codex model has no valid default reasoning effort; set LINGER_LIVE_CODEX_REASONING_EFFORT explicitly.\n' >&2
      exit 1
    fi
  fi
  if [[ -n "$LIVE_REASONING_EFFORT" ]] && ! jq -e --arg effort "$LIVE_REASONING_EFFORT" \
    '(.allowed_reasoning_effort // []) | index($effort) != null' <<<"$selected_runtime_model" >/dev/null; then
    printf 'Selected live Codex reasoning effort is unavailable in this Computer Runtime catalog.\n' >&2
    exit 1
  fi
elif [[ -n "$LIVE_REASONING_EFFORT" ]]; then
  printf 'An explicit live model is required when selecting a reasoning effort.\n' >&2
  exit 1
fi

REGISTRATION="$(jq -cn \
  --arg tenant "$TENANT_ID" \
  --arg owner "$OWNER_ACTOR_ID" \
  --arg computer "$COMPUTER_ID" \
  --arg model "${LIVE_MODEL:-codex-default}" \
  --arg effort "$LIVE_REASONING_EFFORT" \
  '{
    tenantId: $tenant,
    agentId: "agent-live",
    revision: "1",
    agent: {
      name: "Live Local Codex",
      instructions: "Follow explicit verification instructions. Use selected Skills and teamhub CLI business commands when requested."
    },
    runtime: ({
      type: "codex",
      model: $model,
      placement: {
        type: "local",
        tenantId: $tenant,
        ownerActorId: $owner,
        computerId: $computer,
        runtimeType: "codex",
        workspaceGrantId: "grant-live"
      }
    } + if $effort == "" then {} else {reasoningEffort:$effort} end),
    resources: {skills: [], mcpServers: []}
  }')"
curl --fail-with-body --silent --show-error --max-time 10 \
  -X POST \
  "http://127.0.0.1:$FIXTURE_PORT/__test__/runtime-configs" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --argjson registration "$REGISTRATION" '{registration: $registration}')" \
  >/dev/null
# Creating an Agent only writes its TeamHub registration; the Agent Service
# reads it and prepares the Runner at the first Run.
AGENT_ID="$(jq -er '.agentId' <<<"$REGISTRATION")"
ACTOR_ID="actor-$AGENT_ID"
REVISION=$((REVISION + 1))
publish_inbox_state "$REVISION" "$ACTOR_ID"

if [[ "$SOAK_ONLY" == "1" ]]; then
  wait_for_runner_state "$AGENT_ID" ready
  cp "$TMP_ROOT/computer-state/daemon-identity.json" "$TMP_ROOT/daemon-identity-before.json"
  curl --fail-with-body --silent --show-error --max-time 10 \
    "http://127.0.0.1:$FIXTURE_PORT/v0/agent-runtime/local-runtime-registrations" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    | jq -S \
      '[.registrations[] | select(.provider_type == "codex") |
        {registration_id,daemon_id,tenant_id,owner_actor_id,provider_type}]' \
    >"$TMP_ROOT/runtime-identity-before.json"
  jq -e 'length == 1' "$TMP_ROOT/runtime-identity-before.json" >/dev/null
  for _ in {1..400}; do
    if curl --fail-with-body --silent --show-error --max-time 1 \
      "http://127.0.0.1:$FIXTURE_PORT/v0/agent-runtime/assignments" \
      -H "Authorization: Bearer $SERVICE_TOKEN" \
      | jq -S --arg agent "$AGENT_ID" \
        '[.assignments[] | select(.agent_management_id == $agent) |
          {agent_management_id,agent_actor_id,tenant_id,registration_id,assignment_revision}]' \
      >"$TMP_ROOT/assignment-before.json" 2>/dev/null &&
      jq -e 'length == 1 and (.[0].registration_id | length > 0) and (.[0].assignment_revision | tonumber > 0)' \
        "$TMP_ROOT/assignment-before.json" >/dev/null; then
      break
    fi
    sleep 0.05
  done
  jq -e 'length == 1 and (.[0].registration_id | length > 0) and (.[0].assignment_revision | tonumber > 0)' \
    "$TMP_ROOT/assignment-before.json" >/dev/null

  for iteration in {1..20}; do
    message_id="soak-message-$iteration"
    prompt="Complete deterministic Local lifecycle turn $iteration."
    deliver_message "$ROOM_ID" "$message_id" "$prompt" \
      >"$TMP_ROOT/soak-delivery-$iteration.json"
    append_message "$ROOM_MESSAGES" "$message_id" "$prompt"
    REVISION=$((REVISION + 1))
    publish_inbox_state "$REVISION" "$ACTOR_ID"
    if [[ "$iteration" == "1" ]] && ((RECOVERY_DELAY_SECONDS > 0)); then
      wait_for_operation_receipt meta 1 0 "$TMP_ROOT/deployment-before.json"
      : >"$TMP_ROOT/deployment-runtime-pids.txt"
      while IFS= read -r pid_file; do
        if jq -e --arg prefix "$TMP_ROOT/computer-state/context-views/" '.workspace != null and (.workspace | startswith($prefix))' "$pid_file" >/dev/null &&
          kill -0 "$(basename "$pid_file" .pid)" 2>/dev/null; then
          printf '%s\n' "$pid_file" >>"$TMP_ROOT/deployment-runtime-pids.txt"
        fi
      done < <(find "$SOAK_RUNTIME_PID_DIR" -type f -name '*.pid' -print)
      [[ -s "$TMP_ROOT/deployment-runtime-pids.txt" ]]
      stop_agent_service
      printf 'Agent Service stopped; checking Local Runtime survival for %s seconds.\n' "$RECOVERY_DELAY_SECONDS"
      # The model fixture continues locally while cloud observations stop.
      for ((second=0; second<RECOVERY_DELAY_SECONDS; second++)); do
        kill -0 "$DAEMON_PID"
        while IFS= read -r pid_file; do
          kill -0 "$(basename "$pid_file" .pid)"
        done <"$TMP_ROOT/deployment-runtime-pids.txt"
        sleep 1
      done
      start_agent_service
      wait_for_http "http://127.0.0.1:$AGENT_PORT/readyz"
      wait_for_gateway_ready
      printf 'Recovered Agent Service after %s seconds; Daemon and Runtime processes survived.\n' "$RECOVERY_DELAY_SECONDS"
    fi
    wait_for_local_run_terminal meta "$iteration" succeeded
    wait_for_operation_receipt \
      meta "$iteration" 1 "$TMP_ROOT/soak-operation-$iteration.json"
    if [[ "$iteration" == "1" ]] && ((RECOVERY_DELAY_SECONDS > 0)); then
      jq -e --slurpfile before "$TMP_ROOT/deployment-before.json" \
        '.operation_id == $before[0].operation_id and .run_id == $before[0].run_id' \
        "$TMP_ROOT/soak-operation-1.json" >/dev/null
    fi

    case "$iteration" in
      2|6|10|14|18)
        previous_daemon_pid="$DAEMON_PID"
        computer daemon stop >/dev/null
        wait_for_daemon_exit "$previous_daemon_pid"
        DAEMON_PID=""
        computer daemon start >"$TMP_ROOT/soak-daemon-restart-$iteration.json"
        DAEMON_PID="$(computer daemon status --json | jq -er '.daemon.pid')"
        wait_for_gateway_ready
        wait_for_runner_state "$AGENT_ID" ready
        ;;
      4|9|15)
        connections_before="$(jq -s '[.[] | select(.type == "connection")] | length' "$PROXY_EVENTS")"
        stop_agent_service
        start_agent_service
        wait_for_http "http://127.0.0.1:$AGENT_PORT/readyz"
        wait_for_gateway_connection_count "$((connections_before + 1))"
        wait_for_gateway_ready
        wait_for_runner_state "$AGENT_ID" ready
        ;;
      7|12|17)
        connections_before="$(jq -s '[.[] | select(.type == "connection")] | length' "$PROXY_EVENTS")"
        kill -USR1 "$PROXY_PID"
        wait_for_gateway_connection_count "$((connections_before + 1))"
        wait_for_gateway_ready
        wait_for_runner_state "$AGENT_ID" ready
        ;;
    esac
  done

  cmp \
    "$TMP_ROOT/daemon-identity-before.json" \
    "$TMP_ROOT/computer-state/daemon-identity.json"
  curl --fail-with-body --silent --show-error --max-time 10 \
    "http://127.0.0.1:$FIXTURE_PORT/v0/agent-runtime/local-runtime-registrations" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    | jq -S \
      '[.registrations[] | select(.provider_type == "codex") |
        {registration_id,daemon_id,tenant_id,owner_actor_id,provider_type}]' \
    >"$TMP_ROOT/runtime-identity-after.json"
  cmp \
    "$TMP_ROOT/runtime-identity-before.json" \
    "$TMP_ROOT/runtime-identity-after.json"
  curl --fail-with-body --silent --show-error --max-time 10 \
    "http://127.0.0.1:$FIXTURE_PORT/v0/agent-runtime/assignments" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    | jq -S --arg agent "$AGENT_ID" \
      '[.assignments[] | select(.agent_management_id == $agent) |
        {agent_management_id,agent_actor_id,tenant_id,registration_id,assignment_revision}]' \
    >"$TMP_ROOT/assignment-after.json"
  cmp "$TMP_ROOT/assignment-before.json" "$TMP_ROOT/assignment-after.json"

  runtime_state_to_file "$TMP_ROOT/soak-runtime-state.json"
  node - \
    "$TMP_ROOT/soak-runtime-state.json" \
    "$TMP_ROOT/computer-state/operations.sqlite" \
    "$AGENT_ID" <<'NODE'
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [statePath, ledgerPath, agentId] = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const runs = state.runs.filter(
  (run) => run.agent_id === agentId && run.context_kind === "meta",
);
if (
  runs.length !== 20 ||
  new Set(runs.map((run) => run.run_id)).size !== 20 ||
  runs.some(
    (run) => run.status !== "succeeded" || run.terminal_type !== "succeeded",
  )
) {
  throw new Error(`Unexpected soak Local Runs: ${JSON.stringify(runs)}`);
}
const runIds = new Set(runs.map((run) => run.run_id));
const receipts = state.operation_receipts.filter(
  (receipt) => receipt.agent_id === agentId && runIds.has(receipt.run_id),
);
if (
  receipts.length !== 20 ||
  new Set(receipts.map((receipt) => receipt.operation_id)).size !== 20 ||
  runs.some(
    (run) => receipts.filter((receipt) => receipt.run_id === run.run_id).length !== 1,
  )
) {
  throw new Error(`Unexpected soak Operation receipts: ${JSON.stringify(receipts)}`);
}

const ledger = new DatabaseSync(ledgerPath, { readOnly: true });
const operation = ledger.prepare(`
	  SELECT status,last_acked_seq,last_emitted_seq,terminal_event_json
  FROM operations WHERE operation_id=?
`);
for (const receipt of receipts) {
  const row = operation.get(receipt.operation_id);
  if (
    !row ||
    row.status !== "terminal" ||
    !row.terminal_event_json ||
    row.last_acked_seq !== row.last_emitted_seq
  ) {
    throw new Error(
      `Operation ${receipt.operation_id} is not terminal and fully acknowledged`,
    );
  }
}
const unsettled = ledger.prepare(`
	  SELECT operation_id,status,last_acked_seq,last_emitted_seq
	  FROM operations
	  WHERE status<>'terminal' OR last_acked_seq<>last_emitted_seq
`).all();
ledger.close();
if (unsettled.length !== 0) {
  throw new Error(`Unsettled daemon ledger rows: ${JSON.stringify(unsettled)}`);
}
NODE

  computer daemon runners --json | jq -e \
    --arg agent "$AGENT_ID" \
    '.runners | length == 1 and .[0].agent_id == $agent and
     .[0].state == "ready" and .[0].active_operation_id == null' \
    >/dev/null
  previous_daemon_pid="$DAEMON_PID"
  computer daemon stop >/dev/null
  wait_for_daemon_exit "$previous_daemon_pid"
  DAEMON_PID=""
  while IFS= read -r pid_file; do
    runtime_pid="$(basename "$pid_file" .pid)"
    if kill -0 "$runtime_pid" 2>/dev/null; then
      printf 'Runtime PID %s remains after soak shutdown\n' "$runtime_pid" >&2
      exit 1
    fi
  done < <(find "$SOAK_RUNTIME_PID_DIR" -type f -name '*.pid' -print)
  if find "$TMP_ROOT/computer-state/runner-processes" \
    -type f -name '*.json' -print -quit 2>/dev/null | grep -q .; then
    printf 'Runner ownership records remain after soak shutdown\n' >&2
    exit 1
  fi
  printf 'Local Runner soak passed: 20 input messages and unique Local Run terminals, 5 daemon restarts, 3 Agent Service restarts, 3 Gateway reconnects, stable Registration/Assignment identity, fully acknowledged ledger, and no residual child process. CLI business replies and native command cancellation require the live suite.\n'
  exit 0
fi

if [[ "$RESTART_ONLY" == "1" ]]; then
  INITIAL_MESSAGE="live-meta-before-service-restart"
  INITIAL_PROMPT="Run teamhub message send --json --operation-id $ROOM_ID-$REVISION --input a local JSON file containing inbox_id $ROOM_ID and message_segments [{\"type\":\"text\",\"content\":\"STAGE_C_BEFORE_RESTART_OK\"}]. Do not perform any other business action."
  deliver_message "$ROOM_ID" "$INITIAL_MESSAGE" "$INITIAL_PROMPT" >"$TMP_ROOT/restart-initial-delivery.json"
  append_message "$ROOM_MESSAGES" "$INITIAL_MESSAGE" "$INITIAL_PROMPT"
  REVISION=$((REVISION + 1))
  publish_inbox_state "$REVISION" "$ACTOR_ID"
  wait_for_local_run_terminal meta 1 succeeded
  wait_for_operation_receipt meta 1 1 "$TMP_ROOT/restart-initial-operation.json"
  assert_unique_final_message \
    "$(jq -er '.run_id' "$TMP_ROOT/restart-initial-operation.json")" \
    "$(jq -er '.operation_id' "$TMP_ROOT/restart-initial-operation.json")" \
    "$ROOM_ID" STAGE_C_BEFORE_RESTART_OK
  DAEMON_IDENTITY_BEFORE="$(computer daemon status --json | jq -c '{computer_id: .daemon.computer_id, state_directory: .config.state_directory}')"
  computer daemon stop >/dev/null
  wait_for_daemon_exit "$DAEMON_PID"
  DAEMON_PID=""
  stop_agent_service
  start_agent_service
  wait_for_http "http://127.0.0.1:$AGENT_PORT/readyz"
  computer daemon start >"$TMP_ROOT/computer-restart.json"
  DAEMON_PID="$(computer daemon status --json | jq -er '.daemon.pid')"
  wait_for_gateway_ready
  wait_for_runner_state "$AGENT_ID" ready
  DAEMON_IDENTITY_AFTER="$(computer daemon status --json | jq -c '{computer_id: .daemon.computer_id, state_directory: .config.state_directory}')"
  [[ "$DAEMON_IDENTITY_BEFORE" == "$DAEMON_IDENTITY_AFTER" ]]
  RECOVERY_MESSAGE="live-meta-after-service-restart"
  RECOVERY_PROMPT="Run teamhub message send --json --operation-id $ROOM_ID-$REVISION --input a local JSON file containing inbox_id $ROOM_ID and message_segments [{\"type\":\"text\",\"content\":\"STAGE_C_AFTER_RESTART_OK\"}]. Do not perform any other business action."
  deliver_message "$ROOM_ID" "$RECOVERY_MESSAGE" "$RECOVERY_PROMPT" >"$TMP_ROOT/restart-recovery-delivery.json"
  append_message "$ROOM_MESSAGES" "$RECOVERY_MESSAGE" "$RECOVERY_PROMPT"
  REVISION=$((REVISION + 1))
  publish_inbox_state "$REVISION" "$ACTOR_ID"
  wait_for_local_run_terminal meta 2 succeeded
  wait_for_operation_receipt meta 2 1 "$TMP_ROOT/restart-recovery-operation.json"
  assert_unique_final_message \
    "$(jq -er '.run_id' "$TMP_ROOT/restart-recovery-operation.json")" \
    "$(jq -er '.operation_id' "$TMP_ROOT/restart-recovery-operation.json")" \
    "$ROOM_ID" STAGE_C_AFTER_RESTART_OK
  assert_unique_final_message \
    "$(jq -er '.run_id' "$TMP_ROOT/restart-initial-operation.json")" \
    "$(jq -er '.operation_id' "$TMP_ROOT/restart-initial-operation.json")" \
    "$ROOM_ID" STAGE_C_BEFORE_RESTART_OK
  printf 'Live Local Runner daemon and Agent Service restart smoke passed.\n'
  exit 0
fi

if [[ "$RECONNECT_ONLY" == "1" ]]; then
  verify_hold_reconnect_cancel 1
  printf 'Live Local Runner reconnect/cancel smoke passed.\n'
  exit 0
fi

META_MESSAGE="live-meta-resources"
META_PROMPT="Run teamhub message send --json --operation-id stage-c-meta --input a local JSON file containing inbox_id $ROOM_ID and message_segments [{\"type\":\"text\",\"content\":\"STAGE_C_META_OK\"}]. Do not perform any other action."
deliver_message "$ROOM_ID" "$META_MESSAGE" "$META_PROMPT" >"$TMP_ROOT/meta-delivery.json"
append_message "$ROOM_MESSAGES" "$META_MESSAGE" "$META_PROMPT"
REVISION=$((REVISION + 1))
publish_inbox_state "$REVISION" "$ACTOR_ID"
wait_for_local_run_terminal meta 1 succeeded
wait_for_operation_receipt meta 1 1 "$TMP_ROOT/meta-operation.json"
META_RUN_ID="$(jq -er '.run_id' "$TMP_ROOT/meta-operation.json")"
META_OPERATION_ID="$(jq -er '.operation_id' "$TMP_ROOT/meta-operation.json")"
assert_unique_final_message "$META_RUN_ID" "$META_OPERATION_ID" "$ROOM_ID" STAGE_C_META_OK
wait_for_report_count skill.package.downloaded 1

SKILL_FILE="$(find "$TMP_ROOT" -type f -path '*/.agents/skills/stage-c-verifier/references/protocol.txt' -print -quit)"
[[ -n "$SKILL_FILE" ]]
grep -Fx 'SKILL_MARKER=stage-c-skill-loaded' "$SKILL_FILE" >/dev/null

CREATE_MESSAGE="live-task-create-output"
TASK_PHASE_POLICY="This Task is a multi-stage acceptance exercise and is not complete. Subsequent steps will be supplied separately. This input requests only an intermediate checkpoint: do not submit a Task result, call teamhub task finish, or send a message. After this checkpoint's requested CLI succeeds, end this turn and wait for the next input."
CREATE_PROMPT="$TASK_PHASE_POLICY Read .agents/skills/stage-c-verifier/references/protocol.txt. First run teamhub docs get document_live_input --output ./playground/input.txt --json and read that file. The current working directory is the Context View root; the writable Playground is ./playground. First create ./playground/reports/live-output.txt with three lines: OUTPUT_MARKER=stage-c-created, SKILL_EXECUTION_MARKER=stage-c-skill-instruction-followed, and the complete line from the downloaded input. Then run teamhub publish ./playground/reports/live-output.txt --json exactly once. Do not end the turn until the CLI succeeds."
append_message "$TASK_MESSAGES" "$CREATE_MESSAGE" "$CREATE_PROMPT"
REVISION=$((REVISION + 1))
publish_inbox_state "$REVISION" "$ACTOR_ID"
queue_task_turn "$CREATE_MESSAGE" "$CREATE_PROMPT" >"$TMP_ROOT/create-delivery.json"
wait_for_local_run_terminal alter_ego 1 succeeded
wait_for_operation_receipt alter_ego 1 1 "$TMP_ROOT/create-operation.json"
CREATE_RUN_ID="$(jq -er '.run_id' "$TMP_ROOT/create-operation.json")"
CREATE_OPERATION_ID="$(jq -er '.operation_id' "$TMP_ROOT/create-operation.json")"
wait_for_report_count artifact.published 1
wait_for_report_count document.downloaded 1
grep -Fx 'ARTIFACT_INPUT_MARKER=stage-c-authorized-CLI-download' \
  "$TMP_ROOT/artifact-publications/document_live_output-v1-live-output.txt" >/dev/null
grep -Fx 'OUTPUT_MARKER=stage-c-created' \
  "$TMP_ROOT/artifact-publications/document_live_output-v1-live-output.txt" >/dev/null
grep -Fx 'SKILL_EXECUTION_MARKER=stage-c-skill-instruction-followed' \
  "$TMP_ROOT/artifact-publications/document_live_output-v1-live-output.txt" >/dev/null

REPLACE_MESSAGE="live-task-replace-output"
REPLACE_PROMPT="$TASK_PHASE_POLICY The current working directory is the Context View root; the writable Playground is ./playground. First replace ./playground/reports/live-output.txt with exactly two lines: OUTPUT_MARKER=stage-c-replaced and SKILL_EXECUTION_MARKER=stage-c-skill-instruction-followed. Then run teamhub update document_live_output ./playground/reports/live-output.txt --json exactly once. Do not end the turn until the CLI succeeds."
append_message "$TASK_MESSAGES" "$REPLACE_MESSAGE" "$REPLACE_PROMPT"
REVISION=$((REVISION + 1))
publish_inbox_state "$REVISION" "$ACTOR_ID"
queue_task_turn "$REPLACE_MESSAGE" "$REPLACE_PROMPT" >"$TMP_ROOT/replace-delivery.json"
wait_for_local_run_terminal alter_ego 2 succeeded
wait_for_operation_receipt alter_ego 2 1 "$TMP_ROOT/replace-operation.json"
REPLACE_RUN_ID="$(jq -er '.run_id' "$TMP_ROOT/replace-operation.json")"
REPLACE_OPERATION_ID="$(jq -er '.operation_id' "$TMP_ROOT/replace-operation.json")"
wait_for_report_count artifact.published 2
grep -Fx 'OUTPUT_MARKER=stage-c-replaced' \
  "$TMP_ROOT/artifact-publications/document_live_output-v2-live-output.txt" >/dev/null
jq -s -e '
  ([.[] | select(.type == "artifact.published")]) as $publications
  | ($publications | length) == 2
  and ([$publications[].operation] == ["create", "replace"])
  and ([$publications[].version_number] == [1, 2])
  and all($publications[]; .transport == "teamhub-cli" and .idempotency_key_present == true and (.command_operation_id | length) > 0)
  and ([$publications[].command_operation_id] | unique | length) == 2
  and ([.[] | select(.type | startswith("agent.host."))] | length) == 0
' "$FIXTURE_REPORT" >/dev/null
if grep -Eq 'mcp_ctx_[A-Za-z0-9_-]{43}' "$FIXTURE_REPORT"; then
  printf 'Fixture report exposed a Context or Skill snapshot token\n' >&2
  exit 1
fi

verify_hold_reconnect_cancel 3

computer daemon runners stop "$AGENT_ID" --json | jq -e \
  --arg agent "$AGENT_ID" '.runner.agent_id == $agent and .runner.state == "paused"' >/dev/null

DAEMON_IDENTITY_BEFORE="$(computer daemon status --json | jq -c '{computer_id: .daemon.computer_id, state_directory: .config.state_directory}')"
computer daemon stop >/dev/null
wait_for_daemon_exit "$DAEMON_PID"
DAEMON_PID=""

REVISION=$((REVISION + 1))
publish_inbox_state "$REVISION" "$ACTOR_ID" 0
stop_agent_service
start_agent_service
wait_for_http "http://127.0.0.1:$AGENT_PORT/readyz"
computer daemon start >"$TMP_ROOT/computer-restart.json"
DAEMON_PID="$(computer daemon status --json | jq -er '.daemon.pid')"
wait_for_gateway_ready
wait_for_runner_state "$AGENT_ID" ready

REVISION=$((REVISION + 1))
publish_inbox_state "$REVISION" "$ACTOR_ID"
DAEMON_IDENTITY_AFTER="$(computer daemon status --json | jq -c '{computer_id: .daemon.computer_id, state_directory: .config.state_directory}')"
[[ "$DAEMON_IDENTITY_BEFORE" == "$DAEMON_IDENTITY_AFTER" ]]

RECOVERY_MESSAGE="live-meta-after-runner-restart"
RECOVERY_PROMPT="Run teamhub message send --json --operation-id $ROOM_ID-$REVISION --input a local JSON file containing inbox_id $ROOM_ID and message_segments [{\"type\":\"text\",\"content\":\"STAGE_C_RECOVERED_OK\"}]. Do not perform any other business action."
deliver_message "$ROOM_ID" "$RECOVERY_MESSAGE" "$RECOVERY_PROMPT" >"$TMP_ROOT/recovery-delivery.json"
append_message "$ROOM_MESSAGES" "$RECOVERY_MESSAGE" "$RECOVERY_PROMPT"
REVISION=$((REVISION + 1))
publish_inbox_state "$REVISION" "$ACTOR_ID"
wait_for_local_run_terminal meta 2 succeeded
wait_for_operation_receipt meta 2 1 "$TMP_ROOT/recovery-operation.json"
assert_unique_final_message \
  "$(jq -er '.run_id' "$TMP_ROOT/recovery-operation.json")" \
  "$(jq -er '.operation_id' "$TMP_ROOT/recovery-operation.json")" \
  "$ROOM_ID" STAGE_C_RECOVERED_OK
assert_unique_final_message "$META_RUN_ID" "$META_OPERATION_ID" "$ROOM_ID" STAGE_C_META_OK
jq -s -e '
  all(.[] | select(.type == "agent.messages.published"); .idempotency_key_present == true)
' "$FIXTURE_REPORT" >/dev/null

runtime_state_to_file "$TMP_ROOT/runtime-state.json"
node - "$TMP_ROOT/runtime-state.json" <<'NODE'
import { readFileSync } from "node:fs";

const state = JSON.parse(readFileSync(process.argv[2], "utf8"));
const runIds = state.runs.map((run) => run.run_id);
if (runIds.length !== 5) {
  throw new Error(`Expected 5 Local Runs, found ${runIds.length}`);
}
for (const runId of runIds) {
  const matching = state.operation_receipts.filter(
    (receipt) => receipt.run_id === runId,
  );
  if (matching.length !== 1) {
    throw new Error(
      `Local Run ${runId} mapped to ${matching.length} run.start receipts`,
    );
  }
}
NODE

# TeamHub revokes the registration in one transaction and then notifies the
# Agent Service.
curl --fail-with-body --silent --show-error --max-time 10 \
  -X DELETE \
  "http://127.0.0.1:$FIXTURE_PORT/__test__/runtime-configs/$AGENT_ID" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  >/dev/null
api POST "/v1/agents/$AGENT_ID/registration-changes" >/dev/null
computer daemon stop >/dev/null
wait_for_daemon_exit "$DAEMON_PID"
DAEMON_PID=""
if find "$TMP_ROOT/computer-state/runner-processes" -type f -name '*.json' -print -quit 2>/dev/null | grep -q .; then
  printf 'Runner ownership records remain after shutdown\n' >&2
  exit 1
fi

printf 'Live Local Runner Stage C smoke passed: current Execution Context, Context Generation Skill resources, authorized Document CLI download, direct CLI file publication, reconnect without re-executing a long native command, cancel that stops it, Agent Service deferred restore, Runner restart, Computer restart, and cleanup.\n'
