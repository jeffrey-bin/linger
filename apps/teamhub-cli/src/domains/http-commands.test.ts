import { describe, expect, it } from "vitest";
import type { components } from "@linger/wire-contracts/teamhub-agent-api/types";
import {
  encodeAgentCommandBody,
  decodeAgentCommandResult,
  routesByToolName,
} from "../business-routes.js";
import { loadAgentCommandSchema } from "../command-schema-loader.js";

const output = async (name: string) =>
  (await loadAgentCommandSchema(name))!.output;

describe("direct command business boundary", () => {
  it("rejects the retired Human request command without an HTTP route", async () => {
    expect(routesByToolName.request_human_interaction).toBeUndefined();
    expect(
      await loadAgentCommandSchema("request_human_interaction"),
    ).toBeUndefined();
  });
  it("rejects a Connected Apps response that is valid JSON but lacks the required result data", async () => {
    await expect(
      decodeAgentCommandResult("execute_app_tool", {}),
    ).rejects.toThrow();
  });
  it("encodes Connected Apps business fields to the HTTP contract without adding an unsupported invocation field", async () => {
    expect(await encodeAgentCommandBody("list_connected_apps", {})).toEqual({});
    const args = {
      page_id: "page_1",
      nested: { preserve_key: true },
      values: [null, 1],
    };
    const expectedExecute = {
      connection_id: "connection_1",
      tool_slug: "NOTION_FETCH_PAGE",
      tool_version: "20261009_00",
      arguments: args,
    } satisfies components["schemas"]["AgentExecuteAppToolRequest"];
    expect(
      await encodeAgentCommandBody(
        "execute_app_tool",
        {
          connectionId: "connection_1",
          toolSlug: "NOTION_FETCH_PAGE",
          toolVersion: "20261009_00",
          arguments: args,
        },
        "stable-operation",
      ),
    ).toEqual(expectedExecute);
  });
  it("projects every Connected Apps HTTP result to the published CLI result schema", async () => {
    const connection = {
      connection_id: "connection_1",
      app_key: "notion",
      display_name: "Test Notion",
      identity_label: "Fixture account",
    } satisfies components["schemas"]["AgentConnectedApp"];
    const expectedConnection = {
      connectionId: "connection_1",
      appKey: "notion",
      displayName: "Test Notion",
      identityLabel: "Fixture account",
    };
    const list = {
      connections: [connection],
    } satisfies components["schemas"]["AgentListConnectedAppsResponse"];
    const listOutput = await decodeAgentCommandResult(
      "list_connected_apps",
      list,
    );
    expect((await output("list_connected_apps")).parse(listOutput)).toEqual({
      connections: [expectedConnection],
    });
    const tool = {
      tool_slug: "NOTION_FETCH_PAGE",
      tool_version: "20261009_00",
      name: "Fetch page",
      description: "Fetch a page",
      app_key: "notion",
      input_schema: {
        type: "object",
        properties: { page_id: { type: "string" } },
      },
      output_schema: {},
      available_connections: [connection],
    } satisfies components["schemas"]["AgentConnectedAppTool"];
    const search = {
      tools: [tool],
    } satisfies components["schemas"]["AgentSearchAppToolsResponse"];
    expect(
      (await output("search_app_tools")).parse(
        await decodeAgentCommandResult("search_app_tools", search),
      ),
    ).toEqual({
      tools: [
        {
          toolSlug: tool.tool_slug,
          toolVersion: tool.tool_version,
          name: tool.name,
          description: tool.description,
          appKey: tool.app_key,
          inputSchema: tool.input_schema,
          outputSchema: {},
          availableConnections: [expectedConnection],
        },
      ],
    });
    const execution = {
      data: { page_id: "page_1", nested: [true, null] },
    } satisfies components["schemas"]["AgentExecuteAppToolResponse"];
    expect(
      (await output("execute_app_tool")).parse(
        await decodeAgentCommandResult("execute_app_tool", execution),
      ),
    ).toEqual({ data: execution.data });
  });
  it("preserves the explicit reply source of a sequence without lifecycle identity", async () => {
    expect(
      await encodeAgentCommandBody(
        "send_message_sequence",
        {
          inbox_id: "room_1",
          source_message_id: "message_source",
          messages: [
            { content: "first", pause_before: "none" },
            { content: "second", pause_before: "brief" },
          ],
        },
        "stable-operation",
      ),
    ).toMatchObject({
      source_message_id: "message_source",
      inbox_id: "room:room_1",
    });
  });
  it("rejects malformed business inputs before dispatch", async () => {
    await expect(
      encodeAgentCommandBody("send_message_sequence", {
        inbox_id: "room_1",
        messages: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
  it.each(["send_message_sequence", "send_direct_message"])(
    "keeps public Room identities in %s results",
    async (name) => {
      const result = {
        accepted: true,
        inbox_id: "room:room_1",
        message_id: "message_1",
      };
      expect(await decodeAgentCommandResult(name, result)).toEqual({
        ...result,
        inbox_id: "room_1",
      });
      expect(result.inbox_id).toBe("room:room_1");
    },
  );
  it("preserves explicit Task inboxes and unrelated domain results", async () => {
    const task = { accepted: true, inbox_id: "task:task_1" };
    expect(await decodeAgentCommandResult("send_direct_message", task)).toEqual(
      task,
    );
    expect(
      await decodeAgentCommandResult("create_room", {
        inbox_id: "room:room_1",
      }),
    ).toEqual({ inbox_id: "room:room_1" });
  });
});
