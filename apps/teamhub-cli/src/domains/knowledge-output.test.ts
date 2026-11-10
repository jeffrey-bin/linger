import { describe, expect, it } from "vitest";
import { formatKnowledgeCliOutput } from "./knowledge/format-output.js";
async function query(input: Record<string, unknown>, response: unknown) {
  return formatKnowledgeCliOutput("search", input, response);
}
async function readEvidence(input: Record<string, unknown>, response: unknown) {
  return formatKnowledgeCliOutput("read", input, response);
}
describe("Knowledge output parsing", () => {
  it("keeps the source kind each candidate names", async () => {
    const returned = response("wiki", "raw_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbb");
    returned.items[0] = {
      ...returned.items[0]!,
      directory: [{ id: "chunk-1", level: 2, title: "Page" }],
    } as never;

    const result = (await query({ query: "question" }, returned)) as {
      items: { source: { kind: string } }[];
    };
    expect(result.items[0]!.source.kind).toBe("wiki");
  });
  const sessionFact = {
    text: "User cleaned white Adidas sneakers in April 2026 | When: April 2026 | Involving: user",
    factType: "world" as const,
    entities: ["user", "white Adidas"],
    occurredStart: "2026-04-01",
    occurredEnd: "2026-04-30",
    mentionedAt: "2026-05-24T01:00:00.000Z",
    evidenceId: "raw_1111111111111111_bbbbbbbbbbbbbbbb",
    sectionId: "chunk-1",
  };
  const raw = (index: number, extra: Record<string, unknown>) => ({
    ...item(
      `raw_${String(index).repeat(16)}_bbbbbbbbbbbbbbbb`,
      `S${index}`,
      "raw",
      `raw_${String(index).repeat(16)}_bbbbbbbbbbbbbbbb`,
    ),
    directory: [{ id: `chunk-${index}`, level: 2, title: "Chat" }],
    ...extra,
  });
  const grounded = (items: unknown[]) => ({
    gaps: [],
    indexedAt: "2026-09-01T12:00:00Z",
    items,
    schemaVersion: 1 as const,
    status: "grounded" as const,
  });

  it("drops an invalid fact instead of failing the Raw search", async () => {
    const items = [
      raw(1, { content: "I cleaned my white Adidas last month." }),
    ];
    const result = await query(
      { query: "shoes" },
      {
        ...grounded(items),
        facts: [{ ...sessionFact, entities: ["x".repeat(97)] }, sessionFact],
      },
    );
    expect(result.items).toHaveLength(1);
    expect(
      (result.facts as { text: string }[]).map(({ text }) => text),
    ).toEqual([sessionFact.text]);
  });

  it("rejects undeclared fields in an evidence response", async () => {
    const returned = {
      ...evidenceResponse(),
      privatePath: "/private/source.md",
    };

    await expect(
      readEvidence(
        {
          evidenceId: evidenceResponse().evidenceId,
          sectionRequests: [{ sectionId: "work_ownership" }],
        },
        returned,
      ),
    ).rejects.toMatchObject({
      code: "personal_knowledge_unavailable",
      retryable: true,
    });
  });
  it("rejects non-contiguous citation labels", async () => {
    const returned = {
      ...response("raw", "raw_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbb"),
      items: [
        item(
          "raw_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbb",
          "S2",
          "raw",
          "raw_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbb",
        ),
      ],
    };

    await expect(query({ query: "question" }, returned)).rejects.toMatchObject({
      code: "personal_knowledge_unavailable",
      retryable: true,
    });
  });
  it("accepts an empty result instead of turning missing knowledge into an error", async () => {
    const emptyResponse = {
      gaps: [{ code: "no_relevant_evidence" }],
      indexedAt: null,
      items: [],
      schemaVersion: 1 as const,
      status: "empty" as const,
    };
    const returned = emptyResponse;

    await expect(query({ query: "question" }, returned)).resolves.toMatchObject(
      { status: "empty", items: [] },
    );
  });
});
function response(kind: string, sourceRef: string) {
  return {
    gaps: [],
    indexedAt: "2026-09-01T12:00:00Z",
    items: [item(sourceRef, "S1", kind, sourceRef)],
    schemaVersion: 1 as const,
    status: "grounded" as const,
  };
}

function item(id: string, citeAs: string, kind: string, ref: string) {
  return {
    citeAs,
    excerpt: "Grounded evidence",
    id,
    representation: "source_excerpt" as const,
    source: { kind, ref },
    title: "Profile",
  };
}

function evidenceResponse() {
  return {
    complete: false,
    directory: [
      { id: "work_ownership", level: 2, title: "Work ownership" },
      {
        id: "external_dependencies",
        level: 2,
        purpose: "Commitments assigned to other people.",
        title: "External dependencies",
      },
    ],
    evidenceId: "raw_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbb",
    missingSections: ["external_dependencies"],
    schemaVersion: 1 as const,
    sections: [
      {
        content: "- Zhang owns the hardware brief.",
        id: "work_ownership",
        level: 2,
        nextOffset: 32,
        offset: 0,
        title: "Work ownership",
        truncated: true,
      },
    ],
    source: {
      kind: "raw",
      ref: "raw_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbb",
    },
    timeHint: "2026-09-09",
    title: "Hardware partnership meeting",
  };
}
