#!/usr/bin/env bash
set -euo pipefail

# Installs the CLI for the Web origin's environment. Enrollment remains an
# explicit linger-computer-<environment> login step.
# The Agent Service renders the origin and each target's release row
# ("<app_sha256> <app_size> <deps_sha256> <deps_size>") when serving this file.

web_origin="${LINGER_WEB_URL:-http://localhost:3000}"
release_darwin_arm64=""
release_darwin_x64=""
release_linux_arm64=""
release_linux_x64=""

if (( $# > 0 )); then
  printf '%s\n' 'Usage: install-linger-computer.sh (takes no arguments; see LINGER_COMPUTER_APP_ARCHIVE)' >&2
  exit 2
fi

# A self-update inherits the daemon's working directory, which may have been
# deleted since the daemon started; the bundled Node CLI cannot start there.
if ! pwd -P >/dev/null 2>&1; then
  cd "${HOME:-/}" 2>/dev/null || cd /
fi
# Set by the Daemon's self-update. "prepare" verifies the given app archive and
# stages it as staged-upgrade while the running Computer keeps working;
# "activate" switches to that staged bundle without network access. "1" does
# both in one run. Stage modes never stop or start the running Computer.
install_stage_only="${LINGER_COMPUTER_INSTALL_STAGE_ONLY:-0}"
# Local archives and digests override this installer's rendered release row.
app_archive_source="${LINGER_COMPUTER_APP_ARCHIVE:-}"
app_sha256="${LINGER_COMPUTER_APP_SHA256:-}"
deps_archive_source="${LINGER_COMPUTER_DEPS_ARCHIVE:-}"
deps_sha256="${LINGER_COMPUTER_DEPS_SHA256:-}"
deps_size="${LINGER_COMPUTER_DEPS_SIZE:-}"
app_size=""
max_app_archive_bytes=$((64 * 1024 * 1024))
max_deps_archive_bytes=$((512 * 1024 * 1024))
case "$install_stage_only" in
  0 | 1 | prepare | activate) ;;
  *)
    printf '%s\n' 'LINGER_COMPUTER_INSTALL_STAGE_ONLY must be 0, 1, prepare, or activate.' >&2
    exit 2
    ;;
esac
is_stage_mode() {
  [[ "$install_stage_only" == 1 ]] || [[ "$install_stage_only" == prepare ]] || [[ "$install_stage_only" == activate ]]
}
if is_stage_mode && [[ -z "$app_sha256" ]]; then
  printf '%s\n' 'LINGER_COMPUTER_INSTALL_STAGE_ONLY requires LINGER_COMPUTER_APP_SHA256.' >&2
  exit 2
fi
if { [[ -n "$app_archive_source" ]] && { [[ "$app_archive_source" != /* ]] || [[ -z "$app_sha256" ]]; }; } ||
  { [[ -n "$deps_archive_source" ]] && { [[ "$deps_archive_source" != /* ]] || [[ -z "$deps_sha256" ]]; }; }; then
  printf '%s\n' 'LINGER_COMPUTER_APP_ARCHIVE and LINGER_COMPUTER_DEPS_ARCHIVE must be absolute paths given with their SHA256.' >&2
  exit 2
fi

# The origin must be an HTTPS or HTTP origin without a path; every download
# comes from it.
origin_pattern='^https?://([a-z0-9.-]+|\[[0-9a-f:.]+\])(:[0-9]+)?$'
if [[ ! "$web_origin" =~ $origin_pattern ]]; then
  printf '%s\n' 'Linger Web origin must be an HTTPS or HTTP origin without a path.' >&2
  exit 2
fi

# computer_environment_name prints the name a Web origin installs under: the
# host's first label without its "-linger" suffix, "local" for a loopback
# host, or the dashed address for an IP, plus any non-default port. The Web
# client and the Windows installer derive the same name.
computer_environment_name() {
  local rest="${1#*://}" host port name
  if [[ "$rest" == \[* ]]; then host="${rest%%]*}]"; else host="${rest%%:*}"; fi
  port="${rest#"$host"}"
  port="${port#:}"
  if [[ "$1" == http://* && "$port" == 80 ]] || [[ "$1" == https://* && "$port" == 443 ]]; then
    port=""
  fi
  case "$host" in
    localhost | *.localhost | 127.0.0.1 | '[::1]') name=local ;;
    \[*)
      name="${host#[}"
      name="ip-${name%]}"
      name="${name//[:.]/-}"
      ;;
    *)
      if [[ "$host" =~ ^[0-9.]+$ ]]; then
        name="ip-${host//./-}"
      else
        name="${host%%.*}"
        [[ "$name" == linger ]] || name="${name%-linger}"
      fi
      ;;
  esac
  [[ -z "$port" ]] || name="$name-$port"
  printf '%s\n' "$name"
}

# Each Web origin is its own environment with its own install root and its own
# command, linger-computer-<environment>, so Computers of several deployments
# can share one account. linger-computer runs the environment when it is the
# only one installed and lists them otherwise.
environment_name="$(computer_environment_name "$web_origin")"
home_directory="${HOME:?HOME is required}"
bin_directory="${LINGER_COMPUTER_BIN_DIR:-$home_directory/.local/bin}"
command_name="linger-computer-$environment_name"
launcher="$bin_directory/$command_name"
dispatcher="$bin_directory/linger-computer"
launcher_marker='# linger-computer-launcher-v2'
dispatcher_marker='# linger-computer-dispatcher-v1'

# launcher_data_root prints the install root an environment's launcher runs, so
# reinstalling an environment upgrades it where it is.
launcher_data_root() {
  [[ -f "$1" ]] && [[ ! -L "$1" ]] && grep -Fqx "$launcher_marker" "$1" || return 1
  sed -n 's/^data_root="\${LINGER_COMPUTER_DATA_DIR:-\(.*\)}"$/\1/p' "$1" | sed -e 's/\\\(.\)/\1/g' | grep .
}

data_root="${LINGER_COMPUTER_DATA_DIR:-}"
if [[ -z "$data_root" ]]; then
  data_root="$(launcher_data_root "$launcher" || printf '%s' "$home_directory/.local/share/linger/computers/$environment_name")"
fi
active_bundle_file="$data_root/active-bundle"
web_origin_file="$data_root/web-origin"
install_lock="$data_root/.install.lock"
upgrade_pending_file="$data_root/upgrade-pending"
# staged-upgrade is a complete bundle beside the lib-* bundles, so its
# relative dependency links resolve the same before and after activation.
staged_upgrade_directory="$data_root/staged-upgrade"

if [[ "$data_root" != /* ]] || [[ "$data_root" == "/" ]] || [[ "$data_root" == "$home_directory" ]] || [[ "$bin_directory" != /* ]]; then
  printf '%s\n' 'Install destinations must be safe absolute paths.' >&2
  exit 1
fi

mkdir -p -m 700 "$data_root"
if ! is_stage_mode; then mkdir -p -m 700 "$bin_directory"; fi

assert_owned_directory() {
  local directory="$1"
  local owner_uid
  if [[ -L "$directory" ]] || [[ ! -d "$directory" ]]; then
    printf 'Install destination is unsafe: %s\n' "$directory" >&2
    exit 1
  fi
  if stat -f '%u' "$directory" >/dev/null 2>&1; then
    owner_uid="$(stat -f '%u' "$directory")"
  else
    owner_uid="$(stat -c '%u' "$directory")"
  fi
  if [[ "$owner_uid" != "$(id -u)" ]]; then
    printf 'Install destination is not owned by the current user: %s\n' "$directory" >&2
    exit 1
  fi
}

acquire_install_lock() {
  if mkdir -m 700 "$install_lock" 2>/dev/null; then
    printf '%s\n' "$$" > "$install_lock/pid"
    installer_process_identity "$$" > "$install_lock/process-identity"
    return
  fi
  local owner_pid=""
  local owner_identity=""
  local actual_identity=""
  if [[ -L "$install_lock" ]] || [[ ! -d "$install_lock" ]]; then
    printf '%s\n' 'Installer lock is unsafe.' >&2
    exit 1
  fi
  if [[ -f "$install_lock/pid" ]]; then
    read -r owner_pid < "$install_lock/pid" || true
  fi
  if [[ -f "$install_lock/process-identity" ]]; then
    read -r owner_identity < "$install_lock/process-identity" || true
  fi
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    actual_identity="$(installer_process_identity "$owner_pid" || true)"
    if [[ -z "$owner_identity" ]] || [[ "$owner_identity" == "$actual_identity" ]]; then
      printf 'Another linger-computer installation is active (pid %s).\n' "$owner_pid" >&2
      exit 1
    fi
  fi
  rm -f "$install_lock/pid" "$install_lock/process-identity"
  rmdir "$install_lock" 2>/dev/null || {
    printf '%s\n' 'Stale installer lock could not be removed.' >&2
    exit 1
  }
  mkdir -m 700 "$install_lock"
  printf '%s\n' "$$" > "$install_lock/pid"
  installer_process_identity "$$" > "$install_lock/process-identity"
}

installer_process_identity() {
  local process_id="$1"
  local started_at
  started_at="$(ps -p "$process_id" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)"
  [[ -n "$started_at" ]] || started_at="unknown"
  printf '%s:%s\n' "$process_id" "$started_at"
}

export LINGER_COMPUTER_DATA_DIR="$data_root"
if [[ -z "${LINGER_COMPUTER_CONFIG:-}" ]]; then
  export LINGER_COMPUTER_CONFIG="$data_root/config.json"
fi
assert_owned_directory "$data_root"
if ! is_stage_mode; then assert_owned_directory "$bin_directory"; fi
chmod 700 "$data_root"
acquire_install_lock

# The lock is held, so whatever temporary state is left in the root belongs to
# an interrupted earlier run.
find "$data_root" -mindepth 1 -maxdepth 1 \( -name '.install.*' -o -name '.deps.*' -o -name '.bundle.*' \) ! -name '.install.lock' -exec rm -rf {} +

temporary_directory="$(mktemp -d "$data_root/.install.XXXXXX")"
app_archive="$temporary_directory/app.tar.gz"
deps_archive="$temporary_directory/deps.tar.gz"
# The staged bundle sits beside the lib-* bundles so its relative dependency
# links resolve while it is smoke-tested.
staged_bundle="$data_root/.bundle.$$"
old_launcher="$temporary_directory/old-launcher"
old_readiness_file="$temporary_directory/old-readiness.json"
old_active_bundle_file="$temporary_directory/old-active-bundle"
old_web_origin_file="$temporary_directory/old-web-origin"
old_active_bundle_name=""
old_lifecycle_cli=""
installer_node=""
old_bundle_verified=0
installation_action="installed"
old_release_label="not installed"
new_release_label="unknown"
new_bundle_name=""
new_bundle=""
deps_directory=""
was_running=0
daemon_stopped=0
new_daemon_start_attempted=0
switched=0
success=0
installer_started=$SECONDS

# Numbered steps on stderr. A terminal redraws the step line with a spinner
# and the elapsed time; other output gets a heartbeat at most every 10s. The
# Daemon's self-update stage modes write a log and keep plain messages.
progress_enabled=0
[[ "$install_stage_only" != 0 ]] || progress_enabled=1
progress_interactive=0
[[ ! -t 2 ]] || progress_interactive=1
progress_step=0
progress_label=""
progress_started=0
progress_ticker=""

format_duration() {
  if (( $1 < 60 )); then
    printf '%ss' "$1"
  else
    printf '%sm %ss' "$(($1 / 60))" "$(($1 % 60))"
  fi
}

# Called from the cleanup trap: every return states its status.
progress_stop_ticker() {
  if [[ -n "$progress_ticker" ]]; then
    kill "$progress_ticker" 2>/dev/null || true
    wait "$progress_ticker" 2>/dev/null || true
    progress_ticker=""
  fi
  return 0
}

# The ticker redraws the line above the cursor, so anything else printed
# while it runs must go through progress_note. Arguments are files being
# downloaded; the heartbeat reports their combined size.
progress_start_ticker() {
  (
    # A signal waits for a foreground sleep; waiting on a background one lets
    # the ticker stop at once and not hold the installer's output open.
    sleeper=""
    trap - EXIT INT
    trap 'kill "$sleeper" 2>/dev/null; exit 0' TERM
    frames='|/-\'
    frame=0
    interval=10
    (( progress_interactive == 0 )) || interval=0.25
    while :; do
      sleep "$interval" </dev/null >/dev/null 2>&1 &
      sleeper=$!
      wait "$sleeper"
      if (( progress_interactive == 1 )); then
        printf '\033[1A\r[%s/4] %s... %s %s\033[K\n' "$progress_step" "$progress_label" "${frames:frame++ % 4:1}" "$(format_duration "$((SECONDS - progress_started))")" >&2
      else
        detail="still working"
        downloaded=0
        for watched in "$@"; do
          [[ ! -f "$watched" ]] || downloaded=$((downloaded + $(wc -c < "$watched")))
        done
        if (( $# > 0 )); then
          detail="$(awk -v bytes="$downloaded" 'BEGIN { printf "%.1f MB downloaded", bytes / 1048576 }')"
        fi
        printf '      %s (%s)\n' "$detail" "$(format_duration "$((SECONDS - progress_started))")" >&2
      fi
    done
  ) &
  progress_ticker=$!
}

# step_begin <number> <label> [files being downloaded...]. In a terminal,
# curl draws the download bar itself.
step_begin() {
  (( progress_enabled == 1 )) || return 0
  step_end
  progress_step="$1"
  progress_label="$2"
  progress_started=$SECONDS
  shift 2
  printf '[%s/4] %s...\n' "$progress_step" "$progress_label" >&2
  if (( $# > 0 )) && (( progress_interactive == 1 )); then
    return 0
  fi
  progress_start_ticker "$@"
}

step_end() {
  (( progress_enabled == 1 )) && (( progress_step > 0 )) || return 0
  local redraw="$progress_ticker"
  progress_stop_ticker
  if (( progress_interactive == 1 )) && [[ -n "$redraw" ]]; then
    printf '\033[1A\r' >&2
  fi
  printf '[%s/4] %s... %s (%s)' "$progress_step" "$progress_label" "${1:-OK}" "$(format_duration "$((SECONDS - progress_started))")" >&2
  if (( progress_interactive == 1 )) && [[ -n "$redraw" ]]; then
    printf '\033[K' >&2
  fi
  printf '\n' >&2
  progress_step=0
  return 0
}

# Prints a stdout line while a step's terminal line may be redrawing.
progress_note() {
  if (( progress_interactive == 1 )) && [[ -n "$progress_ticker" ]]; then
    progress_stop_ticker
    printf '\033[1A\r\033[K' >&2
    printf '%s\n' "$1"
    printf '[%s/4] %s...\n' "$progress_step" "$progress_label" >&2
    progress_start_ticker
  else
    printf '%s\n' "$1"
  fi
  return 0
}

write_active_bundle() {
  local bundle_name="$1"
  local pending="$data_root/.active-bundle.$$"
  printf '%s\n' "$bundle_name" > "$pending"
  chmod 600 "$pending"
  mv "$pending" "$active_bundle_file"
}

write_upgrade_pending() {
  local previous_bundle="$1"
  local created_at pending
  created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  pending="$data_root/.upgrade-pending.$$"
  printf '{"previous_bundle":"%s","target_app_sha256":"%s","created_at":"%s"}\n' "$previous_bundle" "$app_sha256" "$created_at" > "$pending"
  chmod 600 "$pending"
  mv "$pending" "$upgrade_pending_file"
}

assert_safe_staged_upgrade_directory() {
  if [[ -L "$staged_upgrade_directory" ]] || { [[ -e "$staged_upgrade_directory" ]] && [[ ! -d "$staged_upgrade_directory" ]]; }; then
    printf 'Staged Computer upgrade path is unsafe: %s\n' "$staged_upgrade_directory" >&2
    exit 1
  fi
}

# bundle_deps_directory prints the deps-* directory a bundle's two dependency
# links name, and fails unless they are exactly the installer's relative links
# to one complete dependency directory.
bundle_deps_directory() {
  local bundle="$1"
  local runtime_link tools_link deps_name digest
  [[ -L "$bundle/runtime" ]] && [[ -L "$bundle/cli/computer-tools" ]] || return 1
  runtime_link="$(readlink "$bundle/runtime")" || return 1
  tools_link="$(readlink "$bundle/cli/computer-tools")" || return 1
  [[ "$runtime_link" =~ ^\.\./(deps-[0-9a-f]{16})/runtime$ ]] || return 1
  deps_name="${BASH_REMATCH[1]}"
  [[ "$tools_link" == "../../$deps_name/computer-tools" ]] || return 1
  [[ -d "$data_root/$deps_name" ]] && [[ ! -L "$data_root/$deps_name" ]] || return 1
  [[ -f "$data_root/$deps_name/.sha256" ]] && [[ ! -L "$data_root/$deps_name/.sha256" ]] || return 1
  read -r digest < "$data_root/$deps_name/.sha256" || return 1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] && [[ "deps-${digest:0:16}" == "$deps_name" ]] || return 1
  printf '%s\n' "$deps_name"
}

# bundle_app_sha256 prints a bundle's recorded app archive sha256 once the
# bundle is complete: the daemon is executable and both links are valid.
bundle_app_sha256() {
  local bundle="$1"
  local digest
  [[ -d "$bundle" ]] && [[ ! -L "$bundle" ]] || return 1
  [[ -f "$bundle/app-sha256" ]] && [[ ! -L "$bundle/app-sha256" ]] || return 1
  read -r digest < "$bundle/app-sha256" || return 1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ -f "$bundle/daemon/linger-computer-daemon" ]] && [[ ! -L "$bundle/daemon/linger-computer-daemon" ]] || return 1
  [[ -x "$bundle/daemon/linger-computer-daemon" ]] || return 1
  bundle_deps_directory "$bundle" >/dev/null || return 1
  printf '%s\n' "$digest"
}

load_staged_upgrade() {
  assert_safe_staged_upgrade_directory
  if [[ "$(bundle_app_sha256 "$staged_upgrade_directory" 2>/dev/null || true)" != "$app_sha256" ]]; then
    printf '%s\n' 'Staged Computer upgrade is missing, incomplete, or not the requested build; nothing was switched.' >&2
    exit 1
  fi
  staged_bundle="$staged_upgrade_directory"
  installer_node="$staged_bundle/runtime/bin/node"
  verify_product_node "$installer_node" "Staged Computer runtime" || exit 1
  new_release_label="$(release_label "$staged_bundle")"
}

persist_staged_upgrade() {
  rm -rf "$staged_upgrade_directory"
  mv "$staged_bundle" "$staged_upgrade_directory"
}

write_private_value() {
  local destination="$1"
  local value="$2"
  local pending="$data_root/.$(basename "$destination").$$"
  printf '%s\n' "$value" > "$pending"
  chmod 600 "$pending"
  mv "$pending" "$destination"
  if [[ "${LINGER_INSTALL_TEST_FAIL_AFTER_METADATA_WRITE:-}" == "$(basename "$destination")" ]]; then
    return 91
  fi
}

write_launcher() {
  local launcher_pending="$bin_directory/.linger-computer.$$"
  local default_data_root
  default_data_root="$(printf '%s' "$data_root" | sed -e 's/[\\"]/\\&/g')"
  {
    printf '%s\n' '#!/bin/sh'
    printf '%s\n' 'set -eu'
    printf '%s\n' "$launcher_marker"
    printf '# web-origin %s\n' "$web_origin"
    printf 'data_root="${LINGER_COMPUTER_DATA_DIR:-%s}"\n' "$default_data_root"
    printf 'LINGER_COMPUTER_COMMAND=%s; export LINGER_COMPUTER_COMMAND\n' "$command_name"
    printf '%s\n' 'active_file="$data_root/active-bundle"'
    printf '%s\n' 'test -f "$active_file" || { echo "linger-computer installation is incomplete" >&2; exit 1; }'
    printf '%s\n' 'IFS= read -r bundle_name < "$active_file"'
    printf '%s\n' 'case "$bundle_name" in lib-[0-9A-Za-z._-]*) ;; *) echo "linger-computer bundle metadata is invalid" >&2; exit 1 ;; esac'
    printf '%s\n' 'if [ -z "${LINGER_WEB_URL+x}" ] && [ -f "$data_root/web-origin" ]; then IFS= read -r LINGER_WEB_URL < "$data_root/web-origin"; export LINGER_WEB_URL; fi'
    printf '%s\n' 'if [ -z "${LINGER_COMPUTER_CONFIG+x}" ]; then LINGER_COMPUTER_CONFIG="$data_root/config.json"; export LINGER_COMPUTER_CONFIG; fi'
    printf '%s\n' 'exec "$data_root/$bundle_name/cli/linger-computer" "$@"'
  } > "$launcher_pending"
  chmod 755 "$launcher_pending"
  mv "$launcher_pending" "$launcher"
}

is_managed_launcher() {
  [[ -f "$launcher" ]] && [[ ! -L "$launcher" ]] && grep -Fqx "$launcher_marker" "$launcher"
}

# installed_environments prints "<command> <origin>" for every environment
# installed into the bin directory.
installed_environments() {
  local candidate
  for candidate in "$bin_directory"/linger-computer-*; do
    [[ -f "$candidate" ]] && [[ ! -L "$candidate" ]] && grep -Fqx "$launcher_marker" "$candidate" || continue
    printf '%s %s\n' "$(basename "$candidate")" "$(sed -n 's/^# web-origin //p' "$candidate")"
  done
}

# write_dispatcher makes linger-computer run the only installed environment
# and list the environments when there are several. A linger-computer this
# installer did not write is left alone.
write_dispatcher() {
  local pending="$bin_directory/.linger-computer-dispatcher.$$"
  local quoted_bin_directory
  if [[ -e "$dispatcher" ]] || [[ -L "$dispatcher" ]]; then
    [[ -f "$dispatcher" ]] && [[ ! -L "$dispatcher" ]] && grep -Fqx "$dispatcher_marker" "$dispatcher" || return 1
  fi
  quoted_bin_directory="$(printf '%s' "$bin_directory" | sed -e "s/'/'\\\\''/g")"
  {
    printf '%s\n' '#!/bin/sh'
    printf '%s\n' 'set -eu'
    printf '%s\n' "$dispatcher_marker"
    printf "bin_directory='%s'\n" "$quoted_bin_directory"
    cat <<'DISPATCHER'
count=0
only=""
listing=""
for candidate in "$bin_directory"/linger-computer-*; do
  [ -f "$candidate" ] && [ -x "$candidate" ] && grep -Fqx '# linger-computer-launcher-v2' "$candidate" || continue
  count=$((count + 1))
  only="$candidate"
  listing="$listing
$(printf '  %-34s %s' "$(basename "$candidate")" "$(sed -n 's/^# web-origin //p' "$candidate")")"
done
case "$count" in
  0) echo "Linger Computer is not installed for any environment. Install it from the Computers page of your Linger Web app." >&2; exit 1 ;;
  1) exec "$only" "$@" ;;
esac
printf 'Linger Computer is installed for %s environments on this computer. Run the command of the environment you mean:%s\n' "$count" "$listing" >&2
exit 2
DISPATCHER
  } > "$pending"
  chmod 755 "$pending"
  mv "$pending" "$dispatcher"
}

has_no_configuration() {
  [[ ! -e "$data_root/config.json" ]] && [[ ! -L "$data_root/config.json" ]]
}

daemon_log_file() {
  "$installer_node" -e '
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    let directory = join(process.argv[1], "state");
    try { const value = JSON.parse(readFileSync(process.argv[2], "utf8")).state_directory; if (typeof value === "string" && value) directory = value; } catch {}
    process.stdout.write(join(directory, "daemon.log"));
  ' "$data_root" "$LINGER_COMPUTER_CONFIG" 2>/dev/null || printf '%s' "$data_root/state/daemon.log"
  return 0
}

# The next step follows the real state: log in, start, or inspect.
next_command() {
  if has_no_configuration; then
    printf '%s\n' login
    return 0
  fi
  local status_output
  status_output="$("$launcher" daemon status --json 2>/dev/null || true)"
  printf '%s' "$status_output" | "$installer_node" -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      let value;
      try { value = JSON.parse(input); } catch {}
      const state = value?.daemon?.state;
      process.stdout.write(value?.config?.configured === false ? "login\n"
        : typeof state === "string" && state !== "running" ? "daemon start\n" : "daemon status\n");
    });
  ' 2>/dev/null || printf '%s\n' 'daemon status'
  return 0
}

show_next_steps() {
  local command="$command_name" path_active=1 environments count name origin note dispatcher_managed=0
  is_stage_mode && return 0
  write_dispatcher && dispatcher_managed=1
  if [[ ":${PATH:-}:" != *":$bin_directory:"* ]]; then
    path_active=0
    command="$(printf '%q' "$launcher")"
  fi
  printf '\nNext:\n  %s %s\n' "$command" "$(next_command)"
  printf '\nHelp:\n  %s --help\n' "$command"
  environments="$(installed_environments)"
  count="$(printf '%s' "$environments" | grep -c .)" || true
  if (( count > 1 )); then
    printf '\nThis computer has Linger Computer for %s environments, each with its own command:\n' "$count"
    while read -r name origin; do
      note=""
      [[ "$name" != "$command_name" ]] || note="  (this installation)"
      printf '  %-34s %s%s\n' "$name" "$origin" "$note"
    done <<< "$environments"
    (( dispatcher_managed == 0 )) || printf '%s\n' 'linger-computer alone lists them instead of choosing one.'
  elif (( dispatcher_managed == 1 )); then
    printf '\nWhile this is the only environment on this computer, linger-computer runs it too.\n'
  fi
  if (( dispatcher_managed == 0 )); then
    printf '\nlinger-computer on this computer belongs to another installation; run this environment as %s.\n' "$command_name"
  fi
  (( path_active == 0 )) || return 0
  printf '\n'
  if [[ "$bin_directory" == "$home_directory/.local/bin" ]]; then
    if [[ -f "$home_directory/.zprofile" ]] && grep -Fqx 'export PATH="$HOME/.local/bin:$PATH"' "$home_directory/.zprofile"; then
      printf 'To run %s by name, open a new terminal or run:\n' "$command_name"
    else
      printf 'To run %s by name, run:\n' "$command_name"
      printf '%s\n' 'echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.zprofile'
    fi
    printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"'
  else
    printf 'To run %s by name, run:\nexport PATH=' "$command_name"
    printf '%q' "$bin_directory"
    printf '%s\n' ':"$PATH"'
  fi
}

smoke_cli() {
  "$@" version >/dev/null 2>&1 || return 1
  "$@" --help >/dev/null 2>&1 || return 1
  local status_output
  status_output="$("$@" daemon status --json 2>/dev/null || true)"
  printf '%s' "$status_output" | "$installer_node" -e '
    let source = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { source += chunk; });
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(source);
        if (value?.version !== 1 || typeof value?.daemon?.state !== "string") {
          process.exit(1);
        }
      } catch {
        process.exit(1);
      }
    });
  '
}

release_label() {
  "$1/cli/linger-computer" version | sed 's/^linger-computer //'
}

is_current_install() {
  local active_bundle_name=""
  if ! is_stage_mode; then
    [[ -f "$launcher" ]] && [[ ! -L "$launcher" ]] && [[ -x "$launcher" ]] || return 1
  fi
  [[ -f "$active_bundle_file" ]] && [[ ! -L "$active_bundle_file" ]] || return 1
  read -r active_bundle_name < "$active_bundle_file" || return 1
  [[ "$active_bundle_name" =~ ^lib-[0-9A-Za-z._-]+$ ]] || return 1
  [[ "$(bundle_app_sha256 "$data_root/$active_bundle_name" 2>/dev/null || true)" == "$app_sha256" ]] || return 1
  [[ -f "$data_root/$active_bundle_name/cli/linger-computer" ]] && [[ ! -L "$data_root/$active_bundle_name/cli/linger-computer" ]] || return 1
  installer_node="$data_root/$active_bundle_name/runtime/bin/node"
  [[ -f "$installer_node" ]] && [[ ! -L "$installer_node" ]] && [[ -x "$installer_node" ]] || return 1
  if is_stage_mode; then
    smoke_cli "$data_root/$active_bundle_name/cli/linger-computer"
  else
    smoke_cli "$launcher"
  fi
}

assert_safe_install_paths() {
  local candidate
  local paths=("$active_bundle_file" "$web_origin_file")
  if ! is_stage_mode; then paths+=("$launcher"); fi
  for candidate in "${paths[@]}"; do
    if [[ -L "$candidate" ]]; then
      printf 'Install metadata contains an unsafe symbolic link: %s\n' "$candidate" >&2
      exit 1
    fi
    if [[ -e "$candidate" ]] && [[ ! -f "$candidate" ]]; then
      printf 'Install metadata contains an unsafe non-file path: %s\n' "$candidate" >&2
      exit 1
    fi
  done
}

backup_private_file() {
  local source="$1"
  local backup="$2"
  if [[ -f "$source" ]]; then
    cp -p "$source" "$backup"
  fi
}

restore_private_file() {
  local backup="$1"
  local destination="$2"
  local pending="$data_root/.$(basename "$destination").restore.$$"
  if [[ -f "$backup" ]]; then
    cp -p "$backup" "$pending" || return 1
    chmod 600 "$pending" || return 1
    mv "$pending" "$destination"
  else
    rm -f "$destination"
  fi
}

restore_old_installation() {
  local restore_failed=0
  local active_pointer_restored=0
  local launcher_restored=0
  if (( switched == 0 )); then
    active_pointer_restored=1
    launcher_restored=1
  fi
  if (( switched == 1 )); then
    if (( new_daemon_start_attempted == 1 )); then
      local rollback_stop_output=""
      if ! rollback_stop_output="$("$new_bundle/cli/linger-computer" daemon stop --if-idle 2>&1)"; then
        [[ -z "$rollback_stop_output" ]] || printf '%s\n' "$rollback_stop_output" >&2
        printf '%s\n' 'Automatic rollback was deferred because idle shutdown could not be confirmed. The current bundle and install metadata were preserved; wait for active Operations to finish and retry the installer.' >&2
        return 1
      fi
    fi
    if [[ -f "$old_active_bundle_file" ]]; then
      if [[ "${LINGER_INSTALL_TEST_FAIL_ACTIVE_RESTORE:-}" == "1" ]]; then
        restore_failed=1
      elif cp "$old_active_bundle_file" "$data_root/.active-bundle.restore.$$" &&
        chmod 600 "$data_root/.active-bundle.restore.$$" &&
        mv "$data_root/.active-bundle.restore.$$" "$active_bundle_file"; then
        active_pointer_restored=1
      else
        restore_failed=1
      fi
    elif rm -f "$active_bundle_file"; then
      active_pointer_restored=1
    else
      restore_failed=1
    fi
    if is_stage_mode; then
      launcher_restored=1
    elif [[ -f "$old_launcher" ]]; then
      if cp -p "$old_launcher" "$bin_directory/.linger-computer.restore.$$" &&
        mv "$bin_directory/.linger-computer.restore.$$" "$launcher"; then
        launcher_restored=1
      else
        restore_failed=1
      fi
    elif rm -f "$launcher"; then
      launcher_restored=1
    else
      restore_failed=1
    fi
    restore_private_file "$old_web_origin_file" "$web_origin_file" || restore_failed=1
    if [[ "$install_stage_only" == 1 ]] || [[ "$install_stage_only" == activate ]]; then
      rm -f "$upgrade_pending_file" || restore_failed=1
    fi
    if (( active_pointer_restored == 1 )) && [[ -n "$new_bundle" ]]; then
      rm -rf "$new_bundle"
    fi
  fi
  if (( daemon_stopped == 1 )); then
    if (( active_pointer_restored == 0 || launcher_restored == 0 )); then
      printf '%s\n' 'Rollback could not safely restore the old daemon entrypoints.' >&2
      restore_failed=1
    elif ! run_old_daemon start >/dev/null 2>&1; then
      printf '%s\n' 'Rollback restored the old CLI but failed to restart its daemon.' >&2
      restore_failed=1
    fi
  fi
  return "$restore_failed"
}

cleanup() {
  local exit_code="${1:-$?}"
  trap - EXIT INT TERM
  set +e
  progress_stop_ticker
  if (( exit_code != 0 )) && (( progress_step > 0 )); then
    progress_ticker=""
    step_end FAILED
  fi
  if [[ -n "${LINGER_INSTALL_TEST_CLEANUP_INVOCATIONS:-}" ]]; then
    printf '%s\n' 'cleanup' >> "$LINGER_INSTALL_TEST_CLEANUP_INVOCATIONS"
  fi
  if (( success == 0 )); then
    if ! restore_old_installation; then
      exit_code=1
    fi
  fi
  rm -rf "$temporary_directory"
  if [[ "$staged_bundle" == "$data_root/.bundle.$$" ]]; then
    rm -rf "$staged_bundle"
  fi
  rm -f "$install_lock/pid" "$install_lock/process-identity"
  rmdir "$install_lock" 2>/dev/null || true
  exit "$exit_code"
}
trap 'cleanup $?' EXIT
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

assert_safe_install_paths
backup_private_file "$web_origin_file" "$old_web_origin_file"

fetch_file() {
  local source="$1"
  local destination="$2"
  local max_bytes="$3"
  local transfer_mode="${4:-quiet}"
  local -a retry_options=(
    --connect-timeout 15
    --retry 5
    --retry-all-errors
    --retry-max-time 300
    --speed-limit 1024
    --speed-time 60
    --max-filesize "$max_bytes"
  )
  if [[ "$source" == /* ]]; then
    cp "$source" "$destination"
  elif [[ "$transfer_mode" == "progress" ]] && [[ -t 2 ]]; then
    (( progress_enabled == 1 )) || printf '%s\n' '[install] Downloading Local Computer package...' >&2
    curl --fail --show-error --location "${retry_options[@]}" \
      --progress-bar "$source" --output "$destination"
  else
    if [[ "$transfer_mode" == "progress" ]] && (( progress_enabled == 0 )); then
      printf '%s\n' '[install] Downloading Local Computer package...' >&2
    fi
    curl --fail --silent --show-error --location "${retry_options[@]}" \
      "$source" --output "$destination"
  fi
}

# fetch_archive downloads (or copies) an archive. A failed download returns
# curl's exit code, which the Daemon's self-update uses to retry network errors
# soon; callers run it in an || list, where errexit is off.
fetch_archive() {
  local source="$1"
  local destination="$2"
  local max_bytes="$3"
  fetch_file "$source" "$destination" "$max_bytes" progress
}

# verify_archive refuses a downloaded archive unless it is at most max_bytes
# and has the expected sha256.
verify_archive() {
  local destination="$1"
  local expected="$2"
  local max_bytes="$3"
  local label="$4"
  local size
  (( progress_enabled == 1 )) || printf '[install] Verifying Local Computer %s...\n' "$label" >&2
  size="$(wc -c < "$destination" | tr -d '[:space:]')"
  if (( size > max_bytes )); then
    printf 'Local Computer %s exceeds %s bytes.\n' "$label" "$max_bytes" >&2
    return 1
  fi
  if [[ "$(file_checksum "$destination")" != "$expected" ]]; then
    printf 'Local Computer %s checksum verification failed.\n' "$label" >&2
    return 1
  fi
}

# extract_archive unpacks a verified archive into a new directory after
# checking every entry: no absolute paths or "..", only regular files and
# directories.
extract_archive() {
  local archive="$1"
  local destination="$2"
  local label="$3"
  local entry listing
  while IFS= read -r entry; do
    if [[ "$entry" == /* ]] || [[ "/$entry/" == *"/../"* ]]; then
      printf 'Local Computer %s contains an unsafe path.\n' "$label" >&2
      return 1
    fi
  done < <(tar -tzf "$archive")
  while IFS= read -r listing; do
    if [[ "${listing:0:1}" != "-" ]] && [[ "${listing:0:1}" != "d" ]]; then
      printf 'Local Computer %s must contain only regular files and directories.\n' "$label" >&2
      return 1
    fi
  done < <(tar -tvzf "$archive")
  mkdir -m 700 "$destination"
  tar -xzf "$archive" -C "$destination"
  if find "$destination" ! -type f ! -type d -print -quit | grep -q .; then
    printf 'Local Computer %s must contain only regular files and directories.\n' "$label" >&2
    return 1
  fi
}

release_target() {
  local operating_system architecture
  operating_system="$(uname -s)"
  architecture="$(uname -m)"
  case "$operating_system-$architecture" in
    Darwin-arm64) printf '%s\n' 'darwin-arm64' ;;
    Darwin-x86_64) printf '%s\n' 'darwin-x64' ;;
    Linux-aarch64 | Linux-arm64) printf '%s\n' 'linux-arm64' ;;
    Linux-x86_64 | Linux-amd64) printf '%s\n' 'linux-x64' ;;
    *)
      printf 'Unsupported Local Computer platform: %s %s\n' "$operating_system" "$architecture" >&2
      exit 1
      ;;
  esac
}

file_checksum() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print tolower($1) }'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print tolower($1) }'
    return
  fi
  printf '%s\n' 'A SHA-256 utility is required to install Local Computer.' >&2
  return 1
}

resolve_release() {
  local target row app_row_sha256 app_row_size deps_row_sha256 deps_row_size
  target="$(release_target)"
  case "$target" in
    darwin-arm64) row="$release_darwin_arm64" ;;
    darwin-x64) row="$release_darwin_x64" ;;
    linux-arm64) row="$release_linux_arm64" ;;
    linux-x64) row="$release_linux_x64" ;;
  esac
  read -r app_row_sha256 app_row_size deps_row_sha256 deps_row_size <<< "$row" || true
  if [[ -z "$app_sha256" ]]; then
    app_sha256="$app_row_sha256"
    app_size="$app_row_size"
  fi
  if [[ -z "$deps_sha256" ]]; then
    deps_sha256="$deps_row_sha256"
    deps_size="$deps_row_size"
  fi
  if [[ -z "$app_sha256" ]] || [[ -z "$deps_sha256" ]]; then
    printf 'This installer carries no Local Computer release for %s. Download the installer from your Linger Web origin: curl -fsSL <origin>/install/linger-computer.sh | bash\n' "$target" >&2
    exit 1
  fi
  if [[ ! "$app_sha256" =~ ^[0-9a-f]{64}$ ]] || [[ ! "$deps_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    [[ ! "$deps_size" =~ ^[1-9][0-9]*$ ]] || { [[ -n "$app_size" ]] && [[ ! "$app_size" =~ ^[1-9][0-9]*$ ]]; }; then
    printf '%s\n' 'Local Computer release metadata is invalid.' >&2
    exit 1
  fi
  if [[ -n "$app_size" ]] && (( app_size < max_app_archive_bytes )); then
    max_app_archive_bytes="$app_size"
  fi
  if (( deps_size < max_deps_archive_bytes )); then
    max_deps_archive_bytes="$deps_size"
  fi
  if [[ -z "$app_archive_source" ]]; then
    app_archive_source="$web_origin/install/files/app-$target-$app_sha256.tar.gz"
  fi
  if [[ -z "$deps_archive_source" ]]; then
    deps_archive_source="$web_origin/install/files/deps-$target-$deps_sha256.tar.gz"
  fi
}

# deps_reusable succeeds when deps-<sha16> already holds this release's
# dependency package, so it needs no download.
deps_reusable() {
  local directory="$data_root/deps-${deps_sha256:0:16}"
  [[ -d "$directory" ]] && [[ ! -L "$directory" ]] && [[ -f "$directory/.sha256" ]] &&
    [[ ! -L "$directory/.sha256" ]] && [[ "$(sed -n '1p' "$directory/.sha256")" == "$deps_sha256" ]]
}

# install_deps makes deps-<sha16> hold the downloaded dependency archive once
# it verifies. A matching directory is reused; a new one is extracted beside
# it and renamed into place only once complete.
install_deps() {
  local pending
  deps_directory="$data_root/deps-${deps_sha256:0:16}"
  if deps_reusable; then
    return
  fi
  verify_archive "$deps_archive" "$deps_sha256" "$max_deps_archive_bytes" "dependency package" || exit 1
  pending="$(mktemp -u "$data_root/.deps.XXXXXX")"
  extract_archive "$deps_archive" "$pending" "dependency package" || exit 1
  rm -f "$deps_archive"
  if [[ ! -f "$pending/runtime/bin/node" ]] || [[ ! -d "$pending/computer-tools" ]]; then
    printf '%s\n' 'Local Computer dependency package is missing runtime/bin/node or computer-tools.' >&2
    exit 1
  fi
  chmod 755 "$pending/runtime/bin/node"
  printf '%s\n' "$deps_sha256" > "$pending/.sha256"
  chmod 600 "$pending/.sha256"
  rm -rf "$deps_directory"
  mv "$pending" "$deps_directory"
}

# stage_app_bundle verifies the downloaded app archive, extracts it beside the
# lib-* bundles, and links it to the dependency directory.
stage_app_bundle() {
  local deps_name
  deps_name="$(basename "$deps_directory")"
  verify_archive "$app_archive" "$app_sha256" "$max_app_archive_bytes" "package" || exit 1
  extract_archive "$app_archive" "$staged_bundle" "package" || exit 1
  for required in cli/linger-computer daemon/linger-computer-daemon; do
    if [[ ! -f "$staged_bundle/$required" ]]; then
      printf 'Artifact is missing %s.\n' "$required" >&2
      exit 1
    fi
  done
  if [[ -e "$staged_bundle/runtime" ]] || [[ -e "$staged_bundle/cli/computer-tools" ]] || [[ -e "$staged_bundle/app-sha256" ]]; then
    printf '%s\n' 'Artifact must not contain runtime, cli/computer-tools, or app-sha256.' >&2
    exit 1
  fi
  if find "$staged_bundle" -type d -name node_modules -print -quit | grep -q .; then
    printf '%s\n' 'Artifact contains forbidden bundled content.' >&2
    exit 1
  fi
  ln -s "../$deps_name/runtime" "$staged_bundle/runtime"
  ln -s "../../$deps_name/computer-tools" "$staged_bundle/cli/computer-tools"
  chmod 755 "$staged_bundle/cli/linger-computer" "$staged_bundle/daemon/linger-computer-daemon"
  printf '%s\n' "$app_sha256" > "$staged_bundle/app-sha256"
  chmod 600 "$staged_bundle/app-sha256"
  if ! smoke_cli "$staged_bundle/cli/linger-computer"; then
    printf '%s\n' 'Artifact failed its CLI smoke test.' >&2
    exit 1
  fi
  new_release_label="$(release_label "$staged_bundle")"
}

verify_product_node() {
  local executable="$1"
  local label="$2"
  local diagnostic_file="$temporary_directory/node-runtime-diagnostic"
  local version=""
  if version="$("$executable" --version 2>"$diagnostic_file")" && [[ "$version" == v* ]]; then
    return 0
  fi
  if grep -Fq 'libatomic.so.1' "$diagnostic_file" 2>/dev/null; then
    printf '%s\n' 'Local Computer on Linux requires libatomic.so.1. Install it first (Ubuntu/Debian: sudo apt-get install libatomic1; Fedora/RHEL: sudo dnf install libatomic).' >&2
  else
    printf '%s does not run.\n' "$label" >&2
  fi
  return 1
}

staged_reused=0
step_begin 1 'Checking the installed version'
if [[ "$install_stage_only" == activate ]]; then
  load_staged_upgrade
else
  resolve_release
  if is_current_install; then
    if [[ "$install_stage_only" != prepare ]]; then
      if [[ -L "$web_origin_file" ]] || [[ ! -f "$web_origin_file" ]] || [[ "$(sed -n '1p' "$web_origin_file")" != "$web_origin" ]]; then
        write_private_value "$web_origin_file" "$web_origin"
      fi
      if ! is_stage_mode; then write_launcher; fi
      rm -rf "$staged_upgrade_directory"
    fi
    success=1
    step_end 'up to date'
    printf 'Linger Computer is already up to date.\n'
    show_next_steps
    exit 0
  fi
  if [[ "$install_stage_only" == prepare ]]; then
    assert_safe_staged_upgrade_directory
    if [[ "$(bundle_app_sha256 "$staged_upgrade_directory" 2>/dev/null || true)" == "$app_sha256" ]] &&
      [[ "$(bundle_deps_directory "$staged_upgrade_directory")" == "deps-${deps_sha256:0:16}" ]]; then
      staged_reused=1
      staged_bundle="$staged_upgrade_directory"
      installer_node="$staged_bundle/runtime/bin/node"
      new_release_label="$(release_label "$staged_bundle")"
    else
      rm -rf "$staged_upgrade_directory"
    fi
  fi
  if (( staged_reused == 0 )); then
    if [[ -f "$active_bundle_file" ]]; then step_end; else step_end 'not installed'; fi
    download_files=("$app_archive")
    deps_reusable || download_files=("$deps_archive" "$app_archive")
    step_begin 2 'Downloading the package' "${download_files[@]}"
    if ! deps_reusable; then
      fetch_archive "$deps_archive_source" "$deps_archive" "$max_deps_archive_bytes" || exit
    fi
    fetch_archive "$app_archive_source" "$app_archive" "$max_app_archive_bytes" || exit
    step_begin 3 'Verifying the package'
    install_deps
    installer_node="$deps_directory/runtime/bin/node"
    verify_product_node "$installer_node" "Local Computer dependency runtime" || exit 1
    stage_app_bundle
  fi
fi

if [[ -f "$active_bundle_file" ]] && [[ ! -L "$active_bundle_file" ]]; then
  cp "$active_bundle_file" "$old_active_bundle_file"
  read -r old_active_bundle_name < "$active_bundle_file" || true
fi
if [[ -n "$old_active_bundle_name" ]] && [[ ! "$old_active_bundle_name" =~ ^lib-[0-9A-Za-z._-]+$ ]]; then
  printf '%s\n' 'Installed bundle metadata is invalid.' >&2
  exit 1
fi
if [[ -n "$old_active_bundle_name" ]] && { [[ ! -d "$data_root/$old_active_bundle_name" ]] || [[ -L "$data_root/$old_active_bundle_name" ]]; }; then
  printf '%s\n' 'Installed bundle path is unsafe or missing.' >&2
  exit 1
fi
if [[ -n "$old_active_bundle_name" ]] && [[ -d "$data_root/$old_active_bundle_name" ]]; then
  # runtime/bin/node may sit behind the bundle's runtime dependency link.
  for required in cli/linger-computer daemon/linger-computer-daemon runtime/bin/node; do
    if [[ -L "$data_root/$old_active_bundle_name/$required" ]] || { [[ -e "$data_root/$old_active_bundle_name/$required" ]] && [[ ! -f "$data_root/$old_active_bundle_name/$required" ]]; }; then
      printf 'Installed bundle entry is unsafe: %s\n' "$required" >&2
      exit 1
    fi
  done
  if [[ -L "$data_root/$old_active_bundle_name/runtime" ]] && ! bundle_deps_directory "$data_root/$old_active_bundle_name" >/dev/null; then
    printf '%s\n' 'Installed bundle dependency links are unsafe.' >&2
    exit 1
  fi
  old_lifecycle_cli="$data_root/$old_active_bundle_name/cli/linger-computer"
fi

# run_old_cli runs the installed bundle's CLI once verify_old_lifecycle_cli
# has kept it.
run_old_cli() {
  [[ -n "$old_lifecycle_cli" ]] || return 1
  "$old_lifecycle_cli" "$@"
}

run_old_daemon() {
  run_old_cli daemon "$@"
}

run_staged_cli() {
  "$staged_bundle/cli/linger-computer" "$@"
}

run_staged_daemon() {
  run_staged_cli daemon "$@"
}

# verify_old_lifecycle_cli decides whether the installed bundle's CLI may stop
# its daemon, and clears it otherwise. The owner-only install root is the trust
# boundary; a bundle with a valid app-sha256 and dependency links is also
# complete enough to roll back to.
verify_old_lifecycle_cli() {
  if bundle_app_sha256 "$data_root/$old_active_bundle_name" >/dev/null 2>&1; then
    old_bundle_verified=1
  fi
  if [[ -z "$old_lifecycle_cli" ]] || [[ ! -f "$old_lifecycle_cli" ]] || [[ -L "$old_lifecycle_cli" ]] || [[ ! -x "$old_lifecycle_cli" ]]; then
    old_lifecycle_cli=""
    return 1
  fi
}

parse_daemon_state() {
  "$installer_node" -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      let value;
      try { value = JSON.parse(input); } catch {}
      const reject = (reason) => {
        reason ??= typeof value?.error?.message === "string" && value.error.message.trim() ? value.error.message.trim() : "the installed CLI could not run";
        process.stderr.write(`Unable to verify the Computer daemon state: ${reason}. The existing installation was preserved.\n`);
        process.exit(1);
      };
      const fs = require("node:fs");
      // A Computer that never logged in has no daemon to stop. A lock in the
      // default state directory means a daemon started before its
      // configuration disappeared, so that case still fails closed.
      if (value?.config?.configured === false) {
        if (fs.existsSync(process.argv[2])) reject(`configuration is missing but ${process.argv[2]} exists`);
        process.stdout.write("stopped 0\n");
        return;
      }
      try {
        const daemon = value?.daemon;
        if (!value || value.error?.category === "configuration") reject();
        const state = daemon?.state;
        const activeOperations = daemon?.active_operations ?? 0;
        if (typeof state !== "string" || state.length === 0) reject();
        if (!Number.isSafeInteger(activeOperations) || activeOperations < 0) reject();
        if (!fs.existsSync(process.argv[1])) {
          fs.writeFileSync(process.argv[1], JSON.stringify({
            runtimes: (value.runtimes ?? []).filter(item => item.status === "ready").map(item => item.type ?? item.runtime_type),
            runners: (value.runners ?? []).filter(item => ["ready", "running", "idle"].includes(item.state)).map(item => item.agent_id),
          }), { mode: 0o600, flag: "wx" });
        }
        process.stdout.write(`${state} ${activeOperations}\n`);
      } catch {
        reject();
      }
    });
  ' "$old_readiness_file" "$data_root/state/daemon.lock"
}

# read_daemon_state prints "<state> <active operations>" from the status of
# the given daemon command runner.
read_daemon_state() {
  local status_output
  status_output="$("$1" status --json 2>/dev/null || true)"
  printf '%s' "$status_output" | parse_daemon_state
}

# stop_idle_daemon refuses while an Operation is active, then stops a running
# daemon with the given command runner only if it is idle and confirms it stopped.
stop_idle_daemon() {
  local cli_runner="$1" daemon_state daemon_state_line active_operations operation_noun stop_output=""
  # Captured, not a process substitution, so a refusal stops the installer.
  daemon_state_line="$(read_daemon_state "$cli_runner")" || exit 1
  read -r daemon_state active_operations <<< "$daemon_state_line"
  if (( active_operations > 0 )); then
    operation_noun="Operations are"
    if (( active_operations == 1 )); then operation_noun="Operation is"; fi
    printf 'Cannot upgrade while %s Agent %s active. Wait for it to finish or stop it explicitly.\n' "$active_operations" "$operation_noun" >&2
    exit 1
  fi
  [[ "$daemon_state" != "stopped" ]] || return 0
  was_running=1
  if ! stop_output="$("$cli_runner" stop --if-idle 2>&1)"; then
    [[ -z "$stop_output" ]] || printf '%s\n' "$stop_output" >&2
    printf '%s\n' 'Unable to stop the Computer daemon; the existing installation was preserved.' >&2
    exit 1
  fi
  daemon_stopped=1
  daemon_state_line="$(read_daemon_state "$cli_runner")" || exit 1
  read -r daemon_state active_operations <<< "$daemon_state_line"
  if [[ "$daemon_state" != "stopped" ]]; then
    printf '%s\n' 'Computer daemon did not stop completely; the existing installation was preserved.' >&2
    exit 1
  fi
}

step_begin 4 'Installing'
if is_stage_mode; then
  if [[ ! "$old_active_bundle_name" =~ ^lib-[0-9A-Za-z._-]+$ ]] || [[ ! -d "$data_root/$old_active_bundle_name" ]]; then
    printf '%s\n' 'Staged Computer upgrade requires an existing installation.' >&2
    exit 1
  fi
fi
if ! is_stage_mode && [[ -e "$launcher" ]]; then
  if [[ ! -f "$launcher" ]] || [[ -L "$launcher" ]] || [[ ! -x "$launcher" ]]; then
    printf 'Existing %s launcher is not a safe executable; the installation was preserved.\n' "$command_name" >&2
    exit 1
  fi
  cp -p "$launcher" "$old_launcher"
fi
if ! is_stage_mode && [[ -e "$launcher" ]] && [[ -z "$old_active_bundle_name" ]] && ! is_managed_launcher; then
  printf 'Existing %s launcher is not owned by this installation; it was preserved.\n' "$command_name" >&2
  exit 1
fi
# A managed launcher without its bundle is a deleted installation whose daemon
# may still run; nothing left can stop it, so do not install over it.
if ! is_stage_mode && [[ -e "$launcher" ]] && [[ -z "$old_active_bundle_name" ]]; then
  printf 'The previous Local Computer installation is incomplete, so the installer cannot stop its daemon. Stop any running linger-computer-daemon process, remove the orphan launcher at %s, and run the installer again.\n' "$launcher" >&2
  exit 1
fi
if [[ -e "$launcher" ]] || [[ -n "$old_active_bundle_name" ]]; then
  installation_action="upgraded"
  # An unverified lifecycle CLI is never run; the state checks below then fail closed.
  if verify_old_lifecycle_cli; then
    old_release_label="$(run_old_cli version 2>/dev/null | sed 's/^linger-computer //' || true)"
    progress_note "$(printf 'Upgrade available: %s -> %s (digest %s).' "$old_release_label" "$new_release_label" "${app_sha256:0:12}")"
  fi
  if is_stage_mode; then
    if (( old_bundle_verified != 1 )); then
      printf '%s\n' 'The installed Computer bundle could not be verified; the staged upgrade was refused.' >&2
      exit 1
    fi
  elif [[ -z "$old_lifecycle_cli" ]] && (( old_bundle_verified == 1 )); then
    # A verified bundle from before the Go CLI has no lifecycle CLI to run;
    # the staged verified CLI controls the same Daemon over its control socket.
    stop_idle_daemon run_staged_daemon
  else
    stop_idle_daemon run_old_daemon
  fi
elif [[ -f "$data_root/config.json" ]] && [[ ! -L "$data_root/config.json" ]]; then
    # The isolated install root already has an enrollment, but has no launcher or bundle written by this installer yet.
  progress_note 'Existing Computer configuration found; installing the managed package in place.'
  stop_idle_daemon run_staged_daemon
fi

if [[ "$install_stage_only" == prepare ]]; then
  if (( staged_reused == 0 )); then
    persist_staged_upgrade
  fi
  success=1
  printf 'Staged linger-computer %s for the next switch; the running Computer was not changed.\n' "$new_release_label"
  exit 0
fi

new_bundle_name="lib-${app_sha256:0:16}-$$"
new_bundle="$data_root/$new_bundle_name"
switched=1
mv "$staged_bundle" "$new_bundle"
if [[ "$installer_node" == "$staged_bundle/"* ]]; then
  installer_node="$new_bundle/runtime/bin/node"
fi
if [[ "$install_stage_only" == 1 ]] || [[ "$install_stage_only" == activate ]]; then
  write_upgrade_pending "$old_active_bundle_name"
fi
write_active_bundle "$new_bundle_name"

# The running daemon owns a bundle root, not a shell command directory.
installed_cli="$new_bundle/cli/linger-computer"
if ! is_stage_mode; then
  write_launcher
  installed_cli="$launcher"
fi

if ! smoke_cli "$installed_cli"; then
  printf '%s\n' 'Installed CLI failed its smoke test.' >&2
  exit 1
fi
write_private_value "$web_origin_file" "$web_origin"

if (( was_running == 1 )); then
  new_daemon_start_attempted=1
  if ! "$launcher" daemon start >/dev/null; then
    printf '%s\n' 'The upgraded daemon failed to restart.' >&2
    exit 1
  fi
  if ! "$new_bundle/runtime/bin/node" -e '
    const { execFile } = require("node:child_process");
    const { promisify } = require("node:util");
    const { setTimeout: delay } = require("node:timers/promises");
    const execute = promisify(execFile);
    (async () => {
      const baseline = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
      const deadline = Date.now() + 30000;
      let missing = ["status=unavailable"];
      while (Date.now() < deadline) {
        let status;
        let report;
        try {
          const { stdout } = await execute(process.argv[1], ["daemon", "status", "--json"], { timeout: 3000, maxBuffer: 1048576 });
          report = JSON.parse(stdout);
          status = report.daemon;
        } catch {}
        const label = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(value) ? value : "unknown";
        missing = [];
        if (!status) missing.push("status=unavailable");
        if (status?.state !== "running") missing.push(`daemon=${label(status?.state)}`);
        if (status?.gateway_state !== "connected") missing.push(`gateway=${label(status?.gateway_state)}`);
        if (status?.reconciled !== true) missing.push("reconciliation=not-confirmed (runner.reconciled receipt required; verify the configured Gateway server supports reconciliation_receipt)");
        for (const type of baseline.runtimes) {
          if (!report?.runtimes?.some(item => (item.type ?? item.runtime_type) === type && item.status === "ready")) missing.push(`runtime=${label(type)}:not-ready`);
        }
        for (const agentId of baseline.runners) {
          if (!report?.runners?.some(item => item.agent_id === agentId && ["ready", "running", "idle"].includes(item.state))) missing.push(`runner=${label(agentId)}:not-ready`);
        }
        if (missing.length === 0) return;
        if (["authentication-failed", "upgrade-required"].includes(status?.gateway_state)) break;
        await delay(250);
      }
      console.error(`Upgrade readiness missing: ${missing.join("; ")}`);
      process.exitCode = 1;
    })().catch(() => { console.error("Upgrade readiness check failed; status could not be verified."); process.exitCode = 1; });
  ' "$launcher" "$old_readiness_file"; then
    printf 'The upgraded daemon did not reconnect to Runner Gateway with reconciled, available Runtimes within 30s; rolling back. See %s.\n' "$(daemon_log_file)" >&2
    exit 1
  fi
fi

success=1
rm -rf "$staged_upgrade_directory"
# Keep the new and the previous bundle, and the dependency directories they
# link to; the previous one is what a Daemon rollback returns to.
previous_bundle_to_keep="$new_bundle_name"
if [[ "$old_active_bundle_name" == lib-* ]]; then
  previous_bundle_to_keep="$old_active_bundle_name"
fi
new_deps_to_keep="$(bundle_deps_directory "$new_bundle")"
previous_deps_to_keep="$(bundle_deps_directory "$data_root/$previous_bundle_to_keep" 2>/dev/null || printf '%s' "$new_deps_to_keep")"
find "$data_root" -mindepth 1 -maxdepth 1 -type d -name 'lib-*' ! -name "$new_bundle_name" ! -name "$previous_bundle_to_keep" -exec rm -rf {} +
find "$data_root" -mindepth 1 -maxdepth 1 -type d -name 'deps-*' ! -name "$new_deps_to_keep" ! -name "$previous_deps_to_keep" -exec rm -rf {} +
step_end
elapsed="$(format_duration "$((SECONDS - installer_started))")"
if [[ "$installation_action" == "upgraded" ]]; then
  printf 'Linger Computer upgraded from %s to %s in %s.\n' "$old_release_label" "$new_release_label" "$elapsed"
else
  printf 'Linger Computer %s installed in %s.\n' "$new_release_label" "$elapsed"
fi
show_next_steps
