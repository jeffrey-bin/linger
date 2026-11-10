import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertLocalMessageEvidence } from "./local-runner-message-evidence.mjs";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const fixture = () => ({
  expected: {
    agentId: "agent-fixture",
    roomId: "room-fixture",
    runId: "run-fixture",
    operationId: "operation-fixture",
    finalText: "FINAL_OK",
  },
  runtime: {
    runs: [
      { agent_id: "agent-fixture", run_id: "run-fixture", status: "succeeded" },
    ],
    operation_receipts: [
      {
        agent_id: "agent-fixture",
        run_id: "run-fixture",
        operation_id: "operation-fixture",
      },
    ],
  },
  report: [
    {
      type: "agent.messages.published",
      agent_id: "agent-fixture",
      room_id: "room-fixture",
      transport: "teamhub-cli",
      message_id: "message-final",
      command_operation_id: "cli-final",
      body_sha256: digest("FINAL_OK"),
      idempotency_key_present: true,
    },
  ],
});
describe("Local CLI final message evidence", () => {
  it("verifies retained reports through the smoke's command-line entrypoint", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sx-message-proof-"));
    try {
      const value = fixture();
      writeFileSync(
        path.join(directory, "events"),
        value.report.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      writeFileSync(
        path.join(directory, "runtime"),
        JSON.stringify(value.runtime),
      );
      const result = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, "local-runner-message-evidence.mjs"),
          path.join(directory, "events"),
          path.join(directory, "runtime"),
          value.expected.agentId,
          value.expected.roomId,
          value.expected.runId,
          value.expected.operationId,
          value.expected.finalText,
        ],
        { encoding: "utf8" },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        publication_count: 1,
        runtime_succeeded: true,
        transport: "teamhub-cli",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("proves the independent command result and successful Local execution", () => {
    expect(assertLocalMessageEvidence(fixture())).toMatchObject({
      publication_count: 1,
      final_message_id: "message-final",
      runtime_succeeded: true,
    });
  });
  it("does not mix previous responses into the exact final result", () => {
    const value = fixture();
    value.report.unshift({
      ...value.report[0],
      message_id: "previous",
      command_operation_id: "previous",
      body_sha256: digest("PREVIOUS_OK"),
    });
    expect(assertLocalMessageEvidence(value).publication_count).toBe(1);
  });
  it.each([
    "missing-final",
    "duplicated-final",
    "wrong-agent",
    "wrong-room",
    "failed-run",
    "wrong-operation",
    "missing-operation",
    "missing-provenance",
    "retired-authority",
  ])("rejects %s", (failure) => {
    const value = fixture();
    switch (failure) {
      case "missing-final":
        value.report = [];
        break;
      case "duplicated-final":
        value.report.push({
          ...value.report[0],
          message_id: "replayed",
          command_operation_id: "later-run",
        });
        break;
      case "wrong-agent":
        value.report[0].agent_id = "other";
        break;
      case "wrong-room":
        value.report[0].room_id = "other";
        break;
      case "failed-run":
        value.runtime.runs[0].status = "failed";
        break;
      case "wrong-operation":
        value.runtime.operation_receipts[0].run_id = "other";
        break;
      case "missing-operation":
        value.runtime.operation_receipts = [];
        break;
      case "missing-provenance":
        value.report[0].command_operation_id = "";
        break;
      case "retired-authority":
        Object.assign(value.report[0], { execution_run_ref: "run-fixture" });
        break;
    }
    expect(() => assertLocalMessageEvidence(value)).toThrow();
  });
  it("does not print credential-shaped malformed input", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "sx-message-evidence-"),
    );
    try {
      writeFileSync(
        path.join(directory, "events"),
        "invalid-json fixture-secret",
      );
      writeFileSync(path.join(directory, "runtime"), "{}");
      const result = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, "local-runner-message-evidence.mjs"),
          path.join(directory, "events"),
          path.join(directory, "runtime"),
          "agent",
          "room",
          "run",
          "operation",
          "FINAL",
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "Local message evidence failed: INVALID_INPUT\n",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
