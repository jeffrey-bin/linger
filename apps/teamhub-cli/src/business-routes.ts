import { createHash } from "node:crypto";
import type { components } from "@linger/wire-contracts/teamhub-agent-api/types";
import { loadAgentCommandSchema } from "./command-schema-loader.js";
import { ToolExecutionError } from "./domain-support/errors.js";
import type { TeamHubApiPostPath } from "./http-client.js";

/**
 * The contract path of each generic business command. The generated contract
 * types every key, so a renamed or removed path fails the typecheck.
 */
export const routesByToolName: Readonly<Record<string, TeamHubApiPostPath>> = {
  search_messages: "/api/agent/v1/messages/search",
  send_message_sequence: "/api/agent/v1/presentation-sequences",
  send_emoji: "/api/agent/v1/emoji-reactions",
  ask_user: "/api/agent/v1/user-questions",
  send_direct_message: "/api/agent/v1/direct-messages",
  create_room: "/api/agent/v1/creation-approval-requests",
  create_task: "/api/agent/v1/tasks",
  check_task: "/api/agent/v1/tasks/check",
  send_task: "/api/agent/v1/tasks/send",
  stop_task: "/api/agent/v1/tasks/stop",
  create_team_md: "/api/agent/v1/team-md",
  add_room_member: "/api/agent/v1/room-members/add",
  get_room_members: "/api/agent/v1/room-members/query",
  get_team_md: "/api/agent/v1/team-md/query",
  list_available_agents: "/api/agent/v1/available-agents",
  get_agent: "/api/agent/v1/agents/get",
  create_agent: "/api/agent/v1/agents",
  update_agent: "/api/agent/v1/agents/updates",
  create_routine: "/api/agent/v1/routines",
  list_routines: "/api/agent/v1/routines/query",
  pause_routine: "/api/agent/v1/routines/pause",
  enable_routine: "/api/agent/v1/routines/enable",
  run_routine: "/api/agent/v1/routines/run",
  delete_routine: "/api/agent/v1/routines/deletion",
  get_personal_profile: "/api/agent/v1/personal-profile/query",
  start_personal_profile_build: "/api/agent/v1/personal-profile/builds",
  write_personal_profile: "/api/agent/v1/personal-profile/revisions",
  get_account_profile: "/api/agent/v1/account-profile/query",
  update_account_profile: "/api/agent/v1/account-profile/updates",
  create_document: "/api/agent/v1/documents",
  get_document_comment_thread: "/api/agent/v1/document-comments/thread",
  reply_document_comment: "/api/agent/v1/document-comments/replies",
  replace_document_comment_text:
    "/api/agent/v1/document-comments/text-replacements",
  list_connected_apps: "/api/agent/v1/apps/connections",
  execute_app_tool: "/api/agent/v1/apps/tools/execute",
};

/** The invocation ID TeamHub deduplicates a write by. */
export function agentOperationInvocationId(operationId: string): string {
  if (!operationId.trim())
    throw new TypeError("A write requires an operation ID");
  return `agent-invocation-sha256:${createHash("sha256").update(operationId).digest("hex")}`;
}

// Only the existing 6-64 character bare Room ID format is unambiguous.
// Preserve every other value for TeamHub's history validation and authorization.
function historyInboxId(value: unknown): unknown {
  return typeof value === "string" &&
    /^room[_-][A-Za-z0-9_-]{1,59}$/u.test(value)
    ? `room:${value}`
    : value;
}

function commandMessages(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  if (toolName === "send_direct_message")
    return input.messages as readonly string[];
  if (toolName === "send_message_sequence")
    return (input.messages as readonly { content: string }[]).map(
      (message) => message.content,
    );
  return [];
}

/**
 * Validates the input with the command's business schema and encodes the
 * request body, initializing only the selected command's dependencies.
 */
export async function encodeAgentCommandBody(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  operationId?: string,
): Promise<Record<string, unknown>> {
  const schema = await loadAgentCommandSchema(toolName);
  let validated = input;
  if (schema) {
    const parsed = schema.input.safeParse(input);
    if (!parsed.success)
      throw new ToolExecutionError(
        "invalid_input",
        "Command input does not match its business schema.",
      );
    validated = parsed.data as Record<string, unknown>;
  }
  // Markdown can decode numeric character references into a provider marker.
  // Only source with neither a marker start nor an ampersand can skip parsing.
  const messages = commandMessages(toolName, validated);
  if (
    messages.some(
      (message) => message.includes("\uE200") || message.includes("&"),
    )
  ) {
    const { assertMessageCitations } =
      await import("./domains/collaboration/message-citations.js");
    assertMessageCitations(messages);
  }
  if (toolName === "list_connected_apps") return {};
  if (toolName === "execute_app_tool")
    return {
      connection_id: validated.connectionId,
      tool_slug: validated.toolSlug,
      tool_version: validated.toolVersion,
      arguments: validated.arguments,
    };
  let body: Record<string, unknown> = { ...validated };
  if (toolName === "search_messages" && Array.isArray(body.inbox_ids))
    body.inbox_ids = body.inbox_ids.map(historyInboxId);
  if (
    toolName === "send_message_sequence" &&
    typeof body.inbox_id === "string"
  ) {
    const { toTeamHubPublicInboxId } =
      await import("./domains/collaboration/message-segments.js");
    body.inbox_id = toTeamHubPublicInboxId(body.inbox_id);
  }
  if (toolName === "create_room") {
    const { createRoomInputSchema } =
      await import("./domains/collaboration/tools/creation-schemas.js");
    const { cloneRoomCreationInput, normalizeRoomCreationInput } =
      await import("./domains/collaboration/tools/creation-tools.js");
    const caller = cloneRoomCreationInput(
      createRoomInputSchema.parse(validated),
    );
    body = {
      request_kind: "room_creation",
      caller_input: caller,
      effective_payload: normalizeRoomCreationInput(caller),
    };
  }
  if (operationId !== undefined)
    body.invocation_id = agentOperationInvocationId(operationId);
  return body;
}

/** Projects a TeamHub result into the command's public output shape. */
export async function decodeAgentCommandResult(
  toolName: string,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (
    ["list_connected_apps", "search_app_tools", "execute_app_tool"].includes(
      toolName,
    )
  ) {
    const schemas = await import("./domains/apps/tools.js");
    if (toolName === "list_connected_apps")
      return schemas.listConnectedAppsOutputSchema.parse({
        connections: (
          result.connections as components["schemas"]["AgentConnectedApp"][]
        ).map(projectConnectedApp),
      });
    if (toolName === "search_app_tools")
      return schemas.searchAppToolsOutputSchema.parse({
        tools: (
          result.tools as components["schemas"]["AgentConnectedAppTool"][]
        ).map((tool) => ({
          toolSlug: tool.tool_slug,
          toolVersion: tool.tool_version,
          name: tool.name,
          description: tool.description,
          appKey: tool.app_key,
          inputSchema: tool.input_schema,
          outputSchema: tool.output_schema,
          availableConnections:
            tool.available_connections.map(projectConnectedApp),
        })),
      });
    return schemas.executeAppToolOutputSchema.parse(
      result.status === "confirmation_pending"
        ? {
            confirmation: {
              status: "pending",
              roomId: result.room_id,
              messageId: result.message_id,
              interactionId: result.interaction_id,
            },
          }
        : { data: result.data },
    );
  }
  if (
    ["send_message_sequence", "send_direct_message"].includes(toolName) &&
    typeof result.inbox_id === "string"
  ) {
    const { fromTeamHubPublicInboxId } =
      await import("./domains/collaboration/message-segments.js");
    return { ...result, inbox_id: fromTeamHubPublicInboxId(result.inbox_id) };
  }
  return result;
}

function projectConnectedApp(
  connection: components["schemas"]["AgentConnectedApp"],
) {
  return {
    connectionId: connection.connection_id,
    appKey: connection.app_key,
    displayName: connection.display_name,
    identityLabel: connection.identity_label,
  };
}
