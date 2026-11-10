import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { syncProfileChunkSource } from "../../src/memory/profile-chunk-source.js";
import {
  contentHash,
  type RawSource,
} from "../../src/memory/search/source-store.js";

const profile = {
  tenant_id: "tenant_1",
  user_artifact_owner_actor_id: "human_1",
  revision_id: "profile_revision_2",
  markdown: "# Profile\n\nWorks on voice products.\n",
  created_date: "2026-10-27",
};

function run(rows: Array<typeof profile>) {
  const sql = vi.fn(async () => rows) as unknown as postgres.Sql;
  const ingest = vi.fn<
    (source: RawSource, content: string) => Promise<boolean>
  >(async () => true);
  return {
    ingest,
    result: syncProfileChunkSource({ agentId: "agent_1", ingest, sql }),
  };
}

describe("Profile Raw source", () => {
  it("indexes the current Profile Revision as one Raw source per Agent", async () => {
    const { ingest, result } = run([profile]);
    expect(await result).toEqual({ indexed: true });
    const [source, content] = ingest.mock.calls[0]!;
    expect(content).toBe(profile.markdown);
    expect(source).toMatchObject({
      identity: {
        agent_id: "agent_1",
        tenant_id: "tenant_1",
        user_artifact_owner_actor_id: "human_1",
      },
      anchorPath: "memory-state/raw/profile/source.json",
      contentHash: contentHash(profile.markdown),
      sourceUri: "teamhub://personal-profile/revisions/profile_revision_2",
      date: "2026-10-27",
      sourceKind: "profile",
      originKind: "profile",
      sourceVersion: "profile_revision_2",
    });
  });

  it("keeps the same source when a newer Revision replaces the old one", async () => {
    const first = run([{ ...profile, revision_id: "profile_revision_1" }]);
    await first.result;
    const second = run([profile]);
    await second.result;
    const [older] = first.ingest.mock.calls[0]!;
    const newer = second.ingest.mock.calls[0]![0];
    expect(newer.id).toBe(older.id);
    expect(newer.sourceVersion).not.toBe(older.sourceVersion);
  });

  it("indexes nothing without a Profile", async () => {
    const { ingest, result } = run([]);
    expect(await result).toEqual({ indexed: false });
    expect(ingest).not.toHaveBeenCalled();
  });
});
