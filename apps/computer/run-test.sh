#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  echo "Usage: bash apps/computer/run-test.sh <command> [args...]" >&2
  exit 2
fi

case ${COMPUTER_TEST_ISOLATION:-auto} in
  off) exec "$@" ;;
  auto)
    host_platform=$(uname -s)
    if [[ $host_platform != Linux || ${CI:-} == true || ${CI:-} == 1 ]]; then
      exec "$@"
    fi
    ;;
  on)
    host_platform=$(uname -s)
    if [[ $host_platform != Linux ]]; then
      echo "Computer PID isolation requires Linux." >&2
      exit 1
    fi
    ;;
  *)
    echo "COMPUTER_TEST_ISOLATION must be auto, on, or off." >&2
    exit 2
    ;;
esac

init_command=$(command -v tini || command -v docker-init || true)
if ! command -v unshare >/dev/null || [[ -z "$init_command" ]]; then
  echo "Computer tests require util-linux unshare and tini (or Docker's docker-init)." >&2
  echo "Install these tools; use COMPUTER_TEST_ISOLATION=off only for an intentional host-process check." >&2
  exit 1
fi

# unshare --fork on util-linux 2.36+ ignores INT/TERM while waiting. Kill our
# sole background job on cancellation; --kill-child kills PID 1 and its tree.
cancel() {
  trap '' INT TERM
  kill -KILL %1 2>/dev/null || true
  wait 2>/dev/null || true
  exit "$1"
}
trap 'cancel 130' INT
trap 'cancel 143' TERM

echo "[computer-tests] private PID namespace (same UID, cwd and test budgets)" >&2
unshare --user --map-current-user --pid --fork --mount-proc --kill-child \
  "$init_command" -- "$@" <&0 &
wait "$!"
