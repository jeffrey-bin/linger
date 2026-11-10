import * as Y from "yjs";

import { inspectRoomDocumentState } from "./document-state.js";
import {
  ROOM_DOCUMENT_MAX_STATE_BYTES,
  ROOM_DOCUMENT_STATE_HASH_VERSION,
  RoomDocumentModelError,
  sha256Hex,
} from "./state-invariants.js";

const blockNoteFragmentKey = "prosemirror";
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface RoomDocumentCommentAnchorAttachment {
  update: Uint8Array;
  updateSha256: string;
  stateBytes: Uint8Array;
  stateBytesSha256: string;
  endStateVector: Uint8Array;
  stateHash: string;
  stateHashVersion: typeof ROOM_DOCUMENT_STATE_HASH_VERSION;
  completeReferences: {
    documentAssetIds: string[];
    documentThreadIds: string[];
  };
}

export function attachRoomDocumentCommentAnchor(input: {
  attachmentOperationId: string;
  threadId: string;
  stateBytes: Uint8Array;
  quotedText: string;
  blockId: string;
  contextBefore: string;
  contextAfter: string;
}): RoomDocumentCommentAnchorAttachment {
  validateInput(input);
  const initialInspection = inspectRoomDocumentState(input.stateBytes);
  if (
    initialInspection.completeReferences.documentThreadIds.includes(
      input.threadId,
    )
  ) {
    throw invalidAttachment("Comment thread is already attached");
  }
  const document = new Y.Doc({ gc: true });
  Y.applyUpdate(document, input.stateBytes);
  const baseVector = Y.encodeStateVector(document);
  const initialContent = contentProjection(document);
  const blocks = collectBlocks(document);
  const targetBlocks = blocks.filter((block) => block.id === input.blockId);
  if (targetBlocks.length !== 1) {
    throw invalidAttachment("Comment anchor Block was not found");
  }
  const target = targetBlocks[0]!;
  const quoteOccurrences = stringOccurrences(target.text, input.quotedText);
  if (quoteOccurrences.length === 0) {
    throw invalidAttachment("Comment anchor quote was not found");
  }
  const documentText = blocks.map((block) => block.text).join("\n");
  const targetDocumentOffset = blocks
    .slice(0, blocks.indexOf(target))
    .reduce((total, block) => total + block.text.length + 1, 0);
  const candidates = quoteOccurrences.filter((offset) => {
    const start = targetDocumentOffset + offset;
    const end = start + input.quotedText.length;
    return (
      documentText.slice(0, start).endsWith(input.contextBefore) &&
      documentText.slice(end).startsWith(input.contextAfter)
    );
  });
  if (candidates.length === 0) {
    throw invalidAttachment("Comment anchor context is stale");
  }
  if (candidates.length > 1) {
    throw invalidAttachment("Comment anchor quote is ambiguous");
  }
  const ranges = textRanges(
    target.textNodes,
    candidates[0]!,
    input.quotedText.length,
  );
  if (ranges.length === 0) {
    throw invalidAttachment("Comment anchor quote was not found");
  }
  const markName = deterministicCommentMarkName(document, input.threadId);
  document.clientID = stableClientID(input.attachmentOperationId);
  document.transact(() => {
    for (const range of ranges) {
      range.text.format(range.offset, range.length, {
        [markName]: { orphan: false, threadId: input.threadId },
      });
    }
  }, input.attachmentOperationId);

  const stateBytes = Y.encodeStateAsUpdate(document);
  if (stateBytes.byteLength > ROOM_DOCUMENT_MAX_STATE_BYTES) {
    throw new RoomDocumentModelError(
      "payload_too_large",
      "Comment anchor attachment exceeds 32 MiB",
    );
  }
  const inspection = inspectRoomDocumentState(stateBytes);
  if (
    JSON.stringify(contentProjection(document)) !==
    JSON.stringify(initialContent)
  ) {
    throw invalidAttachment(
      "Comment anchor attachment changed Document content",
    );
  }
  if (
    !sameStrings(
      inspection.completeReferences.documentAssetIds,
      initialInspection.completeReferences.documentAssetIds,
    )
  ) {
    throw invalidAttachment(
      "Comment anchor attachment changed Document Assets",
    );
  }
  if (
    !sameStrings(
      inspection.completeReferences.documentThreadIds,
      [
        ...initialInspection.completeReferences.documentThreadIds,
        input.threadId,
      ].sort(),
    )
  ) {
    throw invalidAttachment(
      "Comment anchor attachment changed Comment references",
    );
  }
  const update = Y.encodeStateAsUpdate(document, baseVector);
  const stateHash = sha256Hex(stateBytes);
  return {
    update,
    updateSha256: sha256Hex(update),
    stateBytes,
    stateBytesSha256: stateHash,
    endStateVector: Y.encodeStateVector(document),
    stateHash,
    stateHashVersion: ROOM_DOCUMENT_STATE_HASH_VERSION,
    completeReferences: inspection.completeReferences,
  };
}

interface DocumentBlock {
  id: string;
  text: string;
  textNodes: Y.XmlText[];
}

function collectBlocks(document: Y.Doc): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const visit = (node: Y.XmlElement | Y.XmlFragment): void => {
    if (node instanceof Y.XmlElement && node.nodeName === "blockContainer") {
      const id = node.getAttribute("id") ?? "";
      const textNodes = ownTextNodes(node);
      blocks.push({
        id,
        text: textNodes.map((text) => text.toString()).join(""),
        textNodes,
      });
    }
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement) visit(child);
    }
  };
  visit(document.getXmlFragment(blockNoteFragmentKey));
  return blocks;
}

function ownTextNodes(container: Y.XmlElement): Y.XmlText[] {
  const result: Y.XmlText[] = [];
  const pending = [...container.toArray()];
  while (pending.length > 0) {
    const node = pending.shift();
    if (node instanceof Y.XmlText) {
      result.push(node);
    } else if (
      node instanceof Y.XmlElement &&
      node.nodeName !== "blockContainer"
    ) {
      pending.unshift(...node.toArray());
    }
  }
  return result;
}

function contentProjection(document: Y.Doc): unknown {
  const project = (node: unknown): unknown => {
    if (node instanceof Y.XmlText) {
      const projected = node
        .toDelta()
        .map(
          (delta: { insert: string; attributes?: Record<string, unknown> }) => {
            const attributes = Object.fromEntries(
              Object.entries(delta.attributes ?? {}).filter(
                ([name]) => !/^comment(?:--[A-Za-z0-9+/=]{8})?$/.test(name),
              ),
            );
            return {
              insert: delta.insert,
              ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
            };
          },
        );
      const merged: Array<{
        insert: string;
        attributes?: Record<string, unknown>;
      }> = [];
      for (const delta of projected) {
        const previous = merged.at(-1);
        if (
          previous !== undefined &&
          JSON.stringify(previous.attributes ?? {}) ===
            JSON.stringify(delta.attributes ?? {})
        ) {
          previous.insert += delta.insert;
        } else {
          merged.push(delta);
        }
      }
      return merged;
    }
    if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
      return {
        ...(node instanceof Y.XmlElement
          ? { attributes: node.getAttributes(), name: node.nodeName }
          : { name: "fragment" }),
        children: node.toArray().map((child) => project(child)),
      };
    }
    return { unsupported: typeof node };
  };
  return project(document.getXmlFragment(blockNoteFragmentKey));
}

function stringOccurrences(value: string, target: string): number[] {
  const result: number[] = [];
  let offset = value.indexOf(target);
  while (offset >= 0) {
    result.push(offset);
    offset = value.indexOf(target, offset + 1);
  }
  return result;
}

function textRanges(
  textNodes: Y.XmlText[],
  start: number,
  length: number,
): Array<{ text: Y.XmlText; offset: number; length: number }> {
  const result: Array<{ text: Y.XmlText; offset: number; length: number }> = [];
  let position = 0;
  let remaining = length;
  for (const text of textNodes) {
    const end = position + text.length;
    if (remaining > 0 && start < end && start + length > position) {
      const offset = Math.max(start - position, 0);
      const selected = Math.min(text.length - offset, remaining);
      if (selected > 0) {
        result.push({ text, offset, length: selected });
        remaining -= selected;
      }
    }
    position = end;
  }
  return remaining === 0 ? result : [];
}

function deterministicCommentMarkName(
  document: Y.Doc,
  threadId: string,
): string {
  const used = new Set<string>();
  for (const block of collectBlocks(document)) {
    for (const text of block.textNodes) {
      for (const delta of text.toDelta()) {
        for (const name of Object.keys(delta.attributes ?? {})) used.add(name);
      }
    }
  }
  const name = `comment--${commentMarkHash(threadId)}`;
  if (used.has(name)) {
    throw invalidAttachment("Comment anchor mark identity is unavailable");
  }
  return name;
}

function commentMarkHash(threadId: string): string {
  const encoded: number[] = [];
  writeObjectStart(encoded, 2);
  writeString(encoded, "type");
  writeAnyString(encoded, "comment");
  writeString(encoded, "attrs");
  writeObjectStart(encoded, 2);
  writeString(encoded, "orphan");
  encoded.push(121); // lib0 writeAny(false)
  writeString(encoded, "threadId");
  writeAnyString(encoded, threadId);
  const hex = sha256Hex(Uint8Array.from(encoded));
  const digest = Uint8Array.from(hex.match(/../g) ?? [], (value) =>
    Number.parseInt(value, 16),
  );
  for (let index = 6; index < digest.length; index += 1) {
    digest[index % 6] = digest[index % 6]! ^ digest[index]!;
  }
  return base64SixBytes(digest.subarray(0, 6));
}

function writeObjectStart(output: number[], size: number): void {
  output.push(118); // lib0 writeAny(object)
  writeVarUint(output, size);
}

function writeAnyString(output: number[], value: string): void {
  output.push(119); // lib0 writeAny(string)
  writeString(output, value);
}

function writeString(output: number[], value: string): void {
  const bytes = new TextEncoder().encode(value);
  writeVarUint(output, bytes.length);
  output.push(...bytes);
}

function writeVarUint(output: number[], input: number): void {
  let value = input;
  while (value > 0x7f) {
    output.push(0x80 | (value & 0x7f));
    value >>>= 7;
  }
  output.push(value & 0x7f);
}

function base64SixBytes(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < 6; index += 3) {
    const value =
      (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    result += alphabet[(value >>> 18) & 63];
    result += alphabet[(value >>> 12) & 63];
    result += alphabet[(value >>> 6) & 63];
    result += alphabet[value & 63];
  }
  return result;
}

function stableClientID(operationId: string): number {
  const value = Number.parseInt(
    sha256Hex(new TextEncoder().encode(operationId)).slice(0, 8),
    16,
  );
  return value === 0 ? 1 : value;
}

function validateInput(input: {
  attachmentOperationId: string;
  threadId: string;
  stateBytes: Uint8Array;
  quotedText: string;
  blockId: string;
  contextBefore: string;
  contextAfter: string;
}): void {
  if (
    !validIdentifier(input.attachmentOperationId, 64) ||
    !validIdentifier(input.threadId, 64) ||
    !validIdentifier(input.blockId, 64) ||
    input.quotedText.trim() === "" ||
    Array.from(input.quotedText).length > 10_000 ||
    Array.from(input.contextBefore).length > 2_000 ||
    Array.from(input.contextAfter).length > 2_000
  ) {
    throw invalidAttachment("Comment anchor attachment input is invalid");
  }
}

function validIdentifier(value: string, maximum: number): boolean {
  return (
    value.length >= 1 &&
    value.length <= maximum &&
    identifierPattern.test(value)
  );
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function invalidAttachment(message: string): RoomDocumentModelError {
  return new RoomDocumentModelError("validation_failed", message);
}
