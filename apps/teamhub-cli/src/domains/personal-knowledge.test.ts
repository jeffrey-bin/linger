import { describe, expect, it } from "vitest";
import { queryPersonalKnowledgeSchema } from "./knowledge/tools/query.js";
import { readPersonalKnowledgeEvidenceSchema } from "./knowledge/tools/read-evidence.js";

describe("Personal Knowledge MCP", () => {
  it.each([
    "agentId",
    "agent_id",
    "personalKnowledgeAgentId",
    "personal_knowledge_agent_id",
    "userArtifactOwnerActorId",
    "user_artifact_owner_actor_id",
    "tenantId",
    "tenant_id",
  ])("does not let a model select its knowledge scope through %s", (key) => {
    expect(
      queryPersonalKnowledgeSchema.input.safeParse({
        query: "question",
        [key]: "someone_else",
      }).success,
    ).toBe(false);
    expect(
      readPersonalKnowledgeEvidenceSchema.input.safeParse({
        evidenceId: `raw_${"a".repeat(16)}_${"b".repeat(16)}`,
        sectionRequests: [{ sectionId: "summary" }],
        [key]: "someone_else",
      }).success,
    ).toBe(false);
  });

  it.each([
    "ev_0123456789abcdef01234567",
    "raw_1_2",
    `raw_${"a".repeat(64)}`,
    `raw_${"g".repeat(16)}_${"b".repeat(16)}`,
    "../../memory/secret.md",
  ])("rejects malformed evidence ID %s", (evidenceId) => {
    expect(
      readPersonalKnowledgeEvidenceSchema.input.safeParse({
        evidenceId,
        sectionRequests: [{ sectionId: "summary" }],
      }).success,
    ).toBe(false);
  });
});
