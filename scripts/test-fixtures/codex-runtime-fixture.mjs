#!/usr/bin/env node

import { createInterface } from "node:readline";
import path from "node:path";

if (process.argv[2] === "--version") {
  process.stdout.write("codex-fixture 1.0.0\n");
  process.exit(0);
}

if (process.argv[2] !== "app-server") {
  process.stderr.write("unsupported fixture command\n");
  process.exit(2);
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "account/read") {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: { account: null, requiresOpenaiAuth: false } })}\n`,
    );
    return;
  }
  if (request.method === "model/list") {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: { data: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture model", isDefault: true }], nextCursor: null } })}\n`,
    );
    return;
  }
  if (request.method !== "initialize") return;
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        userAgent: "linger-computer-fixture",
        codexHome: path.join(process.env.HOME, ".codex"),
        platformFamily: process.platform,
        platformOs: process.platform,
      },
    })}\n`,
  );
});
