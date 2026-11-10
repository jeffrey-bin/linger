import { describe, expect, it } from "vitest";

import {
  documentRawSource,
  periodReportSource,
  rawSourceContentPath,
  sourceSearchText,
  wikiPageRawSource,
} from "../../src/memory/search/source-store.js";
import { chunkSource } from "../../src/memory/search/chunks.js";

const identity = {
  agent_id: "agent_alex",
  tenant_id: "tenant_local",
  user_artifact_owner_actor_id: "actor_alex",
};

describe("Document Chunk Raw sources", () => {
  it("keeps one source identity across document versions", () => {
    const base = {
      identity,
      documentId: "document_notes",
      title: "Notes",
      filename: "notes.md",
      mediaType: "text/markdown",
      date: "2026-09-27",
    };
    const first = documentRawSource({
      ...base,
      textSourceKind: "native_body",
      textSourceId: "7",
      markdown: "# First\n",
    });
    const second = documentRawSource({
      ...base,
      textSourceKind: "file_version",
      textSourceId: "version_2",
      markdown: "# Second\n",
      originKind: "mail",
    });

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      originKind: "my_pages",
      sourceUri: "teamhub://documents/document_notes",
    });
    expect(second).toMatchObject({
      sourceKind: "document",
      originKind: "mail",
      sourceVersion: "version_2",
      sourceUri: "teamhub://documents/document_notes/versions/version_2",
      metadata: {
        text_source_kind: "file_version",
        text_source_id: "version_2",
      },
    });
    expect(rawSourceContentPath(second)).toMatch(
      /^memory-state\/raw\/documents\/[a-f0-9]{64}\/[a-f0-9]{64}\.md$/u,
    );
  });

  it("names Wiki pages and reports as their own source kinds", () => {
    const page = wikiPageRawSource({
      identity,
      pageKey: "projects/alpha.md",
      title: "Alpha",
      documentId: "document_page",
      documentVersionId: "version_page",
      publishedAt: "2026-09-27T08:00:00.000Z",
      revision: "revision_a",
      markdown: "# Alpha\n",
    });
    const report = periodReportSource({
      identity,
      collection: "weekly",
      periodStart: "2026-09-21",
      title: "Week",
      markdown: "# Week\n",
    });

    expect(page).toMatchObject({
      sourceKind: "wiki_page",
      originKind: "wiki",
      date: "2026-09-27",
      metadata: { page_key: "projects/alpha.md" },
    });
    expect(report).toMatchObject({
      sourceKind: "period_report",
      originKind: "period_summary",
      date: "2026-09-21",
      metadata: { collection: "weekly", period_start: "2026-09-21" },
    });
    expect(rawSourceContentPath(page)).toMatch(
      /^memory-state\/raw\/wiki\/[a-f0-9]{64}\/[a-f0-9]{64}\.md$/u,
    );
    expect(rawSourceContentPath(report)).toMatch(
      /^memory-state\/raw\/reports\/[a-f0-9]{64}\/[a-f0-9]{64}\.md$/u,
    );
  });

  it("searches a Wiki page's body without its frontmatter or citation labels", () => {
    const page = [
      "---",
      JSON.stringify(
        {
          type: "Project",
          title: "Alpha",
          sources: [
            { id: "R1", resource: "teamhub://documents/doc_1/versions/v1" },
          ],
        },
        null,
        2,
      ),
      "---",
      "",
      "# Alpha",
      "",
      "## Project Summary",
      "",
      "Ships in May [R1]. Owned by Casey [R1, R2] and Kim (R2)；よさんはしょうにん（R3）。",
      "",
      "- Evidence: [R1]",
      "- Keeps [the spec](https://example.com/spec) and [R2](notes.md).",
      "",
    ].join("\n");
    const text = sourceSearchText("wiki_page", page);

    expect(text).toBe(
      [
        "# Alpha",
        "",
        "## Project Summary",
        "",
        "Ships in May. Owned by Casey and Kim；よさんはしょうにん。",
        "",
        "-",
        "- Keeps [the spec](https://example.com/spec) and [R2](notes.md).",
        "",
      ].join("\n"),
    );
    expect(chunkSource(text)[0]!.content.startsWith("# Alpha")).toBe(true);
    expect(sourceSearchText("document", page)).toBe(page);
  });

  it("keeps a Wiki page's description and aliases searchable", () => {
    const page = [
      "---",
      JSON.stringify({
        type: "Project",
        title: "Lev8",
        description: "People-intelligence product for sales teams.",
        aliases: ["レフハチ", ""],
        sources: [
          { id: "R1", resource: "teamhub://documents/doc_1/versions/v1" },
        ],
      }),
      "---",
      "",
      "# Lev8",
      "",
      "## Project Summary",
      "",
      "Launched in May [R1].",
    ].join("\n");

    expect(sourceSearchText("wiki_page", page)).toBe(
      [
        "# Lev8",
        "",
        "People-intelligence product for sales teams.",
        "Aliases: レフハチ",
        "",
        "## Project Summary",
        "",
        "Launched in May.",
      ].join("\n"),
    );
  });
});
