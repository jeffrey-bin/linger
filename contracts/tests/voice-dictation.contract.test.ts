import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("chat dictation contracts", () => {
  it("requires purpose and separates turn events from commands", async () => {
    const definition = parse(
      await readFile(
        resolve(import.meta.dirname, "../openapi/components/voice-media.yaml"),
        "utf8",
      ),
    );
    const schemas = definition.components.schemas;
    expect(schemas.VoiceSessionPurpose.enum).toEqual([
      "hardware_control",
      "chat_dictation",
      "chat_live",
    ]);
    expect(schemas.VoiceSession.required).toContain("purpose");
    expect(schemas.VoiceMediaPolicy.required).toEqual([
      "voice_media_supported",
    ]);
    expect(schemas.VoiceTranscriptEventKind.enum).toContain("dictation_turn");
    expect(schemas.VoiceDictationCommitRequest).toMatchObject({
      additionalProperties: false,
      required: ["request_id"],
    });
    const runtime = parse(
      await readFile(
        resolve(
          import.meta.dirname,
          "../openapi/teamhub-internal/openapi.yaml",
        ),
        "utf8",
      ),
    );
    expect(runtime.components.schemas.ObservationKind.enum).toContain(
      "turn_finalized",
    );
    expect(runtime.components.schemas.VoiceDictationCommitRequest.$ref).toBe(
      "../components/voice-media.yaml#/components/schemas/VoiceDictationCommitRequest",
    );
  });
});
