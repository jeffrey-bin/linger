import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class LocalMessageEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function assertLocalMessageEvidence({ report, runtime, expected }) {
  if (
    !Array.isArray(report) ||
    !Array.isArray(runtime?.runs) ||
    !Array.isArray(runtime?.operation_receipts) ||
    !expected ||
    ![
      expected.agentId,
      expected.roomId,
      expected.runId,
      expected.operationId,
      expected.finalText,
    ].every(nonEmptyString)
  )
    fail("INVALID_INPUT");
  const run = runtime.runs.find((row) => row.run_id === expected.runId);
  const operation = runtime.operation_receipts.find(
    (row) => row.operation_id === expected.operationId,
  );
  if (
    run?.agent_id !== expected.agentId ||
    run.status !== "succeeded" ||
    operation?.agent_id !== expected.agentId ||
    operation.run_id !== expected.runId
  )
    fail("RUNTIME_NOT_SUCCEEDED");
  const finalDigest = createHash("sha256")
    .update(expected.finalText)
    .digest("hex");
  const publications = report.filter(
    (row) => row?.type === "agent.messages.published",
  );
  for (const row of publications) {
    if (
      row.transport !== "teamhub-cli" ||
      ![
        row.message_id,
        row.command_operation_id,
        row.agent_id,
        row.room_id,
      ].every(nonEmptyString) ||
      !/^[a-f0-9]{64}$/.test(row.body_sha256 ?? "") ||
      row.idempotency_key_present !== true
    )
      fail("INVALID_PUBLICATION");
    if (row.execution_run_ref || row.mcp_invocation_id || row.audit_id)
      fail("RETIRED_TRANSPORT_AUTHORITY");
  }
  const finals = publications.filter((row) => row.body_sha256 === finalDigest);
  if (finals.length === 0) fail("FINAL_MESSAGE_MISSING");
  if (finals.length !== 1) fail("FINAL_MESSAGE_DUPLICATED");
  const final = finals[0];
  if (final.agent_id !== expected.agentId || final.room_id !== expected.roomId)
    fail("PUBLICATION_IDENTITY_MISMATCH");
  for (const key of ["message_id", "command_operation_id"]) {
    if (
      new Set(publications.map((row) => row[key])).size !== publications.length
    )
      fail("PUBLICATION_DUPLICATED");
  }
  return {
    agent_id: expected.agentId,
    room_id: expected.roomId,
    local_run_id: expected.runId,
    runner_operation_id: expected.operationId,
    command_operation_id: final.command_operation_id,
    publication_count: finals.length,
    final_message_id: final.message_id,
    final_body_sha256: finalDigest,
    transport: "teamhub-cli",
    runtime_succeeded: true,
  };
}

const nonEmptyString = (value) => typeof value === "string" && value.length > 0;
const fail = (code) => {
  throw new LocalMessageEvidenceError(code);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [
      reportPath,
      runtimePath,
      agentId,
      roomId,
      runId,
      operationId,
      finalText,
    ] = process.argv.slice(2);
    const report = readFileSync(reportPath, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
    const proof = assertLocalMessageEvidence({
      report,
      runtime,
      expected: { agentId, roomId, runId, operationId, finalText },
    });
    process.stdout.write(`${JSON.stringify(proof)}\n`);
  } catch (error) {
    const code =
      error instanceof LocalMessageEvidenceError ? error.code : "INVALID_INPUT";
    process.stderr.write(`Local message evidence failed: ${code}\n`);
    process.exitCode = 1;
  }
}
