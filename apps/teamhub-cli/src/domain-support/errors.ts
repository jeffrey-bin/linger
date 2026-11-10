export type SchemaErrorCode =
  | "INVALID_SCHEMA"
  | "MISSING_SCHEMA_DESCRIPTION"
  | "UNSUPPORTED_SCHEMA_REFERENCE";

export class SchemaError extends Error {
  readonly code: SchemaErrorCode;
  readonly path?: string;

  constructor(
    code: SchemaErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly path?: string },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SchemaError";
    this.code = code;
    this.path = options?.path;
  }
}

export type ToolErrorJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ToolErrorJsonValue[]
  | { readonly [key: string]: ToolErrorJsonValue };

export interface ToolExecutionErrorOptions {
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, ToolErrorJsonValue>>;
}

/**
 * A model-safe domain failure. Infrastructure errors must not be wrapped in
 * this class unless their message and structured details are safe to expose.
 */
export class ToolExecutionError extends Error {
  override readonly name = "ToolExecutionError";
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, ToolErrorJsonValue>>;

  constructor(
    code: string,
    message: string,
    options: ToolExecutionErrorOptions = {},
  ) {
    assertToolErrorIdentifier("code", code);
    assertToolErrorText("message", message);
    const details = normalizeDetails(options.details);
    super(message);
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = details;
    Object.freeze(this);
  }
}

const normalizeDetails = (
  details: Readonly<Record<string, ToolErrorJsonValue>> | undefined,
): Readonly<Record<string, ToolErrorJsonValue>> | undefined => {
  if (details === undefined) return undefined;
  const normalized = cloneToolErrorJson(details, "details");
  if (!isPlainObject(normalized)) {
    throw new TypeError("Tool error details must be a JSON object");
  }
  return deepFreezeJson(normalized);
};

const cloneToolErrorJson = (
  value: unknown,
  path: string,
  seen = new WeakSet<object>(),
): ToolErrorJsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") {
    throw new TypeError(`Tool error ${path} must contain only JSON values`);
  }
  if (seen.has(value)) {
    throw new TypeError(`Tool error ${path} must not contain cycles`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        cloneToolErrorJson(entry, `${path}[${index}]`, seen),
      );
    }
    if (!isPlainObject(value)) {
      throw new TypeError(`Tool error ${path} must contain only plain objects`);
    }
    const result: Record<string, ToolErrorJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = cloneToolErrorJson(value[key], `${path}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
};

const deepFreezeJson = <Value extends ToolErrorJsonValue>(
  value: Value,
): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.values(value).forEach((entry) => deepFreezeJson(entry));
  return Object.freeze(value);
};

const isPlainObject = (
  value: unknown,
): value is { readonly [key: string]: ToolErrorJsonValue } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

function assertToolErrorIdentifier(
  path: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(value)) {
    throw new TypeError(`Tool error ${path} must be a stable snake_case code`);
  }
}

function assertToolErrorText(
  path: string,
  value: unknown,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 1_000
  ) {
    throw new TypeError(`Tool error ${path} must be a non-empty safe string`);
  }
}
