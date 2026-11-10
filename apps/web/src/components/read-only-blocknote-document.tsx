import "@blocknote/mantine/style.css";
import "./read-only-blocknote-document.css";
import "./knowledge-document.css";

import {
  BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
  type Block,
  type PartialBlock,
} from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { useMemo } from "react";
import { createKnowledgeReadingExtension } from "./knowledge-reading-extension";
import { roomDocumentCodeBlockSpec } from "@/features/rooms/documents/room-document-mermaid-code-block";

import {
  prepareReadOnlyMarkdown,
  type ReadOnlyMarkdownPresentation,
} from "./read-only-markdown-presentation";

const knowledgeSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, codeBlock: roomDocumentCodeBlockSpec },
});

export interface ReadOnlyBlockNoteDocumentProps {
  ariaLabel: string;
  assetBaseUrl?: string;
  markdown: string;
  presentation?: ReadOnlyMarkdownPresentation;
  documentTitle?: string;
  hiddenSectionTitles?: readonly string[];
  resolveLink?: (reference: string) => string | null | undefined;
}

export function ReadOnlyBlockNoteDocument({
  ariaLabel,
  assetBaseUrl,
  markdown,
  presentation = "default",
  documentTitle,
  hiddenSectionTitles,
  resolveLink,
}: ReadOnlyBlockNoteDocumentProps) {
  const initialContent = useMemo(
    () =>
      parseSafeMarkdown(
        markdown,
        assetBaseUrl,
        presentation,
        documentTitle,
        hiddenSectionTitles,
        resolveLink,
      ),
    [
      assetBaseUrl,
      markdown,
      presentation,
      documentTitle,
      hiddenSectionTitles,
      resolveLink,
    ],
  );
  const editor = useCreateBlockNote(
    {
      initialContent,
      ...(presentation === "knowledge"
        ? {
            extensions: [createKnowledgeReadingExtension()],
            schema: knowledgeSchema,
          }
        : {}),
    },
    [initialContent, presentation],
  );

  return (
    <article
      aria-label={ariaLabel}
      className={
        presentation === "knowledge"
          ? "read-only-blocknote-document read-only-blocknote-document--knowledge"
          : "read-only-blocknote-document"
      }
      data-content-renderer="blocknote"
      data-editable="false"
      data-knowledge-presentation={
        presentation === "knowledge" ? "true" : undefined
      }
    >
      <BlockNoteView
        className="read-only-blocknote-document__view"
        comments={false}
        editable={false}
        editor={editor}
        emojiPicker={false}
        filePanel={false}
        formattingToolbar={false}
        linkToolbar={false}
        sideMenu={false}
        slashMenu={false}
        tableHandles={false}
        theme="light"
      />
    </article>
  );
}

function parseSafeMarkdown(
  markdown: string,
  assetBaseUrl?: string,
  presentation: ReadOnlyMarkdownPresentation = "default",
  documentTitle?: string,
  hiddenSectionTitles?: readonly string[],
  resolveLink?: ReadOnlyBlockNoteDocumentProps["resolveLink"],
): PartialBlock[] {
  const parser = BlockNoteEditor.create();
  try {
    const blocks = sanitizeEmbeddedContent(
      parser.tryParseMarkdownToBlocks(
        prepareReadOnlyMarkdown(
          markdown,
          presentation,
          documentTitle,
          hiddenSectionTitles,
        ),
      ),
      assetBaseUrl,
      resolveLink,
    );
    return blocks.length ? blocks : [{ type: "paragraph", content: "" }];
  } finally {
    parser.unmount();
  }
}

function sanitizeEmbeddedContent(
  blocks: Block[],
  assetBaseUrl?: string,
  resolveLink?: ReadOnlyBlockNoteDocumentProps["resolveLink"],
): PartialBlock[] {
  return blocks.map((block) => {
    if (block.type === "image") {
      const props = block.props as {
        caption?: string;
        name?: string;
        url?: string;
      };
      const resolvedUrl = resolveEmbeddedImageUrl(props.url, assetBaseUrl);
      if (resolvedUrl) {
        return {
          ...block,
          props: { ...block.props, url: resolvedUrl },
        };
      }
      return {
        content: props.caption || props.name || "Embedded media omitted.",
        type: "paragraph",
      };
    }

    if (
      block.type === "audio" ||
      block.type === "file" ||
      block.type === "video"
    ) {
      const props = block.props as { caption?: string; name?: string };
      return {
        content: props.caption || props.name || "Embedded media omitted.",
        type: "paragraph",
      };
    }

    return {
      ...block,
      children: sanitizeEmbeddedContent(
        block.children,
        assetBaseUrl,
        resolveLink,
      ),
      content: sanitizeInlineLinks(block.content, assetBaseUrl, resolveLink),
    } as PartialBlock;
  });
}

function sanitizeInlineLinks(
  content: Block["content"],
  assetBaseUrl: string | undefined,
  resolveLink?: ReadOnlyBlockNoteDocumentProps["resolveLink"],
): Block["content"] {
  if (!Array.isArray(content)) {
    if (content?.type !== "tableContent") return content;
    return {
      ...content,
      rows: content.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) =>
          Array.isArray(cell)
            ? sanitizeInlineLinks(cell, assetBaseUrl, resolveLink)
            : {
                ...cell,
                content: sanitizeInlineLinks(
                  cell.content,
                  assetBaseUrl,
                  resolveLink,
                ),
              },
        ),
      })),
    } as Block["content"];
  }
  return content.flatMap((item) => {
    if (item.type !== "link") return item;
    const resolved = resolveLink?.(item.href);
    if (resolved === null) return item.content;
    if (resolved !== undefined) return { ...item, href: resolved };
    if (!isRelativeReference(item.href)) return item;
    const href = resolvePreviewAssetUrl(item.href, assetBaseUrl);
    return href ? { ...item, href } : item.content;
  });
}

function isRelativeReference(reference: string) {
  const trimmed = reference.trim();
  return Boolean(
    trimmed &&
    !trimmed.startsWith("/") &&
    !trimmed.startsWith("\\") &&
    !trimmed.startsWith("#") &&
    !/^[a-z][a-z\d+.-]*:/i.test(trimmed),
  );
}

function resolveEmbeddedImageUrl(
  reference: string | undefined,
  assetBaseUrl: string | undefined,
) {
  const trimmed = reference?.trim();
  const header = /^data:image\/(?:png|jpeg|gif|webp);base64,/i.exec(
    trimmed ?? "",
  );
  if (trimmed && header) {
    const payload = trimmed.slice(header[0].length);
    if (
      payload.length > 0 &&
      payload.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(payload)
    ) {
      return trimmed;
    }
    return undefined;
  }
  return resolvePreviewAssetUrl(reference, assetBaseUrl);
}

function resolvePreviewAssetUrl(
  reference: string | undefined,
  assetBaseUrl: string | undefined,
) {
  if (!reference || !assetBaseUrl) return undefined;
  const trimmed = reference.trim();
  if (!isRelativeReference(trimmed)) {
    return undefined;
  }

  try {
    const base = new URL(assetBaseUrl);
    const candidate = new URL(trimmed, base);
    const marker = "/v0/document-previews/";
    const markerIndex = base.pathname.indexOf(marker);
    const tokenEnd = base.pathname.indexOf("/", markerIndex + marker.length);
    if (markerIndex < 0 || tokenEnd < 0) return undefined;
    const snapshotRoot = base.pathname.slice(0, tokenEnd + 1);
    if (
      candidate.origin !== base.origin ||
      !candidate.pathname.startsWith(snapshotRoot)
    ) {
      return undefined;
    }
    return candidate.toString();
  } catch {
    return undefined;
  }
}
