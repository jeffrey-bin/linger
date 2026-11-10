#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const loginMarker = argumentValue("--linger-login-marker");
const workspaceMarker = argumentValue("--linger-workspace-marker");
removeArgument("--linger-login-marker");
removeArgument("--linger-workspace-marker");
const sessionId =
  argumentValue("--session-id") ??
  argumentValue("--resume") ??
  "claude-smoke-session";

if (!loginMarker) {
  process.stderr.write("--linger-login-marker is required\n");
  process.exit(2);
}

if (args.includes("--version")) {
  process.stdout.write("2.1.282 (Claude Code fixture)\n");
  process.exit(0);
}

if (args[0] === "auth") {
  if (args[1] !== "status" || args[2] !== "--json") {
    process.stderr.write("unsupported auth fixture command\n");
    process.exit(2);
  }
  const loggedIn = existsSync(loginMarker);
  process.stdout.write(
    `${JSON.stringify({
      loggedIn,
      authMethod: loggedIn ? "oauth" : "none",
      apiProvider: "firstParty",
    })}\n`,
  );
  process.exit(loggedIn ? 0 : 1);
}

process.stdout.write(
  `${JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: sessionId,
  })}\n`,
);

if (args.includes("--bare")) {
  const probe = createInterface({ input: process.stdin });
  for await (const line of probe) {
    const request = JSON.parse(line);
    if (
      request.type === "control_request" &&
      request.request?.subtype === "initialize"
    ) {
      process.stdout.write(
        `${JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: request.request_id,
            response: {
              models: [
                {
                  value: "claude-default",
                  displayName: "Claude fixture",
                  supportsEffort: true,
                  supportedEffortLevels: ["medium"],
                },
              ],
            },
          },
        })}\n`,
      );
      break;
    }
  }
  process.exit(0);
}

if (!existsSync(loginMarker)) {
  process.stderr.write("Claude fixture execution started before login\n");
  process.exit(3);
}

const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (
    request.type === "control_request" &&
    request.request?.subtype === "initialize"
  ) {
    process.stdout.write(
      `${JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: request.request_id,
          response: {
            models: [
              {
                value: "claude-default",
                displayName: "Claude fixture",
                supportsEffort: true,
                supportedEffortLevels: ["medium"],
              },
            ],
          },
        },
      })}\n`,
    );
    continue;
  }
  if (request.type !== "user") continue;
  // Native Claude confirms the submitted turn through a replayed user frame.
  process.stdout.write(
    `${JSON.stringify({ ...request, isReplay: true, session_id: sessionId })}\n`,
  );
  const markerPath = path.join(
    process.cwd(),
    workspaceMarker ?? ".linger-smoke-marker",
  );
  const marker = readFileSync(markerPath, "utf8").trim();
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      user_message_uuid: request.uuid,
      result: `fixture complete:${marker}`,
    })}\n`,
  );
  break;
}

function argumentValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function removeArgument(name) {
  const index = args.indexOf(name);
  if (index !== -1) args.splice(index, 2);
}
