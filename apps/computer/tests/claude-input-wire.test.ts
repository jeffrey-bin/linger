import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { parseDaemonToAgentEnvelope } from "@linger/wire-contracts/runner-gateway/validator";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")(
  "accepts actual Claude ACK and uncertain failure through the Gateway contract",
  async () => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "claude-input-wire-"),
    );
    const fixtureFile = path.join(fixtureRoot, "outcomes.json");
    try {
      await promisify(execFile)(
        "go",
        [
          "test",
          "./internal/linger/transport",
          "-run",
          "^TestClaudeInputWireOutcomes$",
          "-count=1",
        ],
        {
          cwd: fileURLToPath(new URL("../local-daemon/", import.meta.url)),
          env: {
            ...process.env,
            LINGER_CLAUDE_INPUT_WIRE_FIXTURE: fixtureFile,
          },
          timeout: 120_000,
        },
      ).catch((error: Error & { stdout?: string; stderr?: string }) => {
        throw new Error(
          [error.message, error.stdout, error.stderr]
            .filter(Boolean)
            .join("\n"),
          { cause: error },
        );
      });
      const [ack, failure] = JSON.parse(
        await readFile(fixtureFile, "utf8"),
      ).map(parseDaemonToAgentEnvelope);
      expect(ack).toMatchObject({
        type: "operation.input_result",
        outcome: "accepted",
      });
      expect(failure).toMatchObject({
        type: "operation.input_result",
        outcome: "rejected",
        effect: "uncertain",
        reason: "transport",
        expected_turn_id: ack.turn_id,
        seq: ack.seq + 1,
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  },
  130_000,
);
