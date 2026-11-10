// Isomorphic helpers: no `node:` imports, so the Web app can use this entry.

/** A plain object or class instance; arrays and null are rejected. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface ErrorWithCode extends Error {
  code?: string;
}

/** An Error carrying a string `code`, optionally matching `code`. */
export const isNodeError = (
  error: unknown,
  code?: string,
): error is ErrorWithCode =>
  error instanceof Error &&
  typeof (error as ErrorWithCode).code === "string" &&
  (code === undefined || (error as ErrorWithCode).code === code);

/** Returns `value` when it is an Error, otherwise wraps it so it can be thrown. */
export const asError = (value: unknown): Error =>
  value instanceof Error
    ? value
    : new Error(typeof value === "string" ? value : "Unknown error", {
        cause: value,
      });

/** Display text for an untyped value: structured values serialize as JSON. */
export const displayText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.href;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
};

/** Resolves after `ms`; rejects with `signal.reason` when aborted. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** URL text of a fetch() input captured by a test double. */
export function requestUrlText(input: string | URL | Request): string;
export function requestUrlText(input: undefined): undefined;
export function requestUrlText(
  input: string | URL | Request | undefined,
): string | undefined;
export function requestUrlText(
  input: string | URL | Request | undefined,
): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** String body of a fetch() init captured by a test double. */
export const requestBodyText = (body: unknown): string => {
  if (typeof body !== "string") {
    throw new TypeError("Expected a string request body");
  }
  return body;
};
