import { BlockNoteEditor } from "@blocknote/core";
import type {
  Block,
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema,
  PartialBlock,
} from "@blocknote/core";
import { blocksToYXmlFragment, yDocToBlocks } from "@blocknote/core/yjs";
import * as Y from "yjs";

import {
  ROOM_DOCUMENT_MAX_REFERENCES,
  ROOM_DOCUMENT_MAX_SOURCE_BYTES,
  ROOM_DOCUMENT_MAX_STATE_BYTES,
  ROOM_DOCUMENT_SCHEMA_VERSION,
  ROOM_DOCUMENT_STATE_HASH_VERSION,
  RoomDocumentModelError,
  sha256Hex,
} from "./state-invariants.js";
import {
  inspectRoomDocumentState,
  parseRoomDocumentAssetReference,
} from "./document-state.js";

export * from "./comment-anchor.js";
export * from "./document-state.js";
export * from "./duplicate.js";
export { exportRoomDocumentRevision } from "./export.js";
export type {
  RoomDocumentExportFormat,
  RoomDocumentAssetManifestEntry,
  RoomDocumentRevisionExport,
} from "./export.js";
export * from "./history.js";
export { validateRoomDocumentSemanticBlocks } from "./semantic-blocks.js";
export type { RoomDocumentSemanticBlockSet } from "./semantic-blocks.js";
export * from "./semantic.js";
export {
  ROOM_DOCUMENT_MAX_BLOCKS,
  ROOM_DOCUMENT_MAX_BLOCK_DEPTH,
  ROOM_DOCUMENT_MAX_INLINE_SEGMENTS,
  ROOM_DOCUMENT_MAX_REFERENCES,
  ROOM_DOCUMENT_MAX_SOURCE_BYTES,
  ROOM_DOCUMENT_SCHEMA_VERSION,
  ROOM_DOCUMENT_MAX_STATE_BYTES,
  ROOM_DOCUMENT_MAX_TEXT_BYTES,
  ROOM_DOCUMENT_SESSION_LIMITS,
  ROOM_DOCUMENT_STATE_HASH_VERSION,
  RoomDocumentModelError,
} from "./state-invariants.js";

const blockNoteFragmentKey = "prosemirror";
const utf8 = new TextDecoder("utf-8", { fatal: true });
const externalMediaWarning =
  "External media was converted to text because Document Assets are not available during materialization";
const rawDataMediaPattern = /\bsrc\s*=\s*(?:"data:|'data:|data:)/iu;

type DefaultBlock = Block<
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema
>;
type DefaultPartialBlock = PartialBlock<
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema
>;

export type RoomDocumentSourceKind =
  | "blank"
  | "markdown"
  | "plain_text"
  | "sanitized_html";

export interface RoomDocumentComputedState {
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

export async function materializeRoomDocument(input: {
  materializationId: string;
  schemaVersion: number;
  sourceKind: RoomDocumentSourceKind;
  sourceBytes?: Uint8Array;
  allowedDocumentAssetIds?: string[];
}): Promise<RoomDocumentComputedState> {
  if (input.schemaVersion !== ROOM_DOCUMENT_SCHEMA_VERSION) {
    throw new RoomDocumentModelError(
      "unsupported_document",
      `Room Document schema version ${input.schemaVersion} is unsupported`,
    );
  }
  if (
    input.sourceBytes &&
    input.sourceBytes.byteLength > ROOM_DOCUMENT_MAX_SOURCE_BYTES
  ) {
    throw new RoomDocumentModelError(
      "payload_too_large",
      "Room Document source exceeds 32 MiB",
    );
  }

  const allowedDocumentAssetIds = validateAllowedDocumentAssetIDs(
    input.allowedDocumentAssetIds ?? [],
  );
  if (
    input.sourceKind !== "sanitized_html" &&
    allowedDocumentAssetIds.size > 0
  ) {
    throw new RoomDocumentModelError(
      "validation_failed",
      "Document Assets are only allowed for imported HTML",
    );
  }
  const { blocks, warnings } = sourceToBlocks({
    ...input,
    allowedDocumentAssetIds,
  });
  const document = new Y.Doc({ gc: true, guid: input.materializationId });
  document.clientID = materializationClientId(input.materializationId);
  const editor = BlockNoteEditor.create({ initialContent: blocks });
  try {
    blocksToYXmlFragment(
      editor,
      editor.document,
      document.getXmlFragment(blockNoteFragmentKey),
    );
  } finally {
    editor.unmount();
  }

  const stateBytes = Y.encodeStateAsUpdate(document);
  if (stateBytes.byteLength > ROOM_DOCUMENT_MAX_STATE_BYTES) {
    throw new RoomDocumentModelError(
      "payload_too_large",
      "Materialized Room Document state exceeds 32 MiB",
    );
  }
  const bytesSha256 = sha256Hex(stateBytes);
  const inspection = inspectRoomDocumentState(stateBytes);

  return {
    stateBytes,
    bytesSha256,
    stateVector: Y.encodeStateVector(document),
    stateHash: bytesSha256,
    stateHashVersion: ROOM_DOCUMENT_STATE_HASH_VERSION,
    completeReferences: inspection.completeReferences,
    warnings,
  };
}

export function readRoomDocumentBlocks(stateBytes: Uint8Array): DefaultBlock[] {
  const document = new Y.Doc({ gc: true });
  Y.applyUpdate(document, stateBytes);
  const editor = BlockNoteEditor.create();
  try {
    return yDocToBlocks(editor, document, blockNoteFragmentKey);
  } finally {
    editor.unmount();
  }
}

export function fingerprintRoomDocumentState(document: Y.Doc): string {
  return sha256Hex(Y.encodeStateAsUpdate(document));
}

function sourceToBlocks(input: {
  materializationId: string;
  sourceKind: RoomDocumentSourceKind;
  sourceBytes?: Uint8Array;
  allowedDocumentAssetIds: ReadonlySet<string>;
}): { blocks: DefaultPartialBlock[]; warnings: string[] } {
  if (input.sourceKind === "blank") {
    if (input.sourceBytes !== undefined) {
      throw new RoomDocumentModelError(
        "validation_failed",
        "Blank Room Document input must not contain source bytes",
      );
    }
    return {
      blocks: [
        stableBlock(
          { type: "paragraph", content: "" },
          input.materializationId,
          "0",
        ),
      ],
      warnings: [],
    };
  }
  if (input.sourceBytes === undefined) {
    throw new RoomDocumentModelError(
      "validation_failed",
      "Imported Room Document input requires source bytes",
    );
  }

  let source: string;
  try {
    source = utf8.decode(input.sourceBytes);
  } catch {
    throw new RoomDocumentModelError(
      "validation_failed",
      "Room Document source must be valid UTF-8",
    );
  }

  if (input.sourceKind === "plain_text") {
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    return {
      blocks: lines.map((line, index) =>
        stableBlock(
          { type: "paragraph", content: line },
          input.materializationId,
          String(index),
        ),
      ),
      warnings: [],
    };
  }

  if (
    input.sourceKind === "sanitized_html" &&
    rawDataMediaPattern.test(source)
  ) {
    throw new RoomDocumentModelError(
      "validation_failed",
      "Embedded media must be imported as a Document Asset before materialization",
    );
  }
  const parser = BlockNoteEditor.create();
  let parsed: DefaultBlock[];
  // BlockNote currently drops images inside HTML table cells. Move those images
  // immediately after their table so imports retain the media (and its Asset
  // reference) instead of silently losing it. Table text remains in place.
  const importSource =
    input.sourceKind === "sanitized_html" &&
    /<table\b/i.test(source) &&
    /<img\b/i.test(source)
      ? liftTableImages(source)
      : source;
  try {
    parsed =
      input.sourceKind === "markdown"
        ? parser.tryParseMarkdownToBlocks(source)
        : parser.tryParseHTMLToBlocks(importSource);
  } finally {
    parser.unmount();
  }
  const warnings: string[] = [];
  const blockIDs = { next: 0 };
  const blocks = parsed.map((block) =>
    normalizeImportedBlock(
      block,
      input.materializationId,
      blockIDs,
      warnings,
      input.allowedDocumentAssetIds,
    ),
  );
  return {
    blocks:
      blocks.length > 0
        ? blocks
        : [
            stableBlock(
              { type: "paragraph", content: "" },
              input.materializationId,
              "0",
            ),
          ],
    warnings: [...new Set(warnings)],
  };
}

function liftTableImages(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const table of doc.querySelectorAll("table")) {
    const images = [...table.querySelectorAll("img")];
    // Inserting after the same table reverses the sequence; walk backwards.
    for (const image of images.reverse()) {
      const paragraph = doc.createElement("p");
      paragraph.append(image);
      table.after(paragraph);
    }
  }
  return doc.body.innerHTML;
}

function normalizeImportedBlock(
  block: DefaultBlock,
  materializationId: string,
  blockIDs: { next: number },
  warnings: string[],
  allowedDocumentAssetIds: ReadonlySet<string>,
): DefaultPartialBlock {
  const blockID = String(blockIDs.next++);
  if (["file", "image", "video", "audio"].includes(block.type)) {
    const props = block.props as Record<string, unknown>;
    if (
      typeof props.url === "string" &&
      /^(?:data|document-image):/i.test(props.url.trim())
    ) {
      throw new RoomDocumentModelError(
        "validation_failed",
        "Embedded media must be imported as a Document Asset before materialization",
      );
    }
    const assetID = parseRoomDocumentAssetReference(props.url);
    if (assetID !== undefined) {
      if (!allowedDocumentAssetIds.has(assetID)) {
        throw new RoomDocumentModelError(
          "validation_failed",
          `Document Asset ${assetID} is not allowed for this materialization`,
        );
      }
      return stableBlock(
        {
          ...block,
          children: block.children.map((child) =>
            normalizeImportedBlock(
              child,
              materializationId,
              blockIDs,
              warnings,
              allowedDocumentAssetIds,
            ),
          ),
        },
        materializationId,
        blockID,
      );
    }
    if (typeof props.url === "string" && /^data:/i.test(props.url)) {
      throw new RoomDocumentModelError(
        "validation_failed",
        "Embedded media must be imported as a Document Asset before materialization",
      );
    }
    const label = [props.name, props.caption, props.url]
      .filter(
        (value): value is string => typeof value === "string" && value !== "",
      )
      .join(" - ");
    warnings.push(externalMediaWarning);
    return stableBlock(
      { type: "paragraph", content: label || block.type },
      materializationId,
      blockID,
    );
  }
  return stableBlock(
    {
      ...block,
      children: block.children.map((child) =>
        normalizeImportedBlock(
          child,
          materializationId,
          blockIDs,
          warnings,
          allowedDocumentAssetIds,
        ),
      ),
    },
    materializationId,
    blockID,
  );
}

function validateAllowedDocumentAssetIDs(values: string[]): Set<string> {
  if (values.length > ROOM_DOCUMENT_MAX_REFERENCES) {
    throw new RoomDocumentModelError(
      "validation_failed",
      "Allowed Document Asset IDs exceed their limit",
    );
  }
  const result = new Set<string>();
  for (const value of values) {
    if (
      parseRoomDocumentAssetReference(`document-asset:${value}`) ===
        undefined ||
      result.has(value)
    ) {
      throw new RoomDocumentModelError(
        "validation_failed",
        "Allowed Document Asset IDs must be unique and valid",
      );
    }
    result.add(value);
  }
  return result;
}

function stableBlock(
  block: DefaultPartialBlock,
  materializationId: string,
  blockIndex: string,
): DefaultPartialBlock {
  return {
    ...block,
    id: `block_${materializationId.replaceAll("-", "")}_${blockIndex}`,
  };
}

function materializationClientId(materializationId: string): number {
  const hex = materializationId.replaceAll("-", "");
  let clientId = 0;
  for (let offset = 0; offset < hex.length; offset += 8) {
    clientId ^= Number.parseInt(hex.slice(offset, offset + 8), 16) >>> 0;
  }
  return clientId === 0 ? 1 : clientId >>> 0;
}

export function fingerprintRoomDocumentDeletes(document: Y.Doc): string {
  return sha256Hex(
    Y.encodeStateAsUpdate(document, Y.encodeStateVector(document)),
  );
}
