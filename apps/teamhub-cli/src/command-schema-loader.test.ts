import { describe, expect, it } from "vitest";
import { toolSchemaToJsonSchema } from "./domain-support/schema.js";
import { loadAgentCommandSchema } from "./command-schema-loader.js";

// CLI commands without their own --schema load these business schemas.
const loadable = [
  "add_room_member",
  "add_tracking_item",
  "check_task",
  "complete_tracking_item",
  "create_agent",
  "create_document",
  "create_room",
  "create_routine",
  "create_task",
  "create_team_md",
  "delete_routine",
  "enable_routine",
  "execute_app_tool",
  "get_account_profile",
  "get_agent",
  "get_document_comment_thread",
  "get_personal_profile",
  "get_room_members",
  "get_team_md",
  "list_available_agents",
  "list_connected_apps",
  "list_routines",
  "list_tracking_items",
  "pause_routine",
  "read_knowledge",
  "replace_document_comment_text",
  "reply_document_comment",
  "run_routine",
  "search_app_tools",
  "search_knowledge",
  "send_direct_message",
  "send_message_sequence",
  "send_task",
  "start_personal_profile_build",
  "stop_task",
  "update_account_profile",
  "update_agent",
  "update_tracking_item",
  "write_personal_profile",
];

describe("business command schemas", () => {
  it.each(loadable)("loads %s as draft-07 JSON Schema", async (name) => {
    const schema = await loadAgentCommandSchema(name);
    expect(schema).toBeDefined();
    expect(toolSchemaToJsonSchema(schema!.input, "input")).toMatchObject({
      type: "object",
    });
    expect(toolSchemaToJsonSchema(schema!.output, "output")).toMatchObject({
      type: "object",
    });
  });

  it.each([
    "get_agent_build",
    "finish_task",
    "get_task_members",
    "list_tasks",
    "search_skills",
    "send_message",
    "set_profile",
    "send_to_alterego",
    "send_to_meta",
    "show_fragment",
    "upload_artifacts",
    "upload_artifact_tree",
    "apply_document_semantic_mutation",
    "request_human_interaction",
  ])("has no schema for the retired or CLI-owned %s", async (name) => {
    expect(await loadAgentCommandSchema(name)).toBeUndefined();
  });

  it("constrains the reply source of a message sequence", async () => {
    const schema = toolSchemaToJsonSchema(
      (await loadAgentCommandSchema("send_message_sequence"))!.input,
      "input",
    );
    expect(schema).toHaveProperty("properties.source_message_id.minLength", 1);
    expect(schema).toHaveProperty("properties.source_message_id.maxLength", 64);
  });

  it("bounds a Task message by Unicode code point", async () => {
    const send = (await loadAgentCommandSchema("send_task"))!.input;
    expect(
      send.safeParse({ task_id: "task_1", message: "😀".repeat(20_000) })
        .success,
    ).toBe(true);
    expect(
      send.safeParse({ task_id: "task_1", message: "😀".repeat(20_001) })
        .success,
    ).toBe(false);
    expect(send.safeParse({ task_id: "task_1", message: "  " }).success).toBe(
      false,
    );
  });
});
