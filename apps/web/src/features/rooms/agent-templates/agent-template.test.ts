import { describe, expect, it } from "vitest";

import { createTeamHubTestSeed } from "@/test/teamhub-seed";
import type { TeamHubSkillManifest } from "@/features/teamhub/teamhub-types";

import {
  agentTemplateFromAgent,
  templateResourceSummary,
} from "./agent-template";
import {
  resolveAgentTemplateBindings,
  withImportedTemplateSkills,
} from "./resolve-agent-template-bindings";

describe("agentTemplateFromAgent", () => {
  it("captures the portable definition and drops managed defaults", () => {
    const agent = structuredClone(createTeamHubTestSeed().tenantAgents[0]!);
    agent.actor.display_name = "  Code Reviewer 2 ";
    agent.skill_bindings.push({
      is_default: true,
      manifest_version: "1.0.1",
      name: "docx",
      skill_id: "linger_docx",
    });

    expect(
      agentTemplateFromAgent(agent, "orb-teal", ["gmail", "gmail"]),
    ).toEqual({
      avatar_key: "orb-teal",
      connector_bindings: ["gmail"],
      description: agent.description,
      instructions: agent.instructions,
      name: "Code Reviewer 2",
      source_agent_actor_id: agent.actor.id,
      skill_bindings: [
        {
          manifest_version: "1.0.0",
          name: "Review Changes",
          skill_id: "skill-review-changes",
        },
      ],
    });
  });

  it("prefers the stored Agent avatar when the browser has none", () => {
    const agent = structuredClone(createTeamHubTestSeed().tenantAgents[0]!);
    agent.avatar_key = "orb-rust";
    expect(agentTemplateFromAgent(agent).avatar_key).toBe("orb-rust");
    expect(agentTemplateFromAgent(agent, "orb-sky").avatar_key).toBe("orb-sky");
  });
});

describe("templateResourceSummary", () => {
  it.each([
    [1, 0, "1 Skill"],
    [2, 0, "2 Skills"],
    [0, 2, "2 Connectors"],
    [1, 1, "1 Skill · 1 Connector"],
    [0, 0, "Instructions only"],
  ])(
    "summarises %i Skills and %i Connectors",
    (skills, connectors, expected) => {
      expect(
        templateResourceSummary({
          connector_bindings: Array.from(
            { length: connectors },
            (_, index) => `app-${index}`,
          ),
          skill_bindings: Array.from({ length: skills }, () => ({
            manifest_version: "1.0.0",
            name: "s",
            skill_id: "s",
          })),
        }),
      ).toBe(expected);
    },
  );
});

describe("resolveAgentTemplateBindings", () => {
  const template = {
    skill_bindings: [
      {
        manifest_version: "0.9.0",
        name: "Review Changes",
        skill_id: "skill-review-changes",
      },
      {
        manifest_version: "1.0.0",
        name: "Research Market",
        skill_id: "skill-research-market",
      },
      {
        manifest_version: "1.0.0",
        name: "Configured exporter",
        skill_id: "configured-exporter",
      },
      {
        manifest_version: "1.0.0",
        name: "Legacy summary",
        skill_id: "legacy-summary",
      },
      { manifest_version: "1.0.0", name: "Missing", skill_id: "missing" },
    ],
  };

  it("uses the exact version when present and the newest active one otherwise", () => {
    const skills = createTeamHubTestSeed().skillManifests;
    const reviewLatest: TeamHubSkillManifest = {
      ...skills.find((skill) => skill.skill_id === "skill-review-changes")!,
      manifest_version: "1.2.0",
      name: "Review Changes v2",
    };

    expect(
      resolveAgentTemplateBindings(template, {
        skills: [...skills, reviewLatest],
      }),
    ).toEqual({
      skillBindings: [
        {
          manifest_version: "1.2.0",
          name: "Review Changes v2",
          skill_id: "skill-review-changes",
        },
        {
          manifest_version: "1.0.0",
          name: "Research Market",
          skill_id: "skill-research-market",
        },
      ],
      importableSkills: [],
      unavailableSkills: [
        { key: "configured-exporter", name: "Configured exporter" },
        { key: "legacy-summary", name: "Legacy summary" },
        { key: "missing", name: "Missing" },
      ],
    });
  });

  it("copies a Skill the publisher shared instead of skipping it", () => {
    const result = resolveAgentTemplateBindings(template, {
      imports: [
        {
          source: {
            manifest_version: "1.0.0",
            name: "Missing",
            skill_id: "missing",
          },
          status: "importable",
        },
        {
          source: {
            manifest_version: "1.0.0",
            name: "Legacy summary",
            skill_id: "legacy-summary",
          },
          status: "unavailable",
        },
      ],
      skills: [],
    });
    expect(result.importableSkills).toEqual([
      { manifest_version: "1.0.0", name: "Missing", skill_id: "missing" },
    ]);
    expect(result.unavailableSkills.map((item) => item.key)).toEqual([
      "skill-review-changes",
      "skill-research-market",
      "configured-exporter",
      "legacy-summary",
    ]);
  });
});

describe("withImportedTemplateSkills", () => {
  it("binds each copied Skill once and leaves out references that stayed unavailable", () => {
    const bound = {
      manifest_version: "1.0.0",
      name: "Research Market",
      skill_id: "skill-research-market",
    };
    expect(
      withImportedTemplateSkills(
        [bound],
        [
          {
            skill: {
              manifest_version: "1.0.0",
              name: "incident",
              skill_id: "skill_copy",
            },
            source: {
              manifest_version: "1.0.0",
              name: "incident",
              skill_id: "skill_source",
            },
            status: "imported",
          },
          {
            skill: {
              manifest_version: "1.0.0",
              name: "incident",
              skill_id: "skill_copy",
            },
            source: {
              manifest_version: "1.0.0",
              name: "incident",
              skill_id: "skill_other",
            },
            status: "imported",
          },
          {
            source: {
              manifest_version: "1.0.0",
              name: "gone",
              skill_id: "skill_gone",
            },
            status: "unavailable",
          },
        ],
      ),
    ).toEqual([
      bound,
      { manifest_version: "1.0.0", name: "incident", skill_id: "skill_copy" },
    ]);
  });
});
