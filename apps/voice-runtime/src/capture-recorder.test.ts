import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as realSleep } from "node:timers/promises";

import { initializeLogger } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import {
  TeamHubVoiceRuntimeError,
  type TeamHubVoiceRuntimeClient,
  type VoiceRecordingReport,
} from "@linger/wire-contracts/teamhub-internal/client";

import {
  CaptureRecorder,
  frameFitsClock,
  parseRecordingDirective,
  playlistDurationMs,
  silenceSamplesNeeded,
  uploadableSegments,
} from "./capture-recorder.js";

initializeLogger({ pretty: false, level: "silent" });

const prefix = "voice-staging/capture_session_abc/epoch-0";
const directive = (stagingPrefix = prefix) =>
  JSON.stringify({
    recording: { staging_prefix: stagingPrefix, segment_seconds: 1 },
  });

describe("parseRecordingDirective", () => {
  it("reads the epoch TeamHub names", () => {
    expect(parseRecordingDirective(directive())).toEqual({
      stagingPrefix: prefix,
      segmentSeconds: 1,
    });
  });

  it("ignores absent, malformed, and unsafe directives", () => {
    for (const metadata of [
      undefined,
      "",
      "{}",
      "not json",
      JSON.stringify({ recording: { staging_prefix: "../escape" } }),
      JSON.stringify({ recording: { staging_prefix: `${prefix}/../x` } }),
    ])
      expect(parseRecordingDirective(metadata)).toBeUndefined();
  });

  it("bounds the segment duration", () => {
    const parsed = parseRecordingDirective(
      JSON.stringify({
        recording: { staging_prefix: prefix, segment_seconds: 60 },
      }),
    );
    expect(parsed?.segmentSeconds).toBe(2);
  });
});

describe("wall-clock pacing", () => {
  it("pads silence only beyond the lag tolerance", () => {
    expect(silenceSamplesNeeded(0, 100)).toBe(0);
    expect(silenceSamplesNeeded(0, 1_000)).toBe(48_000);
    expect(silenceSamplesNeeded(48_000, 1_150)).toBe(0);
  });

  it("drops audio running too far ahead of the clock", () => {
    expect(frameFitsClock(0, 960, 0)).toBe(true);
    expect(frameFitsClock(48_000, 960, 400)).toBe(false);
  });
});

describe("uploadableSegments", () => {
  it("returns only the contiguous complete segments after the cursor", () => {
    const files = [
      "epoch-0.m3u8",
      "epoch-0_00002.ts",
      "epoch-0_00000.ts",
      "epoch-0_00001.ts.tmp",
      "epoch-0_00003.ts",
    ];
    expect(uploadableSegments(files, 0).map((item) => item.index)).toEqual([0]);
    expect(
      uploadableSegments([...files, "epoch-0_00001.ts"], 0).map(
        (item) => item.index,
      ),
    ).toEqual([0, 1, 2, 3]);
    expect(uploadableSegments(files, 2).map((item) => item.index)).toEqual([
      2, 3,
    ]);
  });
});

describe("playlistDurationMs", () => {
  it("sums the segment durations", () => {
    expect(
      playlistDurationMs(
        "#EXTM3U\n#EXTINF:1.002,\na.ts\n#EXTINF:0.512000,\nb.ts\n#EXT-X-ENDLIST\n",
      ),
    ).toBe(1_514);
  });
});

const ffmpegAvailable = (() => {
  try {
    execFileSync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
})();

class FakeTeamHub {
  readonly puts: Array<{ key: string; bytes: Uint8Array }> = [];
  readonly reports: VoiceRecordingReport[] = [];
  rejectSegments = false;

  client() {
    return {
      putMediaObject: async (key: string, bytes: Uint8Array) => {
        if (this.rejectSegments && key.endsWith(".ts"))
          throw new TeamHubVoiceRuntimeError(409);
        this.puts.push({ key, bytes });
      },
      reportRecording: async (report: VoiceRecordingReport) => {
        this.reports.push(report);
      },
    } as unknown as TeamHubVoiceRuntimeClient;
  }

  segmentKeys() {
    return this.puts
      .map((item) => item.key)
      .filter((key) => key.endsWith(".ts"));
  }

  lastPlaylist() {
    const playlist = [...this.puts]
      .reverse()
      .find((item) => item.key.endsWith(".m3u8"));
    return playlist ? new TextDecoder().decode(playlist.bytes) : "";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await sleep(50);
  }
};

describe.skipIf(!ffmpegAvailable)("CaptureRecorder with ffmpeg", () => {
  it("records the named epoch and seals it when the directive ends", async () => {
    const teamhub = new FakeTeamHub();
    const recorder = new CaptureRecorder({ client: teamhub.client() });
    recorder.followMetadata(directive());
    await until(() => teamhub.reports.some((item) => item.state === "active"));
    await sleep(3_000);
    recorder.followMetadata("{}");
    await until(() =>
      teamhub.reports.some((item) => item.state === "available"),
    );
    await recorder.close();

    const keys = teamhub.segmentKeys();
    expect(keys.length).toBeGreaterThanOrEqual(3);
    keys.forEach((key, index) =>
      expect(key).toBe(
        `voice-staging/capture_session_abc/epoch-0_${String(index).padStart(5, "0")}.ts`,
      ),
    );
    expect(teamhub.puts.at(-1)?.key).toBe(`${prefix}.m3u8`);
    expect(teamhub.lastPlaylist()).toContain("#EXT-X-ENDLIST");
    const available = teamhub.reports.find(
      (item) => item.state === "available",
    )!;
    expect(available.staging_prefix).toBe(prefix);
    expect(available.started_at).toBe(teamhub.reports[0]!.started_at);
    expect(available.archived_through_ms).toBe(
      playlistDurationMs(teamhub.lastPlaylist()),
    );
    expect(available.archived_through_ms).toBeGreaterThan(3_000);
    // Handing over after sealing reports nothing further.
    expect(teamhub.reports.filter((item) => item.state === "failed")).toEqual(
      [],
    );
  }, 30_000);

  it("publishes only uploaded segments when encoding continues during a slow upload", async () => {
    const teamhub = new FakeTeamHub();
    const client = teamhub.client();
    const missingSegments: string[] = [];
    let delayFirstSegment = true;
    const recorder = new CaptureRecorder({
      client: {
        ...client,
        putMediaObject: async (key: string, bytes: Uint8Array) => {
          if (key.endsWith(".ts") && delayFirstSegment) {
            delayFirstSegment = false;
            await sleep(1_600);
          }
          if (key.endsWith(".m3u8")) {
            const uploaded = new Set(teamhub.segmentKeys());
            for (const name of new TextDecoder().decode(bytes).split("\n")) {
              if (
                name.endsWith(".ts") &&
                !uploaded.has(`voice-staging/capture_session_abc/${name}`)
              )
                missingSegments.push(name);
            }
          }
          await client.putMediaObject(key, bytes);
        },
      } as TeamHubVoiceRuntimeClient,
    });
    try {
      recorder.followMetadata(directive());
      await until(() =>
        teamhub.reports.some((item) => item.state === "active"),
      );
      expect(missingSegments).toEqual([]);
      recorder.followMetadata("{}");
      await until(() =>
        teamhub.reports.some((item) => item.state === "available"),
      );
      expect(missingSegments).toEqual([]);
    } finally {
      await recorder.close();
    }
  }, 30_000);

  it("does not charge pending upload time to the encoder shutdown deadline", async () => {
    const teamhub = new FakeTeamHub();
    const client = teamhub.client();
    let releaseUpload!: () => void;
    const upload = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let uploading = false;
    const recorder = new CaptureRecorder({
      client: {
        ...client,
        putMediaObject: async (key: string, bytes: Uint8Array) => {
          if (!uploading && key.endsWith(".ts")) {
            uploading = true;
            await upload;
          }
          await client.putMediaObject(key, bytes);
        },
      } as TeamHubVoiceRuntimeClient,
    });
    try {
      recorder.followMetadata(directive());
      await until(() => uploading);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      recorder.followMetadata("{}");
      await realSleep(200);
      await vi.advanceTimersByTimeAsync(31_000);
      vi.useRealTimers();
      releaseUpload();
      await until(() =>
        teamhub.reports.some((item) => item.state !== "active"),
      );
      expect(teamhub.reports.at(-1)?.state).toBe("available");
    } finally {
      vi.useRealTimers();
      releaseUpload();
      await recorder.close();
    }
  }, 30_000);

  it("rejects an encoder failure during the final flush even with a sealed playlist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-encoder-flush-"));
    const encoder = join(directory, "encoder");
    const ffmpegPath = "ffmpeg";
    await writeFile(
      encoder,
      `#!/bin/sh\n'${ffmpegPath.replaceAll("'", "'\\''")}' "$@"\nexit 1\n`,
      { mode: 0o700 },
    );
    const teamhub = new FakeTeamHub();
    const recorder = new CaptureRecorder({
      client: teamhub.client(),
      ffmpegPath: encoder,
    });
    try {
      recorder.followMetadata(directive());
      await until(() =>
        teamhub.reports.some((item) => item.state === "active"),
      );
      recorder.followMetadata("{}");
      await until(() =>
        teamhub.reports.some((item) => item.state !== "active"),
      );
      expect(teamhub.reports.at(-1)).toMatchObject({
        state: "failed",
        failure_code: "recorder_encoder",
      });
    } finally {
      await recorder.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports a conflict when another recorder owns the epoch", async () => {
    const teamhub = new FakeTeamHub();
    teamhub.rejectSegments = true;
    const recorder = new CaptureRecorder({ client: teamhub.client() });
    recorder.followMetadata(directive());
    await until(() => teamhub.reports.some((item) => item.state === "failed"));
    await recorder.close();
    expect(teamhub.reports).toEqual([
      expect.objectContaining({
        staging_prefix: prefix,
        state: "failed",
        failure_code: "recorder_conflict",
      }),
    ]);
    expect(teamhub.reports[0]!.started_at).toBeUndefined();
  }, 30_000);

  it("hands the epoch over on shutdown after uploading complete segments", async () => {
    const teamhub = new FakeTeamHub();
    const recorder = new CaptureRecorder({ client: teamhub.client() });
    recorder.followMetadata(directive());
    await until(() => teamhub.reports.some((item) => item.state === "active"));
    await recorder.close();
    const failed = teamhub.reports.at(-1)!;
    expect(failed).toEqual(
      expect.objectContaining({
        state: "failed",
        failure_code: "recorder_handover",
      }),
    );
    expect(failed.started_at).toBe(teamhub.reports[0]!.started_at);
    expect(teamhub.segmentKeys().length).toBeGreaterThan(0);
  }, 30_000);
});

describe("CaptureRecorder encoder failure", () => {
  it("reports a failed spawn without waiting for an exit event that cannot occur", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-encoder-missing-"));
    const teamhub = new FakeTeamHub();
    const recorder = new CaptureRecorder({
      client: teamhub.client(),
      ffmpegPath: join(directory, "missing-encoder"),
    });
    try {
      recorder.followMetadata(directive());
      await until(
        () => teamhub.reports.some((item) => item.state === "failed"),
        2_000,
      );
      expect(teamhub.reports.at(-1)?.failure_code).toBe("recorder_encoder");
      await recorder.close();
    } finally {
      void recorder.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["shutdown", "backpressure"])(
    "bounds %s when the encoder remains alive without reading stdin",
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "voice-encoder-stall-"));
      const encoder = join(directory, "encoder");
      const pidFile = join(directory, "pid");
      await writeFile(
        encoder,
        `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 60\n`,
        { mode: 0o700 },
      );
      const teamhub = new FakeTeamHub();
      let now = Date.now();
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
      const recorder = new CaptureRecorder({
        client: teamhub.client(),
        ffmpegPath: encoder,
        now: () => now,
      });
      let closing: Promise<void> | undefined;
      let closed = false;
      try {
        recorder.followMetadata(directive());
        await vi.advanceTimersByTimeAsync(100);
        await realSleep(100);
        now += scenario === "shutdown" ? 4_000 : 6_000;
        await vi.advanceTimersByTimeAsync(100);
        if (scenario === "shutdown") {
          closing = recorder.close().then(() => {
            closed = true;
          });
          await vi.advanceTimersByTimeAsync(31_000);
        } else {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await realSleep(100);
        if (scenario === "shutdown") expect(closed).toBe(true);
        expect(teamhub.reports.at(-1)).toMatchObject({
          state: "failed",
          failure_code: "recorder_encoder",
        });
      } finally {
        const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The recorder may already have reaped its child.
          }
        }
        await realSleep(100);
        await vi.advanceTimersByTimeAsync(31_000);
        await Promise.race([closing ?? recorder.close(), realSleep(1_000)]);
        vi.useRealTimers();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("reports failure when the encoder exits with a blocked input pipe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-encoder-test-"));
    const encoder = join(directory, "encoder");
    // Leave stdin unread long enough for the pipe to fill, then fail.
    await writeFile(encoder, "#!/bin/sh\nsleep 2\nexit 1\n", { mode: 0o700 });
    const teamhub = new FakeTeamHub();
    let now = Date.now();
    const recorder = new CaptureRecorder({
      client: teamhub.client(),
      ffmpegPath: encoder,
      now: () => now,
    });
    try {
      recorder.followMetadata(directive());
      await sleep(100);
      now += 4_000;
      await until(
        () => teamhub.reports.some((item) => item.state === "failed"),
        5_000,
      );
      expect(teamhub.reports.at(-1)).toEqual(
        expect.objectContaining({
          state: "failed",
          failure_code: "recorder_encoder",
        }),
      );
      await recorder.close();
    } finally {
      void recorder.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
