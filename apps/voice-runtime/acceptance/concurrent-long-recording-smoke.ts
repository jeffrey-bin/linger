import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

interface Target {
  roomId: string;
  username: string;
}
interface SoakResult {
  archived_through_ms: number;
  capture_session_id: string;
  duration_ms: number;
  final_event_count: number;
  finalize_latency_ms: number;
  gap_count: number;
  gap_duration_ms: number;
  status: "finalized";
  voice_session_id: string;
  recording_started_at: string;
  recording_stopped_at: string;
}

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const integer = (name: string, fallback: number, minimum: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
};

required("VOICE_SOAK_PASSWORD");
required("VOICE_SOAK_PCM_FILE");
required("VOICE_SOAK_DURATION_MS");
const maxGapCount = integer("VOICE_SOAK_MAX_GAP_COUNT", 0, 0);
const targets = parseTargets(required("VOICE_SOAK_TARGETS"));
const minimumOverlapMs = integer("VOICE_SOAK_MIN_OVERLAP_MS", 0, 0);
const longTarget = process.env.VOICE_SOAK_LONG_TARGET?.trim();
const longDurationMs = longTarget
  ? integer("VOICE_SOAK_LONG_DURATION_MS", 10_800_000, 30_000)
  : undefined;
if (longTarget && !targets.some((target) => target.username === longTarget))
  throw new Error("VOICE_SOAK_LONG_TARGET is not one of the targets");
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const children = new Set<ChildProcess>();
const ready = { start: new Set<ChildProcess>(), stop: new Set<ChildProcess>() };
let failed = false;
process.once("SIGTERM", () => {
  failed = true;
  for (const child of children) child.kill("SIGTERM");
});

const settled = await Promise.allSettled(
  targets.map((target) =>
    runTarget(repoRoot, target).catch((error: unknown) => {
      failed = true;
      for (const child of children) child.kill("SIGTERM");
      throw error;
    }),
  ),
);
const failures = settled.flatMap((result, index) =>
  result.status === "rejected"
    ? [{ reason: result.reason, target: targets[index]! }]
    : [],
);
if (failures.length > 0) {
  const summary = failures
    .map(
      ({ reason, target }) =>
        `${target.username}|${target.roomId}: ${message(reason)}`,
    )
    .join("; ");
  throw new Error(`concurrent Voice soak failed: ${summary}`);
}
const results = settled.flatMap((result) =>
  result.status === "fulfilled" ? [result.value] : [],
);
if (
  !longTarget &&
  (ready.start.size !== targets.length || ready.stop.size !== targets.length)
)
  throw new Error("Concurrent soak is missing coordinated Start/Stop evidence");
if (
  new Set(results.map((result) => result.capture_session_id)).size !==
  results.length
) {
  throw new Error(
    "concurrent Voice soak reused a CaptureSession across targets",
  );
}
for (const [index, result] of results.entries()) {
  if (result.gap_count > maxGapCount) {
    const target = targets[index]!;
    throw new Error(
      `concurrent Voice soak failed: ${target.username}|${target.roomId}: gap count ${result.gap_count} exceeds ${maxGapCount} (${result.gap_duration_ms}ms)`,
    );
  }
}
const overlapMs = Math.max(
  0,
  Math.min(
    ...results.map((result) => Date.parse(result.recording_stopped_at)),
  ) -
    Math.max(
      ...results.map((result) => Date.parse(result.recording_started_at)),
    ),
);
const stopSpreadMs =
  Math.max(
    ...results.map((result) => Date.parse(result.recording_stopped_at)),
  ) -
  Math.min(...results.map((result) => Date.parse(result.recording_stopped_at)));
if (!longTarget && stopSpreadMs > 2_000)
  throw new Error(`Concurrent Stop spread ${stopSpreadMs}ms exceeds 2000ms`);
if (overlapMs < minimumOverlapMs)
  throw new Error(
    `simultaneous recording ${overlapMs}ms is below ${minimumOverlapMs}ms`,
  );

console.log(
  JSON.stringify({
    concurrency: results.length,
    duration_ms: Math.min(...results.map((result) => result.duration_ms)),
    max_duration_ms: Math.max(...results.map((result) => result.duration_ms)),
    simultaneous_recording_ms: overlapMs,
    stop_spread_ms: stopSpreadMs,
    max_finalize_latency_ms: Math.max(
      ...results.map((result) => result.finalize_latency_ms),
    ),
    min_final_event_count: Math.min(
      ...results.map((result) => result.final_event_count),
    ),
    status: "passed",
    total_gap_count: results.reduce(
      (total, result) => total + result.gap_count,
      0,
    ),
    total_gap_duration_ms: results.reduce(
      (total, result) => total + result.gap_duration_ms,
      0,
    ),
  }),
);
process.exit(0);

function parseTargets(raw: string): Target[] {
  const targets = raw.split(";").map((entry) => {
    const [username, roomId, extra] = entry.split("|");
    if (
      extra !== undefined ||
      !username ||
      !roomId ||
      !/^[A-Za-z0-9._@+-]+$/.test(username) ||
      !/^[A-Za-z0-9_-]+$/.test(roomId)
    ) {
      throw new Error(
        "VOICE_SOAK_TARGETS must use username|roomId entries separated by semicolons",
      );
    }
    return { roomId, username };
  });
  if (targets.length < 1 || targets.length > 20) {
    throw new Error("VOICE_SOAK_TARGETS must contain between 1 and 20 targets");
  }
  const identities = targets.map(
    ({ roomId, username }) => `${username}\0${roomId}`,
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error("VOICE_SOAK_TARGETS must not contain duplicate targets");
  }
  if (new Set(targets.map((target) => target.username)).size !== targets.length)
    throw new Error("concurrent Voice soak requires independent accounts");
  return targets;
}

function runTarget(repoRoot: string, target: Target) {
  return new Promise<SoakResult>((resolve, reject) => {
    const compiled = import.meta.url.endsWith(".mjs");
    const child = spawn(
      process.execPath,
      compiled
        ? [
            fileURLToPath(
              new URL("./long-recording-smoke.mjs", import.meta.url),
            ),
          ]
        : [
            "--import",
            createRequire(import.meta.url).resolve("tsx"),
            fileURLToPath(
              new URL("./long-recording-smoke.ts", import.meta.url),
            ),
          ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          VOICE_SOAK_ROOM_ID: target.roomId,
          VOICE_SOAK_USERNAME: target.username,
          VOICE_SOAK_COORDINATED: longTarget ? "0" : "1",
          VOICE_SOAK_DURATION_MS:
            target.username === longTarget
              ? String(longDurationMs)
              : required("VOICE_SOAK_DURATION_MS"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let progressLine = "";
    let stderr = "";
    let diagnostic: Record<string, unknown> | undefined;
    children.add(child);
    child.stdin.on("error", () => child.kill("SIGTERM"));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = boundedAppend(stdout, chunk);
      progressLine = boundedAppend(progressLine, chunk);
      const lines = progressLine.split("\n");
      progressLine = lines.pop() || "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (
            event.status === "barrier-ready" &&
            (event.phase === "start" || event.phase === "stop")
          ) {
            const phase = event.phase;
            ready[phase].add(child);
            if (!failed && ready[phase].size === targets.length)
              for (const publisher of children)
                publisher.stdin!.write(`${phase}\n`);
          }
          if (event.status === "diagnostic") {
            diagnostic = { ...diagnostic, ...event };
            console.log(JSON.stringify({ target: target.username, ...event }));
          }
          if (
            event.status === "recording" ||
            event.status === "finalizing" ||
            event.status === "finalized"
          )
            console.log(JSON.stringify({ target: target.username, ...event }));
        } catch {
          /* Ignore unstructured SDK log lines. */
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      children.delete(child);
      if (code !== 0) {
        console.log(
          JSON.stringify({
            target: target.username,
            status: "failed",
            exit_code: code,
            signal,
            error_codes: [
              ...new Set(
                stderr.match(
                  /\b(?:ERR_[A-Z_]+|ECONN[A-Z_]+|ETIMEDOUT|EHOST[A-Z_]+|CERT_[A-Z_]+)\b/g,
                ) ?? [],
              ),
            ],
            diagnostic_flags: [
              "certificate",
              "handshake",
              "timed out",
              "ICE",
              "TURN",
              "module",
              "syntax",
              "memory",
              "RequiredField",
            ].filter((flag) =>
              stderr.toLowerCase().includes(flag.toLowerCase()),
            ),
            failure_class:
              /(?:^|\n)([A-Za-z]*Error)(?: \[[^\]]+\])?:/.exec(stderr)?.[1] ||
              "runner_failed",
            reason: failureReason(stderr),
            diagnostic,
          }),
        );
        reject(
          new Error(
            `runner exited ${code ?? "without status"}: ${lastLine(stderr) || lastLine(stdout) || "no diagnostic"}`,
          ),
        );
        return;
      }
      const result = parseResult(stdout);
      if (!result) {
        reject(new Error("runner completed without a soak result"));
        return;
      }
      resolve(result);
    });
  });
}

function parseResult(output: string): SoakResult | undefined {
  for (const line of output.trim().split("\n").reverse()) {
    try {
      const value = JSON.parse(line) as Partial<SoakResult>;
      if (
        value.status === "finalized" &&
        typeof value.capture_session_id === "string" &&
        typeof value.voice_session_id === "string" &&
        typeof value.duration_ms === "number" &&
        typeof value.final_event_count === "number" &&
        typeof value.finalize_latency_ms === "number" &&
        typeof value.archived_through_ms === "number" &&
        isNonNegativeInteger(value.gap_count) &&
        isNonNegativeInteger(value.gap_duration_ms) &&
        typeof value.recording_started_at === "string" &&
        Number.isFinite(Date.parse(value.recording_started_at)) &&
        typeof value.recording_stopped_at === "string" &&
        Number.isFinite(Date.parse(value.recording_stopped_at))
      ) {
        return value as SoakResult;
      }
    } catch {
      // Runtime logs are structured JSON but are not soak result records.
    }
  }
  return undefined;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function boundedAppend(current: string, chunk: string) {
  const combined = current + chunk;
  return combined.length > 64_000 ? combined.slice(-64_000) : combined;
}

function lastLine(value: string) {
  return value.trim().split("\n").at(-1)?.slice(0, 500);
}

function failureReason(value: string) {
  const line = value
    .split("\n")
    .find((line) =>
      /^Error: (Room already has active Capture|Capture |transcript progress|duplicate final|(?:GET|POST|DELETE) \/v0\/|artifact verification|Version |Voice soak)/.test(
        line,
      ),
    );
  return line?.slice(0, 300) || "runner_failed";
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
