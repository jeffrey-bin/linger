import { describe, expect, it } from "vitest";
import { parseLocalPlacement } from "../../../src/agent/runner-gateway/local-computer-management.js";

describe("Local placement admission", () => {
  const placement = {
    type: "local",
    computerId: "computer",
    ownerActorId: "owner",
    tenantId: "tenant",
    workspaceGrantId: "grant",
    runtimeType: "codex",
    assignmentRevision: 1,
  };
  it.each([
    { runtimeType: "hermes" },
    { runtimeType: "invalid" },
    { computerId: "../other" },
    { assignmentRevision: 0 },
  ])("rejects an invalid placement %o", (change) => {
    expect(() => parseLocalPlacement({ ...placement, ...change })).toThrow(
      "invalid",
    );
  });
  it.each(["codex", "claude", "pi"])(
    "keeps %s admission valid",
    (runtimeType) => {
      expect(parseLocalPlacement({ ...placement, runtimeType })).toEqual({
        ...placement,
        runtimeType,
      });
    },
  );
});
