export type JsonLogLevel = "debug" | "info" | "warn" | "error";

export interface JsonLogger {
  log(
    level: JsonLogLevel,
    event: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void;
  child(fields: Readonly<Record<string, unknown>>): JsonLogger;
}

export interface JsonLoggerOptions {
  service: string;
  level?: JsonLogLevel | "off";
  /** Receives one JSON line without the trailing newline. Defaults to stderr. */
  write?: (line: string) => void;
}

const REDACTED = "[Redacted]";
const CIRCULAR = "[Circular]";
const MAX_ERROR_CAUSE_DEPTH = 3;
const MAX_VALUE_DEPTH = 16;

const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: Number.POSITIVE_INFINITY,
} as const;

const NON_SECRET_FIELDS = new Set(["acknowledgedchangetoken", "changetoken"]);

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

const SENSITIVE_SUFFIXES = [
  "apikey",
  "apikeys",
  "credential",
  "credentials",
  "encryptionkey",
  "password",
  "passwords",
  "privatekey",
  "secret",
  "secrets",
  "signingkey",
  "token",
  "tokens",
];

const normalizeFieldName = (field: string): string =>
  field.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

const isSensitiveField = (field: string): boolean => {
  const normalized = normalizeFieldName(field);
  if (NON_SECRET_FIELDS.has(normalized)) return false;
  return (
    SENSITIVE_FIELD_NAMES.has(normalized) ||
    normalized.startsWith("authorization") ||
    SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
};

const serializeError = (
  error: Error,
  includeStack: boolean,
  causeDepth: number,
  seen: WeakSet<object>,
): Record<string, unknown> => {
  seen.add(error);
  const { code } = error as { code?: unknown };
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if (typeof code === "string" || typeof code === "number") {
    serialized.code = code;
  }
  if (error.cause !== undefined && causeDepth < MAX_ERROR_CAUSE_DEPTH) {
    serialized.cause =
      error.cause instanceof Error
        ? seen.has(error.cause)
          ? CIRCULAR
          : serializeError(error.cause, includeStack, causeDepth + 1, seen)
        : normalize(error.cause, includeStack, 0, seen);
  }
  if (includeStack && error.stack !== undefined) serialized.stack = error.stack;
  seen.delete(error);
  return serialized;
};

// `seen` holds only the current ancestor chain, so a shared (non-circular)
// object that appears twice is still rendered both times.
const normalize = (
  value: unknown,
  includeStack: boolean,
  depth: number,
  seen: WeakSet<object>,
): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Error) {
    return seen.has(value)
      ? CIRCULAR
      : serializeError(value, includeStack, 0, seen);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof URL) return value.href;
  if (seen.has(value)) return CIRCULAR;
  if (depth >= MAX_VALUE_DEPTH) return "[Truncated]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) =>
        normalize(item, includeStack, depth + 1, seen),
      );
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = isSensitiveField(key)
        ? REDACTED
        : normalize(item, includeStack, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
};

const normalizeFields = (
  fields: Readonly<Record<string, unknown>>,
  includeStack: boolean,
): Record<string, unknown> =>
  normalize(fields, includeStack, 0, new WeakSet()) as Record<string, unknown>;

const writeStderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/**
 * One JSON line per event: `time`, `level`, `service`, `event`, then child and
 * call fields. Sensitive keys are redacted at any depth and logging never
 * throws. The shape matches Agent's `AgentLogger` so Agent can adopt it.
 */
export const createJsonLogger = (options: JsonLoggerOptions): JsonLogger => {
  const threshold = LEVEL_PRIORITY[options.level ?? "info"];
  const write = options.write ?? writeStderr;

  const build = (context: Readonly<Record<string, unknown>>): JsonLogger => ({
    log: (level, event, fields = {}) => {
      if (LEVEL_PRIORITY[level] < threshold) return;
      const time = new Date().toISOString();
      try {
        const includeStack = level === "debug";
        // Reserved keys always win over a same-named context or call field.
        const {
          time: _time,
          level: _level,
          service: _service,
          event: _event,
          ...rest
        } = normalizeFields({ ...context, ...fields }, includeStack);
        write(
          JSON.stringify({
            time,
            level,
            service: options.service,
            event,
            ...rest,
          }),
        );
      } catch {
        try {
          write(
            JSON.stringify({
              time,
              level,
              service: options.service,
              event,
              log_error: "unserializable_fields",
            }),
          );
        } catch {
          // Logging must never take down the caller.
        }
      }
    },
    child: (fields) => build({ ...context, ...fields }),
  });

  return build({});
};
