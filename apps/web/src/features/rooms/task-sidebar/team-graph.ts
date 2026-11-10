import type {
  TeamHubTeamMdDocument,
  TeamHubTeamMdParticipant,
} from "@/features/teamhub/teamhub-types";

export type Relationship = "handoff" | "report";
export type RelationshipVisibility = Record<Relationship, boolean>;
interface TeamEdge {
  id: string;
  from: string;
  to: string;
  kinds: Relationship[];
}
type TeamNode = TeamHubTeamMdParticipant & {
  x: number;
  y: number;
  center: boolean;
  identity: string;
};
interface TeamPath {
  id: string;
  d: string;
  /** Drawn on its own so a dashed line never leaves its arrow floating. */
  arrow: string;
  kind: Relationship;
  from: string;
  to: string;
}

export const patternTitles: Record<
  TeamHubTeamMdDocument["collaborate_pattern"],
  string
> = {
  "classify-and-act": "Classify and act",
  "fan-out-and-synthesize": "Fan out and synthesize",
  "adversarial-verification": "Cross verification",
  tournament: "Tournament",
  "loop-until-done": "Iterate until done",
};

/** Relationship names are local to team.md; Actor IDs are the graph identity. */
export function teamEdges(document: TeamHubTeamMdDocument): TeamEdge[] {
  const people = [document.orchestrator, ...document.members];
  const byName = new Map(
    people.map((person) => [person.name, person.actor_id]),
  );
  const edges = new Map<string, TeamEdge>();
  function add(
    from: string | undefined,
    to: string | undefined,
    kind: Relationship,
  ) {
    if (!from || !to) return;
    const id = JSON.stringify([from, to]);
    const edge = edges.get(id) ?? { id, from, to, kinds: [] };
    if (!edge.kinds.includes(kind)) edge.kinds.push(kind);
    edges.set(id, edge);
  }
  for (const person of people) {
    for (const name of person.receive_from)
      add(byName.get(name), person.actor_id, "handoff");
    for (const name of person.report_to)
      add(person.actor_id, byName.get(name), "report");
  }
  return [...edges.values()];
}

const INSET = 40;
const COLUMN_MIN = 78;
const TOP = 22;
const LABEL = 40;

/**
 * Columns run left to right: the coordinator, one column per handoff depth,
 * then the coordinator again as the endpoint that receives results. Lines
 * between the same two columns share one vertical trunk, and every line ends
 * in a straight horizontal run so its arrow always sits on it.
 */
export function layoutTeamGraph(
  document: TeamHubTeamMdDocument,
  width: number,
  visible: RelationshipVisibility = { handoff: true, report: true },
) {
  const edges = teamEdges(document);
  const coordinator = document.orchestrator.actor_id;
  const pattern = document.collaborate_pattern;
  const members = document.members;
  const memberLinks = edges.filter(
    (edge) =>
      edge.kinds.includes("handoff") &&
      edge.from !== coordinator &&
      edge.to !== coordinator &&
      edge.from !== edge.to,
  );
  const levels = memberLevels(members, memberLinks);
  const stages = Array.from(
    { length: Math.max(0, ...levels.values()) + 1 },
    () => [] as TeamHubTeamMdParticipant[],
  );
  for (const person of members)
    stages[levels.get(person.actor_id)!]!.push(person);
  const dispatched = edges
    .filter((edge) => edge.from === coordinator && edge.to !== coordinator)
    .map((edge) => edge.to);
  const collected = edges
    .filter((edge) => edge.to === coordinator && edge.from !== coordinator)
    .map((edge) => edge.from);
  // A coordinator that hands nothing off only collects, so it stands once at
  // the end; it is repeated as the endpoint only when it also dispatches.
  const leadFirst = dispatched.length > 0 || collected.length === 0;
  const hasReturn = leadFirst && collected.length > 0;
  const offset = leadFirst ? 1 : 0;
  const columns =
    offset + stages.length + (leadFirst ? (hasReturn ? 1 : 0) : 1);
  width = Math.max(width, INSET * 2 + (columns - 1) * COLUMN_MIN);
  const columnX = (index: number) =>
    columns === 1
      ? width / 2
      : INSET + (index * (width - INSET * 2)) / (columns - 1);

  const large = Math.max(...stages.map((stage) => stage.length)) > 6;
  const avatar = large ? 28 : 36;
  const radius = avatar / 2;
  const row = large ? 72 : 86;
  const loop = pattern === "loop-until-done" && hasReturn;
  const loopSpace = loop ? 54 : 0;
  const rows = Math.max(1, ...stages.map((stage) => stage.length));
  const height = TOP * 2 + (rows - 1) * row + avatar + LABEL + loopSpace;
  const minY = TOP + radius;
  const maxY = height - loopSpace - TOP - LABEL - radius;
  const middle = (minY + maxY) / 2;

  const inputs = (id: string) =>
    memberLinks.filter((edge) => edge.to === id).length;
  const nodes = new Map<string, TeamNode>();
  for (const [level, stage] of stages.entries()) {
    const parentY = (person: TeamHubTeamMdParticipant) => {
      const ys = memberLinks
        .filter((edge) => edge.to === person.actor_id)
        .map((edge) => nodes.get(edge.from)?.y)
        .filter((y): y is number => y !== undefined);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : middle;
    };
    // Children sit beside their parents, which keeps brackets from crossing.
    const ordered =
      level === 0 ? stage : [...stage].sort((a, b) => parentY(a) - parentY(b));
    let ys =
      level === 0
        ? ordered.map((_, i) => middle + (i - (ordered.length - 1) / 2) * row)
        : ordered.map(parentY);
    const wanted = mean(ys);
    for (let i = 1; i < ys.length; i++)
      ys[i] = Math.max(ys[i]!, ys[i - 1]! + row);
    const shift = wanted - mean(ys);
    ys = ys.map((y) => Math.min(maxY, Math.max(minY, y + shift)));
    for (const [i, person] of ordered.entries()) {
      const center = inputs(person.actor_id) > 1;
      nodes.set(person.actor_id, {
        ...person,
        x: columnX(level + offset),
        y: ys[i]!,
        center,
        identity: memberIdentity(pattern, center),
      });
    }
  }
  const meanY = (ids: string[]) =>
    ids.length ? mean(ids.map((id) => nodes.get(id)?.y ?? middle)) : middle;
  const lead: TeamNode = {
    ...document.orchestrator,
    x: columnX(leadFirst ? 0 : columns - 1),
    y: meanY(leadFirst ? dispatched : collected),
    center: true,
    identity: "Coordinator",
  };
  const ordered = [lead, ...members.map((p) => nodes.get(p.actor_id)!)];
  const returned = hasReturn
    ? {
        x: columnX(columns - 1),
        y: meanY(collected),
      }
    : null;

  const position = (id: string, asTarget: boolean) =>
    id === coordinator
      ? asTarget && returned
        ? returned
        : lead
      : nodes.get(id)!;
  const port = radius + 6;
  const columnOf = (x: number) =>
    Math.round(((x - INSET) / Math.max(1, width - INSET * 2)) * (columns - 1));
  const paths: TeamPath[] = [];
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const kind: Relationship | null =
      edge.kinds.includes("handoff") && visible.handoff
        ? "handoff"
        : edge.kinds.includes("report") && visible.report
          ? "report"
          : null;
    if (!kind) continue;
    const a = position(edge.from, false);
    const b = position(edge.to, true);
    const sx = a.x + port;
    const ex = b.x - port;
    let d: string;
    let arrow: string;
    if (ex <= sx) {
      // Backward links arc over the columns and drop onto the target.
      const top = Math.min(a.y, b.y) - radius - 14;
      const turn = b.x > a.x ? 8 : -8;
      d = `M ${a.x} ${a.y - port} V ${top + 8} Q ${a.x} ${top} ${a.x + turn} ${top} H ${b.x - turn} Q ${b.x} ${top} ${b.x} ${top + 8} V ${b.y - port}`;
      arrow = arrowHead(b.x, b.y - port, "down");
    } else {
      const bus = (columnX(columnOf(a.x)) + columnX(columnOf(a.x) + 1)) / 2;
      const dir = b.y > a.y ? 1 : -1;
      const k = Math.min(8, Math.abs(b.y - a.y) / 2, bus - sx, ex - bus);
      d =
        Math.abs(a.y - b.y) < 0.5
          ? `M ${sx} ${a.y} H ${ex}`
          : `M ${sx} ${a.y} H ${bus - k} Q ${bus} ${a.y} ${bus} ${a.y + dir * k} V ${b.y - dir * k} Q ${bus} ${b.y} ${bus + k} ${b.y} H ${ex}`;
      arrow = arrowHead(ex, b.y, "right");
    }
    paths.push({ id: edge.id, d, arrow, kind, from: edge.from, to: edge.to });
  }
  let loopPath: {
    d: string;
    arrow: string;
    labelX: number;
    labelY: number;
  } | null = null;
  if (loop && returned && visible.handoff) {
    const bottom = height - 20;
    const end = lead.y + radius + 44;
    loopPath = {
      d: `M ${returned.x} ${returned.y + radius + 40} V ${bottom - 10} Q ${returned.x} ${bottom} ${returned.x - 10} ${bottom} H ${lead.x + 10} Q ${lead.x} ${bottom} ${lead.x} ${bottom - 10} V ${end}`,
      arrow: arrowHead(lead.x, end, "up"),
      labelX: (lead.x + returned.x) / 2,
      labelY: bottom,
    };
  }
  return {
    nodes: ordered,
    returned,
    loop: loopPath,
    edges: edges.filter((edge) => paths.some((path) => path.id === edge.id)),
    paths,
    avatar,
    width,
    height,
  };
}

function memberIdentity(
  pattern: TeamHubTeamMdDocument["collaborate_pattern"],
  center: boolean,
) {
  switch (pattern) {
    case "classify-and-act":
      return "Specialist";
    case "adversarial-verification":
      return "Verifier";
    case "tournament":
      return center ? "Judge" : "Contender";
    case "fan-out-and-synthesize":
      return center ? "Synthesizer" : "Researcher";
    default:
      return "Worker";
  }
}

function arrowHead(x: number, y: number, dir: "right" | "up" | "down") {
  if (dir === "right")
    return `M ${x - 4.5} ${y - 4} L ${x} ${y} L ${x - 4.5} ${y + 4}`;
  const s = dir === "up" ? 4.5 : -4.5;
  return `M ${x - 4} ${y + s} L ${x} ${y} L ${x + 4} ${y + s}`;
}

function mean(values: number[]) {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

/** Longest incoming depth for DAGs; cycles remain finite and retain every node. */
function memberLevels(members: TeamHubTeamMdParticipant[], edges: TeamEdge[]) {
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  function level(id: string): number {
    const known = levels.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = edges.filter((edge) => edge.to === id && edge.from !== id);
    const value = parents.length
      ? 1 + Math.max(...parents.map((edge) => level(edge.from)))
      : 0;
    visiting.delete(id);
    levels.set(id, value);
    return value;
  }
  for (const person of members) level(person.actor_id);
  return levels;
}
