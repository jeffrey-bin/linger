import type { AgentUserMemory } from "../../executor/types.js";
import {
  renderUserMemoryUpdate,
  type UserMemoryTracker,
} from "../user-memory/index.js";
import { encodeExecutionContextRef } from "../../executor/context-ref.js";
import { defineFeature, type FeatureDeclaration } from "../contracts.js";

export const USER_MEMORY_UPDATE_FEATURE_ID = "user-memory-update";

/**
 * Delivers a memory.md version newer than the one a live AnotherMe Context
 * holds, appended to its next input. The prefix is never rewritten, so the
 * Runtime's cached history stays valid. Each update carries the complete file.
 * The Context only holds the version once a Run carrying it succeeds; a failed
 * or cancelled Run offers it again.
 */
export function createUserMemoryUpdateFeature(deps: {
  readonly memories: UserMemoryTracker;
}): FeatureDeclaration {
  return defineFeature({
    id: USER_MEMORY_UPDATE_FEATURE_ID,
    match: { agentTypes: ["anotherme"] },
    context: {
      ports: { prepareInput: {}, onRunTerminal: {} },
      create: () => {
        // Formatting the same message again yields the same text.
        const decided = new Map<string, string | null>();
        // memory.md formatted into the current Run but not yet confirmed.
        let offered: AgentUserMemory | undefined;
        return {
          prepareInput: (view, message) => {
            if (message.trustedNotification) return null;
            const contextKey = encodeExecutionContextRef(view.ref);
            const key = `${contextKey}\u0000${message.messageId}`;
            if (!decided.has(key)) {
              const latest = deps.memories.latest(view.ref.agentId);
              const held = deps.memories.held(contextKey);
              let text: string | null = null;
              if (
                latest &&
                latest.version > (held?.version ?? 0) &&
                latest.version > (offered?.version ?? 0)
              ) {
                // A rollback can republish identical text under a new version.
                if (latest.markdown === held?.markdown)
                  deps.memories.hold(contextKey, latest);
                else {
                  offered = latest;
                  text = renderUserMemoryUpdate(latest);
                }
              }
              decided.set(key, text);
            }
            const text = decided.get(key);
            return text ? { text } : null;
          },
          onRunTerminal: (bound, event) => {
            const contextKey = encodeExecutionContextRef(bound.ref);
            if (
              event.terminal.type === "succeeded" &&
              offered &&
              offered.version > (deps.memories.held(contextKey)?.version ?? 0)
            )
              deps.memories.hold(contextKey, offered);
            offered = undefined;
          },
        };
      },
    },
  });
}
