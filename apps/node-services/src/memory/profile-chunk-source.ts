import { localTimeZone } from "./date.js";
import type postgres from "postgres";

import { profileRawSource, type RawSource } from "./search/source-store.js";

interface ProfileRow {
  created_date: string;
  markdown: string;
  revision_id: string;
  tenant_id: string;
  user_artifact_owner_actor_id: string;
}

/**
 * Index the represented Human's current Profile Revision as Raw for an
 * AnotherMe Agent. A newer Revision replaces the indexed one; an unchanged
 * Revision is skipped by the index itself.
 */
export async function syncProfileChunkSource(options: {
  agentId: string;
  ingest: (source: RawSource, content: string) => Promise<boolean>;
  sql: postgres.Sql;
}): Promise<{ indexed: boolean }> {
  const [profile] = await options.sql<ProfileRow[]>`
    SELECT subject.tenant_id,
      subject.represented_human_actor_id AS user_artifact_owner_actor_id,
      subject.user_profile_revision_id AS revision_id,
      subject.user_profile_markdown AS markdown,
      to_char(revision.created_at AT TIME ZONE ${localTimeZone()}, 'YYYY-MM-DD') AS created_date
    FROM memory_source.another_me_subjects subject
    JOIN memory_source.profile_revision_dates revision
      ON revision.id = subject.user_profile_revision_id
    WHERE subject.agent_management_id = ${options.agentId}
  `;

  if (!profile?.markdown.trim()) return { indexed: false };
  const source = profileRawSource({
    identity: {
      agent_id: options.agentId,
      tenant_id: profile.tenant_id,
      user_artifact_owner_actor_id: profile.user_artifact_owner_actor_id,
    },
    revisionId: profile.revision_id,
    date: profile.created_date,
    markdown: profile.markdown,
  });
  return { indexed: await options.ingest(source, profile.markdown) };
}
