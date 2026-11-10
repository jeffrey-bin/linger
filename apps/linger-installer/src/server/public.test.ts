import { expect, test } from "vitest";
import { publicComputer } from "./public.js";
test("status contains only public runtime status fields and filters malformed native entries", () => {
  const result = publicComputer({
    state: "ready",
    connected: true,
    detail: "This computer is ready",
    runtimes: [
      {
        type: "codex",
        status: "ready",
        models: Array(100).fill({ id: "model", metadata: "native" }),
      },
      null,
      "invalid",
      { type: "claude" },
      { type: "pi", status: "authentication_required" },
    ],
  });
  expect(result.connected).toBe(true);
  expect(result.runtimes).toEqual([
    { type: "codex", status: "ready" },
    { type: "pi", status: "authentication_required" },
  ]);
  expect(JSON.stringify(result)).not.toContain("metadata");
});
