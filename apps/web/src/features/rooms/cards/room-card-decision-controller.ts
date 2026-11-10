import { teamHubData } from "@/features/teamhub/teamhub-api";
import {
  type TeamHubClient,
  TeamHubError,
} from "@/features/teamhub/teamhub-client";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import type { RoomCardDecision } from "./room-message-card-contract";

export function createRoomCardDecisionController({
  client,
  onResolved,
  roomId,
  tenantId,
}: {
  client: Pick<TeamHubClient, "api">;
  onResolved: (message: TeamHubMessage) => Promise<void> | void;
  roomId: string;
  tenantId: string;
}) {
  return {
    async decide(action: RoomCardDecision) {
      let message: TeamHubMessage;
      try {
        message = await teamHubData(
          client.api.POST("/v0/decisions/{decisionId}", {
            params: { path: { decisionId: action.requestId } },
            body: {
              decision: action.decision,
              expected_version: action.expectedVersion,
              ...(action.feedback ? { comment: action.feedback } : {}),
              ...(action.connectionId
                ? { connection_id: action.connectionId }
                : {}),
              ...(action.answers ? { answers: action.answers } : {}),
              ...(action.links?.length ? { links: action.links } : {}),
              ...(action.attachmentUploadIds?.length
                ? { attachment_upload_ids: action.attachmentUploadIds }
                : {}),
            },
          }),
        );
      } catch (error) {
        if (!(error instanceof TeamHubError) || error.status !== 409)
          throw error;
        message = await teamHubData(
          client.api.GET("/v0/rooms/{roomId}/messages/{messageId}", {
            params: { path: { roomId, messageId: action.messageId } },
          }),
        );
        assertDecisionIdentity(message, tenantId, roomId, action);
        if (message.card!.version < action.expectedVersion) {
          invalidDecisionResult();
        }
        if (message.card!.version === action.expectedVersion) {
          throw error;
        }
        await onResolved(message);
        if (!isTargetDecisionState(message, action)) {
          throw error;
        }
        return message;
      }

      assertDecisionResult(message, tenantId, roomId, action);
      await onResolved(message);
      return message;
    },
  };
}

function assertDecisionResult(
  message: TeamHubMessage,
  tenantId: string,
  roomId: string,
  action: RoomCardDecision,
) {
  assertDecisionIdentity(message, tenantId, roomId, action);
  if (
    message.card!.version <= action.expectedVersion ||
    !isTargetDecisionState(message, action)
  ) {
    invalidDecisionResult();
  }
}

/** Whether the card shows this answer: an approval names its decision (a
 * connection authorization also its Connection), a denial its status. */
function isTargetDecisionState(
  message: TeamHubMessage,
  action: RoomCardDecision,
) {
  const card = message.card;
  if (!card) return false;
  if (action.decision === "approve")
    return (
      card.answer?.decision === "approve" &&
      (card.answer.connection_id ?? undefined) === action.connectionId
    );
  if (action.decision === "deny") return card.status === "denied";
  return card.status === "answered";
}

function assertDecisionIdentity(
  message: TeamHubMessage,
  tenantId: string,
  roomId: string,
  action: RoomCardDecision,
) {
  if (
    message.id !== action.messageId ||
    message.tenant_id !== tenantId ||
    message.room_id !== roomId ||
    message.author.tenant_id !== tenantId ||
    message.card?.intent !== "decision_requested" ||
    message.card.decision_id !== action.requestId
  ) {
    invalidDecisionResult();
  }
}

function invalidDecisionResult(): never {
  throw new Error(
    "Card decision response does not match the active Room command.",
  );
}
