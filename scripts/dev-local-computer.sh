#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMAND="${1:-start}"

if [[ "${LINGER_LOCAL_COMPUTER_ENV_LOADED:-0}" != "1" ]]; then
  export LINGER_LOCAL_COMPUTER_ENV_LOADED=1
  exec node "$ROOT/scripts/with-local-env.mjs" --optional -- bash "$0" "$@"
fi

DISPLAY_NAME="${LINGER_LOCAL_COMPUTER_DISPLAY_NAME:-$(hostname -s)}"
TEAMHUB_URL="${TEAMHUB_BASE_URL:-http://127.0.0.1:8080}"
OWNER_FILE="${LINGER_LOCAL_OWNER_FILE:-$ROOT/.linger-runtime/local-owner.json}"
WORKSPACE_PATH="${LINGER_LOCAL_COMPUTER_WORKSPACE:-$ROOT}"
GRANT_ID="${LINGER_LOCAL_COMPUTER_GRANT_ID:-workspace-local-dev}"
GRANT_LABEL="${LINGER_LOCAL_COMPUTER_GRANT_LABEL:-Linger Workspace}"
MAX_CONCURRENT_RUNS="${LINGER_LOCAL_COMPUTER_MAX_CONCURRENT_RUNS:-${LINGER_LOCAL_COMPUTER_CAPACITY:-}}"
STATE_DIRECTORY="${LINGER_LOCAL_COMPUTER_STATE_DIRECTORY:-$ROOT/.linger-runtime/computer}"
CONFIG_PATH="${LINGER_LOCAL_COMPUTER_CONFIG:-$STATE_DIRECTORY/config.json}"
CODEX_AUTH_FILE="${LINGER_CODEX_AUTH_FILE:-${CODEX_HOME:-$HOME/.codex}/auth.json}"
NODE_SERVICES_URL="${TEAMHUB_NODE_SERVICES_URL:-http://127.0.0.1:4319}"
AGENT_HEALTH_URL="${LINGER_LOCAL_AGENT_HEALTH_URL:-${NODE_SERVICES_URL%/}/healthz}"
# The CLI starts the Daemon built beside it in dist/daemon.
COMPUTER_CLI="${LINGER_LOCAL_COMPUTER_CLI:-$ROOT/apps/computer/dist/cli/linger-computer}"

usage() {
  cat <<'EOF'
Usage: bash scripts/dev-local-computer.sh <command> [operation-id]

Commands:
  start                 Build and start the local daemon, then wait for Gateway readiness.
  stop                  Stop the daemon and every owned Runner process.
  restart               Stop, then start the daemon.
  status                Show daemon and Gateway status.
  runtimes              List discovered local Runtime types.
  runners               List active and retained Runner operations.
  stop-runner <id>      Stop one Agent Runner by Agent ID.
  config                Register if needed, then regenerate and print the local config path.
EOF
}

require_command() {
  command -v "$1" >/dev/null || {
    printf 'Required command is unavailable: %s\n' "$1" >&2
    exit 2
  }
}

absolute_path() {
  node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$1"
}

# The Computer registers like a production server Computer: enroll as the
# local owner through TeamHub once, then reuse the stored credential. Deleting
# runner-token registers a new Computer on the next start.
ensure_registration() {
  TOKEN_FILE="$STATE_DIRECTORY/runner-token"
  local registration="$STATE_DIRECTORY/runner-registration.json"
  if [[ ! -f "$TOKEN_FILE" || ! -f "$registration" ]]; then
    node "$ROOT/scripts/register-local-computer.mjs" \
      --teamhub-url "$TEAMHUB_URL" \
      --owner-file "$OWNER_FILE" \
      --display-name "$DISPLAY_NAME" \
      --output-directory "$STATE_DIRECTORY"
  fi
  COMPUTER_ID="$(jq -er '.computer_id' "$registration")"
  TENANT_ID="$(jq -er '.tenant_id' "$registration")"
  GATEWAY_URL="$(jq -er '.gateway_url' "$registration")"
}

write_config() {
  if [[ -n "$MAX_CONCURRENT_RUNS" ]]; then
    [[ "$MAX_CONCURRENT_RUNS" =~ ^[1-9][0-9]*$ ]] &&
      ((MAX_CONCURRENT_RUNS <= 100)) || {
      printf 'LINGER_LOCAL_COMPUTER_MAX_CONCURRENT_RUNS must be an integer between 1 and 100\n' >&2
      exit 2
    }
  fi
  WORKSPACE_PATH="$(absolute_path "$WORKSPACE_PATH")"
  [[ -d "$WORKSPACE_PATH" ]] || {
    printf 'Local workspace is not a directory: %s\n' "$WORKSPACE_PATH" >&2
    exit 2
  }
  if [[ -f "$CODEX_AUTH_FILE" ]]; then
    CODEX_AUTH_FILE="$(absolute_path "$CODEX_AUTH_FILE")"
  else
    CODEX_AUTH_FILE=""
  fi
  # Pin the Runtimes LINGER_<TYPE>_PATH names; the Daemon discovers the rest.
  local runtime_paths='{}' runtime_type runtime_path
  for runtime_type in codex claude pi; do
    runtime_path="$(printenv "LINGER_$(printf '%s' "$runtime_type" | tr '[:lower:]' '[:upper:]')_PATH" || true)"
    [[ -n "$runtime_path" ]] || continue
    runtime_paths="$(jq -c --arg type "$runtime_type" --arg path "$(absolute_path "$runtime_path")" '. + {($type): $path}' <<<"$runtime_paths")"
  done
  mkdir -p "$STATE_DIRECTORY" "$(dirname "$CONFIG_PATH")"
  jq -n \
    --arg computer "$COMPUTER_ID" \
    --arg display "$DISPLAY_NAME" \
    --arg gateway "$GATEWAY_URL" \
    --arg token "$TOKEN_FILE" \
    --arg state "$STATE_DIRECTORY" \
    --arg auth "$CODEX_AUTH_FILE" \
    --arg grant "$GRANT_ID" \
    --arg grant_label "$GRANT_LABEL" \
    --arg tenant "$TENANT_ID" \
    --arg workspace "$WORKSPACE_PATH" \
    --arg max_concurrent_runs "$MAX_CONCURRENT_RUNS" \
    --argjson runtime_paths "$runtime_paths" \
    '{
      runner_id: $computer,
      display_name: $display,
      gateway: {url: $gateway, token_file: $token},
      state_directory: $state,
      runtime_paths: $runtime_paths,
      workspace_grants: [{
        grant_id: $grant,
        "label": $grant_label,
        tenant_id: $tenant,
        root_path: $workspace,
        mode: "workspace-write",
        scope: "owner"
      }]
    }
    + (if $max_concurrent_runs == "" then {} else {max_concurrent_operations: ($max_concurrent_runs | tonumber)} end)
    + (if $auth == "" then {} else {codex: {auth_file: $auth}} end)' >"$CONFIG_PATH"
  chmod 600 "$CONFIG_PATH"
}

computer() {
  "$COMPUTER_CLI" "$@" --config "$CONFIG_PATH"
}

build_computer() {
  require_command go
  local version
  version="$(jq -er '.version' "$ROOT/apps/computer/package.json")"
  local ldflags="-X github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport.ReleaseVersion=$version"
  (
    cd "$ROOT/apps/computer/local-daemon"
    CGO_ENABLED=0 go build -trimpath -ldflags "$ldflags" -o ../dist/cli/linger-computer ./cmd/linger-computer
    CGO_ENABLED=0 go build -trimpath -ldflags "$ldflags" -o ../dist/daemon/linger-computer-daemon ./cmd/linger-computer-daemon
  )
}

prepare_runtime_config() {
  require_command node
  require_command jq
  if [[ "${LINGER_LOCAL_COMPUTER_SKIP_BUILD:-0}" != "1" ]]; then
    build_computer
  fi
  STATE_DIRECTORY="$(absolute_path "$STATE_DIRECTORY")"
  CONFIG_PATH="$(absolute_path "$CONFIG_PATH")"
  ensure_registration
  write_config
}

prepare_control() {
  require_command node
  CONFIG_PATH="$(absolute_path "$CONFIG_PATH")"
  [[ -f "$CONFIG_PATH" ]] || {
    printf 'Local Computer config is unavailable: %s. Run the start or config command first.\n' "$CONFIG_PATH" >&2
    exit 2
  }
}

wait_for_gateway() {
  for _ in {1..200}; do
    if computer daemon status --json 2>/dev/null | jq -e '.daemon.gateway_state == "connected"' >/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  printf 'Local Computer did not connect to the Agent Service Runner Gateway.\n' >&2
  printf 'If TeamHub data was reset or this Computer was removed, delete %s and start again to register a new Computer.\n' \
    "$TOKEN_FILE" >&2
  computer daemon status --json >&2 2>/dev/null || true
  computer daemon stop >/dev/null 2>&1 || true
  return 1
}

# Registration and the Gateway both need the running Agent Service.
require_agent_service() {
  require_command curl
  curl --fail --silent --show-error --max-time 2 "$AGENT_HEALTH_URL" >/dev/null || {
    printf 'Agent Service is unavailable at %s. Start pnpm dev first.\n' "$AGENT_HEALTH_URL" >&2
    exit 1
  }
}

start_prepared() {
  computer daemon start >/dev/null
  wait_for_gateway
  computer daemon status --json
  printf 'Local Computer is ready. Open http://localhost:3000 and create an Agent with Runs on = Local Computer.\n'
}

start() {
  require_agent_service
  prepare_runtime_config
  start_prepared
}

case "$COMMAND" in
  start)
    start
    ;;
  restart)
    require_agent_service
    prepare_runtime_config
    computer daemon stop >/dev/null 2>&1 || true
    start_prepared
    ;;
  stop)
    prepare_control
    computer daemon stop
    ;;
  status)
    prepare_control
    computer daemon status --json
    ;;
  runtimes)
    prepare_control
    computer daemon status --json | jq '.runtimes'
    ;;
  runners)
    prepare_control
    computer daemon runners --json
    ;;
  stop-runner)
    [[ -n "${2:-}" ]] || {
      printf 'stop-runner requires an Agent ID\n' >&2
      exit 2
    }
    prepare_control
    computer daemon runners stop "$2" --json
    ;;
  config)
    prepare_runtime_config
    printf '%s\n' "$CONFIG_PATH"
    ;;
  help | --help | -h)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
