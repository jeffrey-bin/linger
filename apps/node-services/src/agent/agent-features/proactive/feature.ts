import { defineFeature, type FeatureDeclaration } from "../contracts.js";
import type { ExecutionContextRef } from "../../executor/context-ref.js";
import type { AgentLogger } from "../../observability/agent-log.js";
import { NotAnotherMeRoomError } from "./client.js";
import { reviewRoom, type ReviewDeps } from "./review.js";

export interface ProactiveFeatureDeps extends ReviewDeps {
  readonly logger: AgentLogger;
  readonly trackBackground: (
    operation: Promise<unknown>,
    ref: ExecutionContextRef,
    event: string,
  ) => void;
}

/**
 * Proactive review of an AnotherMe's direct Room: after each accepted Human
 * message, every complete window of twenty ordinary messages becomes a hidden
 * wake that TeamHub delivers once the Room is quiet for three minutes.
 * AnotherMe then judges and acts in one Run: it reminds, records Tracking
 * Items, or stays silent.
 */
export const createProactiveFeature = (
  deps: ProactiveFeatureDeps,
): FeatureDeclaration => {
  if (
    typeof deps?.client?.window !== "function" ||
    !deps.logger ||
    typeof deps.trackBackground !== "function"
  )
    throw new Error(
      "proactive feature requires client, logger and trackBackground",
    );
  // One review per Room at a time; Rooms that are not the AnotherMe's direct
  // Room are remembered so group traffic does not keep asking TeamHub.
  const reviewing = new Set<string>();
  const notDirect = new Set<string>();
  return defineFeature({
    id: "proactive",
    match: { agentTypes: ["anotherme"], contextKinds: ["meta"] },
    context: {
      ports: { afterInboxInputAccepted: {} },
      create: (bound) => ({
        afterInboxInputAccepted: (context, fact) => {
          const owner = context.identity.representedHuman?.actorId;
          const roomId = fact.inboxId.startsWith("room:")
            ? fact.inboxId.slice("room:".length)
            : undefined;
          if (
            !owner ||
            !roomId ||
            notDirect.has(roomId) ||
            reviewing.has(roomId) ||
            !fact.messages?.some((message) => message.sender.actorId === owner)
          )
            return;
          reviewing.add(roomId);
          const review = reviewRoom(
            deps,
            roomId,
            context.ref.agentId,
            bound.signal,
          )
            .then((outcomes) => {
              for (const { judgedCount } of outcomes)
                deps.logger.log("info", "proactive.window_judged", {
                  roomId,
                  agentId: context.ref.agentId,
                  judgedCount,
                  action: "decide",
                });
            })
            .catch((error: unknown) => {
              if (error instanceof NotAnotherMeRoomError) notDirect.add(roomId);
              else throw error;
            })
            .finally(() => reviewing.delete(roomId));
          deps.trackBackground(review, context.ref, "proactive.review_failed");
        },
      }),
    },
  });
};
