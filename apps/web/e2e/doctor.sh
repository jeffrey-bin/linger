#!/usr/bin/env bash
set -euo pipefail

for endpoint in \
  "${PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT:-23008}/healthz" \
  "${PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT:-28089}/healthz" \
  "${PLAYWRIGHT_ROOM_DOCUMENT_CONTROL_PORT:-28088}/healthz" \
  "${PLAYWRIGHT_ROOM_DOCUMENT_RUNTIME_PORT:-24328}/readyz"; do
  printf 'GET http://127.0.0.1:%s\n' "$endpoint"
  curl --noproxy '*' --fail --silent --show-error --max-time 5 "http://127.0.0.1:$endpoint"
  printf '\n'
done
printf 'Listeners (compare PIDs with this run, not just port availability):\n'
if command -v ss >/dev/null; then
ss -ltnp | awk -v ports=":(${PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT:-23008}|${PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT:-28089}|${PLAYWRIGHT_ROOM_DOCUMENT_CONTROL_PORT:-28088}|${PLAYWRIGHT_ROOM_DOCUMENT_RUNTIME_PORT:-24328})$" '$4 ~ ports'

else
  for port in "${PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT:-23008}" "${PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT:-28089}" "${PLAYWRIGHT_ROOM_DOCUMENT_CONTROL_PORT:-28088}" "${PLAYWRIGHT_ROOM_DOCUMENT_RUNTIME_PORT:-24328}"; do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN
  done
fi
