import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import {
  fingerprintRoomDocumentDeletes,
  fingerprintRoomDocumentState,
} from "@linger/document-model";
import * as Y from "yjs";

import type { RoomDocumentCollaborationSession } from "@/features/rooms/documents/room-document-collaboration";
import { roomDocumentCommentSchema } from "@/features/rooms/documents/room-document-comment-schema";
import { RoomDocumentSaveTracker } from "@/features/rooms/documents/room-document-save-tracker";

/** Markdown a test seeds into a Document's collaborative state, by Document ID. */
export const localDocumentMarkdown = new Map<string, string>();

/**
 * A Room Document collaboration session without a Document Runtime. Every
 * local edit is acknowledged as durable at once, so the editor reaches Saved.
 * Tests route `openRoomDocumentSession` here with `vi.mock`.
 */
export async function openLocalDocumentSession(input: {
  documentId: string;
  readOnly?: boolean;
  schemaVersion: number;
  stateHashVersion: number;
  user: RoomDocumentCollaborationSession["user"];
}): Promise<RoomDocumentCollaborationSession> {
  const document = new Y.Doc({ gc: true });
  const markdown = localDocumentMarkdown.get(input.documentId);
  if (markdown) seedMarkdown(document, markdown);
  const tracker = new RoomDocumentSaveTracker({
    document,
    documentId: input.documentId,
    readOnly: input.readOnly,
    schemaVersion: input.schemaVersion,
    stateHashVersion: input.stateHashVersion,
  });
  tracker.markLocalHydrated();
  tracker.markRemoteHydrated();
  tracker.setConnected(true);
  acknowledgeCurrentHead(tracker, document, input);

  let destroyed = false;
  let acknowledging = 0;
  const acknowledgeLocalUpdate = () => {
    if (acknowledging) return;
    acknowledging = requestAnimationFrame(() => {
      acknowledging = 0;
      if (!destroyed) acknowledgeCurrentHead(tracker, document, input);
    });
  };
  document.on("update", acknowledgeLocalUpdate);

  return {
    awareness: null,
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      if (acknowledging) cancelAnimationFrame(acknowledging);
      document.off("update", acknowledgeLocalUpdate);
      tracker.destroy();
      document.destroy();
    },
    document,
    getSaveSnapshot: tracker.getSnapshot,
    readOnly: input.readOnly ?? false,
    subscribeSaveState: tracker.subscribe,
    user: input.user,
  };
}

function seedMarkdown(document: Y.Doc, markdown: string) {
  const editor = BlockNoteEditor.create({ schema: roomDocumentCommentSchema });
  try {
    blocksToYXmlFragment(
      editor,
      editor.tryParseMarkdownToBlocks(markdown),
      document.getXmlFragment("prosemirror"),
    );
  } finally {
    editor.unmount();
  }
}

function acknowledgeCurrentHead(
  tracker: RoomDocumentSaveTracker,
  document: Y.Doc,
  input: {
    documentId: string;
    schemaVersion: number;
    stateHashVersion: number;
  },
) {
  tracker.setUnsyncedChanges(0);
  tracker.acceptDurableAck({
    delete_set_hash: fingerprintRoomDocumentDeletes(document),
    head: {
      document_id: input.documentId,
      persisted_seq: Math.max(
        1,
        (tracker.getSnapshot().durableSequence ?? 0) + 1,
      ),
      schema_version: input.schemaVersion,
      state_hash: fingerprintRoomDocumentState(document),
      state_hash_version: input.stateHashVersion,
      state_vector: bytesToBase64(Y.encodeStateVector(document)),
    },
    type: "durability_ack",
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
}
