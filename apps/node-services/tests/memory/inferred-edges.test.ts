import type { WikiNode } from "openwiki/dist/visualize/graph.js";
import { describe, expect, it } from "vitest";

import { buildWikiGraph } from "../../src/memory/graph/build.js";
import { mentionEdges } from "../../src/memory/graph/inferred-edges.js";

const node = (id: string, title: string, body = ""): WikiNode => ({
  id,
  title,
  type: "Section",
  description: "",
  tags: [],
  body,
  size: body.length,
  links: [],
  backlinks: [],
});

describe("mention edges", () => {
  it("links a page to the entities it names, weighting key sections and dates", () => {
    const edges = mentionEdges(
      [
        node("projects/lev8-voice", "Example Product Voice Agent"),
        node("contacts/lisa", "Lisa Chen"),
        node("clients/example-client", "Example Client"),
        node(
          "sessions/2026-10-01/standup",
          "Standup",
          "# Standup\n\n## Decisions And Outcomes\n\n- Decision: Lisa Chen owns the pilot.\n\n## Notes\n\nWe reviewed Example Product Voice Agent and the voice agent pilot.\nLisa Chen will follow up.",
        ),
      ],
      new Map([["projects/lev8-voice", ["voice agent pilot"]]]),
    );
    const byTarget = new Map(edges.map((edge) => [edge.target, edge]));
    expect(byTarget.get("contacts/lisa")).toMatchObject({
      source: "sessions/2026-10-01/standup",
      kind: "mention",
      count: 2,
      lastSeen: "2026-10-01",
    });
    // The title and an alias of the same project add up on one edge.
    expect(byTarget.get("projects/lev8-voice")).toMatchObject({ count: 2 });
    // A name in a key section weighs more than a passing remark.
    expect(byTarget.get("contacts/lisa")!.weight).toBeGreaterThan(
      byTarget.get("projects/lev8-voice")!.weight,
    );
    for (const edge of edges) {
      expect(edge.weight).toBeGreaterThan(0);
      expect(edge.weight).toBeLessThan(1);
    }
    expect(byTarget.has("clients/example-client")).toBe(false);
  });

  it("skips short, partial-word, and shared names but matches Han names", () => {
    const edges = mentionEdges([
      node("contacts/al", "Al"),
      node("projects/ai", "AI"),
      node("projects/sample", "Sample"),
      node("contacts/lisa-a", "Lisa"),
      node("contacts/lisa-b", "Lisa"),
      node("contacts/zhang", "\u9648\u5c0f\u660e"),
      node(
        "sessions/2026-10-02/x",
        "X",
        "Al and AI met Lisa about SampleProduct. \u9648\u5c0f\u660e joined.",
      ),
    ]);
    expect(edges.map((edge) => edge.target)).toEqual(["contacts/zhang"]);
  });

  it("weighs only exactly rendered key sections double", () => {
    const body = (heading: string) =>
      `## ${heading}\n\nOrion Labs shipped.\n\n## Notes\n\nNothing else.`;
    const edges = mentionEdges([
      node("clients/orion", "Orion Labs"),
      node("sessions/2026-10-01/a", "A", body("Decisions And Outcomes")),
      node("sessions/2026-10-02/b", "B", body("Project notes")),
      node("sessions/2026-10-03/c", "C", body("Notes")),
    ]);
    const weight = (source: string) =>
      edges.find((edge) => edge.source === source)!.weight;
    expect(weight("sessions/2026-10-01/a")).toBeGreaterThan(
      weight("sessions/2026-10-02/b"),
    );
    expect(weight("sessions/2026-10-02/b")).toBe(
      weight("sessions/2026-10-03/c"),
    );
  });

  it("ignores directory pages, plain-word aliases, and lowercase common words", () => {
    const edges = mentionEdges(
      [
        node("contacts/index", "Contacts"),
        node("clients/epic", "Epic"),
        node("projects/outreach", "Multi-channel Outreach"),
        node("projects/index", "Projects", "- Epic launch plan"),
        node(
          "sessions/2026-10-03/y",
          "Y",
          "## Contacts\n\nAn epic week. **Action Sequence:** reviewed contacts.\n\nEpic signed.",
        ),
      ],
      new Map([["projects/outreach", ["Sequence"]]]),
    );
    expect(edges).toEqual([
      expect.objectContaining({
        source: "sessions/2026-10-03/y",
        target: "clients/epic",
        count: 1,
      }),
    ]);
  });

  it("weighs an entity named on almost every page less than a specific one", () => {
    const pages = Array.from({ length: 6 }, (_, index) =>
      node(
        `sessions/2026-10-0${index + 1}/s`,
        `S${index}`,
        index === 0 ? "Acme Corp and Orion Labs" : "Acme Corp again",
      ),
    );
    const edges = mentionEdges([
      node("clients/acme", "Acme Corp"),
      node("clients/orion", "Orion Labs"),
      ...pages,
    ]);
    const first = edges.filter(
      (edge) => edge.source === "sessions/2026-10-01/s",
    );
    const weight = (target: string) =>
      first.find((edge) => edge.target === target)!.weight;
    expect(weight("clients/orion")).toBeGreaterThan(weight("clients/acme"));
  });
});

describe("graph build with inferred edges", () => {
  it("adds mention edges beside the native graph at read time", () => {
    const { graph } = buildWikiGraph(
      [
        {
          key: "projects/voice.md",
          content:
            '---\n{"title": "Voice Agent", "type": "Project", "aliases": ["voice pilot"]}\n---\n# Voice Agent',
        },
        {
          key: "sessions/2026-10-01/a.md",
          content:
            "---\ntitle: Kickoff\ntype: Session\n---\n# Kickoff\n\nPlanned the voice pilot.",
        },
        {
          key: "sessions/2026-10-02/b.md",
          content:
            "---\ntitle: Review\ntype: Session\n---\n# Review\n\n[Kickoff](../2026-10-01/a.md)",
        },
      ],
      "wiki-r1",
    );
    // OpenWiki's own edges stay exactly as parsed.
    expect(graph.edges).toEqual([
      { source: "sessions/2026-10-02/b", target: "sessions/2026-10-01/a" },
    ]);
    expect(
      graph.inferredEdges?.map((edge) => [edge.kind, edge.source, edge.target]),
    ).toEqual([["mention", "sessions/2026-10-01/a", "projects/voice"]]);
    expect(graph.wikiRevision).toBe("wiki-r1");
  });
});
