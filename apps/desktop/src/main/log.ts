import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

// JSON lines under <userData>/logs, local only. Never log credentials,
// cookies or channel bodies.
export const fileLogger = (
  directory: string,
  options: { stderr?: boolean } = {},
): Logger => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const write =
    (level: string) =>
    (event: string, fields: Record<string, unknown> = {}): void => {
      const ts = new Date().toISOString();
      const line = JSON.stringify({ ts, level, event, ...fields });
      const day = ts.slice(0, 10).replaceAll("-", "");
      try {
        appendFileSync(path.join(directory, `desktop-${day}.log`), `${line}\n`);
      } catch {
        // Logging must never take the app down.
      }
      if (options.stderr) process.stderr.write(`${line}\n`);
    };
  return { info: write("info"), warn: write("warn"), error: write("error") };
};
