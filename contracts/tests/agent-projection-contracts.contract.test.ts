import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Schema {
  required?: string[];
  properties?: Record<string, { $ref?: string; maxLength?: number }>;
}

function schemas(file: string): Record<string, Schema> {
  const source = readFileSync(resolve(process.cwd(), file), "utf8");
  return (
    (parse(source) as { components?: { schemas?: Record<string, Schema> } })
      .components?.schemas ?? {}
  );
}

describe("Agent projection contracts", () => {
  it("projects versioned memory only through the represented Human identity", () => {
    const projections = schemas(
      "contracts/openapi/components/agent-projections.yaml",
    );

    expect(projections.AgentIdentity.properties?.represented_human?.$ref).toBe(
      "#/components/schemas/AgentRepresentedHumanRef",
    );
    expect(projections.AgentRepresentedHumanRef.required).toEqual([
      "id",
      "display_name",
    ]);
    expect(projections.AgentRepresentedHumanRef.properties?.memory?.$ref).toBe(
      "./user-memory.yaml#/components/schemas/UserMemoryRevision",
    );
    const memory = schemas("contracts/openapi/components/user-memory.yaml");
    expect(memory.UserMemoryRevision.required).toEqual(["version", "markdown"]);
    expect(memory.UserMemoryRevision.properties?.markdown?.maxLength).toBe(
      16384,
    );
  });
});
