import { describe, expect, it } from "vitest";

import {
  assertGhostResources,
  materializeGhostResources,
} from "../../../src/agent/executor/ghost.js";
import { createInMemoryGhostStore } from "../test-support/in-memory-ghost-store.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("Ghost resources", () => {
  it("materializes deterministic immutable Skill and MCP descriptors", () => {
    const resources = materializeGhostResources({
      skills: [
        {
          skillId: "skill-z",
          manifestVersion: "1.0.0",
          name: "Zed",
          packageName: "skill-z",
          packageSha256: SHA_B,
          config: { z: true },
        },
        {
          skillId: "skill-a",
          manifestVersion: "2.0.0",
          name: "Alpha",
          packageName: "skill-a",
          packageSha256: SHA_A,
          config: { nested: { second: 2, first: 1 } },
        },
      ],
      mcpServers: [
        {
          mcpId: "mcp-z",
          manifestVersion: "1.0.0",
          name: "Zed MCP",
          transport: "streamable_http",
          url: "https://mcp.example.test/zed",
          allowedTools: ["write", "read"],
        },
        {
          mcpId: "mcp-a",
          manifestVersion: "1.0.0",
          name: "Alpha MCP",
          transport: "streamable_http",
          url: "http://127.0.0.1:4321/mcp",
          allowedTools: ["search"],
        },
      ],
    });

    expect(resources.skills.map(({ skillId }) => skillId)).toEqual([
      "skill-a",
      "skill-z",
    ]);
    expect(resources.mcpServers.map(({ mcpId }) => mcpId)).toEqual([
      "mcp-a",
      "mcp-z",
    ]);
    expect(resources.mcpServers[1]?.allowedTools).toEqual(["read", "write"]);
    expect(Object.keys(resources.skills[0]?.config.nested ?? {})).toEqual([
      "first",
      "second",
    ]);
    expect(Object.isFrozen(resources.skills[0]?.config.nested)).toBe(true);
    expect(() => assertGhostResources(resources)).not.toThrow();
  });

  it("rejects aliases, credentials, duplicates, and non-JSON config", () => {
    const skill = {
      skillId: "skill-a",
      manifestVersion: "1.0.0",
      name: "Alpha",
      packageName: "skill-a",
      packageSha256: SHA_A,
      config: {},
    } as const;

    expect(() => materializeGhostResources({ skills: [skill, skill] })).toThrow(
      "duplicate skill-a",
    );
    expect(() =>
      materializeGhostResources({
        skills: [{ ...skill, accessToken: "secret" } as never],
      }),
    ).toThrow("accessToken is not supported");
    expect(() =>
      materializeGhostResources({
        skills: [{ ...skill, config: { callback: () => undefined } as never }],
      }),
    ).toThrow("only JSON values");
    expect(() =>
      materializeGhostResources({
        mcpServers: [
          {
            mcpId: "mcp-a",
            manifestVersion: "1.0.0",
            name: "Alpha MCP",
            transport: "streamable_http",
            url: "https://token@example.test/mcp",
            allowedTools: ["search"],
          },
        ],
      }),
    ).toThrow("without credentials");
  });

  it("accepts 512-character Skill IDs without widening MCP IDs", () => {
    const skill = {
      skillId: "s".repeat(512),
      manifestVersion: "1.0.0",
      name: "Boundary Skill",
      packageName: "boundary-skill",
      packageSha256: SHA_A,
      config: {},
    };
    expect(
      materializeGhostResources({ skills: [skill] }).skills[0]?.skillId,
    ).toBe(skill.skillId);
    expect(() =>
      materializeGhostResources({
        skills: [{ ...skill, skillId: "s".repeat(513) }],
      }),
    ).toThrow("skillId is invalid");
    expect(() =>
      materializeGhostResources({
        mcpServers: [
          {
            mcpId: "m".repeat(65),
            manifestVersion: "1.0.0",
            name: "MCP",
            transport: "streamable_http",
            url: "https://mcp.example.test",
            allowedTools: ["search"],
          },
        ],
      }),
    ).toThrow("mcpId is invalid");
  });

  it("persists canonical resources and role defaults through the in-memory Ghost port", async () => {
    const store = createInMemoryGhostStore<{ model: string }>();

    await expect(
      store.insert({
        agentId: "agent-a",
        tenantId: "tenant-a",
        revision: "1",
        agent: { name: "Agent A", instructions: "Work carefully." },
        runtime: { model: "test-model" },
        resources: {
          skills: [
            {
              skillId: "skill-a",
              manifestVersion: "1.0.0",
              name: "Alpha",
              packageName: "skill-a",
              packageSha256: SHA_A,
              config: { enabled: true },
            },
          ],
          mcpServers: [
            {
              mcpId: "mcp-a",
              manifestVersion: "1.0.0",
              name: "Alpha MCP",
              transport: "streamable_http",
              url: "https://mcp.example.test/mcp",
              allowedTools: ["search"],
            },
          ],
        },
      }),
    ).resolves.toBe("inserted");

    const restored = await store.get("agent-a");
    expect(restored?.tenantId).toBe("tenant-a");
    expect(restored?.resources.skills[0]).toMatchObject({
      skillId: "skill-a",
      packageSha256: SHA_A,
      config: { enabled: true },
    });
    expect(restored?.resources.mcpServers[0]).toMatchObject({
      mcpId: "mcp-a",
      allowedTools: ["search"],
    });
    expect(Object.isFrozen(restored?.resources.skills[0]?.config)).toBe(true);
    await store.close();
  });
});
