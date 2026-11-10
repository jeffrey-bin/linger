import { describe, expect, it } from "vitest";
import {
  executeAppToolSchema,
  searchAppToolsInputSchema,
} from "./apps/tools.js";

describe("Connected Apps MCP", () => {
  it("accepts catalog app keys without an application-specific release", () => {
    expect(
      searchAppToolsInputSchema.safeParse({
        query: "Find Linear issues",
        appKey: "linear",
      }).success,
    ).toBe(true);
    expect(
      searchAppToolsInputSchema.safeParse({
        query: "Find issues",
        appKey: "../linear",
      }).success,
    ).toBe(false);
  });

  it("rejects unversioned or malformed execution selectors", () => {
    expect(() =>
      executeAppToolSchema.input.parse({
        connectionId: "connection_1",
        toolSlug: "gmail.send",
        toolVersion: "latest",
        arguments: {},
      }),
    ).toThrow();
  });
});
