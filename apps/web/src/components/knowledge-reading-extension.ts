import { createExtension } from "@blocknote/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import {
  isKnowledgeChangeLogHeading,
  isKnowledgeHistoryHeading,
  KNOWLEDGE_HISTORY_VISIBLE_ENTRIES,
  knowledgeCitationRanges,
} from "./read-only-markdown-presentation";

interface ReadingState {
  expanded: boolean;
  decorations: DecorationSet;
}

const readingKey = new PluginKey<ReadingState>("knowledgeReading");
export const KNOWLEDGE_READING_EXTENSION_KEY = "knowledgeReading";
const hidden = { style: "display: none" };
const changeLogDate = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?/u;

/**
 * Wiki reading projection drawn with ProseMirror decorations only: citation
 * labels and older Interaction History entries are hidden, never removed, so
 * the collaborative Y.Doc and stored Markdown keep their provenance. The
 * Change Log is drawn as a card.
 */
export const createKnowledgeReadingExtension = createExtension(() => ({
  key: KNOWLEDGE_READING_EXTENSION_KEY,
  prosemirrorPlugins: [
    new Plugin<ReadingState>({
      key: readingKey,
      state: {
        init: (_, state) => ({
          expanded: false,
          decorations: readingDecorations(state.doc, false),
        }),
        apply: (tr, value, _, state) => {
          const meta = tr.getMeta(readingKey) as
            | { expanded: boolean }
            | undefined;
          if (!meta && !tr.docChanged) return value;
          const expanded = meta?.expanded ?? value.expanded;
          return {
            expanded,
            decorations: readingDecorations(state.doc, expanded),
          };
        },
      },
      props: {
        decorations: (state) => readingKey.getState(state)?.decorations,
      },
    }),
  ],
}));

function readingDecorations(
  doc: ProseMirrorNode,
  expanded: boolean,
): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    // One character per position keeps string offsets aligned with the doc;
    // inline code and non-text inline nodes can never be part of a label.
    let text = "";
    node.forEach((child) => {
      text +=
        child.isText && !child.marks.some((mark) => mark.type.spec.code)
          ? child.text!
          : "￼".repeat(child.nodeSize);
    });
    for (const [start, end] of knowledgeCitationRanges(text)) {
      decorations.push(
        Decoration.inline(pos + 1 + start, pos + 1 + end, hidden),
      );
    }
    return false;
  });
  decorations.push(...sectionDecorations(doc, expanded));
  return DecorationSet.create(doc, decorations);
}

function sectionDecorations(
  doc: ProseMirrorNode,
  expanded: boolean,
): Decoration[] {
  const group = doc.firstChild;
  if (!group) return [];
  const blocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
  group.forEach((node, offset) => blocks.push({ node, pos: 1 + offset }));

  const decorations: Decoration[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const level = headingLevel(blocks[index]!.node);
    const title = blocks[index]!.node.textContent;
    const changeLog = isKnowledgeChangeLogHeading(title);
    if (
      level === undefined ||
      (!changeLog && !isKnowledgeHistoryHeading(title))
    )
      continue;
    const entries: typeof blocks = [];
    let next = index + 1;
    for (; next < blocks.length; next += 1) {
      const nextLevel = headingLevel(blocks[next]!.node);
      if (nextLevel !== undefined && nextLevel <= level) break;
      const text = blocks[next]!.node.textContent.trim();
      if (text) entries.push(blocks[next]!);
    }
    index = next - 1;
    if (changeLog) {
      decorations.push(...changeLogCard(entries));
      continue;
    }
    if (entries.length <= KNOWLEDGE_HISTORY_VISIBLE_ENTRIES) continue;
    if (!expanded)
      for (const entry of entries.slice(KNOWLEDGE_HISTORY_VISIBLE_ENTRIES))
        decorations.push(
          Decoration.node(entry.pos, entry.pos + entry.node.nodeSize, hidden),
        );
    const last = entries.at(-1)!;
    decorations.push(
      Decoration.widget(
        last.pos + last.node.nodeSize,
        (view) => sectionToggle(view, expanded),
        {
          ignoreSelection: true,
          key: `history-${last.pos}-${expanded}`,
          side: -1,
          stopEvent: () => true,
        },
      ),
    );
  }
  return decorations;
}

/** The Change Log, which keeps only its newest entries, drawn as one card. */
function changeLogCard(
  entries: ReadonlyArray<{ node: ProseMirrorNode; pos: number }>,
): Decoration[] {
  return entries.flatMap((entry, position) => {
    const classes = ["knowledge-change-log-entry"];
    if (position === 0) classes.push("knowledge-change-log-entry--first");
    if (position === entries.length - 1)
      classes.push("knowledge-change-log-entry--last");
    const decorations = [
      Decoration.node(entry.pos, entry.pos + entry.node.nodeSize, {
        class: classes.join(" "),
      }),
    ];
    const date = changeLogDate.exec(entry.node.firstChild?.textContent ?? "");
    if (date && entry.node.firstChild?.isTextblock)
      decorations.push(
        Decoration.inline(entry.pos + 2, entry.pos + 2 + date[0].length, {
          class: "knowledge-change-log-date",
        }),
      );
    return decorations;
  });
}

function headingLevel(block: ProseMirrorNode): number | undefined {
  const content = block.firstChild;
  return content?.type.name === "heading"
    ? Number(content.attrs.level)
    : undefined;
}

function sectionToggle(view: EditorView, expanded: boolean) {
  const wrapper = document.createElement("div");
  wrapper.className = "knowledge-section-toggle";
  wrapper.contentEditable = "false";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = expanded ? "Show less" : "View more";
  button.setAttribute("aria-expanded", String(expanded));
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    view.dispatch(view.state.tr.setMeta(readingKey, { expanded: !expanded }));
  });
  wrapper.append(button);
  return wrapper;
}
