import { expect, it } from "vitest";
import { loadAgentCommandSchema } from "./command-schema-loader.js";
import { routesByToolName } from "./business-routes.js";

it("exposes live membership and collaboration protocol reads", async () => {
  for (const [toolName, input, endpoint] of [
    [
      "get_room_members",
      { inbox_id: "thread:room_thread" },
      "room-members/query",
    ],
    ["get_team_md", { inbox_id: "room_one" }, "team-md/query"],
  ] as const) {
    expect(routesByToolName[toolName]).toBe(`/api/agent/v1/${endpoint}`);
    expect(
      (await loadAgentCommandSchema(toolName))?.input.parse(input),
    ).toEqual(input);
  }
});

it("accepts registered Agent identity alongside Human members", async () => {
  const members = [
    { actor_id: "actor_human", kind: "human", display_name: "Owner" },
    {
      actor_id: "actor_sam",
      kind: "agent",
      display_name: "Sam",
      agent_type: "general",
      description: "Researches Slack AI cases",
    },
    {
      actor_id: "actor_delegate",
      kind: "agent",
      display_name: "Delegate",
      agent_type: "anotherme",
      description: "",
    },
  ];
  for (const [toolName, scope] of [
    ["get_room_members", { inbox_id: "room:room_one", room_id: "room_one" }],
  ] as const) {
    const schema = (await loadAgentCommandSchema(toolName))!;
    const output = { ...scope, membership_revision: 1, members };
    expect(schema.output.parse(output)).toEqual(output);
  }
});
