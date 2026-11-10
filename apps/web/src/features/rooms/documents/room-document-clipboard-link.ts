import { readDocumentClipboardLink } from "../files/document-clipboard-link";

import type { RoomDocumentEditor } from "./room-document-blocknote-editor";

export function insertRoomDocumentClipboardLink(
  editor: RoomDocumentEditor,
  clipboardData: Pick<DataTransfer, "getData">,
  origin: string,
  tenantId: string,
) {
  const link = readDocumentClipboardLink(clipboardData, origin);
  if (!link || link.tenantId !== tenantId) return false;

  editor.insertInlineContent(
    [
      {
        props: {
          documentId: link.documentId,
          href: link.url,
          label: link.title,
          tenantId: link.tenantId,
        },
        type: "documentLink",
      },
    ],
    { updateSelection: true },
  );
  return true;
}
