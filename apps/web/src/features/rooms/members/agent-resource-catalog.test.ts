import { describe, expect, it, vi } from "vitest";

import {
  acceptsEmptySkillConfig,
  loadAllManifestPages,
} from "./agent-resource-catalog";

describe("Agent resource catalog", () => {
  it("uses JSON Schema evaluation to decide whether empty Skill config is valid", () => {
    expect(
      acceptsEmptySkillConfig({
        additionalProperties: false,
        properties: { prefix: { type: "string" } },
        type: "object",
      }),
    ).toBe(true);
    expect(
      acceptsEmptySkillConfig({
        $defs: {
          configured: {
            additionalProperties: false,
            required: ["prefix"],
            type: "object",
          },
        },
        $ref: "#/$defs/configured",
      }),
    ).toBe(false);
    expect(
      acceptsEmptySkillConfig({
        if: { maxProperties: 0 },
        then: false,
        type: "object",
      }),
    ).toBe(false);
  });

  it("uses the declared draft-04 and draft-06 dialects", () => {
    for (const $schema of [
      "http://json-schema.org/draft-04/schema#",
      "https://json-schema.org/draft-06/schema",
    ]) {
      expect(
        acceptsEmptySkillConfig({
          $schema,
          additionalProperties: false,
          type: "object",
        }),
      ).toBe(true);
    }

    expect(
      acceptsEmptySkillConfig({
        $schema: "https://json-schema.org/schema",
        if: { maxProperties: 0 },
        then: false,
        type: "object",
      }),
    ).toBe(false);
    expect(
      acceptsEmptySkillConfig({
        $schema: "https://json-schema.org/draft/unknown/schema",
        type: "object",
      }),
    ).toBe(false);
  });

  it("reads every cursor page and rejects a non-advancing cursor", async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: ["one"],
        page: { has_more: true, next_cursor: "page-2" },
      })
      .mockResolvedValueOnce({
        items: ["two"],
        page: { has_more: false },
      });

    await expect(loadAllManifestPages(loadPage)).resolves.toEqual([
      "one",
      "two",
    ]);
    expect(loadPage).toHaveBeenNthCalledWith(1, {
      cursor: undefined,
      limit: 100,
    });
    expect(loadPage).toHaveBeenNthCalledWith(2, {
      cursor: "page-2",
      limit: 100,
    });

    await expect(
      loadAllManifestPages(
        vi.fn().mockResolvedValue({
          items: [],
          page: { has_more: true, next_cursor: "same" },
        }),
      ),
    ).rejects.toThrow("invalid catalog cursor");
  });
});
