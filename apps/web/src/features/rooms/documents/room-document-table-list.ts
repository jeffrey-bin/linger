import type { RoomDocumentEditor } from "./room-document-comment-schema";

type TableListKind = "bullet" | "numbered";
const listPrefix = /^(?:• |\d+\. )/u;

function currentTableLine(editor: RoomDocumentEditor) {
  const { $from, $to } = editor.prosemirrorState.selection;
  if ($from.parent.type.name !== "tableParagraph" || !$from.sameParent($to)) {
    return null;
  }
  let start = 0;
  let end = $from.parent.content.size;
  $from.parent.forEach((node, offset) => {
    if (node.type.name !== "hardBreak") return;
    if (offset < $from.parentOffset) start = offset + node.nodeSize;
    else if (end === $from.parent.content.size) end = offset;
  });
  return {
    from: $from.start() + start,
    text: $from.parent.textBetween(start, end, "", "\ufffc"),
  };
}

// Table cells persist inline content, not child blocks. Keep list markers and
// hard breaks in that representation so all existing readers preserve them.
export function insertTableCellList(
  editor: RoomDocumentEditor,
  kind: TableListKind,
) {
  const line = currentTableLine(editor);
  if (!line) return false;
  const previous = line.text.match(listPrefix)?.[0] ?? "";
  editor.transact((tr) => {
    tr.insertText(
      kind === "bullet" ? "• " : "1. ",
      line.from,
      line.from + previous.length,
    );
  });
  editor.focus();
  return true;
}

export function continueTableCellList(editor: RoomDocumentEditor) {
  const line = currentTableLine(editor);
  if (!line) return false;
  const prefix = line.text.match(listPrefix)?.[0];
  if (!prefix) return false;
  if (line.text.slice(prefix.length).trim() === "") {
    editor.transact((tr) => tr.delete(line.from, line.from + prefix.length));
  } else {
    const next =
      prefix === "• " ? prefix : `${Number.parseInt(prefix, 10) + 1}. `;
    editor.insertInlineContent(`\n${next}`, { updateSelection: true });
  }
  return true;
}
