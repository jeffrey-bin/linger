import { createHash } from "node:crypto";
import { createAgentLogFileSink } from "./agent-log-file-sink.js";

let fileSink: ReturnType<typeof createAgentLogFileSink> | undefined;
// The same Error object crosses Context Runtime, executor, and registry. Keep
// the first failure as the alert owner without mutating or retaining the Error.
const claimedFailureAlerts = new WeakSet<object>();

export const claimAgentFailureAlert = (failure: unknown): boolean => {
  if (
    failure === null ||
    (typeof failure !== "object" && typeof failure !== "function")
  ) {
    return true;
  }
  if (claimedFailureAlerts.has(failure)) return false;
  claimedFailureAlerts.add(failure);
  return true;
};

export const flushAgentLogs = (timeoutMs = 1_000): Promise<boolean> =>
  fileSink?.flush(timeoutMs) ?? Promise.resolve(true);
export const closeAgentLogs = async (timeoutMs = 1_000): Promise<boolean> => {
  const sink = fileSink;
  const complete = (await sink?.close(timeoutMs)) ?? true;
  if (fileSink === sink) fileSink = undefined;
  return complete;
};

// Short-lived tools also get one bounded drain. Explicit process.exit / SIGKILL
// cannot run this hook; the service lifecycle closes the sink before exiting.
process.once("beforeExit", () => {
  void closeAgentLogs();
});

export type AgentLogLevel = "debug" | "info" | "warn" | "error";

export type AgentLogFields = Readonly<Record<string, unknown>>;

export interface AgentLogger {
  log(level: AgentLogLevel, event: string, fields?: AgentLogFields): void;
  child(context: AgentLogFields): AgentLogger;
}

type ConfiguredLogLevel = AgentLogLevel | "off";
type AgentLogTextField = "messageText" | "replyText";

export interface AgentLogOptions {
  /**
   * Terminal format; unset prints JSON lines when NODE_ENV is production and
   * readable lines otherwise. Local files are always JSON lines.
   */
  readonly format?: "pretty" | "json";
  /** `metadata` keeps only the length of message and reply text. */
  readonly content: "full" | "metadata";
  /** Size at which a local log file rotates. */
  readonly maxFileBytes: number;
  /** Files kept per log stream, the current one included. */
  readonly maxFiles: number;
}

const DEFAULT_LOG_OPTIONS: AgentLogOptions = {
  content: "metadata",
  maxFileBytes: 10 * 1024 * 1024,
  maxFiles: 3,
};
let logOptions = DEFAULT_LOG_OPTIONS;

/** Replaces the fixed log options for tests; no argument restores them. */
export const setAgentLogOptions = (
  options: Partial<AgentLogOptions> = {},
): void => {
  logOptions = { ...DEFAULT_LOG_OPTIONS, ...options };
};

let logDirectory: string | undefined;

/** Sets the root of the local NDJSON files; no argument keeps logs on the
 * terminal only. */
export const setAgentLogDirectory = (directory?: string): void => {
  logDirectory = directory;
};

const MAX_CONTENT_BYTES = 8 * 1024;
const MAX_AGGREGATE_ERROR_CHILDREN = 8;
const REDACTED = "[Redacted]";
// Token counts of model usage, which a suffix rule below would hide.
const NON_SECRET_FIELDS = new Set([
  "acknowledgedchangetoken",
  "changetoken",
  "inputtokens",
  "cachedinputtokens",
  "outputtokens",
]);

const SENSITIVE_FIELD_NAMES = new Set([
  "apikey",
  "auth",
  "authentication",
  "authorization",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "servicetoken",
  "setcookie",
  "token",
]);

const METADATA_CONTENT_FIELD_NAMES = new Set([
  "args",
  "arguments",
  "body",
  "content",
  "data",
  "developerinstructions",
  "diagnostics",
  "detail",
  "details",
  "entries",
  "errormessage",
  "events",
  "input",
  "instructions",
  "items",
  "message",
  "messages",
  "messagetext",
  "output",
  "params",
  "payload",
  "prompt",
  "rawmessage",
  "replytext",
  "request",
  "response",
  "responsebody",
  "result",
  "rpcmessage",
  "segments",
  "stack",
  "stderr",
  "stdout",
  "text",
  "toolarguments",
  "toolresult",
  "value",
  "values",
]);

const METADATA_ERROR_FIELD_NAMES = new Set([
  "code",
  "errno",
  "retryable",
  "signal",
  "status",
  "statuscode",
  "syscall",
]);

const LEVEL_PRIORITY: Record<ConfiguredLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: Number.POSITIVE_INFINITY,
};

export const createAgentLogger = (
  context: AgentLogFields = {},
): AgentLogger => {
  const capturedContext = { ...context };
  return Object.freeze({
    log: (
      level: AgentLogLevel,
      event: string,
      fields: AgentLogFields = {},
    ): void => emitAgentEvent(level, event, fields, capturedContext),
    child: (additionalContext: AgentLogFields): AgentLogger =>
      createAgentLogger({ ...capturedContext, ...additionalContext }),
  });
};

export const agentLogText = (
  field: AgentLogTextField,
  text: string,
): AgentLogFields => {
  const contentLength = Buffer.byteLength(text, "utf8");
  const contentTruncated = contentLength > MAX_CONTENT_BYTES;
  return {
    ...(logOptions.content === "full"
      ? { [field]: truncateUtf8(text, MAX_CONTENT_BYTES) }
      : {}),
    contentLength,
    contentTruncated,
  };
};

export const logAgentEvent = (
  level: AgentLogLevel,
  event: string,
  fields: AgentLogFields = {},
): void => emitAgentEvent(level, event, fields, {});

const emitAgentEvent = (
  level: AgentLogLevel,
  event: string,
  fields: AgentLogFields,
  context: AgentLogFields,
): void => {
  try {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[configuredLogLevel()]) {
      return;
    }

    const now = new Date();
    let entry: Record<string, unknown>;
    try {
      const combined = { ...fields, ...context };
      entry = normalizeEntry({
        ...combined,
        time: now.toISOString(),
        level,
        component:
          typeof combined.component === "string"
            ? combined.component
            : eventComponent(event),
        event,
      });
    } catch {
      entry = {
        time: now.toISOString(),
        level,
        component: eventComponent(event),
        event,
        logError: "fields_serialization_failed",
      };
    }

    const fileLine = JSON.stringify(entry);
    const format =
      logOptions.format ??
      (process.env.NODE_ENV === "production" ? "json" : "pretty");
    const consoleLine =
      format === "json" ? fileLine : renderPrettyEntry(entry, now);
    try {
      writeLine(level, consoleLine);
    } catch {
      // A broken terminal must not prevent local diagnostics or business work.
    }
    try {
      writeLocalLine(entry, `${fileLine}\n`);
    } catch {
      // A broken local sink must never interfere with the observed operation.
    }
  } catch {
    // Observability must never interfere with the operation being observed.
  }
};

const configuredLogLevel = (): ConfiguredLogLevel => {
  const configured = process.env.AGENT_LOG_LEVEL;
  if (isConfiguredLogLevel(configured)) {
    return configured;
  }
  return process.env.NODE_ENV === "test" ? "off" : "info";
};

const isConfiguredLogLevel = (
  value: string | undefined,
): value is ConfiguredLogLevel =>
  value === "debug" ||
  value === "info" ||
  value === "warn" ||
  value === "error" ||
  value === "off";

const eventComponent = (event: string): string =>
  event.includes(".") ? event.slice(0, event.indexOf(".")) : "agent";

const normalizeEntry = (entry: Record<string, unknown>) => {
  const normalized = JSON.parse(
    JSON.stringify(
      entry,
      jsonReplacer(
        logOptions.content,
        entry.event === "agent_runtime_measurement",
      ),
    ),
  ) as Record<string, unknown>;
  // These fixed Runner messages are classification metadata, never Provider
  // stderr. Keep all other errorMessage values under the existing content gate.
  if (
    entry.event === "runner.operation.failed" &&
    (entry.errorMessage === "codex process exited" ||
      entry.errorMessage === "Runtime execution failed" ||
      entry.errorMessage === "Provider cancellation cleanup is unconfirmed")
  ) {
    normalized.errorMessage = entry.errorMessage;
  }
  return normalized;
};

const jsonReplacer = (
  content: AgentLogOptions["content"],
  measurement = false,
): ((key: string, value: unknown) => unknown) => {
  const seen = new WeakSet<object>();
  return (key, value) => {
    if (
      key &&
      isSensitiveField(key) &&
      !(
        normalizeFieldName(key) === "authorizationms" &&
        typeof value === "number" &&
        Number.isFinite(value)
      )
    ) {
      return REDACTED;
    }
    if (content === "metadata" && normalizeFieldName(key) === "error") {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return serializeMetadataError(value);
    }
    if (
      content === "metadata" &&
      key &&
      METADATA_CONTENT_FIELD_NAMES.has(normalizeFieldName(key)) &&
      !(
        measurement &&
        (key === "input" || key === "output") &&
        isMeasurementCount(value)
      )
    ) {
      return undefined;
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (typeof value === "string") {
      return redactSensitiveText(value);
    }
    if (typeof value !== "object" || value === null) {
      return value;
    }
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value instanceof Error ? serializeError(value, content) : value;
  };
};

// Request usage buckets are numeric metadata. Text remains filtered even when
// a caller uses the measurement event name.
const isMeasurementCount = (value: unknown): boolean =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

const serializeError = (
  error: Error,
  content: AgentLogOptions["content"],
): Record<string, unknown> | string => {
  if (content === "metadata") return serializeMetadataError(error);
  const serialized: Record<string, unknown> = {
    name: safeErrorName(error.name),
    message: redactSensitiveText(error.message),
  };
  for (const property of Object.getOwnPropertyNames(error)) {
    if (property !== "name" && property !== "message") {
      serialized[property] =
        property === "data"
          ? REDACTED
          : (error as unknown as Record<string, unknown>)[property];
    }
  }
  return serialized;
};

const serializeMetadataError = (
  error: unknown,
  depth = 0,
  ancestors = new Set<object>(),
): Record<string, unknown> | string => {
  if (depth >= 3) return "[Truncated]";
  if (typeof error !== "object" || error === null) {
    return {
      name: "NonErrorThrown",
      ...(typeof error === "string"
        ? { reason: diagnosticText(error, 1024) }
        : {}),
    };
  }
  if (ancestors.has(error)) return "[Circular]";
  const nextAncestors = new Set(ancestors).add(error);
  const name =
    error instanceof Error ? error.name : ownDataProperty(error, "name");
  const serialized: Record<string, unknown> = {
    name: typeof name === "string" ? safeErrorName(name) : "NonErrorThrown",
  };
  const message = ownDataProperty(error, "message");
  if (typeof message === "string")
    serialized.reason = diagnosticText(message, 1024);
  const stack =
    error instanceof Error ? error.stack : ownDataProperty(error, "stack");
  if (typeof stack === "string") {
    // Stack headers can repeat multiline response bodies. Keep only frames.
    serialized.frames = diagnosticText(
      stack
        .split("\n")
        .filter((line) => /^\s+at\s/.test(line))
        .slice(0, 8)
        .join("\n"),
      4096,
    );
  }
  for (const property of Object.getOwnPropertyNames(error)) {
    if (METADATA_ERROR_FIELD_NAMES.has(normalizeFieldName(property))) {
      const value = ownDataProperty(error, property);
      if (isSafeErrorMetadataValue(value)) serialized[property] = value;
    }
  }
  const cause = ownDataProperty(error, "cause");
  if (cause !== undefined)
    serialized.cause = serializeMetadataError(cause, depth + 1, nextAncestors);
  if (error instanceof AggregateError) {
    const errors = ownDataProperty(error, "errors");
    if (Array.isArray(errors)) {
      serialized.errorCount = errors.length;
      serialized.errorsTruncated = errors.length > MAX_AGGREGATE_ERROR_CHILDREN;
      serialized.errors = errors
        .slice(0, MAX_AGGREGATE_ERROR_CHILDREN)
        .map((nested) =>
          serializeMetadataError(nested, depth + 1, nextAncestors),
        );
    }
  }
  return serialized;
};

const diagnosticText = (value: string, maxBytes: number): string =>
  truncateUtf8(
    redactSensitiveText(value)
      .replace(
        /\/(?:Users|home|private|tmp|var\/folders)(?:\/[^\s"'`<>)]*)?/gu,
        "[Redacted path]",
      )
      .replace(/[A-Za-z]:\\Users\\[^\s"'`<>)]*/gu, "[Redacted path]"),
    maxBytes,
  );

const ownDataProperty = (value: object, property: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const safeErrorName = (name: string): string =>
  /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(name) ? name : "Error";

const isSafeErrorMetadataValue = (
  value: unknown,
): value is string | number | boolean | null =>
  value === null ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  (typeof value === "string" &&
    value.length <= 128 &&
    /^[a-zA-Z0-9._:/-]*$/.test(value));

const normalizeFieldName = (field: string): string =>
  field.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

export const isSensitiveField = (field: string): boolean => {
  const normalized = normalizeFieldName(field);
  if (NON_SECRET_FIELDS.has(normalized)) {
    return false;
  }
  return (
    SENSITIVE_FIELD_NAMES.has(normalized) ||
    normalized.startsWith("authorization") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("apikeys") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized.endsWith("encryptionkey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwords") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("secrets") ||
    normalized.endsWith("signingkey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("tokens")
  );
};

export const redactSensitiveText = (value: string): string =>
  value
    .replace(
      /data:[^\s,;]+;base64,[A-Za-z0-9+/=_-]+/gi,
      "[Redacted binary data]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]+/g, REDACTED)
    .replace(/(?:mcp|cli)_ctx_[A-Za-z0-9_-]{43}/gu, REDACTED)
    .replace(
      /(PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*)["']?[A-Za-z0-9_-]+["']?/giu,
      `$1${REDACTED}`,
    )
    .replace(/(\bBearer\s+)[^\s,;"']+/gi, `$1${REDACTED}`)
    .replace(
      /((?:"|')?(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|password|private[_-]?key|refresh[_-]?token|service[_-]?token|secret|token)(?:"|')?\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)/gi,
      `$1"${REDACTED}"`,
    )
    .replace(
      /(\b(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|password|private[_-]?key|refresh[_-]?token|service[_-]?token|secret|token)\s*=\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /([?&](?:access_token|api[_-]?key|password|secret|token)=)[^&#\s]*/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
      `$1${REDACTED}:${REDACTED}@`,
    );

const writeLocalLine = (
  entry: Readonly<Record<string, unknown>>,
  line: string,
): void => {
  const root = logDirectory;
  if (!root) return;
  fileSink ??= createAgentLogFileSink();
  fileSink.enqueue({
    root,
    agentId:
      typeof entry.agentId === "string" && entry.agentId.trim()
        ? safeAgentLogSegment(entry.agentId)
        : undefined,
    line,
    maximumBytes: logOptions.maxFileBytes,
    maximumFiles: logOptions.maxFiles,
  });
};

const safeAgentLogSegment = (agentId: string): string => {
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(agentId)) {
    return agentId;
  }
  return `agent-${createHash("sha256").update(agentId).digest("hex").slice(0, 16)}`;
};

const truncateUtf8 = (text: string, maximumBytes: number): string => {
  const content = Buffer.from(text, "utf8");
  if (content.length <= maximumBytes) {
    return text;
  }
  let end = maximumBytes;
  while (end > 0 && (content[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return content.subarray(0, end).toString("utf8");
};

const renderPrettyEntry = (
  entry: Record<string, unknown>,
  now: Date,
): string => {
  const level = String(entry.level).toUpperCase().padEnd(5);
  const label =
    typeof entry.agentName === "string"
      ? entry.agentName
      : String(entry.component);
  const lines = [
    `${localTime(now)} ${level} [${label}] ${String(entry.event)}`,
  ];

  const identity = prettyIdentity(entry);
  if (identity.length > 0) {
    lines.push(`  ${identity.join(" ")}`);
  }

  if (typeof entry.messageText === "string") {
    const sender = [entry.messageFromType, entry.messageFrom]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    appendPrettyContent(lines, sender ? `${sender}: ` : "", entry.messageText);
  }
  if (typeof entry.replyText === "string") {
    appendPrettyContent(lines, "", entry.replyText);
  }

  const hasVisibleContent =
    typeof entry.messageText === "string" ||
    typeof entry.replyText === "string";
  const remaining = Object.entries(entry).filter(([key, value]) => {
    if (value === undefined || PRETTY_RESERVED_FIELDS.has(key)) {
      return false;
    }
    return !(
      hasVisibleContent &&
      entry.contentTruncated === false &&
      (key === "contentLength" || key === "contentTruncated")
    );
  });
  if (remaining.length > 0) {
    lines.push(
      `  ${remaining
        .map(([key, value]) => `${key}=${prettyValue(value)}`)
        .join(" ")}`,
    );
  }
  return lines.join("\n");
};

const PRETTY_RESERVED_FIELDS = new Set([
  "time",
  "level",
  "component",
  "event",
  "roomId",
  "agentId",
  "agentName",
  "messageId",
  "outputId",
  "workId",
  "threadId",
  "turnId",
  "messageFrom",
  "messageFromType",
  "messageText",
  "replyText",
]);

const prettyIdentity = (entry: Record<string, unknown>): string[] => {
  const fields: Array<[string, string]> = [
    ["room", "roomId"],
    ["agent", "agentId"],
    ["message", "messageId"],
    ["output", "outputId"],
    ["work", "workId"],
    ["thread", "threadId"],
    ["turn", "turnId"],
  ];
  return fields.flatMap(([label, key]) =>
    entry[key] === undefined ? [] : [`${label}=${prettyValue(entry[key])}`],
  );
};

const appendPrettyContent = (
  lines: string[],
  prefix: string,
  content: string,
): void => {
  const contentLines = content.split("\n");
  lines.push(`  ${prefix}${contentLines[0] ?? ""}`);
  for (const line of contentLines.slice(1)) {
    lines.push(`    ${line}`);
  }
};

const prettyValue = (value: unknown): string =>
  typeof value === "string"
    ? value.replaceAll("\n", "\\n")
    : JSON.stringify(value);

const localTime = (date: Date): string =>
  [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":") + `.${String(date.getMilliseconds()).padStart(3, "0")}`;

const writeLine = (level: AgentLogLevel, line: string): void => {
  switch (level) {
    case "debug":
    case "info":
      console.log(line);
      return;
    case "warn":
      console.warn(line);
      return;
    case "error":
      console.error(line);
  }
};
