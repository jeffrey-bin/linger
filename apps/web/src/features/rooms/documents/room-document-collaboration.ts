import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

import {
  registerOpenDocumentSession,
  roomDocumentLocalCopyName,
} from "./room-document-local-copies";
import {
  RoomDocumentSaveTracker,
  type RoomDocumentSaveSnapshot,
} from "./room-document-save-tracker";

export interface RoomDocumentCollaborationUser {
  actorId: string;
  color: string;
  name: string;
}

export interface RoomDocumentCollaborationSession {
  awareness: HocuspocusProvider["awareness"];
  destroy(): Promise<void>;
  document: Y.Doc;
  getSaveSnapshot(): RoomDocumentSaveSnapshot;
  readOnly?: boolean;
  subscribeSaveState(listener: () => void): () => void;
  user: RoomDocumentCollaborationUser;
}

export async function openRoomDocumentSession(input: {
  actorId: string;
  collaborationCredential: string;
  documentId: string;
  /** The Document's local copies were deleted and the session closed. */
  onLocalCopiesDeleted?: () => void;
  readOnly: boolean;
  refreshCredential?: () => Promise<string>;
  runtimeUrl: string;
  schemaVersion: number;
  stateHashVersion: number;
  user: RoomDocumentCollaborationUser;
}): Promise<RoomDocumentCollaborationSession> {
  const document = new Y.Doc({ gc: true });
  const tracker = new RoomDocumentSaveTracker({
    document,
    documentId: input.documentId,
    readOnly: input.readOnly,
    schemaVersion: input.schemaVersion,
    stateHashVersion: input.stateHashVersion,
  });
  const markOffline = () => tracker.setConnected(false);
  window.addEventListener("offline", markOffline);
  // Warm only the transport: no document or credential is attached until an
  // editor's local copy has been restored.
  const websocketProvider = new HocuspocusProviderWebsocket({
    maxDelay: 5_000,
    url: input.runtimeUrl,
  });
  // Only an editor keeps a local copy; a reader shows what the Runtime sends.
  const persistence = input.readOnly
    ? undefined
    : new IndexeddbPersistence(roomDocumentLocalCopyName(input), document);
  if (persistence !== undefined) {
    try {
      await persistence.whenSynced;
      if (document.getXmlFragment("prosemirror").length > 0) {
        const { recoverRoomDocumentPastedMedia } =
          await import("./room-document-markdown-paste");
        recoverRoomDocumentPastedMedia(document);
      }
    } catch (error) {
      window.removeEventListener("offline", markOffline);
      websocketProvider.destroy();
      tracker.destroy();
      await persistence.destroy();
      document.destroy();
      throw error;
    }
  }
  tracker.markLocalHydrated();

  // The connection token is valid only while the Document's permissions stay
  // unchanged, so every reconnect asks TeamHub for a new one.
  let initialCredentialAvailable = true;
  const token = input.refreshCredential
    ? async () => {
        if (initialCredentialAvailable) {
          initialCredentialAvailable = false;
          return input.collaborationCredential;
        }
        const refreshed = await input.refreshCredential?.();
        if (refreshed === undefined) {
          throw new Error("Document credential refresh failed.");
        }
        return refreshed;
      }
    : input.collaborationCredential;
  const provider = new HocuspocusProvider({
    document,
    name: input.documentId,
    onAuthenticationFailed: () => {
      tracker.markAuthenticationFailed();
      websocketProvider.disconnect();
    },
    onClose: markOffline,
    onDisconnect: () => {
      // A forced 4408 close skips provider.onClose, so reset the flag here
      // or the next SyncStep2 would not emit synced again.
      provider.synced = false;
      markOffline();
    },
    onStateless: ({ payload }) => {
      try {
        const envelope: unknown = JSON.parse(payload);
        // Only an editor's own edits can fail to save.
        if (input.readOnly || !tracker.acceptDurabilityFailure(envelope)) {
          tracker.acceptDurableAck(envelope);
        }
      } catch {
        // Stateless messages without a JSON durable envelope belong to other
        // provider extensions and do not affect save evidence.
      }
    },
    onStatus: ({ status }) => tracker.setConnected(status === "connected"),
    onSynced: ({ state }) => {
      if (state) {
        tracker.markRemoteHydrated();
      }
    },
    onUnsyncedChanges: ({ number }) => tracker.setUnsyncedChanges(number),
    token,
    websocketProvider,
  });
  provider.attach();
  // A preconnected socket does not replay its status event on attachment.
  if (websocketProvider.status === "connected") tracker.setConnected(true);
  let destroyed = false;
  const destroy = async () => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    unregister();
    window.removeEventListener("offline", markOffline);
    provider.destroy();
    websocketProvider.destroy();
    tracker.destroy();
    await persistence?.destroy();
    document.destroy();
  };
  // Deleting the Document's local copies closes the session, whether this tab
  // or another deletes them, instead of writing to a deleted database.
  const closeForDeletion = async () => {
    if (destroyed) return;
    await destroy();
    input.onLocalCopiesDeleted?.();
  };
  const unregister = registerOpenDocumentSession({
    actorId: input.actorId,
    close: closeForDeletion,
    documentId: input.documentId,
    hasUnsavedChanges: () => tracker.hasUnsavedLocalChanges(),
  });
  persistence?.db?.addEventListener(
    "versionchange",
    () => void closeForDeletion(),
  );

  return {
    awareness: provider.awareness,
    destroy,
    document,
    getSaveSnapshot: tracker.getSnapshot,
    readOnly: input.readOnly,
    subscribeSaveState: tracker.subscribe,
    user: input.user,
  };
}
