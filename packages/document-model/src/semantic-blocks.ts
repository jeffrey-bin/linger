import { BlockNoteEditor } from "@blocknote/core";
import type {
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema,
  PartialBlock,
} from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { isRecord } from "@linger/service-kit";

import { inspectRoomDocumentState } from "./document-state.js";
import {
  ROOM_DOCUMENT_SCHEMA_VERSION,
  RoomDocumentModelError,
  sha256Hex,
} from "./state-invariants.js";

const blockIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface RoomDocumentSemanticBlockSet {
  schemaVersion: typeof ROOM_DOCUMENT_SCHEMA_VERSION;
  blocks: PartialBlock<
    DefaultBlockSchema,
    DefaultInlineContentSchema,
    DefaultStyleSchema
  >[];
  blocksSha256: string;
  completeReferences: {
    documentAssetIds: string[];
    documentThreadIds: string[];
  };
}

export function validateRoomDocumentSemanticBlocks(input: {
  schemaVersion: number;
  blocks: unknown[];
}): RoomDocumentSemanticBlockSet {
  if (input.schemaVersion !== ROOM_DOCUMENT_SCHEMA_VERSION) {
    throw new RoomDocumentModelError(
      "unsupported_document",
      `Room Document schema version ${input.schemaVersion} is unsupported`,
    );
  }
  rejectCommentMarks(input.blocks);
  validateBlockIds(input.blocks);
  const blocks = structuredClone(
    input.blocks,
  ) as RoomDocumentSemanticBlockSet["blocks"];
  const completeReferences = inspectBlocks(blocks);
  return {
    schemaVersion: ROOM_DOCUMENT_SCHEMA_VERSION,
    blocks,
    blocksSha256: sha256Hex(
      new TextEncoder().encode(
        canonicalJSON({
          blocks: input.blocks,
          schemaVersion: input.schemaVersion,
        }),
      ),
    ),
    completeReferences,
  };
}

function inspectBlocks(
  blocks: RoomDocumentSemanticBlockSet["blocks"],
): RoomDocumentSemanticBlockSet["completeReferences"] {
  if (blocks.length === 0) {
    return { documentAssetIds: [], documentThreadIds: [] };
  }
  const document = new Y.Doc({ gc: true });
  let editor:
    | BlockNoteEditor<
        DefaultBlockSchema,
        DefaultInlineContentSchema,
        DefaultStyleSchema
      >
    | undefined;
  try {
    editor = BlockNoteEditor.create({ initialContent: blocks });
    if (!preservesRoomDocumentSemanticFields(blocks, editor.document))
      throw invalidBlocks(
        "Semantic mutation Blocks contain unsupported fields or formatting that cannot be preserved",
      );
    blocksToYXmlFragment(
      editor,
      editor.document,
      document.getXmlFragment("prosemirror"),
    );
    return inspectRoomDocumentState(Y.encodeStateAsUpdate(document))
      .completeReferences;
  } catch (error) {
    if (error instanceof RoomDocumentModelError) throw error;
    throw invalidBlocks(
      "Semantic mutation Blocks do not match the BlockNote schema",
    );
  } finally {
    editor?.unmount();
    document.destroy();
  }
}

function validateBlockIds(blocks: unknown[]): void {
  const seen = new Set<string>();
  const pending = [...blocks];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!isRecord(value))
      throw invalidBlocks("Semantic mutation Blocks are invalid");
    if (
      typeof value.id !== "string" ||
      value.id.length > 128 ||
      !blockIdPattern.test(value.id) ||
      seen.has(value.id)
    ) {
      throw invalidBlocks(
        "Semantic mutation Block IDs must be present, valid, and unique",
      );
    }
    seen.add(value.id);
    if (value.children !== undefined) {
      if (!Array.isArray(value.children)) {
        throw invalidBlocks("Semantic mutation Block children are invalid");
      }
      pending.push(...value.children);
    }
  }
}

function rejectCommentMarks(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectCommentMarks(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^comment(?:--|$)/.test(key)) {
      throw invalidBlocks(
        "Semantic mutation Blocks cannot contain Comment marks",
      );
    }
    rejectCommentMarks(child);
  }
}

// Defaults may be added, but no caller-supplied data may be silently discarded.
export function preservesRoomDocumentSemanticFields(
  input: unknown,
  output: unknown,
): boolean {
  if (typeof input === "string" && Array.isArray(output))
    return (
      canonicalJSON(output) ===
      canonicalJSON(
        input === "" ? [] : [{ type: "text", text: input, styles: {} }],
      )
    );
  if (Array.isArray(input))
    return (
      Array.isArray(output) &&
      input.length === output.length &&
      input.every((v, i) => preservesRoomDocumentSemanticFields(v, output[i]))
    );
  if (input && typeof input === "object")
    return (
      !!output &&
      typeof output === "object" &&
      Object.entries(input).every(([k, v]) =>
        preservesRoomDocumentSemanticFields(
          v,
          (output as Record<string, unknown>)[k],
        ),
      )
    );
  return input === output;
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function invalidBlocks(message: string): RoomDocumentModelError {
  return new RoomDocumentModelError("validation_failed", message);
}
