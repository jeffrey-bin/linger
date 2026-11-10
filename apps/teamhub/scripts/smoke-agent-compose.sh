#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)
source "$script_dir/lib/compose-cleanup.sh"
compose_file="$repo_root/deployments/compose/docker-compose.yml"
project_name=${TEAMHUB_SMOKE_PROJECT:-teamhub-agent-smoke}
http_port=${TEAMHUB_SMOKE_HTTP_PORT:-18082}
postgres_port=${TEAMHUB_SMOKE_POSTGRES_PORT:-54352}
agent_port=${TEAMHUB_SMOKE_AGENT_PORT:-18092}

if [[ ! $project_name =~ ^teamhub-[a-z0-9-]*smoke[a-z0-9-]*$ ]]; then
	printf 'FAIL: TEAMHUB_SMOKE_PROJECT must be an isolated teamhub-*smoke* project name\n' >&2
	exit 2
fi
for port in "$http_port" "$postgres_port" "$agent_port"; do
	if [[ ! $port =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
		printf 'FAIL: smoke ports must be integers in 1..65535\n' >&2
		exit 2
	fi
done

base_url="http://127.0.0.1:$http_port"
agent_url="http://127.0.0.1:$agent_port"
database_url="postgres://teamhub:teamhub@127.0.0.1:$postgres_port/teamhub?sslmode=disable"
secret_seed=agent-smoke-secret-seed-0123456789abcdef
# TeamHub derives the Agent Service credential from the seed.
# service_token calls TeamHub as the Agent Service; node_services_token is what
# TeamHub presents to the Agent Service stub.
service_token=$(node -e 'const { hkdfSync } = require("node:crypto"); process.stdout.write(Buffer.from(hkdfSync("sha256", process.argv[1], "simplexai/service-credential/v1", "teamhub-internal", 32)).toString("base64url"));' "$secret_seed")
node_services_token=$(node -e 'const { hkdfSync } = require("node:crypto"); process.stdout.write(Buffer.from(hkdfSync("sha256", process.argv[1], "simplexai/service-credential/v1", "node-services-internal", 32)).toString("base64url"));' "$secret_seed")
agent_management_id=agent-smoke-reviewer
work_dir=$(mktemp -d)
compose=(docker compose -p "$project_name" -f "$compose_file")
teamhub_pid=
stub_pid=

export TEAMHUB_POSTGRES_PORT=$postgres_port

stop_process() {
	local pid=${1:-}
	if [[ -z $pid ]]; then
		return
	fi
	if kill -0 "$pid" >/dev/null 2>&1; then
		kill "$pid" >/dev/null 2>&1 || true
		for ((attempt = 0; attempt < 20; attempt++)); do
			if ! kill -0 "$pid" >/dev/null 2>&1; then
				break
			fi
			sleep 0.1
		done
		if kill -0 "$pid" >/dev/null 2>&1; then
			kill -KILL "$pid" >/dev/null 2>&1 || true
		fi
	fi
	wait "$pid" >/dev/null 2>&1 || true
}

cleanup() {
	stop_process "$teamhub_pid"
	stop_process "$stub_pid"
	if [[ ${TEAMHUB_SMOKE_KEEP_COMPOSE:-0} != 1 ]]; then
		cleanup_isolated_compose_project "$project_name" "$compose_file" >/dev/null 2>&1 || true
	fi
	rm -rf -- "$work_dir"
}
trap cleanup EXIT

fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

pass() {
	printf 'PASS: %s\n' "$*"
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

request() {
	local expected=$1
	local output=$2
	local headers=$3
	shift 3
	local status
	status=$(curl --silent --show-error --connect-timeout 5 --max-time 30 --dump-header "$headers" --output "$output" --write-out '%{http_code}' "$@")
	if [[ $status != "$expected" ]]; then
		printf 'Unexpected HTTP response: expected=%s actual=%s\n' "$expected" "$status" >&2
		printf 'Response body:\n' >&2
		cat "$output" >&2
		exit 1
	fi
}

assert_json() {
	local file=$1
	local description=$2
	shift 2
	jq -e "$@" "$file" >/dev/null || fail "$description"
}

assert_replay_header() {
	local headers=$1
	tr -d '\r' <"$headers" | awk 'BEGIN { found=0 } tolower($0)=="idempotent-replay: true" { found=1 } END { exit found ? 0 : 1 }' || fail 'Idempotent-Replay header is missing'
}

require_teamhub_id() {
	[[ $1 =~ ^[a-z_]+[a-f0-9]{32}$ ]] || fail "unsafe TeamHub identifier: $1"
}

wait_for_service() {
	local url=$1
	local pid=$2
	local log_file=$3
	for ((attempt = 0; attempt < 80; attempt++)); do
		if curl --silent --fail --connect-timeout 1 --max-time 2 "$url/healthz" >/dev/null; then
			return
		fi
		if ! kill -0 "$pid" >/dev/null 2>&1; then
			cat "$log_file" >&2
			fail "service exited before becoming healthy: $url"
		fi
		sleep 0.25
	done
	cat "$log_file" >&2
	fail "service did not become healthy: $url"
}

start_teamhub() {
	local registry_mode=$1
	local log_file="$work_dir/teamhub-$registry_mode.log"
	local -a environment=(
		"TEAMHUB_DATABASE_URL=$database_url"
		"TEAMHUB_HTTP_ADDRESS=127.0.0.1:$http_port"
		"TEAMHUB_ARTIFACT_STORAGE_ROOT=$work_dir/artifacts"
		"LINGER_SECRET_SEED=$secret_seed"
	)
	if [[ $registry_mode == configured ]]; then
		environment+=("TEAMHUB_NODE_SERVICES_URL=$agent_url")
	fi
	env "${environment[@]}" "$work_dir/teamhub" >"$log_file" 2>&1 &
	teamhub_pid=$!
	wait_for_service "$base_url" "$teamhub_pid" "$log_file"
}

db_scalar() {
	local query=$1
	"${compose[@]}" exec -T postgres psql -U teamhub -d teamhub -At -c "$query"
}

require_command curl
require_command docker
require_command go
require_command jq
require_command node
require_command cmp

cd "$repo_root"

run_tag="$(date +%Y%m%d%H%M%S)-$$"
alice_cookie="$work_dir/alice.cookie"
empty_headers="$work_dir/headers"
registration_key="smoke-agent-registration-$run_tag"
model_id='openai/gpt-5.4'
agent_payload=$(jq -nc --arg model "$model_id" '{name:"Smoke Reviewer",instructions:"Review the Room conversation.",runtime:{model:$model}}')

printf 'Starting Agent smoke with isolated project %s\n' "$project_name"
cleanup_isolated_compose_project "$project_name" "$compose_file" >/dev/null 2>&1 || true
"${compose[@]}" up -d --wait postgres

go build -trimpath -o "$work_dir/teamhub" ./cmd/teamhub
go build -trimpath -o "$work_dir/migrate" ./cmd/migrate
go build -trimpath -o "$work_dir/demo-seed" ./cmd/demo-seed
go build -trimpath -o "$work_dir/agent-smoke-stub" ./cmd/agent-smoke-stub

TEAMHUB_DATABASE_URL="$database_url" "$work_dir/migrate"

TEAMHUB_DATABASE_URL="$database_url" \
	TEAMHUB_SEED_DEVELOPMENT_DATA=true \
	TEAMHUB_DEMO_IDENTITIES_ONLY=true \
	"$work_dir/demo-seed"

TEAMHUB_AGENT_SMOKE_ADDRESS="127.0.0.1:$agent_port" \
	TEAMHUB_AGENT_SMOKE_TOKEN="$node_services_token" \
	TEAMHUB_AGENT_SMOKE_AGENT_ID="$agent_management_id" \
	TEAMHUB_AGENT_SMOKE_LOG="$work_dir/agent-requests.jsonl" \
	"$work_dir/agent-smoke-stub" >"$work_dir/agent-stub.log" 2>&1 &
stub_pid=$!
wait_for_service "$agent_url" "$stub_pid" "$work_dir/agent-stub.log"
start_teamhub configured

request 200 "$work_dir/alice-login.json" "$empty_headers" \
	-X POST -H 'Content-Type: application/json' \
	-d '{"identifier":"alice@example.com","password":"teamhub-dev-alice"}' \
	-c "$alice_cookie" "$base_url/v0/auth/login"
pass 'Human can log in to the real TeamHub process'

request 201 "$work_dir/agent.json" "$work_dir/agent.headers" \
	-X POST -b "$alice_cookie" -H 'Content-Type: application/json' \
	-H "Idempotency-Key: $registration_key" -d "$agent_payload" \
	"$base_url/v0/tenants/tenant_acme/agents"
actor_id=$(jq -er '.actor.id' "$work_dir/agent.json")
returned_agent_id=$(jq -er '.agent_management_id' "$work_dir/agent.json")
require_teamhub_id "$actor_id"
[[ $returned_agent_id == "$agent_management_id" ]] || fail 'TeamHub did not persist the AgentManagement ID'

request 201 "$work_dir/agent-replay.json" "$work_dir/agent-replay.headers" \
	-X POST -b "$alice_cookie" -H 'Content-Type: application/json' \
	-H "Idempotency-Key: $registration_key" -d "$agent_payload" \
	"$base_url/v0/tenants/tenant_acme/agents"
assert_replay_header "$work_dir/agent-replay.headers"
cmp "$work_dir/agent.json" "$work_dir/agent-replay.json" >/dev/null || fail 'Agent registration replay changed the response'
jq -se '[.[] | select(.kind == "registration")] | length == 1' "$work_dir/agent-requests.jsonl" >/dev/null || fail 'Agent replay called AgentManagement more than once'
mapping_count=$(db_scalar "select count(*) from agent_registrations where actor_id='$actor_id' and agent_management_id='$agent_management_id' and status='active'")
[[ $mapping_count == 1 ]] || fail 'Agent identity mapping was not committed'
pass 'Agent registration creates independent IDs and replays exactly once'

request 201 "$work_dir/room.json" "$empty_headers" \
	-X POST -b "$alice_cookie" -H 'Content-Type: application/json' \
	-H "Idempotency-Key: smoke-agent-room-$run_tag" \
	-d "{\"name\":\"Agent smoke $run_tag\"}" \
	"$base_url/v0/tenants/tenant_acme/rooms"
room_id=$(jq -er '.id' "$work_dir/room.json")
require_teamhub_id "$room_id"
request 200 "$work_dir/member.json" "$empty_headers" \
	-X PUT -b "$alice_cookie" -H 'Content-Type: application/json' -d '{"role":"member"}' \
	"$base_url/v0/rooms/$room_id/members/$actor_id"
pass 'Human can invite the registered Agent Actor into a Room'

request 201 "$work_dir/human-message.json" "$empty_headers" \
	-X POST -b "$alice_cookie" -H 'Content-Type: application/json' \
	-H "Idempotency-Key: smoke-agent-human-message-$run_tag" \
	-d '{"body":"Please review this smoke message."}' \
	"$base_url/v0/rooms/$room_id/messages"
human_message_id=$(jq -er '.id' "$work_dir/human-message.json")
require_teamhub_id "$human_message_id"

agent_callback_payload=$(jq -nc '{
  raw_message:"@Alice Smoke review completed.",
  segments:[
    {type:"reference",content:"@Alice",target:"actor_acme_alice",target_type:"user"},
    {type:"text",content:" Smoke review completed."}
  ]
}')
request 201 "$work_dir/agent-message.json" "$work_dir/agent-message.headers" \
	-X POST -H "Authorization: Bearer $service_token" -H 'Content-Type: application/json' \
	-H "Idempotency-Key: smoke-agent-callback-$run_tag" \
	-d "$agent_callback_payload" \
	"$base_url/v0/rooms/$room_id/agents/$agent_management_id/messages"
assert_json "$work_dir/agent-message.json" 'Agent callback author was not mapped to the TeamHub Actor' --arg actor "$actor_id" '.author.id == $actor'
assert_json "$work_dir/agent-message.json" 'Agent callback did not preserve structured content' \
	'.raw_message == "@Alice Smoke review completed." and .segments[0].type == "reference" and .segments[0].target == "actor_acme_alice"'
request 201 "$work_dir/agent-message-replay.json" "$work_dir/agent-message-replay.headers" \
	-X POST -H "Authorization: Bearer $service_token" -H 'Content-Type: application/json' \
	-H "Idempotency-Key: smoke-agent-callback-$run_tag" \
	-d "$agent_callback_payload" \
	"$base_url/v0/rooms/$room_id/agents/$agent_management_id/messages"
assert_replay_header "$work_dir/agent-message-replay.headers"
cmp "$work_dir/agent-message.json" "$work_dir/agent-message-replay.json" >/dev/null || fail 'Agent callback replay changed the response'
request 200 "$work_dir/messages.json" "$empty_headers" -b "$alice_cookie" "$base_url/v0/rooms/$room_id/messages"
assert_json "$work_dir/messages.json" 'Room does not contain exactly one Human and one Agent Message' --arg actor "$actor_id" \
	'.items | length == 2 and any(.[]; .author.id == $actor and .raw_message == "@Alice Smoke review completed." and .segments[0].type == "reference")'
pass 'Agent callback committed one idempotent Message with the mapped Actor author'

stop_process "$teamhub_pid"
teamhub_pid=
start_teamhub unavailable
request 201 "$work_dir/agent-restart-replay.json" "$work_dir/agent-restart-replay.headers" \
	-X POST -b "$alice_cookie" -H 'Content-Type: application/json' \
	-H "Idempotency-Key: $registration_key" -d "$agent_payload" \
	"$base_url/v0/tenants/tenant_acme/agents"
assert_replay_header "$work_dir/agent-restart-replay.headers"
cmp "$work_dir/agent.json" "$work_dir/agent-restart-replay.json" >/dev/null || fail 'Registration replay after restart changed the response'
request 503 "$work_dir/agent-registry-unavailable.json" "$empty_headers" \
	-X POST -b "$alice_cookie" -H 'Content-Type: application/json' \
	-H "Idempotency-Key: smoke-agent-new-after-restart-$run_tag" -d "$agent_payload" \
	"$base_url/v0/tenants/tenant_acme/agents"
assert_json "$work_dir/agent-registry-unavailable.json" 'New registration without registry did not return the expected error' '.error.code == "AGENT_REGISTRY_UNAVAILABLE"'
pass 'Persisted registration replay survives restart without AgentManagement'

printf '\nAgent Compose smoke passed.\n'
printf '  Actor: %s\n' "$actor_id"
printf '  AgentManagement ID: %s\n' "$agent_management_id"
printf '  Room: %s\n' "$room_id"
