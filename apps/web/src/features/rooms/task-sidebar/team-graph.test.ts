import { describe, expect, it } from "vitest";
import type {
  TeamHubTeamMdDocument,
  TeamHubTeamMdParticipant,
} from "@/features/teamhub/teamhub-types";
import { layoutTeamGraph, teamEdges } from "./team-graph";

function teamDocument(
  count = 6,
  pattern: TeamHubTeamMdDocument["collaborate_pattern"] = "classify-and-act",
): TeamHubTeamMdDocument {
  const person = (index: number): TeamHubTeamMdParticipant => ({
    actor_id: `agent-${index}`,
    name: `Agent ${index}`,
    role: `Verify source ${index} and report the evidence.`,
    receive_from: index ? ["Agent 0"] : [],
    report_to: index ? ["Agent 0"] : [],
  });
  return {
    collaborate_pattern: pattern,
    task_goal: "Verify the product design.",
    orchestrator: person(0),
    members: Array.from({ length: count - 1 }, (_, i) => person(i + 1)),
    revision: 1,
    updated_at: "2026-10-15T08:00:00Z",
    raw_markdown: "# Original team.md",
  };
}

/** Coordinates of the last point of a path made of M/H/V/L/Q commands. */
function endOf(d: string) {
  let x = 0,
    y = 0,
    prev = { x: 0, y: 0 };
  for (const [, cmd, args] of d.matchAll(/([MHVLQ])([^MHVLQ]*)/g)) {
    const n = args!.trim().split(/\s+/).map(Number);
    prev = { x, y };
    if (cmd === "H") x = n[0]!;
    else if (cmd === "V") y = n[0]!;
    else [x, y] = n.slice(-2) as [number, number];
  }
  return { x, y, prev };
}

function expectArrowsOnLines(graph: ReturnType<typeof layoutTeamGraph>) {
  for (const path of graph.paths) {
    const end = endOf(path.d);
    const tip = path.arrow
      .match(/L ([\d.-]+) ([\d.-]+)/)!
      .slice(1)
      .map(Number);
    expect(tip).toEqual([end.x, end.y]);
    // The final run is straight, so the arrow points along the line.
    expect(end.prev.x === end.x || end.prev.y === end.y).toBe(true);
  }
}

describe("collaboration graph", () => {
  it("resolves document-local names, keeps direction and merges only identical directed relations", () => {
    const doc = teamDocument(3);
    doc.members[0]!.report_to = ["Agent 2"];
    doc.members[1]!.receive_from = ["Agent 1", "Agent 1"];
    const edges = teamEdges(doc);
    expect(edges).toHaveLength(3);
    expect(
      edges.find((e) => e.from === "agent-1" && e.to === "agent-2")?.kinds,
    ).toEqual(["report", "handoff"]);
    expect(edges.some((e) => e.from === "agent-0" && e.to === "agent-2")).toBe(
      false,
    );
  });

  for (const pattern of [
    "classify-and-act",
    "adversarial-verification",
  ] as const) {
    for (const count of [4, 6, 10, 51]) {
      it(`${pattern} dispatches from the coordinator and returns to its endpoint for ${count} agents`, () => {
        const graph = layoutTeamGraph(teamDocument(count, pattern), 404);
        expect(graph.nodes).toHaveLength(count);
        expect(graph.returned).not.toBeNull();
        const [lead, ...workers] = graph.nodes;
        expect(graph.returned!.x).toBeGreaterThan(workers[0]!.x);
        const handoffs = graph.paths.filter((p) => p.kind === "handoff");
        const reports = graph.paths.filter((p) => p.kind === "report");
        expect(handoffs).toHaveLength(count - 1);
        expect(reports).toHaveLength(count - 1);
        for (const p of handoffs)
          expect(p.d).toMatch(
            new RegExp(`^M ${lead!.x + graph.avatar / 2 + 6} `),
          );
        for (const p of reports)
          expect(endOf(p.d).x).toBeLessThan(graph.returned!.x);
        // Every dispatch line shares one vertical trunk.
        const trunks = new Set(
          handoffs.map((p) => p.d.match(/Q ([\d.]+)/)?.[1]).filter(Boolean),
        );
        expect(trunks.size).toBeLessThanOrEqual(1);
        for (const p of graph.paths) expect(p.d).not.toMatch(/NaN|Infinity/);
        for (let i = 1; i < workers.length; i++)
          expect(workers[i]!.y - workers[i - 1]!.y).toBeGreaterThanOrEqual(72);
        expectArrowsOnLines(graph);
      });
    }
  }

  it("lays out the synthesizer from incoming relationships, regardless of declaration order", () => {
    const doc = teamDocument(6, "fan-out-and-synthesize");
    doc.members[0]!.receive_from = doc.members.slice(1).map((p) => p.name);
    for (const p of doc.members.slice(1)) p.report_to = [doc.members[0]!.name];
    const graph = layoutTeamGraph(doc, 410);
    const sink = graph.nodes.find((p) => p.actor_id === "agent-1")!;
    expect(sink.center).toBe(true);
    expect(sink.identity).toBe("Synthesizer");
    expect(graph.nodes.slice(2).every((p) => p.x < sink.x)).toBe(true);
    expect(graph.nodes.slice(2).every((p) => p.identity === "Researcher")).toBe(
      true,
    );
    expectArrowsOnLines(graph);
  });

  it("chains loop members by handoff and closes the loop back to the coordinator", () => {
    const doc = teamDocument(4, "loop-until-done");
    doc.members[0]!.receive_from = ["Agent 3"];
    doc.members[2]!.receive_from = ["Agent 2"];
    doc.orchestrator.receive_from = ["Agent 1"];
    const graph = layoutTeamGraph(doc, 410, { handoff: true, report: false });
    const ids = graph.nodes
      .slice(1)
      .sort((a, b) => a.x - b.x)
      .map((p) => p.actor_id);
    expect(ids).toEqual(["agent-2", "agent-3", "agent-1"]);
    expect(
      graph.edges.some((e) => e.from === "agent-1" && e.to === "agent-0"),
    ).toBe(true);
    expect(graph.edges.every((e) => e.kinds.includes("handoff"))).toBe(true);
    expect(graph.loop).not.toBeNull();
    expect(graph.loop!.d).not.toMatch(/NaN/);
    expectArrowsOnLines(graph);
  });

  it("shows a coordinator that only collects reports once, at the end", () => {
    const doc = teamDocument(2, "adversarial-verification");
    doc.members[0]!.receive_from = [];
    const graph = layoutTeamGraph(doc, 404);
    const [lead, member] = graph.nodes;
    expect(graph.returned).toBeNull();
    expect(lead!.x).toBeGreaterThan(member!.x);
    expect(graph.paths).toHaveLength(1);
    expect(endOf(graph.paths[0]!.d).x).toBeLessThan(lead!.x);
    expectArrowsOnLines(graph);
  });

  it("hides each relationship kind independently", () => {
    const doc = teamDocument(4);
    expect(
      layoutTeamGraph(doc, 404, { handoff: false, report: true }).paths.every(
        (p) => p.kind === "report",
      ),
    ).toBe(true);
    expect(
      layoutTeamGraph(doc, 404, { handoff: false, report: false }).paths,
    ).toHaveLength(0);
  });

  it("keeps disconnected members and terminates on mutual dependencies", () => {
    const doc = teamDocument(4, "tournament");
    doc.members[0]!.receive_from = ["Agent 2"];
    doc.members[1]!.receive_from = ["Agent 1"];
    doc.members[2]!.receive_from = [];
    doc.members[2]!.report_to = [];
    const graph = layoutTeamGraph(doc, 410);
    expect(new Set(graph.nodes.map((p) => p.actor_id)).size).toBe(4);
    expect(
      graph.nodes.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
    ).toBe(true);
    expect(graph.paths.map((p) => p.id).sort()).toEqual(
      graph.edges.map((e) => e.id).sort(),
    );
    expectArrowsOnLines(graph);
  });

  it("keeps an uneven three-round tournament readable in a narrow panel", () => {
    const doc = teamDocument(10, "tournament");
    const [a, b, c, d, e, first, second, third, final] = doc.members;
    first!.receive_from = [a!.name, b!.name];
    second!.receive_from = [c!.name, d!.name];
    third!.receive_from = [first!.name, second!.name];
    final!.receive_from = [third!.name, e!.name];
    const graph = layoutTeamGraph(doc, 248);
    expect(graph.width).toBeGreaterThan(248);
    for (const node of graph.nodes) {
      expect(node.x - 40).toBeGreaterThanOrEqual(0);
      expect(node.x + 40).toBeLessThanOrEqual(graph.width);
      expect(node.y + 60).toBeLessThan(graph.height);
      for (const other of graph.nodes) {
        if (node === other) continue;
        expect(
          Math.abs(node.x - other.x) >= 64 || Math.abs(node.y - other.y) >= 72,
        ).toBe(true);
      }
    }
    const firstJudge = graph.nodes.find(
      (node) => node.actor_id === first!.actor_id,
    )!;
    expect(firstJudge.identity).toBe("Judge");
    const firstPair = graph.nodes.filter((node) =>
      [a!.actor_id, b!.actor_id].includes(node.actor_id),
    );
    expect(firstJudge.y).toBeGreaterThan(
      Math.min(...firstPair.map((node) => node.y)),
    );
    expect(firstJudge.y).toBeLessThan(
      Math.max(...firstPair.map((node) => node.y)),
    );
    expectArrowsOnLines(graph);
  });
});
