import type { TeamHubCompositionAttachmentInput } from "@/features/teamhub/teamhub-runtime";

export interface ComposerAttachment extends TeamHubCompositionAttachmentInput {
  error?: string;
  progress: number;
  status: "failed" | "ready" | "uploading";
}

/**
 * Attachments a composer has selected or is still uploading. A keyed store
 * outlives the composer, so leaving a Room or the page keeps uploads running
 * and the chips come back when the composer mounts again.
 */
export interface ComposerAttachmentStore {
  attachments: { current: ComposerAttachment[] };
  controllers: { current: Map<string, AbortController> };
  idempotencyKey: { current: string | undefined };
  /** True when the store belongs to one composer instance only. */
  private: boolean;
  set: (next: ComposerAttachment[]) => void;
  snapshot: () => ComposerAttachment[];
  subscribe: (listener: () => void) => () => void;
}

const keyedStores = new Map<string, ComposerAttachmentStore>();

function createStore(isPrivate: boolean): ComposerAttachmentStore {
  const listeners = new Set<() => void>();
  const store: ComposerAttachmentStore = {
    attachments: { current: [] },
    controllers: { current: new Map() },
    idempotencyKey: { current: undefined },
    private: isPrivate,
    set: (next) => {
      store.attachments.current = next;
      for (const listener of listeners) listener();
    },
    snapshot: () => store.attachments.current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store;
}

export function composerAttachmentStore(
  draftKey: string | undefined,
): ComposerAttachmentStore {
  if (!draftKey) return createStore(true);
  let store = keyedStores.get(draftKey);
  if (!store) {
    store = createStore(false);
    keyedStores.set(draftKey, store);
  }
  return store;
}

export function resetComposerAttachmentDraftsForTest() {
  keyedStores.clear();
}
