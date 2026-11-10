import { BlockNoteEditor } from "@blocknote/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  createDocumentTestRuntime,
  seedRoomDocument,
} from "@/test/document-scenarios";
import { RoomDocumentBlockNoteEditor } from "./room-document-blocknote-editor";
import { roomDocumentCommentSchema } from "./room-document-comment-schema";
import {
  localDocumentMarkdown,
  openLocalDocumentSession,
} from "@/test/local-document-session";
import { knowledgeHiddenBlockIds } from "./room-document-knowledge-presentation";

vi.mock("../mermaid-preview-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mermaid-preview-adapter")>()),
  renderMermaidSvg: vi
    .fn()
    .mockResolvedValue(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120"><text>Outreach diagram</text></svg>',
    ),
}));

const wikiMarkdown = `---
okf_version: "0.2"
type: Person Context
title: Casey Example
description: Project coordinator
tags:
  - hardware
graph:
  schema_version: 1
  about:
    - kind: person
      ref: casey-example
generated: { by: "openwiki/0.4.3", at: "2026-09-15T10:57:57.970Z" }
---

# Casey Example

Project coordinator across hardware discussions.

## Working preferences

Validate prototypes before committing.

Evidence: [R1]

## Sources

- Internal source record

### Source details

Machine-facing provenance.

- [Internal session file](../sources/session.md)

### Evidence provenance

- [Internal TeamHub messages](teamhub://rooms/example/messages)

## Current areas

Hardware prototypes [R2] and AI products [R1, R2]. Owns prototypes（R3）。

\`\`\`mermaid
sequenceDiagram
  User->>Agent: Express outreach intent
  Agent->>Queue: Append task
\`\`\`

## Interaction History

${Array.from({ length: 7 }, (_, index) => `- 2026-10-0${7 - index}: Update ${index + 1} [R1].`).join("\n")}
`;

function parse(markdown: string) {
  const editor = BlockNoteEditor.create({ schema: roomDocumentCommentSchema });
  editor.replaceBlocks(
    editor.document,
    editor.tryParseMarkdownToBlocks(markdown),
  );
  return editor.document;
}

describe("Wiki knowledge reading projection", () => {
  it.each(["Sources"])(
    "hides %s and its nested file blocks without changing the document",
    (heading) => {
      const blocks = parse(
        [
          "Summary.",
          "",
          `## ${heading}`,
          "",
          "- [Internal transcript](../sources/session.md)",
          "  - Nested file",
          "",
          "### Source details",
          "",
          "Internal provenance.",
          "",
          "### Internal files",
          "",
          "Internal path.",
          "",
          "## Next steps",
          "",
          "Visible action.",
        ].join("\n"),
      );
      const original = JSON.stringify(blocks);
      const hidden = knowledgeHiddenBlockIds(blocks, "Project");
      const visible = JSON.stringify(
        blocks.filter((block) => !hidden.has(block.id)),
      );
      expect(visible).not.toMatch(/Internal|Nested file|Details/);
      expect(visible).toContain("Summary.");
      expect(visible).toContain("Next steps");
      expect(visible).toContain("Visible action.");
      expect(JSON.stringify(blocks)).toBe(original);
    },
  );

  it.each(["Source Links", "Source", "**Sources:**"])(
    "keeps a %j section, which is not the rendered source marker",
    (heading) => {
      const blocks = parse(`## ${heading}\n\n- [Plan](plan.md)`);
      expect(knowledgeHiddenBlockIds(blocks, "Project").size).toBe(0);
    },
  );

  it("hides repeated related pages", () => {
    const blocks = parse(
      [
        "## Related",
        "",
        "- [Realtime Voice Interaction](realtime-voice-interaction.md): Live concerns.",
        "- [Kickoff](../sessions/2026-10-21/capture_session_cd34.md): meeting stays.",
        "- [Realtime Voice Interaction](realtime-voice-interaction.md#scope): context capture.",
        "",
        "## Notes",
        "",
        "Kept.",
      ].join("\n"),
    );
    const original = JSON.stringify(blocks);
    const hidden = knowledgeHiddenBlockIds(blocks, "Project");
    const visible = blocks.filter((block) => !hidden.has(block.id));
    const text = JSON.stringify(visible);
    expect(text).toContain("Live concerns.");
    expect(text).toContain("meeting stays.");
    expect(text).not.toContain("context capture");
    expect(text).toContain('"Related"');
    expect(text).toContain("Kept.");
    expect(JSON.stringify(blocks)).toBe(original);
  });

  it("preserves code examples and substantive sections mentioning sources or evidence", () => {
    const blocks = parse(
      "```md\n## Sources\ngenerated: example\n```\n\n## Source code\n\nKeep this.\n\n## Evidence Notes\n\nBusiness evidence.",
    );
    expect(knowledgeHiddenBlockIds(blocks, "Project").size).toBe(0);
  });

  beforeEach(() =>
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    ),
  );
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it("hides parsed YAML, its Setext generated heading, duplicate title and Sources without changing blocks", () => {
    const blocks = parse(wikiMarkdown);
    const original = JSON.stringify(blocks);
    const hidden = knowledgeHiddenBlockIds(blocks, "Casey example");
    const visible = JSON.stringify(
      blocks.filter((block) => !hidden.has(block.id)),
    );

    expect(visible).not.toMatch(
      /okf_version|Person Context|openwiki|schema_version|Casey Example|Internal source record|Source details|Machine-facing|Evidence: \[R1\]/,
    );
    expect(visible).toContain("Working preferences");
    expect(visible).toContain("Current areas");
    expect(visible).toContain(
      "Project coordinator across hardware discussions.",
    );
    expect(JSON.stringify(blocks)).toBe(original);
  });

  it("hides JSON OKF frontmatter without hiding the readable Wiki body", () => {
    const markdown = `---
{
  "type": "Session",
  "title": "2026-08-25 Discussion with Example Client",
  "description": "Example Client and Sample Project discussed a staged integration",
  "session_id": "room_sample_session",
  "date": "2026-08-25",
  "source_kind": "room",
  "status": "stable",
  "sources": [
    {
      "id": "R1",
      "resource": "teamhub://documents/document_a/versions/version_a",
      "title": "Raw document version"
    }
  ],
  "relations": {
    "clients": ["../../clients/example-client.md"],
    "projects": ["../../projects/sample-project.md"]
  },
  "generated": {
    "by": "linger-llm-wiki/1",
    "at": "2026-09-29T11:54:08.958Z"
  }
}
---

# 2026-08-25 Discussion with Example Client

Readable body.`;
    const blocks = parse(markdown);
    const original = JSON.stringify(blocks);
    const hidden = knowledgeHiddenBlockIds(
      blocks,
      "2026-08-25 Discussion with Example Client",
    );
    const visible = JSON.stringify(
      blocks.filter((block) => !hidden.has(block.id)),
    );
    expect(visible).not.toMatch(
      /session_id|source_kind|teamhub:\/\/|relations|linger-llm-wiki/u,
    );
    expect(visible).toContain("Readable body.");
    expect(JSON.stringify(blocks)).toBe(original);
  });

  it("hides standalone citation scaffolding while preserving evidence prose and code", () => {
    const blocks = parse(
      "Evidence: [R1] [R2]\n\nEvidence: [R3], [R5]\n\nEvidence: [R1] confirms this decision.\n\n```md\nEvidence: [R4]\n```",
    );
    const original = JSON.stringify(blocks);
    const hidden = knowledgeHiddenBlockIds(blocks, "Meeting");
    expect([...hidden]).toEqual([blocks[0]!.id, blocks[1]!.id]);
    expect(JSON.stringify(blocks)).toBe(original);
  });

  it("also recognizes a separate closing divider", () => {
    const blocks = parse(
      "---\ntitle: Person\n\n---\n\n# Person\n\nReadable body.",
    );
    const hidden = knowledgeHiddenBlockIds(blocks, "Person");
    const visible = blocks.filter((block) => !hidden.has(block.id));
    expect(visible.every((block) => block.type === "paragraph")).toBe(true);
    expect(JSON.stringify(visible)).toContain("Readable body.");
    expect(JSON.stringify(visible)).not.toContain("title:");
  });

  it("preserves ordinary dividers, real code, unmatched titles and later same-name headings", () => {
    const blocks = parse(
      "---\n\n# Guide\n\n```yaml\ngenerated: example\n```\n\n# Guide\n\nSources of uncertainty are discussed here.",
    );
    expect(knowledgeHiddenBlockIds(blocks, "Guide").size).toBe(0);
    expect(
      knowledgeHiddenBlockIds(parse("# Another title\n\nBody."), "Guide").size,
    ).toBe(0);
    const repeated = parse("# Guide\n\nBody.\n\n# Guide\n\nLater section.");
    expect([...knowledgeHiddenBlockIds(repeated, "Guide")]).toEqual([
      repeated[0]!.id,
    ]);
  });

  it("does not discard an unterminated metadata-like opening", () => {
    const blocks = parse(
      "---\ntitle: Person\n\n# Actual content\n\nKeep this.",
    );
    expect(knowledgeHiddenBlockIds(blocks, "Person").size).toBe(0);
    expect(knowledgeHiddenBlockIds(parse("---"), "Person").size).toBe(0);
    expect(knowledgeHiddenBlockIds([], "Person").size).toBe(0);
  });

  it("hides standalone generated metadata but preserves the following body", () => {
    const blocks = parse(
      '# generated: { by: "openwiki" }\n\n## Summary\n\nKeep this.',
    );
    expect([...knowledgeHiddenBlockIds(blocks, "Person")]).toEqual([
      blocks[0]!.id,
    ]);
  });

  it("renders the real collaborative editor in Read / Edit / Read without rewriting its Yjs state", async () => {
    const runtime = createDocumentTestRuntime();

    const doc = seedRoomDocument(runtime, "wiki-reading-projection");
    localDocumentMarkdown.set(doc.id, wikiMarkdown);
    const session = await openLocalDocumentSession({
      documentId: doc.id,
      schemaVersion: 1,
      stateHashVersion: 1,
      user: { actorId: "human-jenny", name: "Jenny", color: "#336699" },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const editor = (editable: boolean) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <RoomDocumentBlockNoteEditor
            client={runtime.client}
            canComment={false}
            currentActorId="human-jenny"
            documentId={doc.id}
            editable={editable}
            knowledgeDocumentTitle="Casey example"
            session={session}
            tenantId="tenant-northstar"
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(editor(false));
    try {
      expect(
        await screen.findByText("Validate prototypes before committing."),
      ).toBeVisible();
      expect(screen.getByText("Internal source record")).not.toBeVisible();
      expect(screen.getByText("Evidence: [R1]")).not.toBeVisible();
      expect(screen.getByText("Internal session file")).not.toBeVisible();
      expect(screen.getByText("Internal TeamHub messages")).not.toBeVisible();
      expect(
        screen.getByText("Casey Example", { exact: true }),
      ).not.toBeVisible();
      expect(
        screen.getByRole("heading", { name: "Current areas" }),
      ).toBeVisible();
      expect(screen.getByText("[R2]")).not.toBeVisible();
      expect(screen.getByText("[R1, R2]")).not.toBeVisible();
      expect(screen.getByText("（R3）")).not.toBeVisible();
      expect(screen.getByText("Update 5", { exact: false })).toBeVisible();
      expect(screen.getByText("Update 6", { exact: false })).not.toBeVisible();
      const original = Y.encodeStateAsUpdate(session.document);
      act(() => screen.getByRole("button", { name: "View more" }).click());
      expect(screen.getByText("Update 7", { exact: false })).toBeVisible();
      act(() => screen.getByRole("button", { name: "Show less" }).click());
      expect(screen.getByText("Update 7", { exact: false })).not.toBeVisible();
      expect(Y.encodeStateAsUpdate(session.document)).toEqual(original);
      expect(await screen.findByTitle("Mermaid diagram preview")).toBeVisible();
      expect(
        view.container.querySelector(".room-document-mermaid__source"),
      ).not.toBeVisible();
      expect(screen.queryByRole("button", { name: "Source" })).toBeNull();

      view.rerender(editor(true));
      await waitFor(() =>
        expect(screen.getByText("Internal source record")).toBeVisible(),
      );
      expect(screen.getByText("Casey Example", { exact: true })).toBeVisible();
      expect(screen.getByText("Internal session file")).toBeVisible();
      expect(screen.getByText("Internal TeamHub messages")).toBeVisible();
      expect(screen.getByRole("button", { name: "Source" })).toBeVisible();
      expect(
        screen.getByText("Hardware prototypes [R2] and AI products", {
          exact: false,
        }),
      ).toBeVisible();
      expect(screen.getByText("Update 7", { exact: false })).toBeVisible();
      expect(screen.queryByRole("button", { name: "View more" })).toBeNull();
      expect(
        view.container.querySelector(".room-document-mermaid__source"),
      ).not.toBeVisible();
      expect(Y.encodeStateAsUpdate(session.document)).toEqual(original);

      view.rerender(editor(false));
      await waitFor(() =>
        expect(screen.getByText("Internal source record")).not.toBeVisible(),
      );
      expect(
        screen.getByRole("heading", { name: "Working preferences" }),
      ).toBeVisible();
      expect(Y.encodeStateAsUpdate(session.document)).toEqual(original);
      expect(session.getSaveSnapshot().status).toBe("Saved");
      expect(screen.getByText("Internal session file")).not.toBeVisible();
      expect(screen.getByText("Internal TeamHub messages")).not.toBeVisible();
      expect(await screen.findByTitle("Mermaid diagram preview")).toBeVisible();
      expect(
        view.container.querySelector(".room-document-mermaid__source"),
      ).not.toBeVisible();
    } finally {
      view.unmount();
      queryClient.clear();
      await session.destroy();
    }
  });
});
