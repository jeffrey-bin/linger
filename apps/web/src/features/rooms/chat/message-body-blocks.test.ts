import { describe, expect, it } from "vitest";

import { messageBodyBlocks, messageBodyRuns } from "./message-body-blocks";

describe("messageBodyBlocks", () => {
  it("retains Actor reference segments in their text block around a Document card", () => {
    const reference = {
      content: "lu",
      target: "actor-lu",
      target_type: "user" as const,
      type: "reference" as const,
    };
    const card = {
      content: "notes.md",
      document_id: "document-notes",
      presentation: "card" as const,
      type: "document" as const,
    };
    const text = { content: "Please review, ", type: "text" as const };
    expect(messageBodyBlocks([text, reference, card])).toEqual([
      { kind: "text", body: "Please review, lu", segments: [text, reference] },
      { kind: "document_card", segment: card },
    ]);
  });

  it("shows a canvas Document as a card", () => {
    const canvas = {
      content: "Email to Lisa",
      document_id: "document-canvas",
      presentation: "canvas" as const,
      type: "document" as const,
    };
    expect(messageBodyBlocks([canvas])).toEqual([
      { kind: "document_card", segment: canvas },
    ]);
  });

  it("separates delivered Document cards from inline Document references", () => {
    const card = {
      content: "notes.md",
      document_id: "document-notes",
      presentation: "card" as const,
      type: "document" as const,
    };

    expect(
      messageBodyBlocks([
        { content: "Review ", type: "text" },
        {
          content: "@Plan",
          document_id: "document-plan",
          presentation: "inline",
          type: "document",
        },
        { content: "\n", type: "text" },
        card,
      ]),
    ).toEqual([
      { body: "Review @Plan", kind: "text" },
      { kind: "document_card", segment: card },
    ]);
  });

  it("keeps file segments as file cards between surrounding text", () => {
    expect(
      messageBodyBlocks([
        { content: "Pick a style\n", type: "text" },
        {
          content: "style-options.fragment.html",
          document_id: "document-html",
          document_version_id: "version-html",
          type: "file",
        },
        { content: "Tell me once you choose", type: "text" },
      ]),
    ).toEqual([
      { body: "Pick a style", kind: "text" },
      {
        kind: "file",
        segment: {
          content: "style-options.fragment.html",
          document_id: "document-html",
          document_version_id: "version-html",
          type: "file",
        },
      },
      { body: "Tell me once you choose", kind: "text" },
    ]);
  });

  it("inlines only html_fragment segments", () => {
    expect(
      messageBodyBlocks([
        { content: "Pick a style\n", type: "text" },
        {
          content: "Visual fragment",
          html: "<div class='option'>Pine Green Strategy</div>",
          type: "html_fragment",
        },
        { content: "Tell me once you choose", type: "text" },
      ]),
    ).toEqual([
      { body: "Pick a style", kind: "text" },
      {
        kind: "html_fragment",
        segment: {
          content: "Visual fragment",
          html: "<div class='option'>Pine Green Strategy</div>",
          type: "html_fragment",
        },
      },
      { body: "Tell me once you choose", kind: "text" },
    ]);
  });

  it("keeps artifact tree segments as folder cards", () => {
    const segment = {
      content: "Published deck",
      directory_count: 2,
      entry_document_id: "document-index",
      entry_document_version_id: "version-index",
      file_count: 4,
      publication_group_id: "publication-group",
      root_path: "deck",
      total_bytes: 4096,
      type: "artifact_tree" as const,
    };

    expect(messageBodyBlocks([segment])).toEqual([
      { kind: "artifact_tree", segment },
    ]);
  });

  it("merges consecutive text segments and skips empty text", () => {
    expect(
      messageBodyBlocks([
        { content: "Hello ", type: "text" },
        { content: "world", type: "text" },
        {
          content: "notes.md",
          document_id: "document-md",
          document_version_id: "version-md",
          type: "file",
        },
      ]),
    ).toEqual([
      { body: "Hello world", kind: "text" },
      {
        kind: "file",
        segment: {
          content: "notes.md",
          document_id: "document-md",
          document_version_id: "version-md",
          type: "file",
        },
      },
    ]);
  });
});

describe("messageBodyRuns", () => {
  const file = {
    content: "brief.md",
    document_id: "document-brief",
    document_version_id: "version-brief",
    type: "file" as const,
  };
  const attachment = (id: string) => ({ document: { id } });

  it("splits text around files and shows each Document once, uploads last", () => {
    const blocks = messageBodyBlocks([
      { content: "Before\n", type: "text" },
      file,
      { content: "After", type: "text" },
      { ...file, document_version_id: "version-again" },
    ]);
    expect(
      messageBodyRuns(blocks, [
        attachment("document-brief"),
        attachment("document-upload"),
      ]),
    ).toEqual([
      { kind: "bubble", blocks: [blocks[0]] },
      { kind: "block", block: blocks[1] },
      { kind: "bubble", blocks: [blocks[2]] },
      { kind: "attachment", attachment: attachment("document-upload") },
    ]);
  });
});
