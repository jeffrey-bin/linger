import { describe, expect, it } from "vitest";
import { createTeamHubMessageContent } from "@/features/teamhub/teamhub-message-content";
import { composeDirectRoomMessage } from "../direct-room-message";
import {
  isReferenceOnlyDraft,
  withVoiceMaterials,
} from "./voice-material-composition";

const selection = {
  id: "selection1",
  documentId: "doc-plan",
  title: "Launch plan",
  quote: "Keep the launch small.\nThen gather feedback.",
};
const composition = { body: "Explain this", files: [], mentions: [] };

describe("voice reference composition", () => {
  it("reserves the implicit DM Agent token through the complete wire composition", () => {
    const peer = {
      id: "agent-codex",
      display_name: "Codex",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    const value = withVoiceMaterials(
      composition,
      [{ ...selection, title: "Codex" }],
      ["@Codex"],
    );
    const direct = composeDirectRoomMessage(value, peer);
    const content = createTeamHubMessageContent({
      text: direct.body,
      files: [],
      mentions: direct.mentions,
      documentReferences: value.documentReferences,
    });
    expect(content.segments).toContainEqual(
      expect.objectContaining({ type: "reference", target: peer.id }),
    );
    expect(content.segments).toContainEqual(
      expect.objectContaining({
        type: "document",
        document_id: selection.documentId,
        content: "@Codex_1",
      }),
    );
  });
  it("does not bind a selection to a different document with a colliding inline token", () => {
    const value = withVoiceMaterials(
      {
        ...composition,
        body: "Compare @Launch_plan",
        documentReferences: [{ documentId: "doc-old", token: "@Launch_plan" }],
      },
      [selection],
    );
    expect(value.documentReferences).toEqual([
      { documentId: "doc-old", token: "@Launch_plan" },
      { documentId: "doc-plan", token: "@Launch_plan_1" },
    ]);
  });
  it("sends a whole chat file as its Document reference without quoting it", () => {
    const value = withVoiceMaterials(composition, [
      {
        id: "file1",
        documentId: "doc-report",
        title: "Q3 report.pdf",
        quote: "",
      },
    ]);
    expect(value.body).toBe(
      "Reference material: @Q3_report_pdf\n\nExplain this",
    );
    expect(value.documentReferences).toEqual([
      { documentId: "doc-report", token: "@Q3_report_pdf" },
    ]);
  });
  it("sends the selected excerpt verbatim with a real structured document reference", () => {
    const value = withVoiceMaterials(composition, [selection]);
    expect(value.body).toContain(
      "> Keep the launch small.\n> Then gather feedback.",
    );
    const content = createTeamHubMessageContent({
      text: value.body,
      files: [],
      mentions: value.mentions,
      documentReferences: value.documentReferences,
    });
    expect(content.segments).toContainEqual({
      type: "document",
      document_id: "doc-plan",
      content: "@Launch_plan",
      presentation: "inline",
    });
    expect(content.segments.map((segment) => segment.content).join("")).toBe(
      content.raw_message,
    );
    expect(composition.body).toBe("Explain this");
  });

  it("disambiguates documents with the same title", () => {
    const value = withVoiceMaterials(composition, [
      selection,
      {
        ...selection,
        id: "selection2",
        documentId: "doc-other",
        versionId: "version-old",
        quote: "Another selection",
      },
    ]);
    expect(
      new Set(value.documentReferences?.map((ref) => ref.token)).size,
    ).toBe(2);
    expect(value.documentContexts).toBeUndefined();
  });

  it("does not silently truncate a combined request which exceeds the message limit", () => {
    expect(() =>
      withVoiceMaterials({ ...composition, body: "x".repeat(49_990) }, [
        selection,
      ]),
    ).toThrow("50,000");
  });

  it("puts short reference material before the message, a Message excerpt without a Document reference", () => {
    const value = withVoiceMaterials(composition, [
      selection,
      {
        id: "selection2",
        messageId: "message_abc",
        title: "AnotherMe",
        quote: "Ship on Friday.\nThen review.",
      },
    ]);
    expect(value.body).toBe(
      [
        "Reference material from @Launch_plan:\n> Keep the launch small.\n> Then gather feedback.",
        "Reference material:\n> Ship on Friday.\n> Then review.",
        "Explain this",
      ].join("\n\n"),
    );
    expect(value.documentReferences).toEqual([
      expect.objectContaining({ documentId: "doc-plan" }),
    ]);
  });

  it("allows explicit reference-only prefixes, not an ordinary draft which would be overwritten", () => {
    expect(
      isReferenceOnlyDraft("@Codex @Launch_plan\n", ["@Codex", "@Launch_plan"]),
    ).toBe(true);
    expect(
      isReferenceOnlyDraft("@Codex keep my instructions", ["@Codex"]),
    ).toBe(false);
    expect(isReferenceOnlyDraft("@Launch_plan_extra", ["@Launch_plan"])).toBe(
      false,
    );
  });
});
