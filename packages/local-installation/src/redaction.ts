import { stripVTControlCharacters } from "node:util";
export function redact(text: string): string {
  return stripVTControlCharacters(text)
    .replace(
      /(\b(?:[A-Z_][\w.-]*[_-])?(?:api[_-]?key|password|passwd|token|secret(?:[_-]seed)?|credential|authorization|cookie|set-cookie)\b["']?\s*[:=]\s*)(?:Bearer\s+[^\s]+|"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}
export function lineRedactor(write: (value: string) => void) {
  let pending = "",
    discarded = false;
  const emit = (line: string) => write(redact(line) + "\n");
  return {
    write(chunk: string) {
      for (const part of chunk.split(/(?<=\n)/u)) {
        if (!discarded) pending += part;
        if (pending.length > 64 * 1024) {
          pending = "";
          discarded = true;
        }
        if (part.endsWith("\n")) {
          if (discarded) emit("[long log line hidden]");
          else emit(pending.slice(0, -1));
          pending = "";
          discarded = false;
        }
      }
    },
    flush() {
      if (discarded) emit("[long log line hidden]");
      else if (pending) emit(pending);
      pending = "";
      discarded = false;
    },
  };
}
