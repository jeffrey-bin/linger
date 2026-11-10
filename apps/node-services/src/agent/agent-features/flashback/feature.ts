import { defineFeature, type FeatureDeclaration } from "../contracts.js";
import type { ExecutionContextRef } from "../../executor/context-ref.js";
import type { AgentLogger } from "../../observability/agent-log.js";
import type { MessageSegment } from "../../executor/types.js";
import type { Flashback } from "../../../flashback.js";
import {
  DEFAULT_FLASHBACK_SETTINGS,
  FlashbackSession,
  type FlashbackSettings,
} from "./session.js";

/**
 * Narrow assembly dependencies bound once by the composition root: Memory's
 * flashback in this process, logger, and settings plus the host's
 * generic drain that converges background work on exit. Per-Context recall
 * state lives in the session created inside `create`, never duplicated per
 * Context.
 */
export interface FlashbackFeatureDeps {
  readonly client: Flashback;
  readonly logger: AgentLogger;
  readonly settings?: FlashbackSettings;
  readonly trackBackground: (
    operation: Promise<unknown>,
    ref: ExecutionContextRef,
    event: string,
  ) => void;
}

/**
 * After a real Inbox input is durably accepted, Another Me Meta recalls asynchronously. Applicability is
 * declared by match (the former agentType/kind gate moved here); the owner, text, and runtime checks and
 * acceptance generation, stable inputId replay dedup, and in-flight result ownership are all bound to a single Context instance's
 * session: replacing with the same ref yields a new session, and Runtime suspend preserves it. Submission goes through the after
 * port's original-instance FeatureContext to the final boundary; canSubmit is synchronous and side-effect free;
 * an invalidated signal blocks late results and the record; replay is handled as an already-accepted fact and does not repeat
 * recall. No new concurrency cap or queue is added; the existing business drop rule is kept.
 */
export const createFlashbackFeature = (
  deps: FlashbackFeatureDeps,
): FeatureDeclaration => {
  if (
    typeof deps?.client?.suggest !== "function" ||
    typeof deps.client.record !== "function" ||
    !deps.logger ||
    typeof deps.trackBackground !== "function"
  )
    throw new Error(
      "flashback feature requires client, logger, and trackBackground",
    );
  const settings = deps.settings ?? DEFAULT_FLASHBACK_SETTINGS;
  return defineFeature({
    id: "flashback",
    match: { agentTypes: ["anotherme"], contextKinds: ["meta"] },
    context: {
      ports: { afterInboxInputAccepted: {} },
      create: (bound) => {
        const session = new FlashbackSession(
          deps.client,
          deps.logger,
          settings,
        );
        return {
          afterInboxInputAccepted: (context, fact) => {
            // Replay of a committed fact is still an accepted fact, but it
            // was counted once already — no second generation bump, no
            // second recall.
            if (!session.noteAccepted(fact.inputId)) return;
            const owner = context.identity.representedHuman?.actorId;
            const text = owner
              ? (fact.messages ?? [])
                  .filter((message) => message.sender.actorId === owner)
                  .flatMap((message) =>
                    message.segments.flatMap((segment: MessageSegment) =>
                      segment.type === "text" ? [segment.content] : [],
                    ),
                  )
                  .join("\n")
                  .trim()
              : "";
            if (!owner || !text) return;
            const runtime = context.runtime as {
              readonly placement?: { readonly runtimeType?: string };
            };
            // Claude steers by interrupting the reply, so it only gets
            // follow-ups.
            const steers = runtime.placement?.runtimeType === "codex";
            deps.trackBackground(
              session.recall({
                signal: bound.signal,
                tenantId: context.tenantId,
                ownerActorId: owner,
                roomId:
                  context.ref.kind === "meta" ? context.ref.roomId : undefined,
                text,
                ports: {
                  activeRunId: () => context.activeRunId(),
                  ...(steers
                    ? {
                        steer: (runId, message, options) =>
                          context.steer(runId, message, options),
                      }
                    : {}),
                  followUp: (message, options) =>
                    context.followUp(message, options),
                },
              }),
              context.ref,
              "flashback.background_failed",
            );
          },
        };
      },
    },
  });
};
