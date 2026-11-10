import type { Node } from "@tiptap/pm/model";

import type { RoomDocumentCommentAnchor } from "./room-document-comments";

/** Presentation fallback while the authoritative comment mark is syncing. */
export function resolveCommentAnchorPosition(
  doc: Node | undefined,
  anchor: RoomDocumentCommentAnchor | undefined | null,
): { from: number; to: number } | undefined {
  if (!doc || !anchor?.block_id || !anchor.quoted_text) return;
  let result: { from: number; to: number } | undefined;
  doc.descendants((block, blockPos) => {
    if (block.attrs.id !== anchor.block_id) return;
    let text = "";
    const positions: number[] = [];
    block.descendants((node, offset) => {
      // Nested child blocks have their own anchors.
      if (node.type.name === "blockGroup") return false;
      const value = node.isText
        ? node.text!
        : node.type.name === "hardBreak"
          ? "\n"
          : "";
      for (let index = 0; index < value.length; index += 1) {
        positions.push(blockPos + 1 + offset + index);
      }
      text += value;
    });
    const matches: number[] = [];
    for (
      let index = text.indexOf(anchor.quoted_text);
      index >= 0;
      index = text.indexOf(anchor.quoted_text, index + 1)
    ) {
      matches.push(index);
    }
    const candidates =
      matches.length > 1
        ? matches.filter((index) => {
            const before = text.slice(0, index);
            const after = text.slice(index + anchor.quoted_text.length);
            const contextBefore = anchor.context_before ?? "";
            const contextAfter = anchor.context_after ?? "";
            return (
              (contextBefore.endsWith(before) ||
                before.endsWith(contextBefore)) &&
              (contextAfter.startsWith(after) || after.startsWith(contextAfter))
            );
          })
        : matches;
    if (candidates.length === 1) {
      const index = candidates[0]!;
      result = {
        from: positions[index]!,
        to: positions[index + anchor.quoted_text.length - 1]! + 1,
      };
    }
    return false;
  });
  return result;
}
