import type { z } from "zod";

export interface AgentCommandSchema {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}

/** Load the existing business schema for just this command, not the full catalog. */
export async function loadAgentCommandSchema(
  toolName: string,
): Promise<AgentCommandSchema | undefined> {
  switch (toolName) {
    case "add_room_member":
      return (await import("./domains/collaboration/tools/agents.js"))
        .addRoomMemberSchema;
    case "create_agent":
      return (await import("./domains/collaboration/tools/agents.js"))
        .createAgentSchema;
    case "create_document":
      return (await import("./domains/collaboration/tools/document-tools.js"))
        .createDocumentSchema;
    case "create_room":
      return (await import("./domains/collaboration/tools/creation-tools.js"))
        .createRoomSchema;
    case "create_routine":
      return (await import("./domains/collaboration/tools/routines.js"))
        .createRoutineSchema;
    case "get_agent":
      return (await import("./domains/collaboration/tools/agents.js"))
        .getAgentSchema;
    case "get_room_members":
      return (await import("./domains/collaboration/tools/context-reads.js"))
        .getRoomMembersSchema;
    case "get_team_md":
      return (await import("./domains/collaboration/tools/context-reads.js"))
        .getTeamMdSchema;
    case "create_team_md":
      return (await import("./domains/collaboration/tools/create-team-md.js"))
        .createTeamMdSchema;
    case "delete_routine":
      return (await import("./domains/collaboration/tools/routines.js"))
        .deleteRoutineSchema;
    case "enable_routine":
      return (await import("./domains/collaboration/tools/routines.js"))
        .enableRoutineSchema;
    case "execute_app_tool":
      return (await import("./domains/apps/tools.js")).executeAppToolSchema;
    case "get_document_comment_thread":
      return (
        await import("./domains/collaboration/tools/document-comment-tools.js")
      ).getDocumentCommentThreadSchema;
    case "list_available_agents":
      return (
        await import("./domains/collaboration/tools/list-available-agents.js")
      ).listAvailableAgentsSchema;
    case "list_connected_apps":
      return (await import("./domains/apps/tools.js")).listConnectedAppsSchema;
    case "list_routines":
      return (await import("./domains/collaboration/tools/routines.js"))
        .listRoutinesSchema;
    case "get_personal_profile":
      return (await import("./domains/knowledge/tools/personal-profile.js"))
        .getPersonalProfileSchema;
    case "start_personal_profile_build":
      return (await import("./domains/knowledge/tools/personal-profile.js"))
        .startPersonalProfileBuildSchema;
    case "write_personal_profile":
      return (await import("./domains/knowledge/tools/personal-profile.js"))
        .writePersonalProfileSchema;
    case "get_account_profile":
      return (await import("./domains/knowledge/tools/personal-profile.js"))
        .getAccountProfileSchema;
    case "update_account_profile":
      return (await import("./domains/knowledge/tools/personal-profile.js"))
        .updateAccountProfileSchema;
    case "add_tracking_item":
      return (await import("./domains/knowledge/tools/tracking-items.js"))
        .addTrackingItemSchema;
    case "update_tracking_item":
      return (await import("./domains/knowledge/tools/tracking-items.js"))
        .updateTrackingItemSchema;
    case "complete_tracking_item":
      return (await import("./domains/knowledge/tools/tracking-items.js"))
        .completeTrackingItemSchema;
    case "list_tracking_items":
      return (await import("./domains/knowledge/tools/tracking-items.js"))
        .listTrackingItemsSchema;
    case "pause_routine":
      return (await import("./domains/collaboration/tools/routines.js"))
        .pauseRoutineSchema;
    case "read_knowledge":
      return (await import("./domains/knowledge/tools/read-evidence.js"))
        .readPersonalKnowledgeEvidenceSchema;
    case "search_knowledge":
      return (await import("./domains/knowledge/tools/query.js"))
        .queryPersonalKnowledgeSchema;
    case "replace_document_comment_text":
      return (
        await import("./domains/collaboration/tools/document-comment-tools.js")
      ).replaceDocumentCommentTextSchema;
    case "reply_document_comment":
      return (
        await import("./domains/collaboration/tools/document-comment-tools.js")
      ).replyDocumentCommentSchema;
    case "run_routine":
      return (await import("./domains/collaboration/tools/routines.js"))
        .runRoutineSchema;
    case "search_app_tools":
      return (await import("./domains/apps/tools.js")).searchAppToolsSchema;
    case "send_direct_message":
      return (
        await import("./domains/collaboration/tools/send-direct-message.js")
      ).sendDirectMessageSchema;
    case "send_message_sequence":
      return (
        await import("./domains/collaboration/tools/send-message-sequence.js")
      ).sendMessageSequenceSchema;
    case "update_agent":
      return (await import("./domains/collaboration/tools/agents.js"))
        .updateAgentSchema;
    case "create_task": {
      const { createTaskInputSchema, createTaskOutputSchema } =
        await import("./domains/collaboration/tools/creation-schemas.js");
      return { input: createTaskInputSchema, output: createTaskOutputSchema };
    }
    case "check_task":
      return (await import("./domains/collaboration/tools/tasks.js"))
        .checkTaskSchema;
    case "send_task":
      return (await import("./domains/collaboration/tools/tasks.js"))
        .sendTaskSchema;
    case "stop_task":
      return (await import("./domains/collaboration/tools/tasks.js"))
        .stopTaskSchema;
    default:
      return undefined;
  }
}
