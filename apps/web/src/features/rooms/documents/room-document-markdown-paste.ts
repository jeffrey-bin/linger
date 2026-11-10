import { TextSelection } from "@tiptap/pm/state";
import { parseRoomDocumentAssetReference } from "@linger/document-model";
import * as Y from "yjs";

import { roomDocumentBlocksAreEmpty } from "./room-document-blocks";
import type {
  RoomDocumentEditor,
  RoomDocumentPartialBlock,
} from "./room-document-comment-schema";

/**
 * Block-level Markdown syntax. One of these is enough to treat a plain-text
 * paste as Markdown, because none of them survives a rich-text copy.
 */
const MARKDOWN_BLOCK_PATTERNS = [
  /^ {0,3}#{1,6}[ \t]+\S/m,
  /^ {0,3}[-*+][ \t]+\S/m,
  /^ {0,3}1[.)][ \t]+\S/m,
  /^ {0,3}\d{1,9}[.)][ \t]+[^\n]*\n {0,3}\d{1,9}[.)][ \t]+\S/m,
  /^ {0,3}>[ \t]?\S/m,
  /^ {0,3}(?:```|~~~)/m,
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/m,
  /^ {0,3}\|[^\n]*\|[ \t]*$/m,
  /^ {0,3}\[[^\]\n]{1,128}\]:[ \t]+\S/m,
];

/** Inline Markdown that reads as literal punctuation when it is not parsed. */
const MARKDOWN_INLINE_PATTERNS = [
  /!?\[[^\]\n]{0,200}\]\([^()\s]{1,999}\)/,
  /(?:^|[\s(])(\*\*|__)(?!\s)[^\n]{0,200}\S\1/,
  /(?:^|[\s(])~~(?!\s)[^\n]{0,200}\S~~/,
  /(?:^|[\s(])`(?!\s)[^`\n]{1,200}`/,
];

/** Editor modes whose source is Markdown rather than code to keep verbatim. */
const MARKDOWN_EDITOR_MODES = new Set(["markdown", "md", "mdx"]);

/**
 * The copied editor's language, which VS Code and its forks put on the
 * clipboard, or undefined when the paste did not come from such an editor.
 */
function clipboardEditorMode(clipboardData: DataTransfer): string | undefined {
  const metadata = clipboardData.getData("vscode-editor-data");
  if (!metadata) return undefined;
  try {
    const mode = (JSON.parse(metadata) as { mode?: unknown }).mode;
    return typeof mode === "string" ? mode.toLocaleLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function editorModeCarriesMarkdown(clipboardData: DataTransfer): boolean {
  const mode = clipboardEditorMode(clipboardData);
  return mode === undefined || MARKDOWN_EDITOR_MODES.has(mode);
}

/** Whether this paste may take over the caret and insert whole Blocks. */
function acceptsBlockPaste(
  editor: RoomDocumentEditor,
  clipboardData: DataTransfer | null,
): clipboardData is DataTransfer {
  if (!clipboardData) return false;
  const types = Array.from(clipboardData.types ?? []);
  // BlockNote's own payload and file drops keep their handlers.
  if (types.includes("blocknote/html") || types.includes("Files")) return false;
  // A browser or document editor may put both rich HTML and a Markdown-looking
  // plain-text fallback on the clipboard. Let BlockNote parse the rich payload;
  // otherwise headings and inline marks are flattened to plain text here.
  // Editor metadata is the exception: Markdown and code editors intentionally
  // use their plain-text source for the specialised handlers below.
  if (
    clipboardEditorMode(clipboardData) === undefined &&
    (types.includes("text/html") || types.includes("text/rtf"))
  ) {
    return false;
  }
  const selection = editor.prosemirrorState?.selection;
  // Code blocks take their clipboard literally. Partial replacements keep the
  // default handler; a whole-document replacement is one replaceBlocks action.
  if (
    selection?.$from.parent.type.spec.code === true &&
    !selectsWholeDocument(editor)
  )
    return false;
  return (
    selection === undefined || selection.empty || selectsWholeDocument(editor)
  );
}

function acceptsRichHtmlPaste(
  editor: RoomDocumentEditor,
  clipboardData: DataTransfer | null,
): clipboardData is DataTransfer {
  if (!clipboardData) return false;
  const types = Array.from(clipboardData.types ?? []);
  if (
    types.includes("blocknote/html") ||
    types.includes("Files") ||
    !types.includes("text/html")
  )
    return false;

  const selection = editor.prosemirrorState?.selection;
  if (
    selection?.$from.parent.type.spec.code === true &&
    !selectsWholeDocument(editor)
  )
    return false;
  return true;
}

/** External media has no Document Asset authorization. Keep its source as a
 * link before it enters Yjs, including images inside tables and selections. */
function documentSafeClipboardHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const media of parsed.querySelectorAll("img, video, audio")) {
    const source =
      media.getAttribute("src") ??
      media.querySelector("source")?.getAttribute("src") ??
      "";
    if (!source || parseRoomDocumentAssetReference(source) !== undefined)
      continue;
    const label =
      media.getAttribute("alt") || media.getAttribute("title") || source;
    const replacement = parsed.createElement("a");
    replacement.textContent = label;
    // Non-web URLs remain literal text; they cannot be fetched by another user.
    if (/^https?:\/\//i.test(source)) replacement.setAttribute("href", source);
    else
      replacement.textContent =
        label === source ? source : `${label} (${source})`;
    media.replaceWith(replacement);
  }
  return parsed.body.innerHTML;
}

function documentSafePastedBlocks(
  blocks: RoomDocumentPartialBlock[],
): RoomDocumentPartialBlock[] {
  return blocks.map((block) => ({
    ...(externalMediaFallback(block) ?? block),
    children: block.children
      ? documentSafePastedBlocks(block.children)
      : undefined,
  }));
}

function externalMediaFallback(
  block: RoomDocumentPartialBlock,
): RoomDocumentPartialBlock | undefined {
  if (
    block.type !== "image" &&
    block.type !== "video" &&
    block.type !== "audio" &&
    block.type !== "file"
  )
    return;
  const media = externalMediaSource(
    block.props?.url,
    block.props?.name,
    block.props?.caption,
  );
  if (!media) return;
  return {
    type: "paragraph",
    content: media.href
      ? [{ type: "link", href: media.href, content: media.text }]
      : media.text,
  };
}

function externalMediaSource(url?: string, name?: string, caption?: string) {
  if (!url || parseRoomDocumentAssetReference(url) !== undefined) return;
  const label = [name, caption].filter(Boolean).join(" — ") || url;
  return /^https?:\/\//i.test(url)
    ? { text: label, href: url }
    : { text: label === url ? url : `${label} (${url})` };
}

/** Repair restored media before the first sync can send its rejected state.
 * Replace only media content nodes, preserving containers, IDs, children,
 * comment marks, and the existing collaborative history. */
export function recoverRoomDocumentPastedMedia(document: Y.Doc): void {
  const fragment = document.getXmlFragment("prosemirror");
  document.transact(() => {
    for (const node of [...fragment.createTreeWalker(() => true)]) {
      if (
        !(node instanceof Y.XmlElement) ||
        !["image", "video", "audio", "file"].includes(node.nodeName)
      )
        continue;
      const media = externalMediaSource(
        node.getAttribute("url"),
        node.getAttribute("name"),
        node.getAttribute("caption"),
      );
      const parent = node.parent;
      if (!media || !(parent instanceof Y.XmlElement)) continue;
      const index = parent.toArray().indexOf(node);
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(
        0,
        media.text,
        media.href ? { link: { href: media.href } } : {},
      );
      paragraph.insert(0, [text]);
      parent.delete(index, 1);
      parent.insert(index, [paragraph]);
    }
  });
}

function selectsWholeDocument(editor: RoomDocumentEditor): boolean {
  const state = editor.prosemirrorState;
  if (!state || state.selection.empty) return false;
  const bounds = TextSelection.between(
    state.doc.resolve(0),
    state.doc.resolve(state.doc.content.size),
  );
  return state.selection.from <= bounds.from && state.selection.to >= bounds.to;
}

/**
 * Inserts the Blocks at the caret, replacing the current Block when it is
 * empty, and leaves the caret after the last one.
 */
function insertPastedBlocks(
  editor: RoomDocumentEditor,
  blocks: RoomDocumentPartialBlock[],
): void {
  if (selectsWholeDocument(editor)) {
    const inserted = editor.replaceBlocks(
      editor.document,
      blocks,
    ).insertedBlocks;
    const last = inserted.at(-1);
    if (last) editor.setTextCursorPosition(last, "end");
    return;
  }
  const current = editor.getTextCursorPosition().block;
  const inserted = roomDocumentBlocksAreEmpty([current])
    ? editor.replaceBlocks([current], blocks).insertedBlocks
    : editor.insertBlocks(blocks, current, "after");
  const last = inserted.at(-1);
  if (last) editor.setTextCursorPosition(last, "end");
}

/**
 * Keeps source copied out of a code editor as a code block.
 *
 * BlockNote recognises the VS Code clipboard but pastes its generated HTML
 * through the ProseMirror view, whose clipboard parser does not match the
 * BlockNote code block, so the source lands as plain text instead.
 *
 * @returns whether the paste was handled here.
 */
export function pasteRoomDocumentSourceCode(
  editor: RoomDocumentEditor,
  clipboardData: DataTransfer | null,
): boolean {
  if (!acceptsBlockPaste(editor, clipboardData)) return false;
  const mode = clipboardEditorMode(clipboardData);
  if (mode === undefined || MARKDOWN_EDITOR_MODES.has(mode)) return false;
  const text = clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
  // A single line reads as prose at the caret; only a real excerpt gets a block.
  if (!text.includes("\n")) return false;
  insertPastedBlocks(editor, [
    {
      content: text,
      props: { language: mode },
      type: "codeBlock",
    },
  ]);
  return true;
}

/**
 * Preserves rich content copied from a browser or document editor.
 *
 * Those clipboards commonly contain both HTML and a plain-text fallback. The
 * fallback is useful when HTML is unavailable, but it has already lost the
 * headings, lists, and inline marks the user copied. Parse the HTML first so
 * a formatted paste stays formatted in the document.
 */
export function pasteRoomDocumentRichHtml(
  editor: RoomDocumentEditor,
  clipboardData: DataTransfer | null,
): boolean {
  if (!acceptsRichHtmlPaste(editor, clipboardData)) return false;
  const rawHtml = clipboardData.getData("text/html").trim();
  if (
    !rawHtml ||
    !/<(?:h[1-6]|strong|b|em|i|u|s|del|mark|ul|ol|li|blockquote|pre|code|table|hr|a|img|video|audio)\b/i.test(
      rawHtml,
    )
  ) {
    return false;
  }

  const html = documentSafeClipboardHtml(rawHtml);

  const blocks = editor.tryParseHTMLToBlocks(html);
  if (blocks.length === 0) return false;
  if (
    !selectsWholeDocument(editor) &&
    (!editor.prosemirrorState.selection.empty ||
      !roomDocumentBlocksAreEmpty([editor.getTextCursorPosition().block]))
  ) {
    editor.pasteHTML(html);
    return true;
  }

  insertPastedBlocks(editor, documentSafePastedBlocks(blocks));
  return true;
}

export function looksLikeMarkdown(text: string): boolean {
  if (text.trim() === "") return false;
  return [...MARKDOWN_BLOCK_PATTERNS, ...MARKDOWN_INLINE_PATTERNS].some(
    (pattern) => pattern.test(text),
  );
}

/** Keep front matter out of Markdown's thematic-break and Setext parsers. */
function frontmatterBlocks(
  editor: RoomDocumentEditor,
  text: string,
): RoomDocumentPartialBlock[] | undefined {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() !== "");
  // Rich-text copies may escape the delimiter. Preserve that source too.
  if (!/^\\?---$/.test(lines[start]?.trim() ?? "")) return;
  const end = lines.findIndex(
    (line, index) => index > start && /^(?:\\?---|\.\.\.)$/.test(line.trim()),
  );
  if (end < 0 || !/^[\w-]+\s*:/.test(lines[start + 1]?.trim() ?? "")) return;
  return [
    {
      type: "codeBlock",
      props: { language: "yaml" },
      content: lines.slice(start, end + 1).join("\n"),
    },
    ...editor.tryParseMarkdownToBlocks(lines.slice(end + 1).join("\n")),
  ];
}

/**
 * Pastes Markdown source as real Blocks instead of literal text.
 *
 * BlockNote only reaches for Markdown when its own narrower heuristic matches,
 * and its Markdown paste flattens to inline content in the middle of a
 * document. This parses the clipboard text with `tryParseMarkdownToBlocks` and
 * inserts the Blocks directly, the way the BlockNote import guide describes.
 *
 * @returns whether the paste was handled here.
 */
export function pasteRoomDocumentMarkdown(
  editor: RoomDocumentEditor,
  clipboardData: DataTransfer | null,
): boolean {
  if (!acceptsBlockPaste(editor, clipboardData)) return false;
  if (!editorModeCarriesMarkdown(clipboardData)) return false;
  const text = clipboardData.getData("text/plain");
  const metadata = frontmatterBlocks(editor, text);
  if (!metadata && !looksLikeMarkdown(text)) return false;

  const blocks = metadata ?? editor.tryParseMarkdownToBlocks(text);
  if (blocks.length === 0) return false;
  // A lone paragraph carries no structure worth taking over the caret for.
  if (blocks.length === 1 && blocks[0]?.type === "paragraph") return false;

  insertPastedBlocks(editor, documentSafePastedBlocks(blocks));
  return true;
}
