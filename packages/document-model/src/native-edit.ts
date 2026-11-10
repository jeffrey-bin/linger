import { BlockNoteEditor } from "@blocknote/core";
import * as Y from "yjs";
import type {
  RoomDocumentSemanticBlock,
  RoomDocumentSemanticOperation,
} from "./semantic.js";
import { createRoomDocumentAssetReference } from "./document-state.js";
import { RoomDocumentModelError, sha256Hex } from "./state-invariants.js";

export interface NativeDocumentEdit {
  kind: "edit_document";
  parser_version: "markdown-v1";
  command:
    | "append"
    | "str_replace"
    | "block_insert_before"
    | "block_insert_after"
    | "block_replace"
    | "block_delete"
    | "set_title"
    | "image_insert_after"
    | "image_replace"
    | "file_insert_after";
  content?: string;
  /** Image and file commands: an available Asset of this Document, pinned at admission. */
  asset_id?: string;
  caption?: string;
  /** File command: the file name the block shows. */
  name?: string;
  pattern?: string;
  block_id?: string;
  start_block_id?: string;
  end_block_id?: string;
  title?: string;
}
interface Conflict {
  status: "conflicted";
  reason:
    | "missing_block"
    | "noncontiguous_blocks"
    | "text_not_found"
    | "ambiguous_text"
    | "invalid_structure";
}
const invalid = () =>
  new RoomDocumentModelError(
    "validation_failed",
    "Invalid Native Document edit action.",
  );
const id = (value: unknown) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value) &&
  value !== "0";
export function validateNativeDocumentEdit(edit: NativeDocumentEdit): void {
  const fields: Record<string, readonly string[]> = {
    append: ["content"],
    str_replace: ["content", "pattern", "block_id"],
    block_insert_before: ["content", "block_id"],
    block_insert_after: ["content", "block_id"],
    block_replace: ["content", "block_id", "start_block_id", "end_block_id"],
    block_delete: ["block_id", "start_block_id", "end_block_id"],
    set_title: ["title"],
    image_insert_after: ["block_id", "asset_id", "caption"],
    image_replace: ["block_id", "asset_id", "caption"],
    file_insert_after: ["block_id", "asset_id", "name"],
  };
  const allowed = fields[edit.command];
  if (
    !allowed ||
    edit.parser_version !== "markdown-v1" ||
    Object.keys(edit).some(
      (key) => !["kind", "parser_version", "command", ...allowed].includes(key),
    )
  )
    throw invalid();
  for (const key of ["block_id", "start_block_id", "end_block_id"] as const)
    if (edit[key] !== undefined && !id(edit[key])) throw invalid();
  if (
    [
      "append",
      "str_replace",
      "block_insert_before",
      "block_insert_after",
      "block_replace",
    ].includes(edit.command) &&
    typeof edit.content !== "string"
  )
    throw invalid();
  if (
    edit.command === "str_replace" &&
    (!edit.pattern ||
      /[\r\n]/u.test(edit.pattern) ||
      /[\r\n]/u.test(edit.content!))
  )
    throw invalid();
  if (
    edit.command === "set_title" &&
    (typeof edit.title !== "string" ||
      edit.title.length < 1 ||
      edit.title.length > 255)
  )
    throw invalid();
  if (
    ["block_insert_before", "block_insert_after"].includes(edit.command) &&
    !edit.block_id
  )
    throw invalid();
  if (
    ["image_insert_after", "image_replace"].includes(edit.command) &&
    (!edit.block_id ||
      !id(edit.asset_id) ||
      (edit.caption !== undefined &&
        (typeof edit.caption !== "string" ||
          edit.caption.length > 1000 ||
          /[\r\n]/u.test(edit.caption))))
  )
    throw invalid();
  if (
    edit.command === "file_insert_after" &&
    (!edit.block_id ||
      !id(edit.asset_id) ||
      (edit.name !== undefined &&
        (typeof edit.name !== "string" ||
          edit.name.length < 1 ||
          edit.name.length > 255 ||
          /[\r\n]/u.test(edit.name))))
  )
    throw invalid();
  if (
    ["block_replace", "block_delete"].includes(edit.command) &&
    (edit.block_id
      ? edit.start_block_id !== undefined || edit.end_block_id !== undefined
      : !edit.start_block_id || !edit.end_block_id)
  )
    throw invalid();
}
export function nativeDocumentBlockEdit(
  blocks: RoomDocumentSemanticBlock[],
  edit: NativeDocumentEdit,
  mutationId: string,
): RoomDocumentSemanticOperation | Conflict {
  validateNativeDocumentEdit(edit);
  if (edit.command === "set_title")
    return { kind: "set_title", title: edit.title! };
  let targetIds: string[] = [];
  if (edit.block_id) targetIds = [edit.block_id];
  else if (edit.start_block_id) {
    const start = locate(blocks, edit.start_block_id);
    const end = locate(blocks, edit.end_block_id!);
    if (!start || !end)
      return { status: "conflicted", reason: "missing_block" };
    if (start.siblings !== end.siblings || end.index < start.index)
      return { status: "conflicted", reason: "noncontiguous_blocks" };
    targetIds = start.siblings
      .slice(start.index, end.index + 1)
      .map((block) => block.id!);
  }
  if (edit.command === "block_delete")
    return { kind: "delete_blocks", stableBlockIds: targetIds };
  if (edit.command === "image_insert_after" || edit.command === "image_replace")
    return nativeImageEdit(blocks, edit, mutationId);
  if (edit.command === "file_insert_after")
    return nativeFileEdit(blocks, edit, mutationId);
  if (edit.command === "str_replace") throw invalid();
  if (!edit.content?.trim()) throw invalid();
  const editor = BlockNoteEditor.create();
  let parsed: RoomDocumentSemanticBlock[];
  try {
    parsed = editor.tryParseMarkdownToBlocks(edit.content);
  } finally {
    editor.unmount();
  }
  if (!parsed.length) throw invalid();
  let count = 0;
  const assign = (items: RoomDocumentSemanticBlock[]) => {
    for (const block of items) {
      if (++count > 2048) throw invalid();
      // No media import in this text-only action. Existing assets remain in the untouched blocks.
      if (["image", "video", "audio", "file"].includes(block.type ?? ""))
        throw invalid();
      block.id = `block_${sha256Hex(new TextEncoder().encode(`${mutationId}:${count}`)).slice(0, 48)}`;
      if (block.children) assign(block.children);
    }
  };
  assign(parsed);
  let operation: RoomDocumentSemanticOperation;
  if (edit.command === "append")
    operation = { kind: "append_blocks", blocks: parsed };
  else if (edit.command === "block_replace")
    operation = {
      kind: "replace_blocks",
      stableBlockIds: targetIds,
      blocks: parsed,
    };
  else
    operation = {
      kind: "insert_blocks",
      position: edit.command === "block_insert_before" ? "before" : "after",
      stableBlockId: edit.block_id!,
      blocks: parsed,
    };
  if (new TextEncoder().encode(JSON.stringify(operation)).byteLength > 262144)
    throw invalid();
  return operation;
}
/** Image commands place one Asset image; text commands never import media. */
function nativeImageEdit(
  blocks: RoomDocumentSemanticBlock[],
  edit: NativeDocumentEdit,
  mutationId: string,
): RoomDocumentSemanticOperation | Conflict {
  const target = locate(blocks, edit.block_id!);
  if (!target) return { status: "conflicted", reason: "missing_block" };
  const current = target.siblings[target.index]!;
  if (edit.command === "image_replace" && current.type !== "image")
    return { status: "conflicted", reason: "invalid_structure" };
  const previous =
    edit.command === "image_replace"
      ? (current.props as { caption?: string; previewWidth?: number })
      : {};
  const caption = edit.caption ?? previous.caption;
  const image: RoomDocumentSemanticBlock = {
    id: `block_${sha256Hex(new TextEncoder().encode(`${mutationId}:image`)).slice(0, 48)}`,
    type: "image",
    props: {
      url: createRoomDocumentAssetReference(edit.asset_id!),
      ...(caption ? { caption } : {}),
      ...(previous.previewWidth ? { previewWidth: previous.previewWidth } : {}),
    },
  };
  return edit.command === "image_replace"
    ? {
        kind: "replace_blocks",
        stableBlockIds: [edit.block_id!],
        blocks: [image],
      }
    : {
        kind: "insert_blocks",
        position: "after",
        stableBlockId: edit.block_id!,
        blocks: [image],
      };
}
/** The file command places one Asset as a file block after a block. */
function nativeFileEdit(
  blocks: RoomDocumentSemanticBlock[],
  edit: NativeDocumentEdit,
  mutationId: string,
): RoomDocumentSemanticOperation | Conflict {
  if (!locate(blocks, edit.block_id!))
    return { status: "conflicted", reason: "missing_block" };
  return {
    kind: "insert_blocks",
    position: "after",
    stableBlockId: edit.block_id!,
    blocks: [
      {
        id: `block_${sha256Hex(new TextEncoder().encode(`${mutationId}:file`)).slice(0, 48)}`,
        type: "file",
        props: {
          url: createRoomDocumentAssetReference(edit.asset_id!),
          ...(edit.name ? { name: edit.name } : {}),
        },
      },
    ],
  };
}
function locate(
  siblings: RoomDocumentSemanticBlock[],
  target: string,
): { siblings: RoomDocumentSemanticBlock[]; index: number } | undefined {
  for (const [index, block] of siblings.entries()) {
    if (block.id === target) return { siblings, index };
    const nested = locate(block.children ?? [], target);
    if (nested) return nested;
  }
  return undefined;
}
export function nativeDocumentTextEdit(
  document: Y.Doc,
  edit: NativeDocumentEdit,
): Conflict | undefined {
  validateNativeDocumentEdit(edit);
  const matches: {
    node: Y.XmlText;
    offset: number;
    attributes: Record<string, unknown>;
  }[] = [];
  const pending = document
    .getXmlFragment("prosemirror")
    .toArray()
    .map((node) => ({ node, selected: edit.block_id === undefined }));
  let blockFound = edit.block_id === undefined;
  while (pending.length) {
    const { node, selected } = pending.shift()!;
    if (node instanceof Y.XmlElement) {
      const ownBlock = node.getAttribute("id") === edit.block_id;
      blockFound ||= ownBlock;
      // A block target includes its own inline text, not text from nested child blocks.
      const nextSelected =
        node.nodeName === "blockContainer"
          ? ownBlock || edit.block_id === undefined
          : selected;
      pending.push(
        ...node
          .toArray()
          .map((child) => ({ node: child, selected: nextSelected })),
      );
    } else if (node instanceof Y.XmlText && selected) {
      const deltas = node.toDelta() as {
        insert: unknown;
        attributes?: Record<string, unknown>;
      }[];
      if (deltas.some((delta) => typeof delta.insert !== "string")) continue;
      const text = deltas.map((delta) => delta.insert as string).join("");
      let start = 0;
      for (;;) {
        const offset = text.indexOf(edit.pattern!, start);
        if (offset < 0) break;
        let cursor = 0;
        let attributes: Record<string, unknown> = {};
        for (const delta of deltas) {
          const end = cursor + (delta.insert as string).length;
          if (cursor <= offset && end > offset)
            attributes = { ...(delta.attributes ?? {}) };
          if (
            end > offset &&
            cursor < offset + edit.pattern!.length &&
            Object.keys(delta.attributes ?? {}).some((key) =>
              /^comment(?:--|$)/u.test(key),
            )
          )
            return { status: "conflicted", reason: "invalid_structure" };
          cursor = end;
        }
        matches.push({ node, offset, attributes });
        start = offset + 1;
      }
    }
  }
  if (!blockFound) return { status: "conflicted", reason: "missing_block" };
  if (!matches.length)
    return { status: "conflicted", reason: "text_not_found" };
  if (matches.length !== 1)
    return { status: "conflicted", reason: "ambiguous_text" };
  const match = matches[0]!;
  document.transact(() => {
    match.node.delete(match.offset, edit.pattern!.length);
    match.node.insert(match.offset, edit.content!, match.attributes);
  });
  return undefined;
}
