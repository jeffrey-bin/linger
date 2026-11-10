import { buildWikiGraph } from "./graph/build.js";
import { renderGraphVisualization } from "./graph/visualize.js";
import { loadWikiGraphSubjectsForActor } from "./collector.js";
import { readIndexedWiki } from "./wiki-index.js";
import { memoryDatabase } from "./database.js";
import type postgres from "postgres";

export interface TimelineEvent {
  id: string;
  day: string;
  title: string;
}

export async function readTimelineEvents(
  tenantId: string,
  ownerId: string,
  agentId: string,
  sql: postgres.Sql = memoryDatabase(),
): Promise<TimelineEvent[]> {
  return sql<TimelineEvent[]>`
    SELECT fact.id, fact.occurred_start::text AS day, fact.text AS title
    FROM memory_index.session_facts fact
    JOIN memory_index.sources source
      ON source.id = fact.source_id AND source.active_sha256 = fact.source_sha256
    WHERE fact.tenant_id = ${tenantId} AND fact.owner_id = ${ownerId}
      AND fact.agent_id = ${agentId} AND fact.fact_type = 'world'
      AND source.state = 'active'
      AND fact.occurred_start IS NOT NULL AND fact.occurred_start <= CURRENT_DATE
      AND fact.occurred_end = fact.occurred_start
      AND fact.mentioned_at::date >= fact.occurred_end
    ORDER BY fact.occurred_start, fact.id
  `;
}

export class PersonalKnowledgeGraphNotFoundError extends Error {
  constructor() {
    super("Personal knowledge graph was not found");
    this.name = "PersonalKnowledgeGraphNotFoundError";
  }
}

export interface PersonalKnowledgeGraphVisualizationDependencies {
  loadSubjects: typeof loadWikiGraphSubjectsForActor;
  readWiki: typeof readIndexedWiki;
  renderGraph: typeof renderGraphVisualization;
  readEvents: typeof readTimelineEvents;
}

const defaultDependencies: PersonalKnowledgeGraphVisualizationDependencies = {
  loadSubjects: loadWikiGraphSubjectsForActor,
  readWiki: readIndexedWiki,
  renderGraph: renderGraphVisualization,
  readEvents: readTimelineEvents,
};

/**
 * Renders the Human's knowledge graph from the indexed published Wiki. A
 * Human whose Another Me is inactive, or whose Wiki was never indexed, has
 * no graph.
 */
export async function getPersonalKnowledgeGraphVisualization(
  input: { owner_actor_id: string; tenant_id: string },
  dependencies: PersonalKnowledgeGraphVisualizationDependencies = defaultDependencies,
): Promise<string> {
  const subjects = await dependencies.loadSubjects(input.owner_actor_id);
  const subject = subjects.find(
    (candidate) => candidate.tenantId === input.tenant_id,
  );
  if (!subject) throw new PersonalKnowledgeGraphNotFoundError();
  const wiki = await dependencies.readWiki(
    input.tenant_id,
    input.owner_actor_id,
  );
  if (!wiki.revision || !wiki.pages.length)
    throw new PersonalKnowledgeGraphNotFoundError();
  const events = await dependencies.readEvents(
    input.tenant_id,
    input.owner_actor_id,
    subject.agentManagementId,
  );
  return dependencies.renderGraph(
    buildWikiGraph(wiki.pages, wiki.revision).graph,
    { embedded: true, events },
  );
}
