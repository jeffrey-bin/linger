import { describe, expect, it } from "vitest";

import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";

import { findDocumentCandidates } from "./message-composer-references";
import {
  activeMessageMentions,
  findMessageMentionQuery,
} from "./message-mentions";

const codex: TeamHubActorRef = {
  display_name: "Codex",
  id: "actor-codex",
  kind: "agent",
  tenant_id: "tenant-1",
};
const claude: TeamHubActorRef = {
  display_name: "Claude Code",
  id: "actor-claude",
  kind: "agent",
  tenant_id: "tenant-1",
};

describe("activeMessageMentions", () => {
  it("matches exact structured tokens while preserving trailing punctuation", () => {
    expect(
      activeMessageMentions("Ask @Codex, then confirm with @Claude Code.", [
        codex,
        claude,
      ]),
    ).toEqual([codex, claude]);
  });

  it("does not infer one Actor from a longer plain-text token", () => {
    expect(activeMessageMentions("Ask @CodexExtra", [codex])).toEqual([]);
    expect(activeMessageMentions("Ask @Claude Codebase", [claude])).toEqual([]);
  });

  it("orders active Actors by their first occurrence in the final body", () => {
    expect(
      activeMessageMentions("Ask @Claude Code before @Codex", [codex, claude]),
    ).toEqual([claude, codex]);
  });
});

describe("findMessageMentionQuery", () => {
  it("reads a CJK query after @ so unspaced Document titles are searchable", () => {
    const body = "みて @あい";
    const query = findMessageMentionQuery(body, body.length);
    expect(query).toEqual({ end: body.length, query: "あい", start: 3 });
    const candidates = findDocumentCandidates(query, [
      { documentId: "doc-cn", name: "あいうえお.md", updatedAt: "" },
      { documentId: "doc-en", name: "project-brief.md", updatedAt: "" },
    ]);
    expect(candidates.map((document) => document.documentId)).toEqual([
      "doc-cn",
    ]);
  });
});
