interface RoomDocumentBlock {
  children: readonly RoomDocumentBlock[];
  content?: unknown;
  type: string;
}

export function roomDocumentBlocksAreEmpty(
  blocks: readonly RoomDocumentBlock[],
): boolean {
  return blocks.every((block) => {
    if (block.type !== "paragraph" && block.type !== "heading") {
      return false;
    }
    const content = Array.isArray(block.content) ? block.content : [];
    const hasText = content.some((inline) => {
      if (!inline || typeof inline !== "object") {
        return false;
      }
      return "text" in inline && String(inline.text).trim() !== "";
    });
    return !hasText && roomDocumentBlocksAreEmpty(block.children);
  });
}
