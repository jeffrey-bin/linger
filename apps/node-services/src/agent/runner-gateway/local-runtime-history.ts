import type { RuntimeHistoryPage } from "../executor/history.js";
import type { DebugHistoryInspectionResult } from "@linger/wire-contracts/runner-gateway/types";

/**
 * Maps a Runner Gateway History inspection result onto the shared
 * RuntimeHistoryPage used by every Provider, live or detached.
 */
export function mapLocalRuntimeHistory(
  result: DebugHistoryInspectionResult,
): RuntimeHistoryPage {
  const instructions = {
    status: result.instructions.status,
    source: result.instructions.source,
    ...(result.instructions.status === "unavailable"
      ? {
          reason:
            result.instructions.reason ??
            "Local Runtime instructions are unavailable",
        }
      : {}),
    blocks: result.instructions.blocks.map((block) => ({
      recordOrdinal: block.record_ordinal,
      recordType: block.record_type,
      field: block.field,
      ...(block.content_ordinal === undefined
        ? {}
        : { contentOrdinal: block.content_ordinal }),
      ...(block.timestamp ? { timestamp: block.timestamp } : {}),
      text: block.text,
    })),
  } as RuntimeHistoryPage["instructions"];
  if (result.status !== "available") {
    return {
      status: result.status,
      providerKind: result.provider_kind,
      reason:
        result.reason ?? "Local Runtime history inspection is unavailable",
      instructions,
      records: [],
    };
  }
  const source = result.source;
  if (
    !result.snapshot ||
    (source !== "codex_rollout" &&
      source !== "claude_transcript" &&
      source !== "pi_session")
  ) {
    throw new Error("Local Runtime returned an incomplete History page");
  }
  return {
    status: "available",
    providerKind: result.provider_kind,
    source,
    snapshot: {
      id: result.snapshot.id,
      threadId: result.snapshot.thread_id,
      capturedAt: result.snapshot.captured_at,
      recordCount: result.snapshot.record_count,
      tailState: result.snapshot.tail_state,
    },
    instructions,
    records: result.records.map((record) => ({
      ordinal: record.ordinal,
      ...(record.timestamp ? { timestamp: record.timestamp } : {}),
      ...(record.turn_id ? { turnId: record.turn_id } : {}),
      category: record.category,
      nativeType: record.native_type,
      ...(record.tool_call_id ? { toolCallId: record.tool_call_id } : {}),
      ...(record.tool_name ? { toolName: record.tool_name } : {}),
      ...(record.role ? { role: record.role } : {}),
      ...(record.phase ? { phase: record.phase } : {}),
      nativeRecord: record.native_record,
      redactedFields: record.redacted_fields.map((field) => ({
        path: field.path,
        reason: field.reason,
        ...(field.byte_count === undefined
          ? {}
          : { byteCount: field.byte_count }),
      })),
    })),
    ...(result.previous_cursor
      ? { previousCursor: result.previous_cursor }
      : {}),
  };
}
