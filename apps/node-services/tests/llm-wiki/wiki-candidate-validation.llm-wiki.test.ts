import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkpointTree } from "../../src/llm-wiki/actor-wiki/wiki-workspace.js";
import {
  inspectWikiCandidate,
  normalizeRegisteredNodeMetadata,
  normalizeWikiCandidate,
} from "../../src/llm-wiki/wiki-candidate-validation.js";
import { wikiSourceReferences } from "../../src/llm-wiki/personal-wiki-policy.js";
import {
  PERSONAL_WIKI_NODE_TYPES,
  personalWikiSectionFormat,
  personalWikiSectionUpdate,
} from "../../src/llm-wiki/personal-wiki-node-types.js";
import { renderWikiPage } from "../../src/llm-wiki/wiki-page-template.js";

const validTopicFrontmatter = `---
type: Topic
title: Adapter
description: Durable adapter behavior.
tags: [adapter]
status: stable
generated: { by: linger-llm-wiki/1, at: 2026-09-08T10:00:00Z }
sources:
  - resource: document://source/1
graph:
  schema_version: 1
  id: adapter
  topic_kind: concept
  representation: knowledge
  summary: The adapter normalizes model output.
---

`;

describe("inspectWikiCandidate", () => {
  describe("duplicate entity identities", () => {
    const references = new Map([
      ["raw:S1", "teamhub://rooms/room_entity/messages/message_1"],
    ]);
    function entityPage(
      page: string,
      type: "project" | "topic",
      name: string,
      aliases: string[],
      parts = "",
    ): string {
      const definition = PERSONAL_WIKI_NODE_TYPES.get(type)!;
      return renderWikiPage(
        page,
        {
          title: name,
          description: `${name} durable entity.`,
          fields:
            type === "project"
              ? { project_name: name, project_slug: page.slice(9, -3), aliases }
              : { topic_name: name, aliases },
          sections: Object.fromEntries(
            definition.sections.flatMap((heading) => {
              const update = personalWikiSectionUpdate(definition, heading);
              const text = `Supported ${heading} state for ${name}. [[source:raw:S1]]${
                heading === "Project Directions" ? parts : ""
              }`;
              if (update === "generated") return [];
              return [
                [
                  heading,
                  update === "items"
                    ? [{ text }]
                    : { text, reason: "first write" },
                ],
              ];
            }),
          ),
          source_refs: ["raw:S1"],
          relations: {},
        },
        references,
      );
    }
    async function wiki(pages: Record<string, string>): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), "wiki-duplicate-entity-"));
      await writeFile(join(root, "index.md"), "# Wiki\n");
      for (const [page, content] of Object.entries(pages)) {
        await mkdir(join(root, page, ".."), { recursive: true });
        await writeFile(join(root, page), content);
      }
      return root;
    }

    it("rejects two pages of one type that share a name or alias", async () => {
      const root = await wiki({
        "projects/orbit.md": entityPage(
          "projects/orbit.md",
          "project",
          "Orbit",
          ["Orbit research assistant"],
        ),
        "projects/orbit-research-assistant.md": entityPage(
          "projects/orbit-research-assistant.md",
          "project",
          "Orbit Research-Assistant",
          [],
        ),
      });
      try {
        const report = await inspectWikiCandidate(root, {
          enforceRegisteredNodes: true,
        });
        expect(
          report.issues.filter(
            (issue) => issue.code === "duplicate_entity_identity",
          ),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              page: "projects/orbit.md",
              relatedPages: ["projects/orbit-research-assistant.md"],
            }),
            expect.objectContaining({
              page: "projects/orbit-research-assistant.md",
              relatedPages: ["projects/orbit.md"],
            }),
          ]),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("only warns about duplicates that predate the run", async () => {
      const root = await wiki({
        "projects/a.md": entityPage("projects/a.md", "project", "Atlas", []),
        "projects/b.md": entityPage("projects/b.md", "project", "Atlas", []),
      });
      try {
        const report = await inspectWikiCandidate(root, {
          contentBaseline: await checkpointTree(root),
          enforceRegisteredNodes: true,
        });
        expect(
          report.issues.some(
            (issue) => issue.code === "duplicate_entity_identity",
          ),
        ).toBe(false);
        expect(report.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "duplicate_entity_identity" }),
          ]),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("keeps an untouched page's earlier section layout but checks a changed page", async () => {
      // Remove a current section to stand in for a page published before it existed.
      const earlier = entityPage(
        "projects/a.md",
        "project",
        "Atlas",
        [],
      ).replace(/^## Related\n\n[\s\S]*?(?=^## )/mu, "");
      const root = await wiki({ "projects/a.md": earlier });
      try {
        const sectionIssue = (report: { issues: { detail?: string }[] }) =>
          report.issues.some((issue) =>
            issue.detail?.includes("required H2 section is missing"),
          );
        expect(
          sectionIssue(
            await inspectWikiCandidate(root, {
              contentBaseline: await checkpointTree(root),
              enforceRegisteredNodes: true,
            }),
          ),
        ).toBe(false);
        expect(
          sectionIssue(
            await inspectWikiCandidate(root, {
              contentBaseline: new Map(),
              enforceRegisteredNodes: true,
            }),
          ),
        ).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    async function duplicateIssues(pages: Record<string, string>) {
      const root = await wiki(pages);
      try {
        const report = await inspectWikiCandidate(root, {
          enforceRegisteredNodes: true,
        });
        return report.issues.filter(
          (issue) => issue.code === "duplicate_entity_identity",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    it("allows distinct names and repeated part names inside projects", async () => {
      const direction = "\n\n##### Direction: Evaluation\n\nState.";
      expect(
        await duplicateIssues({
          "projects/atlas.md": entityPage(
            "projects/atlas.md",
            "project",
            "Atlas",
            [],
            direction,
          ),
          "projects/helios.md": entityPage(
            "projects/helios.md",
            "project",
            "Helios",
            ["Helios 2.0"],
            direction,
          ),
          "topics/retrieval.md": entityPage(
            "topics/retrieval.md",
            "topic",
            "Retrieval",
            [],
          ),
        }),
      ).toEqual([]);
    });

    it("rejects a Topic that repeats a Project name, alias, or part", async () => {
      const issues = await duplicateIssues({
        "projects/atlas.md": entityPage(
          "projects/atlas.md",
          "project",
          "Atlas",
          ["Atlas planner"],
          "\n\n##### Direction: Search Planning\n\nState.",
        ),
        "topics/atlas-planner.md": entityPage(
          "topics/atlas-planner.md",
          "topic",
          "Atlas Planner",
          [],
        ),
        "topics/search-planning.md": entityPage(
          "topics/search-planning.md",
          "topic",
          "Search planning",
          [],
        ),
      });
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            page: "topics/atlas-planner.md",
            relatedPages: ["projects/atlas.md"],
          }),
          expect.objectContaining({
            page: "topics/search-planning.md",
            relatedPages: ["projects/atlas.md"],
          }),
        ]),
      );
    });
  });

  it.each(["pre-Pattern", "eight-section", "six-section"])(
    "keeps an unchanged %s Session readable but validates new writes",
    async (shape) => {
      const root = await mkdtemp(join(tmpdir(), "wiki-legacy-pattern-"));
      const page = "sessions/2026-09-29/room_pattern.md";
      const definition = PERSONAL_WIKI_NODE_TYPES.get("session")!;
      try {
        await mkdir(join(root, "sessions/2026-09-29"), { recursive: true });
        await writeFile(join(root, "index.md"), "# Wiki\n");
        const current = renderWikiPage(
          page,
          {
            title: "Evidence review",
            description: "A source-grounded review session.",

            fields: {
              session_id: "room_pattern",
              date: "2026-09-29",
              source_kind: "room",
            },
            sections: Object.fromEntries(
              definition.sections.map((heading) => {
                const text =
                  "The user requested evidence review before confirming the next implementation step. [[source:raw:S1]]";
                const format = personalWikiSectionFormat(definition, heading);
                return [
                  heading,
                  format === "list"
                    ? [text]
                    : format === "outcomes"
                      ? [{ kind: "decision", text, evidence: text }]
                      : format === "actions"
                        ? [{ text, evidence: text }]
                        : text,
                ];
              }),
            ),
            source_refs: ["raw:S1"],
            relations: {},
            source_readable: true,
          },
          new Map([
            ["raw:S1", "teamhub://rooms/room_pattern/messages/message_1"],
          ]),
        );
        const withoutSummary = current.replace(
          /^## Meeting Summary[^\S\r\n]*\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/mu,
          "",
        );
        const legacy =
          shape === "eight-section"
            ? withoutSummary.replace(
                /## Decisions And Outcomes[\s\S]*?(?=## Action Items)/u,
                "## Completed Or Resolved\n\nNone observed.\n\n## Decisions Made\n\nNone observed.\n\n## Goals And Intended Outcomes\n\nReview evidence. [R1]\n\n",
              )
            : shape === "six-section"
              ? withoutSummary
              : withoutSummary.replace(
                  /^## Pattern[^\S\r\n]*\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/mu,
                  "",
                );
        await writeFile(join(root, page), legacy);
        await normalizeWikiCandidate(root);
        const baseline = await checkpointTree(root);
        const inherited = await inspectWikiCandidate(root, {
          contentBaseline: baseline,
          enforceRegisteredNodes: true,
        });
        expect(inherited.issues).toEqual([]);
        const inheritedContent = await readFile(join(root, page), "utf8");
        if (shape === "pre-Pattern")
          expect(inheritedContent).not.toMatch(/^## Pattern/m);
        else if (shape === "eight-section")
          expect(inheritedContent).toContain("## Goals And Intended Outcomes");
        else expect(inheritedContent).not.toMatch(/^## Meeting Summary/m);
        await writeFile(
          join(root, page),
          `${legacy}\nAdditional supported state changed.\n`,
        );
        const changed = await inspectWikiCandidate(root, {
          contentBaseline: baseline,
          enforceRegisteredNodes: true,
        });
        expect(changed.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "invalid_node_structure",
              page,
              detail: expect.stringContaining("Meeting Summary"),
            }),
          ]),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("canonicalizes and deduplicates immutable input references for initialization", () => {
    const source = {
      assetKey: "a",
      title: "A",
      contentPath: "a.md",
      contentSha256: "hash",
      sourceUrl: "document://a/versions/v1",
    };
    const references = wikiSourceReferences({
      added: [source],
      modified: [source],
      removed: [],
    });
    expect([...references]).toEqual([
      [
        expect.stringMatching(/^raw:S[0-9a-f]{16}$/u),
        "teamhub://documents/a/versions/v1",
      ],
    ]);
  });

  it("keeps raw reference IDs stable when the source set grows or is reordered", () => {
    const changes = { added: [], modified: [], removed: [] };
    const uri = "teamhub://documents/stable/versions/v1";
    const first = [...wikiSourceReferences(changes, [uri])][0]![0];
    const expanded = wikiSourceReferences(changes, [
      "teamhub://rooms/a/messages/message_1",
      uri,
    ]);
    expect(expanded.get(first)).toBe(uri);
    expect(
      wikiSourceReferences(changes, [
        uri,
        "teamhub://rooms/a/messages/message_1",
      ]),
    ).toEqual(expanded);
  });

  it("normalizes registered aliases and raw evidence metadata deterministically", () => {
    const normalized = normalizeRegisteredNodeMetadata(
      "projects/alpha.md",
      `---
type: Project
title: Alpha
project_name: Alpha
project_slug: alpha
sources:
  - id: R1
    resource: memory://knowledge/projects/alpha.md
graph:
  schema_version: 1
  id: alpha
  topic_kind: project_knowledge
  representation: knowledge
  summary: Alpha project.
---

# Alpha

The source supports this project [R1].
`,
      ["teamhub://rooms/room-alpha/messages/message_1"],
    );

    expect(normalized).toContain('"aliases": []');
    expect(normalized).toContain(
      '"resource": "teamhub://rooms/room-alpha/messages/message_1"',
    );
    expect(normalized).not.toContain("memory://knowledge/projects/alpha.md");
    expect(normalized).not.toContain('"id": "R1"');
    expect(normalized).toContain('"id": "R2"');
    expect(normalized).toContain("[R1]");
  });

  it("preserves explicit citation identity when canonicalizing a Document version URL", () => {
    const normalized = normalizeRegisteredNodeMetadata(
      "topics/adapter.md",
      validTopicFrontmatter.replace(
        "  - resource: document://source/1",
        "  - id: R7\n    resource: document://document_a/versions/version_a",
      ) + "The adapter uses raw evidence [R7].\n",
    );
    expect(normalized).toContain('"id": "R7"');
    expect(normalized).toContain(
      "teamhub://documents/document_a/versions/version_a",
    );
  });

  it("checks init structure and citations even without routed targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-init-structure-"));
    try {
      await mkdir(join(root, "topics"));
      await mkdir(join(root, "me/daily"), { recursive: true });
      await writeFile(join(root, "index.md"), "# Wiki\n");
      await writeFile(
        join(root, "topics", "adapter.md"),
        validTopicFrontmatter + "A supported adapter fact [R9].\n",
      );
      await writeFile(
        join(root, "me/daily/2026-09-08.md"),
        validTopicFrontmatter + "An invented initialization recap.\n",
      );
      const report = await inspectWikiCandidate(root, {
        enforceRegisteredNodes: true,
      });
      expect(report.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "invalid_node_structure" }),
          expect.objectContaining({ code: "invalid_evidence_reference" }),
        ]),
      );
      expect(report.issues).toContainEqual(
        expect.objectContaining({
          page: "me/daily/2026-09-08.md",
          detail: "new or changed pages must belong to a registered node type",
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a routed Session node and rejects unrelated changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-session-node-"));
    await mkdir(join(root, "sessions", "2026-09-27"), { recursive: true });
    await mkdir(join(root, "people"), { recursive: true });
    await writeFile(join(root, "index.md"), "# Wiki\n");
    await writeFile(
      join(root, "sessions", "2026-09-27", "room-one.md"),
      `---
type: Session
title: "Session: Product planning"
session_id: room-one
date: 2026-09-27
source_kind: room
sources:
  - id: R1
    title: TeamHub Room messages
    resource: teamhub://rooms/room-one/messages/message_1
graph:
  schema_version: 1
  id: room-one@2026-09-27
  topic_kind: concept
  representation: knowledge
  summary: Product planning and supported next steps.
---

# Session: Product planning

## Objective Summary

The team reviewed the product plan and agreed on supported next steps [R1].

## Keywords

- product planning

## Meeting Summary

The team reviewed delivery and supported next steps [R1].

## Main Topics

### Delivery

- Key Points: The delivery plan was reviewed [R1].

## Decisions And Outcomes

None observed.

## Action Items

None observed.

## Pattern

None observed.
`,
    );
    await normalizeWikiCandidate(root);

    await expect(
      inspectWikiCandidate(root, {
        expectedTargetPaths: ["sessions/2026-09-27/room-one.md"],
        newSourceUrls: ["teamhub://rooms/room-one/messages/message_1"],
        sourceNodeTypes: ["session"],
      }),
    ).resolves.toEqual({ issues: [], pageCount: 2 });
    // A routed page must cite its own Session, not another one of the run.
    const ownCitation = (citations: string[]) =>
      inspectWikiCandidate(root, {
        contentBaseline: new Map(),
        expectedTargetPaths: ["sessions/2026-09-27/room-one.md"],
        newSourceUrls: [
          "teamhub://rooms/room-one/messages/message_1",
          "teamhub://rooms/room-two/messages/message_9",
        ],
        targetSourceUrls: new Map([
          ["sessions/2026-09-27/room-one.md", citations],
        ]),
        requireContentChange: true,
        sourceNodeTypes: ["session"],
      });
    expect(
      (await ownCitation(["teamhub://rooms/room-one/messages/message_1"]))
        .issues,
    ).toEqual([]);
    expect(
      (await ownCitation(["teamhub://rooms/room-two/messages/message_9"]))
        .issues,
    ).toEqual([
      expect.objectContaining({
        code: "missing_new_source",
        page: "sessions/2026-09-27/room-one.md",
      }),
    ]);

    await writeFile(
      join(root, "people", "unrelated.md"),
      validTopicFrontmatter +
        "# Unrelated person\n\nThis unrelated page was changed by the Session update.\n",
    );
    await writeFile(
      join(root, "sessions", "2026-09-27", "room-typo.md"),
      (
        await readFile(
          join(root, "sessions", "2026-09-27", "room-one.md"),
          "utf8",
        )
      ).replaceAll("room-one", "room-typo"),
    );
    await expect(
      inspectWikiCandidate(root, {
        expectedTargetPaths: ["sessions/2026-09-27/room-one.md"],
        newSourceUrls: ["teamhub://rooms/room-one/messages/message_1"],
        sourceNodeTypes: ["session"],
      }),
    ).resolves.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "unrelated_page_change",
          page: "people/unrelated.md",
        }),
        expect.objectContaining({
          code: "unrelated_page_change",
          page: "sessions/2026-09-27/room-typo.md",
        }),
      ]),
    });
  });

  it("rejects generated-node provenance that does not point to raw TeamHub evidence", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "wiki-candidate-non-raw-source-"),
    );
    await mkdir(join(root, "topics"), { recursive: true });
    await writeFile(join(root, "index.md"), "# Wiki\n");
    await writeFile(
      join(root, "topics", "adapter.md"),
      `---
type: Topic
title: Adapter
topic_name: Adapter
aliases: [Adapter]
sources:
  - id: R1
    resource: memory://timeline/daily/2026-09-27.md
graph:
  schema_version: 1
  id: adapter
  topic_kind: concept
  representation: knowledge
  summary: Durable adapter behavior.
---

# Adapter

## Overview

The adapter behavior is documented by the supplied evidence [R1].

## Current Understanding

The adapter remains active.

## Related

None observed.

## Change Log

None observed.
`,
    );

    await expect(
      inspectWikiCandidate(root, {
        expectedTargetPaths: ["topics/adapter.md"],
        sourceNodeTypes: ["topic"],
      }),
    ).resolves.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_evidence_reference",
          page: "topics/adapter.md",
        }),
      ]),
    });
  });

  it("reports placeholder pages and links to transient source projections", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-invalid-"));
    await mkdir(join(root, "topics"), { recursive: true });
    await writeFile(join(root, "index.md"), "# Wiki\n");
    await writeFile(
      join(root, "topics", "adapter.md"),
      validTopicFrontmatter +
        "# Adapter\n\nAdapter behavior: <placeholder>.\n\n" +
        "[Source](../inputs/source/document.md)\n",
    );

    await expect(inspectWikiCandidate(root)).resolves.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "placeholder_content",
          page: "topics/adapter.md",
        }),
        expect.objectContaining({
          code: "transient_source_link",
          page: "topics/adapter.md",
        }),
      ]),
      pageCount: 2,
    });
  });

  it("accepts canonical source URLs and resolvable Wiki links", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-valid-"));
    await mkdir(join(root, "topics"), { recursive: true });
    await writeFile(
      join(root, "index.md"),
      "# Wiki\n\n[Adapter](topics/adapter.md)\n",
    );
    await writeFile(
      join(root, "topics", "adapter.md"),
      validTopicFrontmatter +
        "# Adapter\n\nThe adapter normalizes model output before summarization.\n\n" +
        "[Index](../index.md)\n\n" +
        "Source: document://source/version/1\n",
    );

    await normalizeWikiCandidate(root);

    await expect(inspectWikiCandidate(root)).resolves.toEqual({
      issues: [],
      pageCount: 2,
    });
  });

  it("normalizes a duplicate root OKF version emitted as body text", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-root-version-"));
    await writeFile(
      join(root, "index.md"),
      `---
okf_version: "0.2"
---

okf_version: "0.2"

# Wiki
`,
    );

    await normalizeWikiCandidate(root);

    await expect(readFile(join(root, "index.md"), "utf8")).resolves.toBe(
      '---\nokf_version: "0.2"\n---\n\n# Wiki\n',
    );
  });

  it("repairs unquoted OKF scalars before publish the same way Memory does", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-okf-yaml-"));
    await mkdir(join(root, "topics"), { recursive: true });
    await writeFile(
      join(root, "index.md"),
      "# Wiki\n\n[Session](topics/session.md)\n",
    );
    await writeFile(
      join(root, "topics", "session.md"),
      validTopicFrontmatter
        .replace("title: Adapter", "title: Session: 2026-06-05 Bo shares notes")
        .replace("id: adapter", "id: session") +
        "# Session\n\nThe session notes stay in the body after YAML repair.\n",
    );

    await normalizeWikiCandidate(root);

    const published = await readFile(
      join(root, "topics", "session.md"),
      "utf8",
    );
    expect(published).toContain('title: "Session: 2026-06-05 Bo shares notes"');
    expect(published).toContain(
      "The session notes stay in the body after YAML repair.",
    );
    await expect(inspectWikiCandidate(root)).resolves.toEqual({
      issues: [],
      pageCount: 2,
    });
  });

  it("removes an exact source copy without rewriting legacy graph metadata", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "wiki-candidate-openwiki-compat-"),
    );
    await mkdir(join(root, "source-asset"), { recursive: true });
    await mkdir(join(root, "topics"), { recursive: true });
    await writeFile(
      join(root, "index.md"),
      "# Wiki\n\n[Raw source](source-asset/document.md)\n",
    );
    await writeFile(
      join(root, "source-asset", "document.md"),
      "# Raw source\n",
    );
    await writeFile(
      join(root, "topics", "hardware.md"),
      validTopicFrontmatter
        .replace("topic_kind: concept", "topic_kind: hardware_development")
        .replace("representation: knowledge", "representation: topic") +
        "# Hardware Development\n\nDurable hardware development knowledge.\n",
    );

    await normalizeWikiCandidate(root, {
      sourcePaths: ["source-asset/document.md"],
    });

    await expect(
      readFile(join(root, "source-asset", "document.md"), "utf8"),
    ).rejects.toThrow();
    await expect(readFile(join(root, "index.md"), "utf8")).resolves.toContain(
      "Raw source\n",
    );
    await expect(
      readFile(join(root, "topics", "hardware.md"), "utf8"),
    ).resolves.toContain("topic_kind: hardware");
    await expect(
      readFile(join(root, "topics", "hardware.md"), "utf8"),
    ).resolves.toContain("representation: topic");
    await expect(inspectWikiCandidate(root)).resolves.toEqual({
      issues: [],
      pageCount: 2,
    });
  });

  it("rejects an index-only candidate when evidence changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-index-only-"));
    await writeFile(join(root, "index.md"), "# Wiki\n");

    await expect(
      inspectWikiCandidate(root, { requireContentPage: true }),
    ).resolves.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "no_content_pages" }),
      ]),
      pageCount: 1,
    });
  });

  it("rejects a candidate that ignores added or modified evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-unchanged-"));
    await writeFile(join(root, "index.md"), "# Wiki\n");
    await writeFile(
      join(root, "topic.md"),
      validTopicFrontmatter +
        "# Adapter\n\nThe existing adapter behavior remains unchanged.\n",
    );
    await normalizeWikiCandidate(root);
    const baseline = await checkpointTree(root);

    await expect(
      inspectWikiCandidate(root, {
        contentBaseline: baseline,
        requireContentChange: true,
      }),
    ).resolves.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "no_content_changes" }),
      ]),
    });
  });

  it("requires every Memory session provenance boundary to be represented", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-coverage-"));
    await writeFile(join(root, "index.md"), "# Wiki\n");
    await writeFile(
      join(root, "topic.md"),
      validTopicFrontmatter +
        "# Adapter\n\nSource-grounded entity knowledge.\n\n" +
        "Source: teamhub://rooms/room_one/messages/message_1\n",
    );

    await expect(
      inspectWikiCandidate(root, {
        requiredSourceUrls: [
          "teamhub://rooms/room_one/messages/message_1",
          "teamhub://rooms/room_two/messages/message_1",
        ],
      }),
    ).resolves.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "missing_source_coverage",
          detail: expect.stringContaining("room_two"),
        }),
      ]),
    });
  });

  it("rejects deletion of an existing entity page during an additive Memory update", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-preserve-"));
    await writeFile(join(root, "index.md"), "# Wiki\n");
    await writeFile(
      join(root, "existing-topic.md"),
      validTopicFrontmatter +
        "# Existing topic\n\nExisting source-grounded entity knowledge.\n",
    );
    await normalizeWikiCandidate(root);
    const baseline = await checkpointTree(root);
    await rm(join(root, "existing-topic.md"));
    await writeFile(
      join(root, "new-topic.md"),
      validTopicFrontmatter +
        "# New topic\n\nNew source-grounded entity knowledge.\n",
    );

    await expect(
      inspectWikiCandidate(root, {
        contentBaseline: baseline,
        preserveBaselineContentPages: true,
      }),
    ).resolves.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "removed_existing_page",
          page: "existing-topic.md",
        }),
      ]),
    });
  });

  it("removes links to staged source files while keeping generated Wiki links", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-source-links-"));
    await mkdir(join(root, "topics"), { recursive: true });
    await writeFile(
      join(root, "index.md"),
      "# Wiki\n\n[Source](inputs/source.md)\n[Topic](topics/topic.md)\n",
    );
    await writeFile(
      join(root, "topics", "topic.md"),
      validTopicFrontmatter +
        "# Topic\n\nThe topic retains source-grounded explanatory content.\n",
    );

    await normalizeWikiCandidate(root, { sourcePaths: ["source.md"] });

    await expect(readFile(join(root, "index.md"), "utf8")).resolves.toContain(
      "Source\n[Topic](topics/topic.md)",
    );
    await expect(inspectWikiCandidate(root)).resolves.toEqual({
      issues: [],
      pageCount: 2,
    });
  });

  it("removes source-title links emitted by OpenWiki's directory index", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-source-title-"));
    await writeFile(
      join(root, "index.md"),
      "# Wiki\n\n[2.0 Größenplan](2-0-gr%C3%B6%C3%9Fenplan-ijcbw2h1.md)\n",
    );

    await normalizeWikiCandidate(root, { sourceTitles: ["2.0 Größenplan"] });

    await expect(readFile(join(root, "index.md"), "utf8")).resolves.toContain(
      "# Wiki\n\n2.0 Größenplan\n",
    );
    await expect(inspectWikiCandidate(root)).resolves.toEqual({
      issues: [],
      pageCount: 1,
    });
  });

  it("removes navigation-only directories and their stale parent links", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-empty-nav-"));
    await mkdir(join(root, "people"), { recursive: true });
    await writeFile(
      join(root, "index.md"),
      "# Wiki\n\n- [People](people/)\n- [Topic](topic.md)\n",
    );
    await writeFile(
      join(root, "people", "index.md"),
      "# Files\n\n- Alice - User-level preferences without a page.\n",
    );
    await writeFile(
      join(root, "topic.md"),
      validTopicFrontmatter +
        "# Topic\n\nThe topic retains source-grounded explanatory content.\n",
    );

    await normalizeWikiCandidate(root);

    await expect(access(join(root, "people", "index.md"))).rejects.toThrow();
    await expect(readFile(join(root, "index.md"), "utf8")).resolves.toBe(
      '---\nokf_version: "0.2"\n---\n\n# Wiki\n\n- [Topic](topic.md)\n',
    );
    await expect(inspectWikiCandidate(root)).resolves.toEqual({
      issues: [],
      pageCount: 2,
    });
  });

  it("downgrades unresolved concept links to text without creating empty pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-broken-link-"));
    await writeFile(join(root, "index.md"), "# Wiki\n\n[Topic](topic.md)\n");
    await writeFile(
      join(root, "topic.md"),
      validTopicFrontmatter +
        "# Topic\n\nThe topic retains durable knowledge about Alice and Bob.\n\n" +
        "Related: [Alice](/people/alice.md) and [Bob](people/bob.md).\n",
    );

    await normalizeWikiCandidate(root);

    await expect(readFile(join(root, "topic.md"), "utf8")).resolves.toContain(
      "Related: Alice and Bob.",
    );
    await expect(inspectWikiCandidate(root)).resolves.toEqual({
      issues: [],
      pageCount: 2,
    });
  });

  it("detects placeholders only by explicit markers, never by prose", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-generic-"));
    await writeFile(join(root, "index.md"), "# Wiki\n");
    const page = (body: string) => `---
type: Topic
title: Roadmap discussion
description: This document summarizes the roadmap discussion.
sources:
  - resource: document://source/1
---

# Roadmap discussion

${body}
`;
    await writeFile(
      join(root, "topic.md"),
      page(
        "This document summarizes the roadmap and covers the key aspects of each milestone.",
      ),
    );
    await normalizeWikiCandidate(root);
    await expect(inspectWikiCandidate(root)).resolves.toEqual({
      issues: [],
      pageCount: 2,
    });
    for (const marker of ["<TODO>", "[tbd]", "< placeholder note=x>"]) {
      await writeFile(
        join(root, "topic.md"),
        page(`The roadmap milestones are listed here: ${marker}.`),
      );
      await expect(inspectWikiCandidate(root)).resolves.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "placeholder_content",
            page: "topic.md",
          }),
        ]),
      });
    }
  });

  it("accepts native OpenWiki metadata without adding a second graph schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-okf-invalid-"));
    await writeFile(join(root, "index.md"), "# Wiki\n");
    await writeFile(
      join(root, "topic.md"),
      `---
type: Topic
title: Topic
description: Durable knowledge about the topic.
tags: [topic]
status: stable
generated: { by: openwiki/0.4.3, at: 2026-09-08T10:00:00Z }
sources:
  - resource: document://source/1
---

# Topic

This page explains durable behavior with source-grounded context.
`,
    );
    await normalizeWikiCandidate(root);

    await expect(readFile(join(root, "topic.md"), "utf8")).resolves.not.toMatch(
      /graph:|"graph"|topic_kind/u,
    );
    await expect(inspectWikiCandidate(root)).resolves.toEqual({
      issues: [],
      pageCount: 2,
    });
  });

  it("rejects generic Personal Wiki pages omitted by product policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-omitted-page-"));
    await writeFile(join(root, "index.md"), "# Wiki\n");
    await writeFile(
      join(root, "commitments.md"),
      validTopicFrontmatter +
        "# Commitments\n\nTrack project actions on their owning entity pages.\n",
    );

    await expect(inspectWikiCandidate(root)).resolves.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "forbidden_personal_page",
          page: "commitments.md",
        }),
      ]),
    });
  });

  it("reports invalid required OKF fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-okf-invalid-"));
    await writeFile(join(root, "index.md"), "# Wiki\n");
    await writeFile(
      join(root, "topic.md"),
      "---\nstatus: active\n---\n\n# Topic\n",
    );
    await normalizeWikiCandidate(root);

    await expect(inspectWikiCandidate(root)).resolves.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_okf", page: "topic.md" }),
      ]),
    });
  });

  it("reports candidate-wide issues in a stable order for a missing tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-missing-"));

    await expect(
      inspectWikiCandidate(join(root, "absent"), {
        requireContentChange: true,
        requireContentPage: true,
        requiredSourceUrls: ["teamhub://rooms/room_a/messages/message_1"],
      }),
    ).resolves.toEqual({
      issues: [
        expect.objectContaining({ code: "missing_index" }),
        expect.objectContaining({ code: "no_markdown_pages" }),
        expect.objectContaining({ code: "no_content_pages" }),
        expect.objectContaining({ code: "missing_source_coverage" }),
        expect.objectContaining({ code: "no_content_changes" }),
      ],
      pageCount: 0,
    });
  });

  it("limits period evidence to its routed page and rejects empty pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-candidate-period-"));
    await mkdir(join(root, "me/daily"), { recursive: true });
    await mkdir(join(root, "topics"), { recursive: true });
    await writeFile(join(root, "index.md"), "# Wiki\n");
    await writeFile(
      join(root, "me/daily/2026-09-08.md"),
      validTopicFrontmatter + "# Daily\n\nThe routed daily summary.\n",
    );
    await writeFile(
      join(root, "topics/other.md"),
      validTopicFrontmatter + "# Other\n\nAn unrelated topic change.\n",
    );
    await writeFile(join(root, "topics/blank.md"), "");

    const report = await inspectWikiCandidate(root, {
      expectedTargetPaths: ["me/daily/2026-09-08.md"],
      sourceNodeTypes: ["daily"],
    });

    expect(report.pageCount).toBe(4);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        {
          code: "unrelated_page_change",
          detail: "Daily evidence may update only its routed Daily page",
          page: "topics/other.md",
        },
        {
          code: "empty_page",
          detail: "the page has no content",
          page: "topics/blank.md",
        },
      ]),
    );
    expect(report.issues).not.toContainEqual(
      expect.objectContaining({
        code: "unrelated_page_change",
        page: "me/daily/2026-09-08.md",
      }),
    );
  });
});

describe("published baseline regression checks", () => {
  it("ignores legacy graph IDs; native page paths remain the identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-native-identities-"));
    try {
      await mkdir(join(root, "topics"));
      await writeFile(join(root, "index.md"), "# Wiki\n");
      const page =
        validTopicFrontmatter +
        "# Adapter\n\nPreserve published, source-grounded facts.\n";
      await writeFile(join(root, "topics/a.md"), page);
      await writeFile(join(root, "topics/b.md"), page);
      await normalizeWikiCandidate(root);
      const inspected = await inspectWikiCandidate(root);
      expect(inspected.issues).toEqual([]);
      expect(inspected.pageCount).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unchanged routed targets even when a global quality warning is tolerated", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-stale-target-"));
    try {
      await mkdir(join(root, "topics"));
      await writeFile(join(root, "index.md"), "# Wiki\n");
      await writeFile(
        join(root, "topics/a.md"),
        validTopicFrontmatter +
          "# Adapter\n\nA previously published explanation of the documented behavior.\n",
      );
      const inspection = await inspectWikiCandidate(root, {
        contentBaseline: await checkpointTree(root),
        expectedTargetPaths: ["topics/a.md"],
        requireContentChange: true,
        newSourceUrls: ["teamhub://rooms/new/messages/message_1"],
      });
      expect(inspection.issues).toContainEqual(
        expect.objectContaining({
          code: "no_content_changes",
          page: "topics/a.md",
        }),
      );
      expect(inspection.issues).toContainEqual(
        expect.objectContaining({
          code: "missing_new_source",
          page: "topics/a.md",
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
