import type { ChunkSearchProvider } from "../../src/memory/chunk-index.js";
import type {
  RawSource,
  SourceIdentity,
} from "../../src/memory/search/source-store.js";
import { contentHash } from "../../src/memory/search/source-store.js";

/** A test double at the PostgreSQL Raw boundary, never a filesystem read fallback. */
export class RawDatabaseFixture implements ChunkSearchProvider {
  readonly versions = new Map<string, { source: RawSource; content: string }>();
  put(source: RawSource, content: string) {
    this.versions.set(source.id, { source: structuredClone(source), content });
  }
  async search() {
    return [];
  }
  async resolveRawSources(
    identity: SourceIdentity,
    references: readonly { sourceId: string }[],
  ) {
    const ids = new Set(references.map((reference) => reference.sourceId));
    return [...this.versions.values()]
      .map(({ source }) => source)
      .filter(
        (source) =>
          sameIdentity(source.identity, identity) &&
          (!ids.size || ids.has(source.id) || ids.has(source.id.slice(0, 16))),
      );
  }
  async readRawSource(identity: SourceIdentity, source: RawSource) {
    const stored = this.versions.get(source.id);
    return stored &&
      sameIdentity(stored.source.identity, identity) &&
      stored.source.contentHash === source.contentHash &&
      contentHash(stored.content) === source.contentHash
      ? stored.content
      : undefined;
  }
}
function sameIdentity(left: SourceIdentity, right: SourceIdentity) {
  return (
    left.agent_id === right.agent_id &&
    left.tenant_id === right.tenant_id &&
    left.user_artifact_owner_actor_id === right.user_artifact_owner_actor_id
  );
}
