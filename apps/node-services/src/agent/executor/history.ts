import { isRecord } from "@linger/service-kit";

export type RuntimeHistoryJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RuntimeHistoryJsonValue[]
  | { readonly [key: string]: RuntimeHistoryJsonValue };

export type RuntimeHistoryRecordCategory =
  | "message"
  | "tool_call"
  | "tool_result"
  | "lifecycle"
  | "reasoning"
  | "usage"
  | "provider_event"
  | "compaction";

export type RuntimeHistoryRedactionReason =
  | "secret"
  | "encrypted_content"
  | "reasoning_content"
  | "physical_path"
  | "omitted_too_large";

export interface RuntimeHistoryRedactedField {
  readonly path: string;
  readonly reason: RuntimeHistoryRedactionReason;
  readonly byteCount?: number;
}

export interface RuntimeHistoryRecord {
  readonly ordinal: number;
  readonly timestamp?: string;
  readonly turnId?: string;
  readonly category: RuntimeHistoryRecordCategory;
  readonly nativeType: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly role?: string;
  readonly phase?: string;
  readonly nativeRecord: { readonly [key: string]: RuntimeHistoryJsonValue };
  readonly redactedFields: readonly RuntimeHistoryRedactedField[];
}

export interface RuntimeHistoryInstructionBlock {
  readonly recordOrdinal: number;
  readonly recordType: string;
  readonly field: string;
  readonly contentOrdinal?: number;
  readonly timestamp?: string;
  readonly text: string;
}

export type RuntimeHistorySource =
  | "codex_rollout"
  | "claude_transcript"
  | "pi_session";

export type RuntimeHistoryInstructions =
  | {
      readonly status: "available";
      readonly source: RuntimeHistorySource;
      readonly blocks: readonly RuntimeHistoryInstructionBlock[];
    }
  | {
      readonly status: "unavailable";
      readonly source: RuntimeHistorySource;
      readonly reason: string;
      readonly blocks: readonly [];
    };

export interface RuntimeHistorySnapshot {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly recordCount: number;
  readonly tailState: "clean" | "incomplete" | "corrupt";
}

export type RuntimeHistoryPage =
  | {
      readonly status: "available";
      readonly providerKind: string;
      readonly source: RuntimeHistorySource;
      readonly snapshot: RuntimeHistorySnapshot;
      readonly instructions: RuntimeHistoryInstructions;
      readonly records: readonly RuntimeHistoryRecord[];
      readonly previousCursor?: string;
    }
  | {
      readonly status: "unsupported" | "unavailable";
      readonly providerKind: string;
      readonly reason: string;
      readonly instructions: RuntimeHistoryInstructions;
      readonly records: readonly [];
    };

export interface RuntimeHistoryOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/**
 * A History page with no records. `unsupported` means the Runtime cannot
 * inspect History at all; `unavailable` means it can but nothing is readable
 * now. The instruction source follows the Runtime's native History format.
 */
export function unavailableRuntimeHistory(
  providerKind: string,
  reason: string,
  status: "unsupported" | "unavailable" = "unavailable",
): RuntimeHistoryPage {
  return {
    status,
    providerKind,
    reason,
    instructions: {
      status: "unavailable",
      source:
        providerKind === "pi"
          ? "pi_session"
          : providerKind === "claude"
            ? "claude_transcript"
            : "codex_rollout",
      reason,
      blocks: [],
    },
    records: [],
  };
}

export type RuntimeHistoryInspection = RuntimeHistoryPage;

const MAX_NATIVE_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_REDACTED_FIELDS = 1_024;
const MAX_JSON_DEPTH = 100;

/** Defense-in-depth redaction at the Agent Service process boundary. */
export const redactRuntimeHistoryPage = (
  history: RuntimeHistoryPage,
): RuntimeHistoryPage => {
  const instructions = redactInstructions(history.instructions);
  if (history.status !== "available") {
    return Object.freeze({ ...history, instructions });
  }
  return Object.freeze({
    ...history,
    instructions,
    records: Object.freeze(history.records.map(redactHistoryRecord)),
  });
};

const redactInstructions = (
  instructions: RuntimeHistoryInstructions,
): RuntimeHistoryInstructions => {
  if (instructions.status === "unavailable") return instructions;
  return Object.freeze({
    ...instructions,
    blocks: Object.freeze(
      instructions.blocks.map((block) =>
        Object.freeze({ ...block, text: redactString(block.text) }),
      ),
    ),
  });
};

const redactHistoryRecord = (
  record: RuntimeHistoryRecord,
): RuntimeHistoryRecord => {
  const added: RuntimeHistoryRedactedField[] = [];
  const nativePayload =
    isRecord(record.nativeRecord) && isRecord(record.nativeRecord.payload)
      ? record.nativeRecord.payload
      : undefined;
  const reasoning =
    record.category === "reasoning" ||
    nativePayload?.type === "reasoning" ||
    nativePayload?.type === "agent_reasoning";
  const displayableAgentReasoningText =
    record.nativeType === "event_msg.agent_reasoning" &&
    isRecord(record.nativeRecord) &&
    record.nativeRecord.type === "event_msg" &&
    nativePayload?.type === "agent_reasoning";
  const value = redactHistoryValue(
    record.nativeRecord,
    "",
    reasoning,
    displayableAgentReasoningText,
    0,
    added,
  );
  const redactedFields = deduplicateRedactions([
    ...record.redactedFields,
    ...added,
  ]);
  const byteCount = Buffer.byteLength(JSON.stringify(value));
  if (
    byteCount > MAX_NATIVE_RECORD_BYTES ||
    redactedFields.length > MAX_REDACTED_FIELDS
  ) {
    return Object.freeze({
      ...record,
      nativeRecord: Object.freeze({
        omitted_too_large: true,
        byte_count: byteCount,
      }),
      redactedFields: Object.freeze([
        {
          path: "",
          reason: "omitted_too_large" as const,
          byteCount,
        },
      ]),
    });
  }
  return Object.freeze({
    ...record,
    nativeRecord: value as RuntimeHistoryRecord["nativeRecord"],
    redactedFields: Object.freeze(redactedFields),
  });
};

const redactHistoryValue = (
  value: RuntimeHistoryJsonValue,
  pointer: string,
  inReasoningPayload: boolean,
  displayableAgentReasoningText: boolean,
  depth: number,
  redactedFields: RuntimeHistoryRedactedField[],
): RuntimeHistoryJsonValue => {
  if (depth > MAX_JSON_DEPTH) {
    redactedFields.push({
      path: manifestPath(pointer),
      reason: "omitted_too_large",
    });
    return "[OMITTED_TOO_LARGE]";
  }
  if (typeof value === "string") {
    const redacted = redactString(value);
    if (redacted !== value) {
      redactedFields.push({
        path: manifestPath(pointer),
        reason: redacted.includes("[REDACTED_PATH]")
          ? "physical_path"
          : "secret",
      });
    }
    return redacted;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item, index) =>
        redactHistoryValue(
          item,
          `${pointer}/${index}`,
          inReasoningPayload,
          displayableAgentReasoningText,
          depth + 1,
          redactedFields,
        ),
      ),
    );
  }

  const output: Record<string, RuntimeHistoryJsonValue> = {};
  let reasoningContentPresent = false;
  for (const [key, item] of Object.entries(value)) {
    const childPointer = `${pointer}/${escapeJsonPointer(key)}`;
    const normalizedKey = normalizeFieldName(key);
    if (normalizedKey === "encrypted_content") {
      redactedFields.push({
        path: manifestPath(childPointer),
        reason: "encrypted_content",
      });
      if (inReasoningPayload) reasoningContentPresent = true;
      continue;
    }
    if (isSecretField(key)) {
      redactedFields.push({
        path: manifestPath(childPointer),
        reason: "secret",
      });
      continue;
    }
    if (
      inReasoningPayload &&
      (normalizedKey === "content" ||
        normalizedKey === "text" ||
        normalizedKey === "raw_content") &&
      !(displayableAgentReasoningText && childPointer === "/payload/text")
    ) {
      reasoningContentPresent = item !== null && item !== "";
      redactedFields.push({
        path: manifestPath(childPointer),
        reason: "reasoning_content",
      });
      continue;
    }
    output[key] = redactHistoryValue(
      item,
      childPointer,
      inReasoningPayload && normalizedKey !== "summary",
      displayableAgentReasoningText,
      depth + 1,
      redactedFields,
    );
  }
  if (inReasoningPayload && reasoningContentPresent) {
    output.content_present = true;
  }
  return Object.freeze(output);
};

const redactString = (value: string): string =>
  value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(
      /\b(authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    )
    .replace(
      /(?:\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+|\/(?:private\/)?tmp|\/private\/var|\/var\/(?:lib|folders))(?:\/[^\s"'`<>]*)?/gu,
      "[REDACTED_PATH]",
    )
    .replace(/[A-Za-z]:\\Users\\[^\s"'`<>]*/gu, "[REDACTED_PATH]");

const deduplicateRedactions = (
  values: readonly RuntimeHistoryRedactedField[],
): RuntimeHistoryRedactedField[] => {
  const seen = new Set<string>();
  const result: RuntimeHistoryRedactedField[] = [];
  for (const value of values) {
    const key = `${value.path}\u0000${value.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
};

const isSecretField = (key: string): boolean =>
  /^(?:authorization|cookie|set_cookie|secret|client_secret|password|private_key|api_key|token|access_token|refresh_token|session_token|bearer_token|id_token|credential|credentials)$/iu.test(
    normalizeFieldName(key),
  );

const normalizeFieldName = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[-\s]+/gu, "_")
    .toLowerCase();

const escapeJsonPointer = (value: string): string =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");

const manifestPath = (value: string): string => value.slice(0, 4_096);
