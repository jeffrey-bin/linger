import type { RoomDocumentCommentAnchor } from "./room-document-comments";

export function readOnlyDocumentCommentAnchor(
  selection: Selection | null,
  editorRoot: HTMLElement | null,
): RoomDocumentCommentAnchor | null {
  if (
    selection === null ||
    selection.rangeCount !== 1 ||
    selection.isCollapsed ||
    editorRoot === null
  ) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const startBlock = closestBlock(range.startContainer, editorRoot);
  const endBlock = closestBlock(range.endContainer, editorRoot);
  if (startBlock === null || startBlock !== endBlock) return null;

  const quotedText = range.toString();
  const blockId = startBlock.dataset.id;
  if (!blockId || quotedText.trim() === "" || quotedText.length > 10_000) {
    return null;
  }
  const blocks = Array.from(
    editorRoot.querySelectorAll<HTMLElement>(".bn-block[data-id]"),
  );
  const blockIndex = blocks.indexOf(startBlock);
  if (blockIndex < 0) return null;

  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(startBlock);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const afterRange = document.createRange();
  afterRange.selectNodeContents(startBlock);
  afterRange.setStart(range.endContainer, range.endOffset);
  const before = [
    ...blocks.slice(0, blockIndex).map((block) => block.textContent ?? ""),
    beforeRange.toString(),
  ].join("\n");
  const after = [
    afterRange.toString(),
    ...blocks.slice(blockIndex + 1).map((block) => block.textContent ?? ""),
  ].join("\n");
  return {
    block_id: blockId,
    context_after: firstCodePoints(after, 2_000),
    context_before: lastCodePoints(before, 2_000),
    quoted_text: quotedText,
  };
}

function closestBlock(node: Node, editorRoot: HTMLElement): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const block = element?.closest<HTMLElement>(".bn-block[data-id]") ?? null;
  return block !== null && editorRoot.contains(block) ? block : null;
}

function firstCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function lastCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(-limit).join("");
}
