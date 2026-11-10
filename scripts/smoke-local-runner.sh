#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "/tmp/sx-lr.XXXXXX")"
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
# The Agent Service derives its credentials from this seed.
SECRET_SEED="local-runner-smoke-secret-seed-0123456789"
# SERVICE_TOKEN is what the Agent Service presents to the TeamHub fixture;
# NODE_SERVICES_TOKEN is what TeamHub presents to the Agent Service.
SERVICE_TOKEN="$(node -e 'const { hkdfSync } = require("node:crypto"); process.stdout.write(Buffer.from(hkdfSync("sha256", process.argv[1], "simplexai/service-credential/v1", "teamhub-internal", 32)).toString("base64url"));' "$SECRET_SEED")"
NODE_SERVICES_TOKEN="$(node -e 'const { hkdfSync } = require("node:crypto"); process.stdout.write(Buffer.from(hkdfSync("sha256", process.argv[1], "simplexai/service-credential/v1", "node-services-internal", 32)).toString("base64url"));' "$SECRET_SEED")"
TENANT_ID="tenant-smoke"
OWNER_ACTOR_ID="human-smoke"
ROOM_ID="room-smoke"
# Enrollment assigns the Computer ID and writes its Runner credential.
COMPUTER_ID=""
RUNNER_TOKEN_FILE="$TMP_ROOT/runner-token"
CALLBACK_PORT=""
AGENT_PORT=""
PROXY_PORT=""
CALLBACK_LOG="$TMP_ROOT/callbacks.ndjson"
TEAMHUB_FIXTURE_STATE="$TMP_ROOT/teamhub-fixture-state.json"
PROXY_EVENTS="$TMP_ROOT/proxy-events.ndjson"
INBOX_MESSAGES="$TMP_ROOT/inbox-messages.json"
CONFIG="$TMP_ROOT/computer.json"
RUNTIME_PID_DIR="$TMP_ROOT/runtime-pids"
CODEX_FIXTURE="$TMP_ROOT/codex"
CLAUDE_FIXTURE="$TMP_ROOT/claude"
LOGIN_SHELL_FIXTURE="$TMP_ROOT/login-shell"
CLAUDE_LOGIN_MARKER="$TMP_ROOT/claude.logged-in"
AGENT_PID=""
CALLBACK_PID=""
PROXY_PID=""
DAEMON_PID=""
FAILED_LINE=""

mkdir -p \
  "$RUNTIME_PID_DIR" \
  "$TMP_ROOT/workspace-a" \
  "$TMP_ROOT/workspace-b" \
  "$TMP_ROOT/workspace-c"
touch "$CALLBACK_LOG" "$PROXY_EVENTS"
printf '[]\n' >"$INBOX_MESSAGES"
mkdir -p "$TMP_ROOT/agent-codex-home"
printf '{}\n' >"$TMP_ROOT/agent-codex-home/auth.json"

cleanup() {
  local exit_code=$?
  trap - ERR
  set +e
  if [[ -S "$TMP_ROOT/computer-state/control.sock" ]]; then
    computer daemon stop >/dev/null 2>&1
  fi
  for pid in "$DAEMON_PID" "$PROXY_PID" "$AGENT_PID" "$CALLBACK_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
    fi
  done
  for pid in "$DAEMON_PID" "$PROXY_PID" "$AGENT_PID" "$CALLBACK_PID"; do
    if [[ -n "$pid" ]]; then
      wait "$pid" 2>/dev/null
    fi
  done
  if [[ $exit_code -ne 0 ]]; then
    printf '\nLocal Runner smoke failed near line %s. Agent log:\n' \
      "${FAILED_LINE:-unknown}" >&2
    tail -80 "$TMP_ROOT/agent.log" 2>/dev/null >&2
    printf '\nDaemon log:\n' >&2
    tail -80 "$TMP_ROOT/computer-state/daemon.log" 2>/dev/null >&2
  fi
  if [[ "${KEEP_LOCAL_RUNNER_SMOKE:-0}" == "1" ]]; then
    printf 'Smoke artifacts retained at %s\n' "$TMP_ROOT" >&2
  else
    chmod -R u+rwX "$TMP_ROOT" 2>/dev/null || true
    rm -rf "$TMP_ROOT"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM
trap 'FAILED_LINE=$LINENO' ERR

free_port() {
  node -e 'const net=require("node:net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close();});'
}

wait_for_file() {
  local file=$1
  for _ in {1..100}; do
    [[ -s "$file" ]] && return 0
    sleep 0.05
  done
  printf 'Timed out waiting for %s\n' "$file" >&2
  return 1
}

wait_for_http() {
  local url=$1
  for _ in {1..100}; do
    curl --fail --silent --show-error --max-time 1 "$url" >/dev/null 2>&1 && return 0
    sleep 0.05
  done
  printf 'Timed out waiting for %s\n' "$url" >&2
  return 1
}

publish_inbox_state() {
  local revision=${1:-1}
  shift || true
  node - "$TMP_ROOT/inbox-state.json" "$TENANT_ID" "$ROOM_ID" "$revision" "$INBOX_MESSAGES" "$@" <<'NODE'
import { readFileSync, renameSync, writeFileSync } from "node:fs";
const [filename, tenantId, roomId, revision, messagesFile, ...actorIds] = process.argv.slice(2);
// Deterministic TeamHub fixture state, never an Agent filesystem projection.
const snapshot = {tenant_id:tenantId, revision, inboxes:[{inbox_id:`room:${roomId}`,kind:"room",room_id:roomId,actor_ids:actorIds,messages:JSON.parse(readFileSync(messagesFile,"utf8"))}]};
writeFileSync(filename+".pending",JSON.stringify(snapshot),{mode:0o600});
renameSync(filename+".pending",filename);
NODE
  if [[ -n "$CALLBACK_PID" ]]; then
    curl --fail-with-body --silent --show-error --max-time 10 -X POST \
      "http://127.0.0.1:$CALLBACK_PORT/__test__/inbox-wake" \
      -H "Authorization: Bearer $SERVICE_TOKEN" -H 'Content-Type: application/json' --data '{}'
  fi
}

append_context_message() {
  local message_id=$1
  local text=$2
  local target_actor_id=${3:-}
  node - "$INBOX_MESSAGES" "$message_id" "$text" "$target_actor_id" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const [statePath, messageId, text, targetActorId] = process.argv.slice(2);
const messages = JSON.parse(readFileSync(statePath, "utf8"));
if (!messages.some((message) => message.message_id === messageId)) {
  messages.push({
    sequence: messages.length + 1,
    message_id: messageId,
    sender: { actor_id: "human-smoke", type: "user" },
    segments: targetActorId
      ? [
          {
            type: "reference",
            content: "@LocalAgent",
            target: targetActorId,
            target_type: "agent",
          },
          { type: "text", content: ` ${text}` },
        ]
      : [{ type: "text", content: text }],
  });
  writeFileSync(statePath, `${JSON.stringify(messages)}\n`);
}
NODE
}

publish_inbox_state

wait_for_authentication_runtime_fence() {
  local agent_id=$1
  for _ in {1..400}; do
    if node - "$TMP_ROOT/agent-home/agent-manager/logs/agents/$agent_id/events.ndjson" "$agent_id" <<'NODE'
import { readFileSync } from "node:fs";

const [logPath, agentId] = process.argv.slice(2);
const observed = readFileSync(logPath, "utf8")
  .split("\n")
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  })
  .some(
    (entry) =>
      entry.event === "local_run.failed" &&
      entry.agentId === agentId &&
      entry.error?.code === "RUNTIME_AUTHENTICATION_REQUIRED",
  );
process.exit(observed ? 0 : 1);
NODE
    then
      return 0
    fi
    sleep 0.05
  done
  printf 'Timed out waiting for Runtime authentication fence for Agent %s\n' "$agent_id" >&2
  return 1
}

wait_for_agent_activation() {
  local agent_id=$1
  for _ in {1..400}; do
    if node - "$TMP_ROOT/agent-home/agent-manager/logs/agents/$agent_id/events.ndjson" "$agent_id" <<'NODE'
import { readFileSync } from "node:fs";

const [logPath, agentId] = process.argv.slice(2);
const activation = readFileSync(logPath, "utf8")
  .split("\n")
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  })
  .filter((entry) => entry.agentId === agentId &&
    (entry.event === "activation.completed" || entry.event === "activation.failed"))
  .at(-1);
process.exit(activation?.event === "activation.completed" ? 0 : activation ? 2 : 1);
NODE
    then
      return 0
    else
      local activation_exit_code=$?
      if [[ "$activation_exit_code" == 2 ]]; then
        printf 'Activation failed for Agent %s\n' "$agent_id" >&2
        return 1
      fi
    fi
    sleep 0.05
  done
  printf 'Timed out waiting for activation of Agent %s\n' "$agent_id" >&2
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

wait_for_proxy_event() {
  local event_type=$1
  for _ in {1..160}; do
    if jq -s -e --arg type "$event_type" 'any(.[]; .type == $type)' "$PROXY_EVENTS" >/dev/null; then
      return 0
    fi
    sleep 0.025
  done
  printf 'Proxy event %s was not observed\n' "$event_type" >&2
  return 1
}

wait_for_gateway_ready() {
  for _ in {1..400}; do
    if computer daemon status --json 2>/dev/null | jq -e '.daemon.gateway_state == "connected"' >/dev/null; then
      return 0
    fi
    sleep 0.05
  done
  printf 'Computer daemon did not reach connected gateway state\n' >&2
  return 1
}

wait_for_runtime_inventory() {
  for _ in {1..400}; do
    if computer daemon status --json 2>/dev/null | jq -e \
      '.runtimes | length == 3
       and any(.[]; .type == "codex" and .status == "ready")
       and any(.[]; .type == "claude" and .status == "ready")
       and any(.[]; .type == "pi" and .status == "not_installed")' \
      >/dev/null; then
      return 0
    fi
    sleep 0.05
  done
  printf 'Computer daemon did not report the expected Runtime inventory\n' >&2
  computer daemon status --json >&2 || true
  return 1
}

wait_for_two_running_runs() {
  local output_file=$1
  for _ in {1..240}; do
    if snapshot_active_run_owners "$output_file.owners"; then
      cp "$output_file.owners" "$output_file"
      return 0
    fi
    sleep 0.025
  done
  printf 'Two concurrent run.start operations were not observed\n' >&2
  computer daemon runners --json >&2 || true
  node - "$TMP_ROOT/computer-state/operations.sqlite" <<'NODE' >&2 || true
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[2], { readOnly: true });
	console.error(JSON.stringify(database.prepare(`
	  SELECT operation_id,status,last_acked_seq,last_emitted_seq
	  FROM operations ORDER BY created_at,operation_id
	`).all()));
database.close();
NODE
  return 1
}

snapshot_active_run_owners() {
  local output_file=$1
  node - "$TMP_ROOT/computer-state/operations.sqlite" "$output_file" <<'NODE'
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(process.argv[2], { readOnly: true });
const rows = database.prepare(`
	  SELECT operation_id,identity_json,operation_kind
	  FROM operations
	  WHERE status='running' ORDER BY operation_id
	`).all().flatMap(({ operation_id, identity_json, operation_kind }) => {
	  if (operation_kind !== "run.start") return [];
  const encoded = typeof identity_json === "string"
    ? identity_json
    : Buffer.from(identity_json).toString("utf8");
  const identity = JSON.parse(encoded);
  return [{ agent_id: identity.agent_id, operation_id }];
});
database.close();
if (rows.length !== 2) process.exit(1);
writeFileSync(process.argv[3], JSON.stringify(rows));
NODE
}

wait_for_pid_exit() {
  local pid=$1
  for _ in {1..160}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.025
  done
  printf 'PID %s did not exit\n' "$pid" >&2
  return 1
}

wait_for_runtime_pids_exit() {
  for _ in {1..400}; do
    local alive=0
    while IFS= read -r pid_file; do
      local runtime_pid
      runtime_pid="$(basename "$pid_file" .pid)"
      if kill -0 "$runtime_pid" 2>/dev/null; then
        alive=1
        break
      fi
    done < <(find "$RUNTIME_PID_DIR" -type f -name '*.pid' -print)
    [[ $alive -eq 0 ]] && return 0
    sleep 0.025
  done
  printf 'Runtime provider processes did not exit\n' >&2
  return 1
}

wait_for_local_run_terminal() {
  local agent_id=$1
  local expected_status=$2
  local expected_response_prefix=${3:-}
  local minimum_count=${4:-1}
  for _ in {1..400}; do
    if curl --fail --silent --show-error \
      --max-time 1 \
      "http://127.0.0.1:$CALLBACK_PORT/__test__/runtime-state" \
      -H "Authorization: Bearer $SERVICE_TOKEN" \
      >"$TMP_ROOT/runtime-state-snapshot.json" 2>/dev/null &&
      jq -e \
        --arg agent "$agent_id" \
        --arg status "$expected_status" \
        --arg prefix "$expected_response_prefix" \
        --argjson minimum "$minimum_count" \
        '[.runs[] | select(
          .agent_id == $agent
          and .status == $status
          and .terminal_type == $status
          and ($prefix == "" or (.final_response | strings | startswith($prefix)))
        )] | length >= $minimum' \
        "$TMP_ROOT/runtime-state-snapshot.json" >/dev/null
    then
      return 0
    fi
    sleep 0.05
  done
  printf 'Agent %s did not persist %s Local Run terminal%s\n' \
    "$agent_id" \
    "$expected_status" \
    "${expected_response_prefix:+ with response prefix $expected_response_prefix}" >&2
  sed -n '1,240p' "$TMP_ROOT/runtime-state-snapshot.json" >&2 || true
  return 1
}

wait_for_run_receipt_terminal() {
  local agent_id=$1
  local expected_receipt_count=$2
  local expected_connection_epoch=${3:-}
  for _ in {1..400}; do
    if curl --fail --silent --show-error \
      --max-time 1 \
      "http://127.0.0.1:$CALLBACK_PORT/__test__/runtime-state" \
      -H "Authorization: Bearer $SERVICE_TOKEN" \
      >"$TMP_ROOT/runtime-state-snapshot.json" 2>/dev/null &&
      node - \
      "$TMP_ROOT/runtime-state-snapshot.json" \
      "$TMP_ROOT/computer-state/operations.sqlite" \
      "$agent_id" \
      "$expected_receipt_count" \
      "$expected_connection_epoch" <<'NODE'
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [snapshotPath, ledgerPath, agentId, expectedCountText, epochText] =
  process.argv.slice(2);
const starts = JSON.parse(readFileSync(snapshotPath, "utf8"))
  .operation_receipts
  .filter(
    (receipt) =>
      receipt.agent_id === agentId &&
      (epochText === "" || receipt.connection_epoch === Number(epochText)),
  );
if (starts.length < Number(expectedCountText)) process.exit(1);
const latest = starts.at(-1);

const ledger = new DatabaseSync(ledgerPath, { readOnly: true });
const operation = ledger
  .prepare(`
	    SELECT operation_id,status,last_acked_seq,last_emitted_seq,
	           terminal_event_json
    FROM operations WHERE operation_id = ?
  `)
  .get(latest.operation_id);
ledger.close();
if (
  operation?.status !== "terminal" ||
  !operation.terminal_event_json ||
  operation.last_emitted_seq < 1 ||
  operation.last_acked_seq !== operation.last_emitted_seq
) process.exit(1);
NODE
    then
      return 0
    fi
    sleep 0.05
  done
  printf 'Agent %s did not produce %s terminal, acknowledged Local run.start receipts\n' \
    "$agent_id" "$expected_receipt_count" >&2
  return 1
}

assert_run_receipt_count() {
  local agent_id=$1
  local expected_receipt_count=$2
  local expected_connection_epoch=${3:-}
  curl --fail --silent --show-error \
    --max-time 10 \
    "http://127.0.0.1:$CALLBACK_PORT/__test__/runtime-state" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    >"$TMP_ROOT/runtime-state-snapshot.json"
  jq -e \
    --arg agent "$agent_id" \
    --argjson expected "$expected_receipt_count" \
    --arg epoch "$expected_connection_epoch" \
    '[.operation_receipts[] | select(
      .agent_id == $agent
      and ($epoch == "" or .connection_epoch == ($epoch | tonumber))
    )] | length == $expected' \
    "$TMP_ROOT/runtime-state-snapshot.json" >/dev/null
}

# The placement and Runtime status come from the rows TeamHub keeps: the
# registration's placement, its Runtime assignment, and the Computer's
# reported Runtime diagnostics.
agent_placement_identity() {
  local agent_id=$1
  fixture_api GET "/v0/agent-runtime/config?agent_id=$agent_id" >"$TMP_ROOT/placement-config.json"
  fixture_api GET /v0/agent-runtime/assignments >"$TMP_ROOT/placement-assignments.json"
  jq -S -n \
    --arg agent "$agent_id" \
    --slurpfile config "$TMP_ROOT/placement-config.json" \
    --slurpfile assignments "$TMP_ROOT/placement-assignments.json" \
    '{
      agentId: $agent,
      computerId: $config[0].runtime.placement.computer_id,
      runtimeType: $config[0].runtime.placement.runtime_type,
      registrationId: ([$assignments[0].assignments[] | select(.agent_management_id == $agent)][0].registration_id)
    }'
}

wait_for_agent_runtime_status() {
  local agent_id=$1
  local expected_status=$2
  local expected_error_code=${3:-}
  fixture_api GET "/v0/agent-runtime/config?agent_id=$agent_id" >"$TMP_ROOT/runtime-status-config.json"
  for _ in {1..400}; do
    if fixture_api GET /v0/agent-runtime/local-computers \
      >"$TMP_ROOT/runtime-status.json" 2>/dev/null &&
      jq -e \
        --slurpfile config "$TMP_ROOT/runtime-status-config.json" \
        --arg status "$expected_status" \
        --arg error_code "$expected_error_code" \
        '$config[0].runtime.placement as $placement
         | [.computers[] | select(.computer_id == $placement.computer_id)][0] as $computer
         | [$computer.runtime_diagnostics[]? | select((.type // .runtime) == $placement.runtime_type)][0] as $diagnostic
         | $computer.status == "online"
           and $diagnostic.status == $status
           and (($diagnostic.error.code // "") == $error_code)' \
        "$TMP_ROOT/runtime-status.json" >/dev/null; then
      return 0
    fi
    sleep 0.05
  done
  printf 'Agent %s did not reach Runtime status %s\n' "$agent_id" "$expected_status" >&2
  return 1
}

wait_for_two_unacknowledged_run_events() {
  local output_file=$1
  for _ in {1..240}; do
    if node - "$TMP_ROOT/computer-state/operations.sqlite" "$output_file" <<'NODE'
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(process.argv[2], { readOnly: true });
const rows = database
  .prepare(`
	    SELECT operation_id,last_emitted_seq
	    FROM operations
	    WHERE last_emitted_seq > last_acked_seq
    ORDER BY operation_id
  `)
  .all()
  .map(({ operation_id, last_emitted_seq }) => ({ operation_id, last_emitted_seq }));
database.close();
if (rows.length !== 2) {
  process.exit(1);
}
writeFileSync(process.argv[3], JSON.stringify(rows));
NODE
    then
      return 0
    fi
    sleep 0.025
  done
  printf 'Two unacknowledged run events were not observed\n' >&2
  return 1
}

wait_for_replayed_event_acknowledgements() {
  local expected_file=$1
  for _ in {1..240}; do
    if node - "$TMP_ROOT/computer-state/operations.sqlite" "$expected_file" <<'NODE'
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const expected = JSON.parse(readFileSync(process.argv[3], "utf8"));
const database = new DatabaseSync(process.argv[2], { readOnly: true });
const statement = database.prepare(`
  SELECT last_acked_seq FROM operations WHERE operation_id = ?
`);
const acknowledged = expected.every(({ operation_id, last_emitted_seq }) => {
  const row = statement.get(operation_id);
  return row && row.last_acked_seq >= last_emitted_seq;
});
database.close();
process.exit(acknowledged ? 0 : 1);
NODE
    then
      return 0
    fi
    sleep 0.025
  done
  printf 'Replayed run events were not cumulatively acknowledged\n' >&2
  return 1
}

api() {
  local method=$1
  local request_path=$2
  local args=(
    --fail-with-body --silent --show-error
    --max-time 10
    -X "$method"
    "http://127.0.0.1:$AGENT_PORT$request_path"
    -H "Authorization: Bearer $NODE_SERVICES_TOKEN"
  )
  curl "${args[@]}" || {
    local exit_code=$?
    printf 'Smoke HTTP failed: %s %s\n' "$method" "$request_path" >&2
    return "$exit_code"
  }
}

# Calls the TeamHub fixture as the Agent Service does.
fixture_api() {
  local method=$1
  local request_path=$2
  curl --fail-with-body --silent --show-error \
    --max-time 10 \
    -X "$method" \
    "http://127.0.0.1:$CALLBACK_PORT$request_path" \
    -H "Authorization: Bearer $SERVICE_TOKEN"
}

# TeamHub revokes the registration in one transaction and then notifies the
# Agent Service; repeating the notification is harmless.
revoke_agent() {
  local agent_id=$1
  fixture_api DELETE "/__test__/runtime-configs/$agent_id" >/dev/null
  api POST "/v1/agents/$agent_id/registration-changes" >/dev/null
  api POST "/v1/agents/$agent_id/registration-changes" >/dev/null
}

computer() {
  "$ROOT/apps/computer/dist/cli/linger-computer" "$@" --config "$CONFIG"
}

# Register the Computer as production does: TeamHub's enrollment exchange
# records it at credential generation 0 and signs its Runner credential with
# the `runner-signing` key derived from the seed. The fixture plays TeamHub.
enroll_computer() {
  local display_name=$1
  COMPUTER_ID="computer_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
  curl --fail --silent --show-error --max-time 10 \
    -X POST "http://127.0.0.1:$CALLBACK_PORT/__test__/local-computers" \
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

verify_offline_agent_removal() {
  local agent_id=$1
  # Product deletion succeeds while the old identity is offline. Its retained
  # Runner tombstone must still clean up the real Daemon on the next connection.
  revoke_agent "$agent_id"
  SHELL="$LOGIN_SHELL_FIXTURE" \
  computer daemon start >"$TMP_ROOT/daemon-after-offline-delete.log" 2>&1
  DAEMON_PID="$(computer daemon status --json | jq -er '.daemon.pid')"
  wait_for_gateway_ready
  for attempt in {1..160}; do
    computer daemon runners --json >"$TMP_ROOT/runners-after-offline-delete.json"
    if jq -e --arg agent "$agent_id" \
      'any(.runners[]; .agent_id == $agent and .state == "removed" and .pid == null)' \
      "$TMP_ROOT/runners-after-offline-delete.json" >/dev/null; then
      break
    fi
    if [[ "$attempt" == 160 ]]; then
      printf 'Offline Agent removal did not reconcile on reconnect\n' >&2
      exit 1
    fi
    sleep 0.05
  done
  computer daemon stop >/dev/null
  wait_for_pid_exit "$DAEMON_PID"
  DAEMON_PID=""
}

agent_registration_body() {
  local name=$1
  local grant_id=$2
  local runtime_type=${3:-codex}
  local agent_id=${4:-agent-local-smoke}
  jq -cn \
    --arg tenant "$TENANT_ID" \
    --arg owner "$OWNER_ACTOR_ID" \
    --arg name "$name" \
    --arg computer "$COMPUTER_ID" \
    --arg grant "$grant_id" \
    --arg runtime_type "$runtime_type" \
    --arg agent_id "$agent_id" \
    '{
      tenantId: $tenant,
      agentId: $agent_id,
      revision: "1",
      agent: {name: $name, instructions: "Reply to incoming Room messages."},
      runtime: {
        type: "codex",
        model: ($runtime_type + "-default"),
        reasoningEffort: "medium",
        placement: {
          type: "local",
          tenantId: $tenant,
          ownerActorId: $owner,
          computerId: $computer,
          runtimeType: $runtime_type,
          workspaceGrantId: $grant
        }
      },
      resources: {skills: [], mcpServers: []}
    }'
}

publish_runtime_config() {
  local registration=$1
  curl --fail-with-body --silent --show-error \
    --max-time 10 \
    -X POST \
    "http://127.0.0.1:$CALLBACK_PORT/__test__/runtime-configs" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn --argjson registration "$registration" '{registration: $registration}')" \
    >/dev/null
}

deliver_message() {
  local agent_id=$1
  local message_id=$2
  local text=$3
  append_context_message "$message_id" "$text" "actor-$agent_id"
  publish_inbox_state 2 "actor-$agent_id"
}

send_inbox_wake() {
  # A wake is only a hint. The caller commits Inbox state below; the later
  # exact Run/Operation assertions prove dispatch and duplicate suppression.
  curl --fail-with-body --silent --show-error --max-time 10 -X POST \
    "http://127.0.0.1:$CALLBACK_PORT/__test__/inbox-wake" \
    -H "Authorization: Bearer $SERVICE_TOKEN" -H 'Content-Type: application/json' --data '{}'
}

command -v jq >/dev/null
command -v curl >/dev/null
CALLBACK_PORT="$(free_port)"
AGENT_PORT="$(free_port)"
PROXY_PORT="$(free_port)"
cd "$ROOT"

printf 'Building Local Runner process boundaries...\n'
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

cat >"$CODEX_FIXTURE" <<EOF
#!/usr/bin/env bash
if [[ "\$PWD" == "$TMP_ROOT"/* ]]; then
  printf 'Local Runner smoke user workspace\n' > .issue159-smoke-workspace
fi
exec "$(command -v node)" \
  "$ROOT/scripts/test-fixtures/codex-app-server-fixture.mjs" \
  "\$@" \
  --persist-threads \
  --empty-thread-history \
  --always-delay \
  --pid-dir "$RUNTIME_PID_DIR" \
  --completion-delay-ms 4000 \
  --post-delta-delay-ms 4000 \
  --workspace-marker .issue159-smoke-workspace
EOF
cat >"$CLAUDE_FIXTURE" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.1.282 (Claude Code fixture)\n'
  exit 0
fi
if [[ "\$PWD" == "$TMP_ROOT"/* ]]; then
  printf 'Local Runner smoke user workspace\n' > .issue159-smoke-workspace
fi
exec "$(command -v node)" \
  "$ROOT/scripts/test-fixtures/claude-runtime-auth-fixture.mjs" \
  --linger-login-marker "$CLAUDE_LOGIN_MARKER" \
  --linger-workspace-marker .issue159-smoke-workspace \
  "\$@"
EOF
chmod 0700 "$CODEX_FIXTURE" "$CLAUDE_FIXTURE"
cat >"$LOGIN_SHELL_FIXTURE" <<'EOF'
#!/bin/sh
printf 'profile startup noise\n'
exec /bin/sh -c "$2"
EOF
chmod 0700 "$LOGIN_SHELL_FIXTURE"
touch "$CLAUDE_LOGIN_MARKER"

node "$ROOT/apps/node-services/tests/agent/fixtures/teamhub-callback-fixture.mjs" \
  --port "$CALLBACK_PORT" \
  --output-file "$CALLBACK_LOG" \
  --ready-file "$TMP_ROOT/callback.ready" \
  --service-token "$SERVICE_TOKEN" \
  --tenant-id "$TENANT_ID" \
  --inbox-state-file "$TMP_ROOT/inbox-state.json" \
  >"$TMP_ROOT/callback.log" 2>&1 &
CALLBACK_PID=$!
wait_for_file "$TMP_ROOT/callback.ready"
wait_for_http "http://127.0.0.1:$CALLBACK_PORT/health"

node "$ROOT/apps/node-services/tests/agent/fixtures/runner-gateway-proxy.mjs" \
  --listen-port "$PROXY_PORT" \
  --target-port "$AGENT_PORT" \
  --ready-file "$TMP_ROOT/proxy.ready" \
  --events-file "$PROXY_EVENTS" \
  >"$TMP_ROOT/proxy.log" 2>&1 &
PROXY_PID=$!
wait_for_file "$TMP_ROOT/proxy.ready"

TEAMHUB_BASE_URL="http://127.0.0.1:$CALLBACK_PORT" \
LINGER_SECRET_SEED="$SECRET_SEED" \
NODE_SERVICES_ROLES="agent" NODE_SERVICES_HTTP_ADDRESS="127.0.0.1:$AGENT_PORT" \
AGENT_HOME="$TMP_ROOT/agent-home" \
AGENT_RUNNER_PUBLIC_GATEWAY_URL="ws://127.0.0.1:$AGENT_PORT/v1/runner-gateway" \
CODEX_HOME="$TMP_ROOT/agent-codex-home" \
CODEX_CLI_PATH="$CODEX_FIXTURE" \
node --conditions=linger-production \
  "$ROOT/apps/node-services/dist/main.js" \
  >"$TMP_ROOT/agent.log" 2>&1 &
AGENT_PID=$!
wait_for_http "http://127.0.0.1:$AGENT_PORT/startupz"
enroll_computer "Fixture Local Computer"

printf 'workspace-agent-a\n' >"$TMP_ROOT/workspace-a/.linger-smoke-marker"
printf 'workspace-agent-b\n' >"$TMP_ROOT/workspace-b/.linger-smoke-marker"
printf 'workspace-agent-c\n' >"$TMP_ROOT/workspace-c/.linger-smoke-marker"

jq -n \
  --arg computer "$COMPUTER_ID" \
  --arg display "Fixture Local Computer" \
  --arg gateway "ws://127.0.0.1:$PROXY_PORT/v1/runner-gateway" \
  --arg token "$RUNNER_TOKEN_FILE" \
  --arg state "$TMP_ROOT/computer-state" \
  --arg tenant "$TENANT_ID" \
  --arg workspace_a "$TMP_ROOT/workspace-a" \
  --arg workspace_b "$TMP_ROOT/workspace-b" \
  --arg workspace_c "$TMP_ROOT/workspace-c" \
  --arg codex "$CODEX_FIXTURE" \
  --arg claude "$CLAUDE_FIXTURE" \
  --arg pi "$TMP_ROOT/pi-not-installed" \
  '{
    runner_id: $computer,
    display_name: $display,
    gateway: {url: $gateway, token_file: $token},
    max_concurrent_operations: 2,
    state_directory: $state,
    runtime_paths: {codex: $codex, claude: $claude, pi: $pi},
    workspace_grants: [
      {
        grant_id: "grant-agent-a",
        tenant_id: $tenant,
        root_path: $workspace_a,
        mode: "workspace-write",
        scope: "owner"
      },
      {
        grant_id: "grant-agent-b",
        tenant_id: $tenant,
        root_path: $workspace_b,
        mode: "workspace-write",
        scope: "owner"
      },
      {
        grant_id: "grant-agent-c",
        tenant_id: $tenant,
        root_path: $workspace_c,
        mode: "workspace-write",
        scope: "owner"
      }
    ]
  }' >"$CONFIG"

SHELL="$LOGIN_SHELL_FIXTURE" \
computer daemon start >"$TMP_ROOT/computer-start.json"
DAEMON_PID="$(computer daemon status --json | jq -er '.daemon.pid')"

wait_for_gateway_ready
computer daemon status --json | jq -e \
  --arg computer "$COMPUTER_ID" \
  '.daemon.computer_id == $computer and .daemon.state == "running" and .daemon.gateway_state == "connected" and .daemon.capacity == 2' \
  >/dev/null
wait_for_runtime_inventory

fixture_api GET /v0/agent-runtime/local-computers | jq -e \
  --arg computer "$COMPUTER_ID" \
  '.computers | length == 1 and .[0].computer_id == $computer and ([.[0].workspace_grants[] | .grant_id // .grantId] | sort) == (["grant-agent-a", "grant-agent-b", "grant-agent-c"] | sort)' \
  >/dev/null

AGENT_C_BODY="$(agent_registration_body "Local Claude Reviewer" "grant-agent-c" "claude" "agent-local-c")"
# Creating an Agent only writes its TeamHub registration; the Agent Service
# reads it and prepares the Runner at the first Run.
publish_runtime_config "$AGENT_C_BODY"
AGENT_C="$(jq -er '.agentId' <<<"$AGENT_C_BODY")"
publish_inbox_state 2 "actor-$AGENT_C"
wait_for_agent_runtime_status \
  "$AGENT_C" \
  ready
deliver_message \
  "$AGENT_C" \
  "smoke-message-c-warmup" \
  "warm up the Claude Agent through a direct mention" \
  >"$TMP_ROOT/delivery-c-warmup.json"
jq -e \
  '.published == true' \
  "$TMP_ROOT/delivery-c-warmup.json" >/dev/null
append_context_message \
  "smoke-message-c-warmup" \
  "warm up the Claude Agent through a direct mention"
publish_inbox_state 3 "actor-$AGENT_C"
wait_for_agent_activation "$AGENT_C"
if [[ "${LOCAL_RUNNER_SMOKE_SCENARIO:-full}" == "offline-agent-removal" ]]; then
  computer daemon stop >/dev/null
  wait_for_pid_exit "$DAEMON_PID"
  DAEMON_PID=""
  verify_offline_agent_removal "$AGENT_C"
  printf 'Local Runner offline Agent removal smoke passed: TeamHub revocation, repeated registration-change notice, and Daemon reconnect cleanup.\n'
  exit 0
fi
wait_for_run_receipt_terminal \
  "$AGENT_C" \
  1 \
  1

DAEMON_PID_BEFORE_LOGIN="$(computer daemon status --json | jq -er '.daemon.pid')"
node - "$TMP_ROOT/computer-state/operations.sqlite" "$TMP_ROOT/auth-operation-baseline.json" <<'NODE'
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(process.argv[2], { readOnly: true });
const counts = Object.entries(
  database.prepare("SELECT terminal_event_json FROM operations WHERE status='terminal'").all()
    .map(({ terminal_event_json }) => JSON.parse(
      typeof terminal_event_json === "string"
        ? terminal_event_json
        : Buffer.from(terminal_event_json).toString("utf8"),
    ).payload?.type)
    .map((type) => type === "run" ? "run.start" : type)
    .filter((kind) => kind === "run.start")
    .reduce((result, kind) => ({ ...result, [kind]: (result[kind] ?? 0) + 1 }), {}),
).sort(([left], [right]) => left.localeCompare(right));
database.close();
writeFileSync(process.argv[3], JSON.stringify(counts));
NODE
curl --fail-with-body --silent --show-error \
  --max-time 10 \
  "http://127.0.0.1:$CALLBACK_PORT/__test__/retired-invocation-requests" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  >"$TMP_ROOT/auth-retired-invocation-baseline.json"
rm "$CLAUDE_LOGIN_MARKER"
for _ in {1..400}; do
  if computer daemon status --json 2>/dev/null | jq -e \
    'any(.runtimes[]; .type == "claude" and .status == "authentication_required")' \
    >/dev/null; then
    break
  fi
  sleep 0.05
done
computer daemon status --json | jq -e \
  'any(.runtimes[]; .type == "claude" and .status == "authentication_required")' \
  >/dev/null
wait_for_agent_runtime_status \
  "$AGENT_C" \
  authentication_required \
  RUNTIME_AUTHENTICATION_REQUIRED
send_inbox_wake >"$TMP_ROOT/delivery-c-auth-pending.json"
jq -e \
  '.published == true' \
  "$TMP_ROOT/delivery-c-auth-pending.json" >/dev/null
append_context_message \
  "smoke-message-c-auth-pending" \
  "wait for login and then run" \
  "actor-$AGENT_C"
publish_inbox_state 4 "actor-$AGENT_C"
wait_for_local_run_terminal "$AGENT_C" failed
wait_for_authentication_runtime_fence "$AGENT_C"
assert_run_receipt_count "$AGENT_C" 1 1
curl --fail-with-body --silent --show-error \
  --max-time 10 \
  "http://127.0.0.1:$CALLBACK_PORT/__test__/retired-invocation-requests" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  >"$TEAMHUB_FIXTURE_STATE"
# Local Runs must not restore TeamHub Invocation admission.
jq -e \
  --slurpfile baseline "$TMP_ROOT/auth-retired-invocation-baseline.json" \
  '.count == $baseline[0].count' \
  "$TEAMHUB_FIXTURE_STATE" >/dev/null
node - "$TMP_ROOT/computer-state/operations.sqlite" "$TMP_ROOT/auth-operation-baseline.json" <<'NODE'
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(process.argv[2], { readOnly: true });
const counts = Object.entries(
  database.prepare("SELECT terminal_event_json FROM operations WHERE status='terminal'").all()
    .map(({ terminal_event_json }) => JSON.parse(
      typeof terminal_event_json === "string"
        ? terminal_event_json
        : Buffer.from(terminal_event_json).toString("utf8"),
    ).payload?.type)
    .map((type) => type === "run" ? "run.start" : type)
    .filter((kind) => kind === "run.start")
    .reduce((result, kind) => ({ ...result, [kind]: (result[kind] ?? 0) + 1 }), {}),
).sort(([left], [right]) => left.localeCompare(right));
database.close();
const baseline = JSON.parse(readFileSync(process.argv[3], "utf8"));
if (JSON.stringify(counts) !== JSON.stringify(baseline)) {
  throw new Error("Runtime authentication failure started a Run Operation");
}
NODE

touch "$CLAUDE_LOGIN_MARKER"
wait_for_agent_runtime_status "$AGENT_C" ready
computer daemon status --json | jq -e \
  --argjson daemon_pid "$DAEMON_PID_BEFORE_LOGIN" \
  '.daemon.pid == $daemon_pid
   and any(.runtimes[]; .type == "claude" and .status == "ready")' \
  >/dev/null
send_inbox_wake >"$TMP_ROOT/delivery-c-auth-recovered.json"
jq -e \
  '.published == true' \
  "$TMP_ROOT/delivery-c-auth-recovered.json" >/dev/null
append_context_message \
  "smoke-message-c-auth-recovered" \
  "authentication recovered; run now" \
  "actor-$AGENT_C"
publish_inbox_state 5 "actor-$AGENT_C"
wait_for_local_run_terminal \
  "$AGENT_C" \
  succeeded \
  "fixture complete:Local Runner smoke user workspace"
wait_for_run_receipt_terminal \
  "$AGENT_C" \
  2 \
  1

# Exercise the in-place upgrade boundary: the installed bundle changes outside
# this smoke, while the Daemon restarts against the same persisted identity.
agent_placement_identity "$AGENT_C" >"$TMP_ROOT/agent-c-before-upgrade.identity.json"
computer daemon stop >/dev/null
wait_for_pid_exit "$DAEMON_PID"
DAEMON_PID=""
SHELL="$LOGIN_SHELL_FIXTURE" \
computer daemon start >"$TMP_ROOT/computer-after-upgrade.json"
DAEMON_PID="$(computer daemon status --json | jq -er '.daemon.pid')"
wait_for_gateway_connection_count 2
wait_for_gateway_ready
computer daemon status --json | jq -e \
  --arg computer "$COMPUTER_ID" \
  '.daemon.computer_id == $computer
   and .daemon.state == "running"
   and .daemon.gateway_state == "connected"' \
  >/dev/null
agent_placement_identity "$AGENT_C" >"$TMP_ROOT/agent-c-after-upgrade.identity.json"
jq -e \
  --arg agent "$AGENT_C" \
  --arg computer "$COMPUTER_ID" \
  '.agentId == $agent and .computerId == $computer' \
  "$TMP_ROOT/agent-c-after-upgrade.identity.json" >/dev/null
cmp \
  "$TMP_ROOT/agent-c-before-upgrade.identity.json" \
  "$TMP_ROOT/agent-c-after-upgrade.identity.json"
fixture_api GET /v0/agent-runtime/local-computers | jq -e \
  --arg computer "$COMPUTER_ID" \
  '.computers | length == 1
   and .[0].computer_id == $computer
   and .[0].status == "online"' \
  >/dev/null
send_inbox_wake >"$TMP_ROOT/delivery-c-after-upgrade.json"
append_context_message \
  "smoke-message-c-after-upgrade" \
  "run after the in-place Computer upgrade" \
  "actor-$AGENT_C"
publish_inbox_state 6 "actor-$AGENT_C"
wait_for_local_run_terminal \
  "$AGENT_C" \
  succeeded \
  "fixture complete:Local Runner smoke user workspace" \
  2
wait_for_run_receipt_terminal \
  "$AGENT_C" \
  1 \
  2

# Keep the existing two-Agent replay assertions scoped to their own callbacks.
: >"$CALLBACK_LOG"

AGENT_A_BODY="$(agent_registration_body "Local Reviewer A" "grant-agent-a" "codex" "agent-local-a")"
AGENT_B_BODY="$(agent_registration_body "Local Reviewer B" "grant-agent-b" "codex" "agent-local-b")"
publish_runtime_config "$AGENT_A_BODY"
publish_runtime_config "$AGENT_B_BODY"
AGENT_A="$(jq -er '.agentId' <<<"$AGENT_A_BODY")"
AGENT_B="$(jq -er '.agentId' <<<"$AGENT_B_BODY")"
# This fixture starts a fresh Room history phase for the two-Agent replay case.
# Agent C is revoked before the cursor reset, so no active subscription observes
# a backwards cursor. The live-provider smoke keeps a separate fixture Inbox history.
printf '[]\n' >"$INBOX_MESSAGES"
publish_inbox_state \
  7 \
  "actor-$AGENT_A" \
  "actor-$AGENT_B"

send_inbox_wake >"$TMP_ROOT/delivery-a.json" &
DELIVERY_A_PID=$!
send_inbox_wake >"$TMP_ROOT/delivery-b.json" &
DELIVERY_B_PID=$!
wait "$DELIVERY_A_PID"
wait "$DELIVERY_B_PID"
send_inbox_wake >"$TMP_ROOT/delivery-a-replay.json"

append_context_message "smoke-message-a" "run the smoke" "actor-$AGENT_A"
append_context_message "smoke-message-b" "run the smoke" "actor-$AGENT_B"
publish_inbox_state \
  8 \
  "actor-$AGENT_A" \
  "actor-$AGENT_B"

jq -e '.published == true' "$TMP_ROOT/delivery-a.json" >/dev/null
jq -e '.published == true' "$TMP_ROOT/delivery-b.json" >/dev/null
jq -e '.published == true' "$TMP_ROOT/delivery-a-replay.json" >/dev/null

wait_for_two_running_runs "$TMP_ROOT/runs-before-reconnect.json"
kill -USR2 "$PROXY_PID"
wait_for_proxy_event "block_agent_to_daemon"
wait_for_two_unacknowledged_run_events "$TMP_ROOT/unacknowledged-run-events.json"
node - \
  "$TMP_ROOT/computer-state/operations.sqlite" \
  "$TMP_ROOT/unacknowledged-run-events.json" \
  "$TMP_ROOT/runs-during-disconnect.owners" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const expected = JSON.parse(readFileSync(process.argv[3], "utf8"));
const database = new DatabaseSync(process.argv[2], { readOnly: true });
const statement = database.prepare(
  "SELECT identity_json FROM operations WHERE operation_id=?",
);
const owners = expected.map(({ operation_id }) => {
  const row = statement.get(operation_id);
  if (!row) throw new Error(`Missing retained Operation ${operation_id}`);
  const encoded = typeof row.identity_json === "string"
    ? row.identity_json
    : Buffer.from(row.identity_json).toString("utf8");
  return { agent_id: JSON.parse(encoded).agent_id, operation_id };
}).sort((left, right) => left.operation_id.localeCompare(right.operation_id));
database.close();
writeFileSync(process.argv[4], JSON.stringify(owners));
NODE
cmp \
  "$TMP_ROOT/runs-before-reconnect.json.owners" \
  "$TMP_ROOT/runs-during-disconnect.owners"
kill -USR1 "$PROXY_PID"
wait_for_gateway_connection_count 3
wait_for_gateway_ready
wait_for_replayed_event_acknowledgements "$TMP_ROOT/unacknowledged-run-events.json"
wait_for_local_run_terminal \
  "$AGENT_A" \
  succeeded \
  "fixture complete:Local Runner smoke user workspace"
wait_for_local_run_terminal \
  "$AGENT_B" \
  succeeded \
  "fixture complete:Local Runner smoke user workspace"
wait_for_run_receipt_terminal \
  "$AGENT_A" \
  1 \
  2
wait_for_run_receipt_terminal \
  "$AGENT_B" \
  1 \
  2

computer daemon runners --json | jq -e \
  '.runners | length == 3 and all(.[]; .state == "ready" and .active_operation_id == null)' \
  >/dev/null

node - "$TMP_ROOT/computer-state/operations.sqlite" <<'NODE'
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(process.argv[2], { readOnly: true });
const rows = Object.entries(
  database.prepare("SELECT terminal_event_json FROM operations WHERE status='terminal'").all()
    .map(({ terminal_event_json }) => JSON.parse(
      typeof terminal_event_json === "string"
        ? terminal_event_json
        : Buffer.from(terminal_event_json).toString("utf8"),
    ).payload?.type)
    .map((type) => type === "run" ? "run.start" : type)
    .reduce((result, kind) => ({ ...result, [kind]: (result[kind] ?? 0) + 1 }), {}),
).map(([kind, count]) => ({ kind, count })).sort((left, right) => left.kind.localeCompare(right.kind));
database.close();
const expected = [{ kind: "run.start", count: 5 }];
if (JSON.stringify(rows) !== JSON.stringify(expected)) {
  throw new Error(`Unexpected operation ledger: ${JSON.stringify(rows)}`);
}
NODE

send_inbox_wake >"$TMP_ROOT/hold-a.json" &
HOLD_A_DELIVERY_PID=$!
send_inbox_wake >"$TMP_ROOT/hold-b.json" &
HOLD_B_DELIVERY_PID=$!
wait "$HOLD_A_DELIVERY_PID"
wait "$HOLD_B_DELIVERY_PID"
append_context_message "smoke-hold-a" "[hold] local runner CLI cancellation" "actor-$AGENT_A"
append_context_message "smoke-hold-b" "[hold] Agent desired-state cancellation" "actor-$AGENT_B"
publish_inbox_state \
  9 \
  "actor-$AGENT_A" \
  "actor-$AGENT_B"
wait_for_two_running_runs "$TMP_ROOT/held-runs.json"

computer daemon runners stop "$AGENT_A" --json | jq -e \
  --arg agent_id "$AGENT_A" \
  '.runner.agent_id == $agent_id and .runner.state == "paused"' \
  >/dev/null

computer daemon runners stop "$AGENT_B" --json | jq -e \
  --arg agent_id "$AGENT_B" \
  '.runner.agent_id == $agent_id and .runner.state == "paused"' \
  >/dev/null
wait_for_runtime_pids_exit
RECORDED_DAEMON_PID="$(computer daemon status --json | jq -er '.daemon.pid')"
computer daemon stop >/dev/null
wait_for_pid_exit "$DAEMON_PID"
DAEMON_PID=""
if kill -0 "$RECORDED_DAEMON_PID" 2>/dev/null; then
  printf 'Daemon PID %s is still alive\n' "$RECORDED_DAEMON_PID" >&2
  exit 1
fi

verify_offline_agent_removal "$AGENT_A"

while IFS= read -r pid_file; do
  runtime_pid="$(basename "$pid_file" .pid)"
  if kill -0 "$runtime_pid" 2>/dev/null; then
    printf 'Runtime PID %s is still alive\n' "$runtime_pid" >&2
    exit 1
  fi
done < <(find "$RUNTIME_PID_DIR" -type f -name '*.pid' -print)

if find "$TMP_ROOT/computer-state/runner-processes" -type f -name '*.json' -print -quit 2>/dev/null | grep -q .; then
  printf 'Runner ownership records remain after shutdown\n' >&2
  exit 1
fi

printf 'Local Runner smoke passed: Execution Context Local Runs, in-place Computer identity preservation, Claude authentication block/recovery without restart, 3 Agent Runners, Codex reconnect/replay, duplicate suppression, CLI Runner stop, offline Agent deletion/reconnect cleanup, and complete process cleanup.\n'
