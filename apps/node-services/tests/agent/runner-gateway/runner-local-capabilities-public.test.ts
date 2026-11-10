import { describe, expect, it } from "vitest";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";
import { CURRENT_RUNNER_CAPABILITIES } from "../test-support/runner-capabilities.js";

import {
  hello,
  authenticatedPrincipal,
  RecordingPeer,
} from "./runner-gateway-fixtures.js";

describe("RunnerGateway", () => {
  it("scans owner-scoped local Skills through the negotiated capability", async () => {
    const gateway = createTestRunnerGateway({ heartbeatIntervalMs: 1_000 });
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...hello(),
        capabilities: [...CURRENT_RUNNER_CAPABILITIES],
      },
      peer,
    );
    const expiresAt = "2099-08-17T09:10:00.000Z";
    const scanning = gateway.scanLocalSkills({
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
      computerId: "runner-local",
      commandId: "skill-scan-command",
      scanId: "skill-scan-a",
      runtimeType: "codex",
      expiresAt,
    });
    const scan = peer.sent.at(-1);
    if (scan?.type !== "execute" || scan?.kind !== "skills_scan") {
      throw new Error("Expected capability.skills.scan");
    }
    await connection.receive({
      ...scan,
      type: "executed",
      kind: "skills_scan",
      outcome: "succeeded",
      items: [
        {
          candidate_ref: "candidate-a",
          name: "sample-skill",
          description: "Sample local Skill",
          package_sha256: "a".repeat(64),
          file_count: 1,
          size_bytes: 100,
          normalizations: [],
          risk_flags: [],
          importability: "ready",
        },
        {
          candidate_ref: "candidate-unsupported",
          name: "legacy-skill",
          description: "This local Skill cannot be imported safely.",
          package_sha256: "0".repeat(64),
          file_count: 1,
          size_bytes: 1,
          normalizations: [],
          risk_flags: [],
          importability: "unsupported",
          error_code: "LOCAL_SKILL_FRONTMATTER_UNSUPPORTED",
          error_detail: "SKILL.md contains unsupported frontmatter fields",
          manifest_excerpt:
            "---\nname: legacy-skill\ndescription: Legacy\nversion: 1.0.0\n---\n",
        },
      ],
    });
    await expect(scanning).resolves.toMatchObject({
      scanId: "skill-scan-a",
      computerId: "runner-local",
      items: [
        { candidateRef: "candidate-a", name: "sample-skill" },
        {
          candidateRef: "candidate-unsupported",
          errorCode: "LOCAL_SKILL_FRONTMATTER_UNSUPPORTED",
          errorDetail: "SKILL.md contains unsupported frontmatter fields",
          manifestExcerpt: expect.stringContaining("version: 1.0.0"),
        },
      ],
    });

    connection.disconnect();
  });
});
