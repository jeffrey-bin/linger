import { defineFeature, type FeatureDeclaration } from "../contracts.js";
import type { MetaRoomKind } from "../../executor/context-ref.js";
import { assembleExecutionContextDeveloperInstructions } from "./context-instructions.js";

export const CONTEXT_INSTRUCTIONS_FEATURE_ID = "context-instructions";

/**
 * Contributes Context identity and role-capability instructions. No external dependencies; the instruction content is determined only by the activation's facts and trusted
 * identity, configuration, and Context ref facts.
 */
export const createContextInstructionsFeature = (): FeatureDeclaration =>
  defineFeature({
    id: CONTEXT_INSTRUCTIONS_FEATURE_ID,
    context: {
      ports: { contributeContextInstructions: {} },
      create: () => ({
        contributeContextInstructions: (view, facts) => {
          const ref = view.ref;
          const contextPromptInput =
            ref.kind === "alter_ego"
              ? ({ contextKind: ref.kind, taskId: ref.taskId } as const)
              : ref.kind === "document"
                ? ({ contextKind: ref.kind } as const)
                : // The core validity check rejects a Meta Context without a
                  // trusted roomKind before contributions run.
                  ({
                    contextKind: ref.kind,
                    roomId: ref.roomId,
                    roomKind: view.roomKind as MetaRoomKind,
                  } as const);
          return assembleExecutionContextDeveloperInstructions({
            agentName: view.agent.name,
            agentActorId: view.identity.actorId,
            agentType: view.identity.agentType,
            developerInstructions: view.agent.developerInstructions,
            representedHuman: view.identity.representedHuman,
            sponsor: view.identity.sponsor,
            connectedApps: facts.connectedApps,
            compactInstructions: facts.compactInstructions,
            ...contextPromptInput,
          });
        },
      }),
    },
  });
