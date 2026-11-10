import {
  readNativeDocument,
  verifyCaptureDocumentHead,
} from "./verify-document.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { components } from "@linger/wire-contracts/teamhub-public/types";

type Capture = components["schemas"]["VoiceCapture"];
type Version = components["schemas"]["DocumentVersion"];
type MessagePage = components["schemas"]["MessagePage"];
type Document = components["schemas"]["Document"];
const run = promisify(execFile);

export async function verifyCaptureArtifacts(input: {
  capture: Capture;
  baseUrl: URL;
  cookie: string;
  runtimeRoot: string;
  requireSpeech: boolean;
  requireTask: boolean;
  expectedDurationMs?: number;
  minimumDurationMs?: number;
  expectedSpeech?: { marker: string; repetitions: number };
}) {
  const { capture, baseUrl, cookie } = input;
  if (
    capture.status !== "finalized" ||
    !capture.audio_document_version_id ||
    !capture.transcript_document_version_id
  ) {
    throw new Error("Capture is missing final audio or transcript evidence");
  }
  const get = async (path: string) => {
    const response = await fetch(new URL(path, baseUrl), {
      headers: { cookie },
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`artifact verification HTTP ${response.status}`);
    return response;
  };
  await mkdir(input.runtimeRoot, { recursive: true });
  const temporary = await mkdtemp(join(input.runtimeRoot, "artifact-check-"));
  try {
    const download = async (id: string, name: string) => {
      const version = (await (
        await get(`/v0/document-versions/${encodeURIComponent(id)}`)
      ).json()) as Version;
      if (
        version.id !== id ||
        version.size_bytes <= 0 ||
        version.size_bytes > 2 ** 31
      )
        throw new Error("invalid final Version metadata");
      const response = await get(
        `/v0/document-versions/${encodeURIComponent(id)}/content`,
      );
      if (!response.body) throw new Error("missing final content");
      const file = await open(join(temporary, name), "wx", 0o600);
      const digest = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > version.size_bytes)
            throw new Error("Version download exceeds declared size");
          digest.update(chunk);
          await file.writeFile(chunk);
        }
      } finally {
        await file.close();
      }
      if (
        bytes !== version.size_bytes ||
        digest.digest("hex") !== version.sha256
      )
        throw new Error("Version content digest mismatch");
      return version;
    };
    const audio = await download(
      capture.audio_document_version_id,
      "source.m4a",
    );
    const transcript = await download(
      capture.transcript_document_version_id,
      "transcript.md",
    );
    if (
      audio.media_type !== "audio/mp4" ||
      !transcript.media_type.startsWith("text/markdown")
    )
      throw new Error("Capture output media types are invalid");
    const { stdout } = await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type",
        "-of",
        "json",
        join(temporary, "source.m4a"),
      ],
      { timeout: 120_000 },
    );
    const probe = JSON.parse(stdout) as {
      format: { duration: string };
      streams: { codec_type: string }[];
    };
    const durationMs = Number(probe.format.duration) * 1000;
    if (
      probe.streams.length !== 1 ||
      probe.streams[0]?.codec_type !== "audio" ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0
    )
      throw new Error("Capture audio is not one non-empty audio stream");
    if (
      input.expectedDurationMs !== undefined &&
      Math.abs(durationMs - input.expectedDurationMs) >
        5_000 + input.expectedDurationMs * 0.0001
    )
      throw new Error(
        "Capture audio duration does not match the recording interval",
      );
    if (
      input.minimumDurationMs !== undefined &&
      durationMs < input.minimumDurationMs - 3_000
    )
      throw new Error(
        "Capture audio is shorter than the acknowledged recording interval",
      );
    const markdown = await readFile(join(temporary, "transcript.md"), "utf8");
    let markerCount: number | undefined;
    if (input.expectedSpeech) {
      const normalize = (text: string) =>
        text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");
      const marker = normalize(input.expectedSpeech.marker);
      if (marker.length < 4)
        throw new Error("Speech marker must have at least four letters");
      markerCount = normalize(markdown).split(marker).length - 1;
      const expected = input.expectedSpeech.repetitions;
      if (
        markerCount < Math.max(1, Math.ceil((expected - 1) * 0.98)) ||
        markerCount > expected + 1
      )
        throw new Error(
          `Capture speech marker coverage is invalid (${markerCount}/${expected})`,
        );
    }
    if (input.requireSpeech && !/^\[\d\d:/m.test(markdown))
      throw new Error("Capture transcript has no accepted speech");
    if (input.requireSpeech) {
      const { stderr } = await run(
        "ffmpeg",
        [
          "-nostdin",
          "-hide_banner",
          "-i",
          join(temporary, "source.m4a"),
          "-af",
          "volumedetect",
          "-f",
          "null",
          "-",
        ],
        {
          timeout: Math.max(120_000, Math.ceil(durationMs / 4)),
          maxBuffer: 1 << 20,
        },
      );
      const volume = /max_volume: (-?[\d.]+) dB/.exec(stderr);
      if (!volume || Number(volume[1]) < -80)
        throw new Error("Capture audio is silent");
    }
    const messages: MessagePage["items"] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const batch = (await (
        await get(
          `/v0/rooms/${encodeURIComponent(capture.room_id)}/messages?${query}`,
        )
      ).json()) as MessagePage;
      messages.push(
        ...batch.items.filter(
          (message) =>
            Date.parse(message.created_at) >= Date.parse(capture.created_at),
        ),
      );
      if (
        !batch.page.has_more ||
        batch.items.some(
          (message) =>
            Date.parse(message.created_at) < Date.parse(capture.created_at),
        )
      )
        break;
      cursor = batch.page.next_cursor;
    }
    const delivers = (
      segment: components["schemas"]["MessageSegment"],
      version: Version,
    ) =>
      segment.type === "file"
        ? segment.document_version_id === version.id &&
          segment.document_id === version.document_id
        : segment.type === "document" &&
          segment.presentation === "card" &&
          segment.document_id === version.document_id;
    const completed = messages.filter((message) =>
      message.segments.some((segment) => delivers(segment, audio)),
    );
    // Only a Direct Room receives the completion Message; any other Room keeps
    // both Versions as Room files without posting one.
    const room = (await (
      await get(`/v0/rooms/${encodeURIComponent(capture.room_id)}`)
    ).json()) as { kind: string };
    if (room.kind !== "direct") {
      if (completed.length !== 0)
        throw new Error(
          "Only a Direct Room Capture posts a completion Message",
        );
    } else if (
      completed.length !== 1 ||
      !completed[0]!.segments.some((segment) => delivers(segment, transcript))
    )
      throw new Error(
        "Capture must publish exactly one completion Message with both Versions",
      );
    // Current Room delivery uses live Document cards. Verify that each card
    // actually resolves to the Capture's immutable output Version.
    for (const version of [audio, transcript]) {
      const document = (await (
        await get(`/v0/documents/${encodeURIComponent(version.document_id)}`)
      ).json()) as Document;
      await verifyCaptureDocumentHead(
        document,
        version,
        version.id === transcript.id ? markdown : undefined,
        get,
      );
    }
    if (input.requireTask) {
      const tasks = messages.filter(
        (message) =>
          message.author.kind === "human" &&
          message.segments.some(
            (segment) =>
              segment.type === "reference" && segment.target_type === "agent",
          ) &&
          message.segments.some(
            (segment) =>
              (segment.type === "file" ||
                (segment.type === "document" &&
                  segment.presentation === "card")) &&
              segment.content === "recording-context.md",
          ),
      );
      if (
        tasks.length !== 1 ||
        !tasks[0]!.segments.some((segment) => segment.type === "reference")
      )
        throw new Error(
          "Voice task Message or Agent mention is missing or duplicated",
        );
      const context = tasks[0]!.segments.find(
        (segment) =>
          (segment.type === "file" ||
            (segment.type === "document" && segment.presentation === "card")) &&
          segment.content === "recording-context.md",
      );
      let contextText: string;
      if (context?.type === "file") {
        await download(context.document_version_id, "recording-context.md");
        contextText = await readFile(
          join(temporary, "recording-context.md"),
          "utf8",
        );
      } else if (context?.type === "document") {
        const contextDocument = (await (
          await get(`/v0/documents/${encodeURIComponent(context.document_id)}`)
        ).json()) as Document;
        if (!contextDocument.capabilities.read)
          throw new Error("Voice task context is not readable");
        if (contextDocument.current_version?.id) {
          await download(
            contextDocument.current_version.id,
            "recording-context.md",
          );
          contextText = await readFile(
            join(temporary, "recording-context.md"),
            "utf8",
          );
        } else contextText = await readNativeDocument(contextDocument, get);
      } else throw new Error("Voice task context is missing");
      if (
        !contextText.includes("Said by the recorder at") ||
        !contextText.includes("## Transcript so far")
      )
        throw new Error("Voice task context is not a spoken recording task");
    }
    return {
      audio_verified: true,
      transcript_verified: true,
      completion_message_count: completed.length,
      media_duration_ms: Math.round(durationMs),
      task_verified: input.requireTask,
      speech_marker_count: markerCount,
      expected_speech_marker_count: input.expectedSpeech?.repetitions,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
