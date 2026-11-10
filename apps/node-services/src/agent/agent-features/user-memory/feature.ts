import type { AgentUserMemory } from "../../executor/types.js";
import { encodeExecutionContextRef } from "../../executor/context-ref.js";
import { serializePromptData } from "../../prompt/prompt-data.js";
import { defineFeature, type FeatureDeclaration } from "../contracts.js";

export const USER_MEMORY_FEATURE_ID = "user-memory";

/**
 * Latest memory.md per Agent, recorded from the identity read this feature
 * performs at activation and before each new ordinary Run, so delivering
 * memory.md adds no network round trip beyond that read.
 */
export interface UserMemoryTracker {
  record(agentId: string, memory: AgentUserMemory | undefined): void;
  latest(agentId: string): AgentUserMemory | undefined;
  /** memory.md a Context already holds in its prefix or appended inputs. */
  held(contextKey: string): AgentUserMemory | undefined;
  hold(contextKey: string, memory: AgentUserMemory): void;
}

export function createUserMemoryTracker(): UserMemoryTracker {
  const latest = new Map<string, AgentUserMemory>();
  const held = new Map<string, AgentUserMemory>();
  return {
    record(agentId, memory) {
      const known = latest.get(agentId);
      if (memory && (!known || memory.version >= known.version))
        latest.set(agentId, memory);
    },
    latest: (agentId) => latest.get(agentId),
    held: (contextKey) => held.get(contextKey),
    hold: (contextKey, memory) => void held.set(contextKey, memory),
  };
}

/** Reads the represented Human's latest memory.md for one AnotherMe. */
export type UserMemoryResolver = (
  agentId: string,
  signal: AbortSignal,
) => Promise<AgentUserMemory | undefined>;

export function renderUserMemory(memory: AgentUserMemory | undefined): string {
  return `<user-memory version="${memory?.version ?? 0}">
This is the Human's memory.md: what Memory has learned about them from their Profile and from the conversations it reviews each night. Follow its "Communication & Working Style" section as their standing preferences; the other sections are a long-term portrait to keep in mind, not instructions. An explicit request in the current conversation wins. Apply new requests in the current conversation, but do not claim they have been saved: Memory learns lasting changes from the day's conversations at night.
memory.md (JSON-encoded text): ${serializePromptData(memory?.markdown || "No memory yet.")}
</user-memory>`;
}

export function renderUserMemoryUpdate(latest: AgentUserMemory): string {
  return `<user-memory-update version="${latest.version}">
The Human's memory.md changed after nightly maintenance or an administrative rollback. This complete version replaces the one in your instructions and any earlier update; the guidance given there still applies, and an explicit request in the current conversation still wins.
memory.md (JSON-encoded text): ${serializePromptData(latest.markdown)}
</user-memory-update>`;
}

/**
 * AnotherMe memory.md at activation: the version current now goes into the
 * developer instructions, so the Runtime prefix stays stable until the next
 * activation. Newer versions reach a live Context through user-memory-update.
 */
export function createUserMemoryFeature(deps: {
  readonly memories: UserMemoryTracker;
  readonly resolveUserMemory: UserMemoryResolver;
}): FeatureDeclaration {
  return defineFeature({
    id: USER_MEMORY_FEATURE_ID,
    match: { agentTypes: ["anotherme"] },
    activation: {
      ports: { prepareRuntime: {} },
      create: (view) => ({
        prepareRuntime: async (_activation, input) => {
          const refresh = async (signal: AbortSignal) =>
            deps.memories.record(
              view.agentId,
              await deps.resolveUserMemory(view.agentId, signal),
            );
          await refresh(input.signal);
          const latest = deps.memories.latest(view.agentId);
          deps.memories.hold(
            encodeExecutionContextRef(view.ref),
            latest ?? { version: 0, markdown: "" },
          );
          return {
            developerInstructions: renderUserMemory(latest),
            // The read only refreshes what user-memory-update delivers; a
            // new version never needs a new activation.
            checkNextRun: async (signal) => {
              await refresh(signal);
              return true;
            },
          };
        },
      }),
    },
  });
}
