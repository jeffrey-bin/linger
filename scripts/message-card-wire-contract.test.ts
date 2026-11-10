import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

interface OpenApiSchema {
  $ref?: string;
  additionalProperties?: boolean;
  const?: unknown;
  enum?: unknown[];
  minProperties?: number;
  oneOf?: OpenApiSchema[];
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  unevaluatedProperties?: boolean;
}

interface OpenApiDocument {
  components?: { schemas?: Record<string, OpenApiSchema> };
  paths?: Record<
    string,
    Record<string, { operationId?: string; requestBody?: unknown }>
  >;
}

const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "linger-message-card-contract-"),
);

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

const bundleContract = (name: string, source: string): OpenApiDocument => {
  const output = join(temporaryDirectory, `${name}.json`);
  execFileSync(
    "pnpm",
    ["exec", "redocly", "bundle", source, "--output", output],
    { stdio: "ignore" },
  );
  return JSON.parse(readFileSync(output, "utf8")) as OpenApiDocument;
};

const teamhubPublic = bundleContract(
  "teamhub-public",
  "contracts/openapi/teamhub-public/teamhub-api.openapi.yaml",
);

const schemas = (document: OpenApiDocument) =>
  document.components?.schemas ?? {};
const referencedSchemaName = (schema: OpenApiSchema) =>
  schema.$ref?.split("/").at(-1);

describe("Typed card message wire contract", () => {
  it("hydrates typed cards on Messages and exposes business-specific decisions", () => {
    const publicSchemas = schemas(teamhubPublic);

    expect(publicSchemas.Message?.properties).toHaveProperty("card");
    expect(publicSchemas.Message?.properties).toHaveProperty(
      "card_context_message_id",
    );
    expect(publicSchemas.Message?.properties).not.toHaveProperty(
      "agent_run_id",
    );
    // Every card on a Message is a decision waiting on one Human.
    expect(
      referencedSchemaName(publicSchemas.Message?.properties?.card ?? {}),
    ).toBe("DecisionRequestedMessageCard");
    expect(publicSchemas.DecisionRequestedMessageCard).toMatchObject({
      additionalProperties: false,
      properties: {
        card_type: { const: "personal_notice" },
        intent: { const: "decision_requested" },
      },
    });
    expect(publicSchemas.DecisionKind?.enum).toEqual(
      expect.arrayContaining([
        "connection_auth",
        "browser_connection",
        "room_creation",
      ]),
    );
    expect(publicSchemas.RoomEventType?.enum).toEqual(
      expect.arrayContaining(["card.changed", "work_item.changed"]),
    );
    expect(
      teamhubPublic.paths?.["/v0/decisions/{decisionId}"]?.post?.operationId,
    ).toBe("decideDecision");
    expect(
      teamhubPublic.paths?.["/v0/decisions/{decisionId}/screenshot"]?.get
        ?.operationId,
    ).toBe("getDecisionScreenshot");
  });
});
