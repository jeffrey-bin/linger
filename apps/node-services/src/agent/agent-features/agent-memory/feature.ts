import {
  encodeExecutionContextRef,
  type ExecutionContextKey,
} from "../../executor/context-ref.js";
import { defineFeature, type FeatureDeclaration } from "../contracts.js";
import type { AgentMemoryCoordinator } from "./coordinator.js";
import type { AgentMemoryProjection } from "./projection.js";
import { renderAgentMemoryNote } from "./prompts.js";

export const AGENT_MEMORY_FEATURE_ID = "agent-memory";

/**
 * Narrow assembly dependencies bound once by the composition root: the
 * service-level shared maintenance Coordinator (never created per Context)
 * and the shared activation-scoped memory projection.
 */
export interface AgentMemoryFeatureDeps {
  /** Run counter and wake handle of the shared maintenance Coordinator. */
  readonly agentMemory: Pick<AgentMemoryCoordinator, "recordRun" | "wake">;
  /** Shared projection preparing the memory summary and Runtime View. */
  readonly agentMemoryProjection: AgentMemoryProjection;
}

/** When one Context instance's conversation gets the memory summary. */
interface MemoryNoteState {
  /** A new native Session or a completed compaction awaits its summary. */
  due: boolean;
  /** Summary mapped by the latest Runtime activation; absent before publication. */
  mapped?: string;
  /** Input carrying the latest note, so a replay of it renders the same. */
  carrier?: { readonly messageId: string; readonly text: string };
}

/**
 * Succeeded Meta Runs are counted by the shared Coordinator, which maintains Memory once five add up; it is
 * called by the feature from the Context lifecycle port, and budget and reconciliation state live for the service, not
 * inside the Context. Runtime activation prepares the read-only Agent Memory projection. The summary does not enter
 * the developer instructions. Publishing does not change the Session prefix or the resident process: the first input of a new native Session
 * and the first input after compaction each append one hidden message carrying the summary of the activation mapping at that time; before any
 * publish exists nothing is appended; other publishes only update the read-only files. Context compaction start also wakes
 * without waiting: native history is append-only, so records from before compaction stay readable.
 */
export const createAgentMemoryFeature = (
  deps: AgentMemoryFeatureDeps,
): FeatureDeclaration => {
  if (
    typeof deps?.agentMemory?.recordRun !== "function" ||
    typeof deps?.agentMemory?.wake !== "function" ||
    !deps.agentMemoryProjection
  )
    throw new Error(
      "agent-memory feature requires agentMemory and agentMemoryProjection",
    );
  // Bound Context instances by ref; an activation reports into its Context.
  const notes = new Map<ExecutionContextKey, MemoryNoteState>();
  return defineFeature({
    id: AGENT_MEMORY_FEATURE_ID,
    context: {
      ports: { onRunTerminal: {}, onMaintenance: {}, prepareInput: {} },
      create: (bound) => {
        const key = encodeExecutionContextRef(bound.ref);
        const note: MemoryNoteState = { due: false };
        notes.set(key, note);
        bound.signal.addEventListener(
          "abort",
          () => {
            if (notes.get(key) === note) notes.delete(key);
          },
          { once: true },
        );
        return {
          onRunTerminal: (context, event) => {
            // Maintenance reads only Meta Context history.
            if (
              event.terminal.type === "succeeded" &&
              context.ref.kind === "meta"
            )
              void deps.agentMemory.recordRun(context.ref.agentId);
          },
          onMaintenance: (context, event) => {
            if (event.phase === "started" && event.action.kind === "compact")
              void deps.agentMemory.wake(context.ref.agentId);
            // The core suspends a compacted Context, so the reactivation maps
            // the latest summary for the next input.
            if (
              event.phase === "finished" &&
              event.outcome.status === "completed"
            )
              note.due = true;
          },
          prepareInput: (_view, message) => {
            if (note.carrier?.messageId === message.messageId)
              return { text: note.carrier.text };
            if (!note.due) return null;
            note.due = false;
            note.carrier =
              note.mapped === undefined
                ? undefined
                : {
                    messageId: message.messageId,
                    text: renderAgentMemoryNote(note.mapped),
                  };
            return note.carrier ? { text: note.carrier.text } : null;
          },
        };
      },
    },
    activation: {
      ports: { prepareRuntime: {} },
      create: (view) => ({
        prepareRuntime: async (_activation, input) => {
          const prepared = await deps.agentMemoryProjection.prepare(
            view.ref.agentId,
            input.signal,
          );
          const note = notes.get(encodeExecutionContextRef(view.ref));
          if (note) {
            note.mapped = prepared.summary;
            if (input.newSession) note.due = true;
          }
          return {
            runtimeViewMappings: prepared.mapping ? [prepared.mapping] : [],
          };
        },
      }),
    },
  });
};
