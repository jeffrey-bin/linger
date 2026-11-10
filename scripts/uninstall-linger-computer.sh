#!/usr/bin/env bash
set -euo pipefail

# Uninstalls the Computer of the Web origin's environment. The Agent Service
# renders the origin when serving this file.
web_origin="${LINGER_WEB_URL:-http://localhost:3000}"

purge=0
if [[ "${1:-}" == "--purge" ]]; then
  purge=1
  shift
fi
if (( $# > 0 )); then
  printf '%s\n' 'Usage: uninstall-linger-computer.sh [--purge]' >&2
  exit 2
fi

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

environment_name="$(computer_environment_name "$web_origin")"
home_directory="${HOME:?HOME is required}"
bin_directory="${LINGER_COMPUTER_BIN_DIR:-$home_directory/.local/bin}"
command_name="linger-computer-$environment_name"
launcher="$bin_directory/$command_name"
dispatcher="$bin_directory/linger-computer"
launcher_marker='# linger-computer-launcher-v2'

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
install_lock="$data_root/.install.lock"
active_bundle_file="$data_root/active-bundle"
config_file="$data_root/config.json"
product_node=""

if [[ "$data_root" != /* ]] || [[ "$data_root" == "/" ]] || [[ "$data_root" == "$home_directory" ]] || [[ "$bin_directory" != /* ]] || [[ -L "$data_root" ]]; then
  printf '%s\n' 'Uninstall destination is unsafe.' >&2
  exit 1
fi

if [[ -d "$install_lock" ]]; then
  owner_pid=""
  if [[ -f "$install_lock/pid" ]]; then
    read -r owner_pid < "$install_lock/pid" || true
  fi
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    printf '%s\n' 'Cannot uninstall while an installation is active.' >&2
    exit 1
  fi
fi

# resolve_product_node uses the active bundle's runtime, which the installer
# links to its verified dependency directory.
resolve_product_node() {
  local active_bundle_name runtime_path
  [[ -f "$active_bundle_file" ]] && [[ ! -L "$active_bundle_file" ]] || return 1
  read -r active_bundle_name < "$active_bundle_file" || return 1
  [[ "$active_bundle_name" =~ ^lib-[0-9A-Za-z._-]+$ ]] || return 1
  runtime_path="$data_root/$active_bundle_name/runtime/bin/node"
  [[ -f "$runtime_path" ]] && [[ ! -L "$runtime_path" ]] && [[ -x "$runtime_path" ]] || return 1
  product_node="$runtime_path"
}

require_owner_only_config() {
  if [[ ! -e "$config_file" ]] && [[ ! -L "$config_file" ]]; then
    return
  fi
  if ! "$product_node" -e '
    const fs = require("node:fs");
    try {
      const metadata = fs.lstatSync(process.argv[1]);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.uid !== process.getuid?.() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o777) !== 0o600
      ) {
        process.exit(1);
      }
    } catch {
      process.exit(1);
    }
  ' "$config_file"; then
    printf '%s\n' 'Local Computer config is not a safe owner-only regular file; installed files were preserved.' >&2
    exit 1
  fi
}

# CLIs before the daemon command group take lifecycle commands at the top level.
run_daemon_cli() {
  if "$launcher" daemon --help >/dev/null 2>&1; then
    "$launcher" daemon "$@"
  else
    "$launcher" "$@"
  fi
}

read_daemon_state() {
  local status_output
  status_output="$(run_daemon_cli status --json 2>/dev/null || true)"
  if ! printf '%s' "$status_output" | "$product_node" -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const report = JSON.parse(input);
        const state = report?.daemon?.state;
        if (typeof state !== "string" || state.length === 0) process.exit(1);
        if (report?.config?.configured === false) {
          if (state !== "error") process.exit(1);
          process.stdout.write("unconfigured");
          return;
        }
        process.stdout.write(state);
      } catch {
        process.exit(1);
      }
    });
  '; then
    printf '%s\n' 'Unable to verify that the Computer daemon is stopped; installed files were preserved.' >&2
    exit 1
  fi
}

recover_owned_processes() {
  if ! "$product_node" - "$config_file" "$data_root/state" <<'NODE'
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [configPath, defaultStateDirectory] = process.argv.slice(2);
const currentUid = process.getuid?.();
if (currentUid === undefined) process.exit(1);

const missing = (error) =>
  error && (error.code === "ENOENT" || error.code === "ENOTDIR");
const safeRegularFile = (filePath) => {
  const initial = fs.lstatSync(filePath);
  if (
    initial.isSymbolicLink() ||
    !initial.isFile() ||
    initial.uid !== currentUid ||
    initial.nlink !== 1 ||
    (initial.mode & 0o777) !== 0o600
  ) {
    throw new Error("unsafe ownership file");
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.uid !== currentUid ||
      opened.nlink !== 1 ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size > 1024 * 1024
    ) {
      throw new Error("unsafe ownership file");
    }
    const content = fs.readFileSync(descriptor, "utf8");
    const final = fs.lstatSync(filePath);
    if (
      final.isSymbolicLink() ||
      !final.isFile() ||
      final.uid !== currentUid ||
      final.nlink !== 1 ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      (final.mode & 0o777) !== 0o600
    ) {
      throw new Error("unsafe ownership file");
    }
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
};
const safeDirectory = (directory) => {
  const metadata = fs.lstatSync(directory);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== currentUid ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("unsafe ownership directory");
  }
};
const exactKeys = (value, keys) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const processIdentity = (value) => {
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !Number.isSafeInteger(value.processGroupId) ||
    value.processGroupId !== value.pid ||
    typeof value.startTime !== "string" ||
    value.startTime.length === 0
  ) {
    throw new Error("invalid process identity");
  }
  return {
    pid: value.pid,
    processGroupId: value.processGroupId,
    startTime: value.startTime,
  };
};
const daemonIdentity = (value) => {
  if (
    !exactKeys(value, ["nonce", "pid", "processGroupId", "startTime"]) ||
    typeof value.nonce !== "string" ||
    value.nonce.length === 0
  ) {
    throw new Error("invalid Daemon ownership record");
  }
  return processIdentity(value);
};
const runnerIdentity = (value, ownerToken) => {
  if (
    !exactKeys(value, ["identity", "ownerToken", "version"]) ||
    value.version !== 1 ||
    value.ownerToken !== ownerToken ||
    !exactKeys(value.identity, ["pid", "processGroupId", "startTime"])
  ) {
    throw new Error("invalid Runner ownership record");
  }
  return processIdentity(value.identity);
};

let config = {};
try {
  config = JSON.parse(safeRegularFile(configPath));
} catch (error) {
  if (!missing(error)) throw error;
}
const stateDirectory =
  typeof config.state_directory === "string"
    ? config.state_directory
    : defaultStateDirectory;
if (
  !path.isAbsolute(stateDirectory) ||
  stateDirectory === path.parse(stateDirectory).root
) {
  process.exit(1);
}

const readLinuxProcesses = () => {
  const records = [];
  for (const entryName of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entryName)) continue;
    const pid = Number(entryName);
    try {
      const stat = fs.readFileSync(`/proc/${entryName}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const firstSpace = stat.indexOf(" ");
      if (firstSpace < 1 || close <= firstSpace) throw new Error("invalid stat");
      const fields = stat.slice(close + 1).trim().split(/\s+/);
      const record = {
        pid,
        parentPid: Number(fields[1]),
        processGroupId: Number(fields[2]),
        state: fields[0],
        startTime: fields[19],
        args: fs.readFileSync(`/proc/${entryName}/cmdline`, "utf8").split("\0"),
      };
      if (
        Number.isSafeInteger(record.parentPid) &&
        Number.isSafeInteger(record.processGroupId) &&
        typeof record.startTime === "string" &&
        record.startTime.length > 0 &&
        !record.state.startsWith("Z")
      ) {
        records.push(record);
      }
    } catch (error) {
      if (!missing(error) && error.code !== "ESRCH") throw error;
    }
  }
  return records;
};
const readPosixProcesses = () =>
  execFileSync(
    "/bin/ps",
    ["-ww", "-axo", "pid=,ppid=,pgid=,state=,lstart=,command="],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, LC_ALL: "C" },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 1000,
    },
  )
    .split("\n")
    .flatMap((line) => {
      const match =
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+((?:\S+\s+){4}\S+)\s+(.*)$/.exec(
          line,
        );
      if (!match || match[4].startsWith("Z")) return [];
      return [{
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        state: match[4],
        startTime: match[5],
        args: match[6].split(/\s+/),
      }];
    });
const snapshot = () =>
  process.platform === "linux" ? readLinuxProcesses() : readPosixProcesses();
const sameIdentity = (left, right) =>
  left.pid === right.pid &&
  left.processGroupId === right.processGroupId &&
  left.startTime === right.startTime;
const processExists = (identity) =>
  snapshot().some((candidate) => sameIdentity(candidate, identity));
const sleep = (milliseconds) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
const signal = (pid, name) => {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const ownedProcesses = (expected) => {
  const records = snapshot();
  const root = records.find((record) => record.pid === expected.pid);
  if (root && !sameIdentity(root, expected)) return [];
  if (root && root.processGroupId !== root.pid) {
    throw new Error("owned process does not lead its process group");
  }
  const group = records.filter(
    (record) => record.processGroupId === expected.processGroupId,
  );
  if (!root && group.length === 0) return [];
  return root ? group : group.filter((record) => record.pid !== expected.pid);
};
const terminate = (expected) => {
  const tracked = ownedProcesses(expected);
  if (tracked.length === 0) return;
  for (const [signalName, timeout] of [["SIGTERM", 1000], ["SIGKILL", 2000]]) {
    const deadline = Date.now() + timeout;
    while (tracked.some(processExists)) {
      const currentRoot = snapshot().find((record) => record.pid === expected.pid);
      if (currentRoot && sameIdentity(currentRoot, expected)) {
        signal(-expected.processGroupId, signalName);
      } else {
        for (const processRecord of tracked) {
          if (processExists(processRecord)) signal(processRecord.pid, signalName);
        }
      }
      if (Date.now() >= deadline) break;
      sleep(25);
    }
    if (!tracked.some(processExists)) return;
  }
  throw new Error(`owned process ${expected.pid} did not exit`);
};

try {
  safeDirectory(stateDirectory);
} catch (error) {
  if (missing(error)) process.exit(0);
  throw error;
}

const identities = [];
const daemonLockDirectory = path.join(stateDirectory, "daemon.lock");
const ownerPath = path.join(daemonLockDirectory, "owner.json");
try {
  safeDirectory(daemonLockDirectory);
  identities.push(daemonIdentity(JSON.parse(safeRegularFile(ownerPath))));
} catch (error) {
  if (!missing(error)) throw error;
}

const canonicalStateDirectory = fs.realpathSync.native(stateDirectory);
const ownerToken = createHash("sha256")
  .update(canonicalStateDirectory)
  .digest("hex");
const ownerArgument = `--linger-computer-owner=${ownerToken}`;
const registryDirectory = path.join(stateDirectory, "runner-processes");
const registryRecords = [];
try {
  safeDirectory(registryDirectory);
  for (const entry of fs.readdirSync(registryDirectory, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    const recordPath = path.join(registryDirectory, entry.name);
    const record = JSON.parse(safeRegularFile(recordPath));
    identities.push(runnerIdentity(record, ownerToken));
    registryRecords.push(recordPath);
  }
} catch (error) {
  if (!missing(error)) throw error;
}
for (const record of snapshot()) {
  if (record.args.includes(ownerArgument)) {
    identities.push(processIdentity(record));
  }
}
const unique = new Map(
  identities.map((identity) => [`${identity.pid}:${identity.startTime}`, identity]),
);
const stillRunningDeadline = Date.now() + 3000;
for (const identity of unique.values()) {
  terminate(identity);
  while (processExists(identity)) {
    if (Date.now() >= stillRunningDeadline) {
      throw new Error("owned process is still running");
    }
    terminate(identity);
    sleep(25);
  }
}
for (const recordPath of registryRecords) fs.rmSync(recordPath);
NODE
  then
    printf '%s\n' 'Unable to verify and stop all owned Computer processes; installed files were preserved.' >&2
    exit 1
  fi
}

installed_bundle="$(find "$data_root" -maxdepth 1 -type d -name 'lib-*' -print -quit 2>/dev/null || true)"
if [[ -e "$launcher" ]] || [[ -L "$launcher" ]]; then
  if [[ ! -f "$launcher" ]] || [[ -L "$launcher" ]] || [[ ! -x "$launcher" ]]; then
    printf '%s\n' 'Unable to verify the Computer daemon because the launcher is not a safe executable; installed files were preserved.' >&2
    exit 1
  fi
elif [[ -e "$active_bundle_file" ]] || [[ -L "$active_bundle_file" ]] || [[ -n "$installed_bundle" ]]; then
  printf '%s\n' 'Unable to verify the Computer daemon because the launcher is missing; installed files were preserved.' >&2
  exit 1
fi

if [[ -x "$launcher" ]]; then
  if ! resolve_product_node; then
    printf '%s\n' 'Unable to verify the bundled product runtime; installed files were preserved.' >&2
    exit 1
  fi
  require_owner_only_config
  daemon_state="$(read_daemon_state)"
  if [[ "$daemon_state" != "unconfigured" ]]; then
    if ! run_daemon_cli stop >/dev/null; then
      printf '%s\n' 'Unable to stop the Computer daemon; installed files were preserved.' >&2
      exit 1
    fi
  fi
  recover_owned_processes
  if [[ "$daemon_state" != "unconfigured" ]]; then
    daemon_state="$(read_daemon_state)"
    if [[ "$daemon_state" != "stopped" ]]; then
      printf '%s\n' 'Computer daemon did not stop completely; installed files were preserved.' >&2
      exit 1
    fi
  fi
fi

rm -f "$launcher"
# linger-computer only dispatches to environment launchers; drop it with the last one.
remaining_launcher="$(grep -Flx "$launcher_marker" "$bin_directory"/linger-computer-* 2>/dev/null | head -n 1 || true)"
if [[ -z "$remaining_launcher" ]] && [[ -f "$dispatcher" ]] && [[ ! -L "$dispatcher" ]] &&
  grep -Fqx '# linger-computer-dispatcher-v1' "$dispatcher"; then
  rm -f "$dispatcher"
fi
rm -rf "$data_root/lib"
find "$data_root" -mindepth 1 -maxdepth 1 -type d \( -name 'lib-*' -o -name 'deps-*' -o -name '.bundle.*' -o -name '.deps.*' \) -exec rm -rf {} + 2>/dev/null || true
rm -rf "$data_root/staged-upgrade"
rm -f "$data_root/active-bundle" "$data_root/upgrade-pending" "$data_root/upgrade-failed"
rm -rf "$install_lock"

if (( purge == 1 )); then
  rm -rf "$data_root"
  printf 'Uninstalled %s (%s) and purged its Local Computer data.\n' "$command_name" "$web_origin"
else
  printf 'Uninstalled %s (%s). Config, credentials, state, and logs were preserved in %s.\n' "$command_name" "$web_origin" "$data_root"
fi
