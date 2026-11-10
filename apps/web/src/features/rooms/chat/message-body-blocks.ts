import type {
  TeamHubMessageArtifactTreeSegment,
  TeamHubMessageDocumentSegment,
  TeamHubMessageFileSegment,
  TeamHubMessageHtmlFragmentSegment,
  TeamHubMessageSegment,
} from "@/features/teamhub/teamhub-types";
import { isDocumentCardSegment } from "@/features/teamhub/teamhub-message-content";

export type MessageBodyBlock =
  | { kind: "artifact_tree"; segment: TeamHubMessageArtifactTreeSegment }
  | { kind: "document_card"; segment: TeamHubMessageDocumentSegment }
  | { kind: "file"; segment: TeamHubMessageFileSegment }
  | { kind: "html_fragment"; segment: TeamHubMessageHtmlFragmentSegment }
  | { kind: "text"; body: string; segments?: TeamHubMessageSegment[] };

export function messageBodyBlocks(
  segments: TeamHubMessageSegment[],
): MessageBodyBlock[] {
  const blocks: MessageBodyBlock[] = [];
  let text = "";
  let textSegments: TeamHubMessageSegment[] = [];

  const flushText = () => {
    const body = text.trimEnd();
    if (body.trim()) {
      blocks.push({
        body,
        kind: "text",
        ...(textSegments.some((segment) => segment.type === "reference")
          ? { segments: textSegments }
          : {}),
      });
    }
    text = "";
    textSegments = [];
  };

  for (const segment of segments) {
    if (segment.type === "artifact_tree") {
      flushText();
      blocks.push({ kind: "artifact_tree", segment });
      continue;
    }
    if (segment.type === "file") {
      flushText();
      blocks.push({ kind: "file", segment });
      continue;
    }
    if (segment.type === "document" && isDocumentCardSegment(segment)) {
      flushText();
      blocks.push({ kind: "document_card", segment });
      continue;
    }
    if (segment.type === "html_fragment") {
      flushText();
      blocks.push({ kind: "html_fragment", segment });
      continue;
    }
    text += segment.content;
    textSegments.push(segment);
  }
  flushText();
  return blocks;
}

export type MessageTextBlock = Extract<MessageBodyBlock, { kind: "text" }>;

/**
 * A Message body as it is laid out: consecutive text shares one bubble, and
 * every file, folder, Document card, or HTML fragment stands on its own
 * outside the bubble, in segment order. Attachments no file segment names
 * (a person's uploads) follow the content. Each Document appears once.
 */
export type MessageBodyRun<Attachment> =
  | { kind: "bubble"; blocks: MessageTextBlock[] }
  | { kind: "block"; block: Exclude<MessageBodyBlock, MessageTextBlock> }
  | { kind: "attachment"; attachment: Attachment };

export function messageBodyRuns<
  Attachment extends { document: { id: string } },
>(
  blocks: readonly MessageBodyBlock[],
  attachments: readonly Attachment[],
): MessageBodyRun<Attachment>[] {
  const runs: MessageBodyRun<Attachment>[] = [];
  const shown = new Set<string>();
  for (const block of blocks) {
    if (block.kind === "text") {
      const last = runs.at(-1);
      if (last?.kind === "bubble") last.blocks.push(block);
      else runs.push({ kind: "bubble", blocks: [block] });
      continue;
    }
    if (block.kind === "file" || block.kind === "document_card") {
      if (shown.has(block.segment.document_id)) continue;
      shown.add(block.segment.document_id);
    }
    runs.push({ kind: "block", block });
  }
  for (const attachment of attachments) {
    if (shown.has(attachment.document.id)) continue;
    shown.add(attachment.document.id);
    runs.push({ kind: "attachment", attachment });
  }
  return runs;
}
