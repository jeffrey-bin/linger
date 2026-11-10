import { describe, expect, it } from "vitest";

import { buildTeamHubCliRunContext } from "../../../src/agent/executor/local-backend.js";

describe("TeamHub CLI run context", () => {
  it("writes only run_id and scope into the per-run context", () => {
    const ref = { kind: "meta", agentId: "agent_one", roomId: "room" } as const;
    const scope = { kind: "room", id: "room" };
    expect(buildTeamHubCliRunContext({ ref, runId: "run_one" })).toEqual({
      run_id: "run_one",
      scope,
    });
    expect(
      buildTeamHubCliRunContext({ ref, runId: "run_one" }),
    ).not.toHaveProperty("reply_source");
  });

  it("scopes a Task's AlterEgo to its Task without a Task input", () => {
    const ref = {
      kind: "alter_ego",
      agentId: "agent_one",
      taskId: "task_one",
    } as const;
    expect(buildTeamHubCliRunContext({ ref })).toEqual({
      scope: { kind: "task", id: "task_one" },
    });
  });
});
