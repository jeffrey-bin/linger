import { useId, useLayoutEffect, useState } from "react";

import {
  createKnowledgeReadingExtension,
  KNOWLEDGE_READING_EXTENSION_KEY,
} from "@/components/knowledge-reading-extension";
import {
  isKnowledgeEvidenceMarker,
  isKnowledgeSourceHeading,
} from "@/components/read-only-markdown-presentation";
import type { RoomDocumentEditor } from "./room-document-comment-schema";

type KnowledgeBlock = RoomDocumentEditor["document"][number];
const metadataField =
  /^(?:okf_version|type|title|description|tags|graph|generated|schema_version|id|summary|sources|resource)\s*:/iu;

function blockText(block?: KnowledgeBlock): string {
  if (!block || !Array.isArray(block.content)) return "";
  return block.content
    .flatMap((item) => {
      if ("text" in item) return item.text;
      if (item.type === "link")
        return item.content.map((part) => part.text).join("");
      return [];
    })
    .join("")
    .trim();
}

function knowledgeFrontmatterEnd(
  blocks: KnowledgeBlock[],
  start: number,
): number | undefined {
  if (blocks[start]?.type !== "divider") return undefined;
  const first = blockText(blocks[start + 1]);
  if (metadataField.test(first)) {
    for (let index = start + 1; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      if (
        block.type === "divider" ||
        (block.type === "heading" && metadataField.test(blockText(block)))
      ) {
        return index;
      }
      if (block.type === "heading") return undefined;
    }
    return undefined;
  }
  if (!first.trimStart().startsWith("{")) return undefined;

  let json = "";
  for (let index = start + 1; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.type === "divider") {
      return isKnowledgeMetadataJson(json) ? index : undefined;
    }
    if (block.type !== "paragraph" && block.type !== "heading") {
      return undefined;
    }
    const text = blockText(block);
    if (block.type === "heading" && text.trim() !== "}") return undefined;
    json += `${json ? "\n" : ""}${text}`;
    if (block.type === "heading") {
      return isKnowledgeMetadataJson(json) ? index : undefined;
    }
  }
  return undefined;
}

function isKnowledgeMetadataJson(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    return Object.keys(parsed).some((key) => metadataField.test(`${key}:`));
  } catch {
    return false;
  }
}

/** The href of a list item that opens with a link, as related lists do. */
function leadingLink(block: KnowledgeBlock): string | undefined {
  if (
    (block.type !== "bulletListItem" && block.type !== "numberedListItem") ||
    !Array.isArray(block.content)
  )
    return undefined;
  const first = block.content.find(
    (item) => !("text" in item) || item.text.trim() !== "",
  );
  return first && !("text" in first) && first.type === "link"
    ? first.href
    : undefined;
}

/**
 * The generator appends a related entry on every update, so a list keeps
 * only its first item for each linked page.
 */
function hideRepeatedLinks(items: KnowledgeBlock[], hidden: Set<string>) {
  let seen = new Set<string>();
  for (const block of items) {
    const href = leadingLink(block);
    if (href === undefined) {
      seen = new Set();
    } else {
      const page = href.replace(/#.*$/u, "");
      if (seen.has(page)) {
        hidden.add(block.id);
        continue;
      }
      seen.add(page);
    }
    hideRepeatedLinks(block.children, hidden);
  }
}

/** Reading projection only: never remove or update collaborative blocks. */
export function knowledgeHiddenBlockIds(
  blocks: KnowledgeBlock[],
  title: string,
): Set<string> {
  const hidden = new Set<string>();
  const start = blocks.findIndex(
    (block) => block.type !== "paragraph" || blockText(block) !== "",
  );
  if (start < 0) return hidden;

  // Markdown's closing --- can become a Setext heading on the final YAML
  // or JSON line. Require a complete metadata-shaped envelope before hiding it.
  const frontmatterEnd = knowledgeFrontmatterEnd(blocks, start);
  if (frontmatterEnd !== undefined) {
    for (let head = 0; head <= frontmatterEnd; head += 1) {
      hidden.add(blocks[head]!.id);
    }
  }

  // Standalone generated metadata may also occur outside the YAML envelope.
  const visit = (items: KnowledgeBlock[]) => {
    let sourcesLevel: number | undefined;
    for (const block of items) {
      const text = blockText(block);
      if (block.type === "heading") {
        if (sourcesLevel !== undefined && block.props.level <= sourcesLevel)
          sourcesLevel = undefined;
        if (sourcesLevel === undefined && isKnowledgeSourceHeading(text))
          sourcesLevel = block.props.level;
      }
      if (
        sourcesLevel !== undefined ||
        ((block.type === "paragraph" || block.type === "heading") &&
          (/^generated\s*:/iu.test(text) || isKnowledgeEvidenceMarker(text)))
      ) {
        hidden.add(block.id);
      } else {
        visit(block.children);
      }
    }
  };
  visit(blocks);
  hideRepeatedLinks(blocks, hidden);

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (hidden.has(block.id)) continue;
    if (
      block.type === "paragraph" &&
      !blockText(block) &&
      block.children.length === 0
    ) {
      hidden.add(block.id);
      continue;
    }
    if (
      block.type === "heading" &&
      block.props.level === 1 &&
      blockText(block).toLowerCase() === title.trim().toLowerCase()
    ) {
      hidden.add(block.id);
    }
    break;
  }
  return hidden;
}

export function useKnowledgePresentation(
  editor: RoomDocumentEditor,
  title?: string,
) {
  const scope = useId();
  const [projection, setProjection] = useState<{
    hidden: string[];
    first?: string;
  }>({ hidden: [] });
  useLayoutEffect(() => {
    if (title === undefined) return;
    const update = () => {
      const blocks = editor.document;
      const hidden = knowledgeHiddenBlockIds(blocks, title);
      setProjection({
        hidden: [...hidden],
        first: blocks.find((block) => !hidden.has(block.id))?.id,
      });
    };
    update();
    return editor.onChange(update);
  }, [editor, title]);
  const reading = title !== undefined;
  useLayoutEffect(() => {
    if (!reading) return;
    // Decorations only: the collaborative content is never edited.
    editor.registerExtension(createKnowledgeReadingExtension());
    return () => {
      if (!editor._tiptapEditor.isDestroyed)
        editor.unregisterExtension(KNOWLEDGE_READING_EXTENSION_KEY);
    };
  }, [editor, reading]);

  const blockSelector = (id: string) =>
    `[data-knowledge-scope=${JSON.stringify(scope)}] .bn-block-outer[data-id=${JSON.stringify(id)}]`;
  const rules =
    title === undefined
      ? ""
      : [
          ...projection.hidden.map(
            (id) => `${blockSelector(id)} { display: none; }`,
          ),
          ...(projection.first
            ? [
                `${blockSelector(projection.first)} :is(h1,h2,h3,h4,h5,h6) { margin-top: 0; }`,
              ]
            : []),
        ].join("\n");
  return { rules, scope };
}
