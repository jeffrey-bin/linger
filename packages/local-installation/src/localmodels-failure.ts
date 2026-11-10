/** Turns a failed localmodels run into a short cause and a redacted log. */
import { redact } from "./redaction.js";

export interface LocalmodelsFailure {
  /** The upstream error code, when its JSON error line was present. */
  code?: string;
  /** One redacted line naming the cause, fit for the setup page. */
  cause?: string;
  /** Redacted stdout and stderr, split to fit installer log events. */
  log: string[];
}

const LOG_PART = 1800;
const LOG_PARTS = 8;

/** Removes credentials, signed URL parameters and terminal bytes. */
export function redactLocalmodelsOutput(text: string): string {
  return (
    redact(text)
      // Signed download redirects carry their credential in the query.
      .replace(
        /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"']+)\?[^\s"']*/gi,
        "$1?[REDACTED]",
      )
      .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
      .replace(/\b(?:gh[pousr]|glpat)[-_][A-Za-z0-9_-]{16,}/g, "[REDACTED]")
      // eslint-disable-next-line no-control-regex -- Strip control bytes from upstream output.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}

function line(text: string, keepEnd = false): string | undefined {
  const value = redactLocalmodelsOutput(text).replace(/\s+/g, " ").trim();
  if (!value || value.length <= 300) return value || undefined;
  return keepEnd ? `…${value.slice(-299)}` : `${value.slice(0, 299)}…`;
}

function errorEvent(
  stdout: string,
):
  | { code?: string; message?: string; reason?: string; host?: string }
  | undefined {
  for (const raw of stdout.trim().split("\n").reverse()) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    const event = value as Record<string, unknown> | null;
    if (
      event &&
      ((typeof event.schema === "string" &&
        /^localmodels\.[a-z-]+-error\/v1$/.test(event.schema)) ||
        event.kind === "error")
    ) {
      const text = (key: string) =>
        typeof event[key] === "string" ? event[key] : undefined;
      return {
        code: text("code"),
        message: text("message"),
        reason: text("reason"),
        host: text("host"),
      };
    }
  }
}

export function localmodelsFailure(
  args: string[],
  result: { code: number; stdout: string; stderr: string },
): LocalmodelsFailure {
  const event = errorEvent(result.stdout);
  let cause = event?.message ? line(event.message) : undefined;
  if (!cause && event?.reason)
    cause = line(event.host ? `${event.host}: ${event.reason}` : event.reason);
  if (!cause) {
    const tail = result.stderr
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(-3)
      .join(" ");
    // A traceback ends with its cause.
    cause = line(tail, true);
  }
  // Byte progress repeats thousands of times and says nothing about the cause.
  const stdout = result.stdout
    .split("\n")
    .filter((item) => !/^\{"kind": ?"progress"/.test(item.trim()))
    .join("\n")
    .trim();
  const full = redactLocalmodelsOutput(
    [
      `localmodels ${args.slice(0, 2).join(" ")} exited with code ${result.code}${event?.code ? ` (${event.code})` : ""}.`,
      stdout && `stdout:\n${stdout}`,
      result.stderr.trim() && `stderr:\n${result.stderr.trim()}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const log: string[] = [];
  for (let at = 0; at < full.length; at += LOG_PART)
    log.push(full.slice(at, at + LOG_PART));
  // The end holds the error line and any traceback.
  if (log.length > LOG_PARTS)
    log.splice(1, log.length - LOG_PARTS, "[earlier output omitted]");
  return { ...(event?.code ? { code: event.code } : {}), cause, log };
}
