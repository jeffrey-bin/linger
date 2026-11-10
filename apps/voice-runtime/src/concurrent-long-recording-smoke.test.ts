import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const runner = fileURLToPath(
  new URL("../acceptance/concurrent-long-recording-smoke.ts", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("concurrent long-recording smoke CLI", { timeout: 15_000 }, () => {
  it("aggregates zero-gap evidence from every target", () => {
    const result = runConcurrentSmoke();

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toMatchObject({
      concurrency: 3,
      status: "passed",
      total_gap_count: 0,
      total_gap_duration_ms: 0,
    });
  });

  it("rejects a child result that omits gap evidence", () => {
    const result = runConcurrentSmoke({ FAKE_OMIT_GAP_DURATION: "alice" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("runner completed without a soak result");
  });

  it("uses three hours for the long target while preserving the shorter overlap", () => {
    const result = runConcurrentSmoke({
      VOICE_SOAK_LONG_TARGET: "alice",
      VOICE_SOAK_LONG_DURATION_MS: undefined,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toMatchObject({
      concurrency: 3,
      max_duration_ms: 10_800_000,
      duration_ms: 30_000,
      simultaneous_recording_ms: 30_000,
      status: "passed",
    });
  });

  it("rejects a child result that exceeds the configured gap limit", () => {
    const result = runConcurrentSmoke({
      FAKE_GAP_COUNT: "1",
      FAKE_GAP_DURATION_MS: "1250",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("gap count 1 exceeds 0 (1250ms)");
  });

  it("aborts publishers waiting at the barrier when a peer fails", () => {
    const result = runConcurrentSmoke({ FAKE_FAIL_BEFORE_START: "alice" });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("concurrent Voice soak failed");
  });

  it("does not claim simultaneous Stop without the barrier evidence", () => {
    const result = runConcurrentSmoke({ FAKE_SKIP_BARRIERS: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing coordinated Start/Stop evidence");
  });
});

function runConcurrentSmoke(overrides: NodeJS.ProcessEnv = {}) {
  const binDirectory = mkdtempSync(join(tmpdir(), "voice-soak-bin-"));
  temporaryDirectories.push(binDirectory);
  // Exercise the actual direct-Node launch shape; a fake pnpm executable hid
  // that killing pnpm did not deliver SIGTERM to its recording descendant.
  const compiledRunner = join(
    binDirectory,
    "concurrent-long-recording-smoke.mjs",
  );
  writeFileSync(
    compiledRunner,
    transpileModule(readFileSync(runner, "utf8"), {
      compilerOptions: {
        target: ScriptTarget.ES2022,
        module: ModuleKind.ES2022,
      },
    }).outputText,
  );
  writeFileSync(
    join(binDirectory, "long-recording-smoke.mjs"),
    `import {createInterface} from 'node:readline';
const username = process.env.VOICE_SOAK_USERNAME;
if (process.env.FAKE_FAIL_BEFORE_START === username) process.exit(1);
const result = {
  archived_through_ms: 30000,
  capture_session_id: "capture_" + username,
  duration_ms: Number(process.env.VOICE_SOAK_DURATION_MS),
  final_event_count: 3,
  finalize_latency_ms: 500,
  gap_count: Number(process.env.FAKE_GAP_COUNT || 0),
  gap_duration_ms: Number(process.env.FAKE_GAP_DURATION_MS || 0),
  status: "finalized",
  voice_session_id: "session_" + username,
  recording_started_at: "2026-09-06T00:00:00Z",
  recording_stopped_at: new Date(Date.parse("2026-09-06T00:00:00Z") + Number(process.env.VOICE_SOAK_DURATION_MS)).toISOString(),
};
if (process.env.FAKE_OMIT_GAP_DURATION === username) {
  delete result.gap_duration_ms;
}
function finish() { console.log(JSON.stringify(result)); process.exit(0); }
if (process.env.VOICE_SOAK_COORDINATED !== '1' || process.env.FAKE_SKIP_BARRIERS === '1') finish();
const lines = createInterface({input: process.stdin});
lines.on('line', phase => {
  if (phase === 'start') console.log(JSON.stringify({status:'barrier-ready', phase:'stop'}));
  else if (phase === 'stop') finish();
  else process.exit(2);
});
console.log(JSON.stringify({status:'barrier-ready', phase:'start'}));
`,
  );
  return spawnSync(process.execPath, [compiledRunner], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_GAP_COUNT: "0",
      FAKE_GAP_DURATION_MS: "0",
      FAKE_OMIT_GAP_DURATION: "",
      FAKE_FAIL_BEFORE_START: "",
      FAKE_SKIP_BARRIERS: "",
      VOICE_SOAK_MAX_GAP_COUNT: "0",
      ...overrides,
      VOICE_SOAK_DURATION_MS: "30000",
      VOICE_SOAK_PASSWORD: "acceptance-password",
      VOICE_SOAK_PCM_FILE: "/unused/input.pcm",
      VOICE_SOAK_TARGETS: "alice|room_alice;bob|room_bob;carol|room_carol",
    },
    timeout: 10_000,
  });
}
