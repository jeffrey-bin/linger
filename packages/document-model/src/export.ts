import {
  BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
} from "@blocknote/core";
import type {
  Block,
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema,
} from "@blocknote/core";
import { yDocToBlocks } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { isRecord } from "@linger/service-kit";

import {
  inspectRoomDocumentState,
  parseRoomDocumentAssetReference,
} from "./document-state.js";
import {
  ROOM_DOCUMENT_MAX_STATE_BYTES,
  ROOM_DOCUMENT_SCHEMA_VERSION,
  ROOM_DOCUMENT_STATE_HASH_VERSION,
  RoomDocumentModelError,
  sha256Hex,
} from "./state-invariants.js";

type DefaultBlock = Block<
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema
>;

export type RoomDocumentExportFormat =
  | "markdown"
  | "plain_text"
  | "html"
  | "blocks";

export interface RoomDocumentAssetManifestEntry {
  id: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  title?: string;
}

interface ExportableRoomDocumentState {
  stateBytes: Uint8Array;
  bytesSha256: string;
  stateVector: Uint8Array;
  stateHash: string;
  stateHashVersion: typeof ROOM_DOCUMENT_STATE_HASH_VERSION;
  completeReferences: {
    documentAssetIds: string[];
    documentThreadIds: string[];
  };
  warnings: string[];
}

export interface RoomDocumentRevisionExport {
  mediaType: "text/markdown" | "text/plain" | "text/html" | "application/json";
  bytes: Uint8Array;
  sizeBytes: number;
  sha256: string;
  completeReferences: ExportableRoomDocumentState["completeReferences"];
  warnings: string[];
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const commentMarkPattern = /^comment(?:--[A-Za-z0-9+/=]{8})?$/;
const encoder = new TextEncoder();

export async function exportRoomDocumentRevision(input: {
  revisionId: string;
  schemaVersion: number;
  state: ExportableRoomDocumentState;
  assetManifest: RoomDocumentAssetManifestEntry[];
  format: RoomDocumentExportFormat;
}): Promise<RoomDocumentRevisionExport> {
  validateExportInput(input);
  const inspection = inspectRoomDocumentState(input.state.stateBytes);
  if (
    !sameStrings(
      inspection.completeReferences.documentAssetIds,
      input.state.completeReferences.documentAssetIds,
    ) ||
    !sameStrings(
      inspection.completeReferences.documentThreadIds,
      input.state.completeReferences.documentThreadIds,
    ) ||
    !sameStrings(
      input.assetManifest.map((entry) => entry.id),
      inspection.completeReferences.documentAssetIds,
    )
  ) {
    throw invalidExport("Room Document export references are inconsistent");
  }

  const document = new Y.Doc({ gc: true });
  document.getXmlFragment("prosemirror");
  Y.applyUpdate(document, input.state.stateBytes);
  if (
    !bytesEqual(Y.encodeStateVector(document), input.state.stateVector) ||
    input.state.bytesSha256 !== input.state.stateHash
  ) {
    throw invalidExport(
      "Room Document export state fingerprint is inconsistent",
    );
  }

  const blocks = readExportBlocks(input.state.stateBytes);
  const exported = exportBlocks(blocks, input.format, input.assetManifest);
  const content = exported.content;
  const bytes = encoder.encode(content);
  if (bytes.byteLength > ROOM_DOCUMENT_MAX_STATE_BYTES) {
    throw new RoomDocumentModelError(
      "payload_too_large",
      "Room Document export exceeds 32 MiB",
    );
  }
  return {
    mediaType: mediaTypeFor(input.format),
    bytes,
    sizeBytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
    completeReferences: {
      documentAssetIds: [...inspection.completeReferences.documentAssetIds],
      documentThreadIds: [...inspection.completeReferences.documentThreadIds],
    },
    warnings: exported.warnings,
  };
}

function validateExportInput(input: {
  revisionId: string;
  schemaVersion: number;
  state: ExportableRoomDocumentState;
  assetManifest: RoomDocumentAssetManifestEntry[];
  format: RoomDocumentExportFormat;
}): void {
  if (
    input.schemaVersion !== ROOM_DOCUMENT_SCHEMA_VERSION ||
    !validId(input.revisionId) ||
    !["markdown", "plain_text", "html", "blocks"].includes(input.format) ||
    input.state.stateHashVersion !== ROOM_DOCUMENT_STATE_HASH_VERSION ||
    input.state.stateBytes.byteLength > ROOM_DOCUMENT_MAX_STATE_BYTES ||
    !sha256Pattern.test(input.state.bytesSha256) ||
    !sha256Pattern.test(input.state.stateHash) ||
    input.state.bytesSha256 !== sha256Hex(input.state.stateBytes) ||
    input.assetManifest.length > 4096 ||
    !validManifest(input.assetManifest)
  ) {
    throw invalidExport("Room Document export input is invalid");
  }
}

function validManifest(entries: RoomDocumentAssetManifestEntry[]): boolean {
  const seen = new Set<string>();
  return entries.every((entry) => {
    if (
      !validId(entry.id) ||
      seen.has(entry.id) ||
      entry.mediaType.length < 1 ||
      entry.mediaType.length > 255 ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      !sha256Pattern.test(entry.sha256) ||
      (entry.title !== undefined && entry.title.length > 1024)
    ) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
}

function exportBlocks(
  blocks: DefaultBlock[],
  format: RoomDocumentExportFormat,
  assetManifest: RoomDocumentAssetManifestEntry[],
): { content: string; warnings: string[] } {
  if (format === "blocks")
    return {
      content: JSON.stringify({ schema_version: 1, blocks }, null, 2) + "\n",
      warnings: [],
    };
  if (format === "plain_text") {
    return { content: plainTextBlocks(blocks).join("\n"), warnings: [] };
  }
  const destroyRenderers: (() => void)[] = [];
  // Full HTML serialization renders detached block views, but BlockNote does
  // not call their destroy hooks. Give this export its own implementations so
  // the views release window listeners without mutating the shared schema.
  const blockSpecs = Object.fromEntries(
    Object.entries(defaultBlockSpecs).map(([name, spec]) => [
      name,
      {
        ...spec,
        implementation: {
          ...spec.implementation,
          render(...args: Parameters<typeof spec.implementation.render>) {
            const rendered = Reflect.apply(
              spec.implementation.render,
              this,
              args,
            ) as ReturnType<typeof spec.implementation.render>;
            if (rendered.destroy)
              destroyRenderers.push(() => rendered.destroy!());
            return rendered;
          },
        },
      },
    ]),
  ) as typeof defaultBlockSpecs;
  const editor = BlockNoteEditor.create({
    initialContent: blocks,
    schema: BlockNoteSchema.create({ blockSpecs }),
  });
  try {
    if (format === "markdown") {
      return exportMarkdown(editor, blocks, assetManifest);
    }
    return {
      content: editor.blocksToFullHTML(editor.document),
      warnings: [],
    };
  } finally {
    for (const destroy of destroyRenderers.reverse()) destroy();
    editor.unmount();
  }
}

function exportMarkdown(
  editor: BlockNoteEditor,
  blocks: DefaultBlock[],
  assetManifest: RoomDocumentAssetManifestEntry[],
): { content: string; warnings: string[] } {
  const assets = new Map(assetManifest.map((entry) => [entry.id, entry]));
  const parts = blocks.map((block) => markdownBlock(editor, block, assets));
  const content = normalizeMarkdown(parts.join("\n\n"));
  for (const assetId of assets.keys()) {
    if (!content.includes(`document-asset:${assetId}`)) {
      throw invalidExport(
        `Markdown export would lose Document Asset reference ${assetId}`,
      );
    }
  }
  return { content, warnings: markdownVisualWarnings(blocks) };
}

function markdownBlock(
  editor: BlockNoteEditor,
  block: DefaultBlock,
  assets: Map<string, RoomDocumentAssetManifestEntry>,
): string {
  if (block.type === "toggleListItem") {
    const hasVisibleTitle = blockPlainText(block).trim() !== "";
    const summary = hasVisibleTitle
      ? normalizeMarkdown(
          editor
            .blocksToMarkdownLossy([{ ...block, children: [] }])
            .replace(/^\s*[-*+]\s+/, ""),
        )
      : "";
    const details = normalizeMarkdown(
      block.children
        .map((child) => markdownBlock(editor, child, assets))
        .join("\n\n"),
    );
    if (hasVisibleTitle && summary === "") {
      return [
        "<details>",
        `<summary>${escapeHTML(escapeMarkdownText(blockPlainText(block)))}</summary>`,
        ...(details === "" ? [] : ["", details]),
        "",
        "</details>",
      ].join("\n");
    }
    return [
      "<details>",
      `<summary>${escapeHTML(summary || "Details")}</summary>`,
      ...(details === "" ? [] : ["", details]),
      "",
      "</details>",
    ].join("\n");
  }
  if (["image", "file", "video", "audio"].includes(block.type)) {
    return [
      markdownMediaBlock(block, assets),
      ...block.children.map((child) => markdownBlock(editor, child, assets)),
    ]
      .filter((part) => part !== "")
      .join("\n\n");
  }
  const markdown = normalizeMarkdown(editor.blocksToMarkdownLossy([block]));
  if (blockPlainText(block).trim() !== "" && markdown === "") {
    return escapeMarkdownText(blockPlainText(block));
  }
  return markdown;
}

function markdownMediaBlock(
  block: DefaultBlock,
  assets: Map<string, RoomDocumentAssetManifestEntry>,
): string {
  const props = block.props as Record<string, unknown>;
  const assetId = parseRoomDocumentAssetReference(props.url);
  if (assetId === undefined) {
    const visibleLabel = mediaLabel(props, undefined);
    if (visibleLabel !== "") {
      throw invalidExport(
        `Markdown export would lose visible ${block.type} content`,
      );
    }
    return "";
  }
  const asset = assets.get(assetId);
  if (asset === undefined) {
    throw invalidExport(
      `Document Asset ${assetId} is missing from the manifest`,
    );
  }
  const label = escapeMarkdownLabel(mediaLabel(props, asset) || assetId);
  const reference = `document-asset:${assetId}`;
  if (block.type === "image") {
    return `![${label}](${reference})`;
  }
  return `[${label} (${escapeMarkdownLabel(asset.mediaType)})](${reference})`;
}

function mediaLabel(
  props: Record<string, unknown>,
  asset: RoomDocumentAssetManifestEntry | undefined,
): string {
  return (
    [props.caption, props.name, asset?.title].find(
      (value): value is string => typeof value === "string" && value !== "",
    ) ?? ""
  );
}

function markdownVisualWarnings(blocks: DefaultBlock[]): string[] {
  const warnings = new Set<string>();
  const pending = [...blocks];
  while (pending.length > 0) {
    const block = pending.shift()!;
    const props = block.props as Record<string, unknown>;
    for (const [name, defaultValue] of [
      ["backgroundColor", "default"],
      ["textColor", "default"],
      ["textAlignment", "left"],
    ] as const) {
      if (props[name] !== undefined && props[name] !== defaultValue) {
        warnings.add(`markdown_visual_style_downgraded:${block.id}:${name}`);
      }
    }
    addInlineVisualWarnings(block.id, block.content, warnings);
    pending.unshift(...block.children);
  }
  const ordered = [...warnings];
  if (ordered.length <= 256) {
    return ordered;
  }
  return [
    ...ordered.slice(0, 255),
    "markdown_visual_style_downgraded:truncated",
  ];
}

function addInlineVisualWarnings(
  blockId: string,
  value: unknown,
  warnings: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      addInlineVisualWarnings(blockId, entry, warnings);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (isRecord(value.styles)) {
    for (const [name, defaultValue] of [
      ["underline", false],
      ["textColor", "default"],
      ["backgroundColor", "default"],
    ] as const) {
      if (
        value.styles[name] !== undefined &&
        value.styles[name] !== defaultValue
      ) {
        warnings.add(
          `markdown_visual_style_downgraded:${blockId}:inline.${name}`,
        );
      }
    }
  }
  for (const [name, nested] of Object.entries(value)) {
    if (name !== "styles") {
      addInlineVisualWarnings(blockId, nested, warnings);
    }
  }
}

function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_[\]<>#]/gu, "\\$&");
}

function escapeHTML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function readExportBlocks(stateBytes: Uint8Array): DefaultBlock[] {
  const document = new Y.Doc({ gc: true });
  Y.applyUpdate(document, stateBytes);
  removeCommentAnnotations(document.getXmlFragment("prosemirror"));
  const editor = BlockNoteEditor.create();
  try {
    return yDocToBlocks(editor, document, "prosemirror");
  } finally {
    editor.unmount();
  }
}

function removeCommentAnnotations(parent: Y.XmlFragment | Y.XmlElement): void {
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlElement) {
      removeCommentAnnotations(child);
      continue;
    }
    if (!(child instanceof Y.XmlText)) continue;
    let offset = 0;
    for (const delta of child.toDelta()) {
      if (typeof delta.insert !== "string") continue;
      const commentKeys = Object.keys(delta.attributes ?? {}).filter((key) =>
        commentMarkPattern.test(key),
      );
      if (commentKeys.length > 0) {
        child.format(
          offset,
          delta.insert.length,
          Object.fromEntries(commentKeys.map((key) => [key, null])),
        );
      }
      offset += delta.insert.length;
    }
  }
}

function plainTextBlocks(blocks: DefaultBlock[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    lines.push(blockPlainText(block));
    lines.push(...plainTextBlocks(block.children));
  }
  return lines;
}

function blockPlainText(block: DefaultBlock): string {
  if (Array.isArray(block.content)) {
    return block.content.map(inlinePlainText).join("");
  }
  if (block.content !== undefined) {
    return block.content.rows
      .map((row) =>
        row.cells
          .map((cell) =>
            (Array.isArray(cell) ? cell : cell.content)
              .map(inlinePlainText)
              .join(""),
          )
          .join("\t"),
      )
      .join("\n");
  }
  const props = block.props as Record<string, unknown>;
  const label = [props.name, props.caption].find(
    (value): value is string => typeof value === "string" && value !== "",
  );
  if (label !== undefined) {
    return label;
  }
  const assetId = parseRoomDocumentAssetReference(props.url);
  return assetId === undefined ? "" : `document-asset:${assetId}`;
}

function inlinePlainText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (Array.isArray(record.content)) {
    return record.content.map(inlinePlainText).join("");
  }
  return "";
}

function mediaTypeFor(
  format: RoomDocumentExportFormat,
): RoomDocumentRevisionExport["mediaType"] {
  switch (format) {
    case "markdown":
      return "text/markdown";
    case "plain_text":
      return "text/plain";
    case "html":
      return "text/html";
    case "blocks":
      return "application/json";
  }
}

function validId(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && idPattern.test(value);
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function invalidExport(message: string): RoomDocumentModelError {
  return new RoomDocumentModelError("validation_failed", message);
}
