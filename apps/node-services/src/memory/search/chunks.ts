import { createHash } from "node:crypto";
import { tokenizeSearchText } from "../../bm25.js";

const MAX_CHUNK_CHARS = 3_000;
const MAX_CHUNK_TOKENS = 500;
const TARGET_CHUNK_TOKENS = 300;
const OVERSIZED_BLOCK_OVERLAP_CHARS = 200;

export interface SourceChunk {
  id: string;
  heading: string;
  headingPath: string[];
  content: string;
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
}

interface SourceBlock {
  end: number;
  headingPath: string[];
  start: number;
}

/**
 * Deterministic Markdown-aware chunks. Ordinary heading/paragraph boundaries do
 * not overlap. Only a single oversized block is split with a small overlap.
 * Character offsets always refer to the unchanged source text.
 */
export function chunkSource(content: string): SourceChunk[] {
  if (!content) return [];
  const digest = createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 16);
  const blocks = sourceBlocks(content);
  const lineStarts = sourceLineStarts(content);
  const ranges: SourceBlock[] = [];
  let pending: SourceBlock | undefined;
  let pendingTokens = 0;

  const flush = () => {
    if (pending && content.slice(pending.start, pending.end).trim()) {
      ranges.push(pending);
    }
    pending = undefined;
    pendingTokens = 0;
  };

  for (const block of blocks) {
    const text = content.slice(block.start, block.end);
    const tokens = tokenizeSearchText(text).length;
    if (tokens > MAX_CHUNK_TOKENS || text.length > MAX_CHUNK_CHARS) {
      flush();
      ranges.push(...splitOversizedBlock(content, block));
      continue;
    }
    const conversationContinuation =
      pending &&
      isConversationHeading(pending.headingPath) &&
      isConversationHeading(block.headingPath);
    const changedSection =
      pending &&
      !sameHeadingPath(pending.headingPath, block.headingPath) &&
      !conversationContinuation;
    const reachedConversationTarget =
      conversationContinuation && pendingTokens >= TARGET_CHUNK_TOKENS;
    const wouldOverflow =
      pending &&
      (pendingTokens + tokens > MAX_CHUNK_TOKENS ||
        block.end - pending.start > MAX_CHUNK_CHARS);
    if (changedSection || reachedConversationTarget || wouldOverflow) flush();
    pending = pending ? { ...pending, end: block.end } : { ...block };
    pendingTokens += tokens;
    if (!text.trim() && pendingTokens >= TARGET_CHUNK_TOKENS) flush();
  }
  flush();

  return ranges.map((range) => {
    const headingPath = range.headingPath.length
      ? range.headingPath
      : ["Source text"];
    return {
      id: `chunk-${digest}-${range.start}`,
      heading: headingPath.at(-1)!,
      headingPath,
      content: content.slice(range.start, range.end),
      start: range.start,
      end: range.end,
      lineStart: lineAt(lineStarts, range.start),
      lineEnd: lineAt(lineStarts, Math.max(range.start, range.end - 1)),
    };
  });
}

function sourceBlocks(content: string): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  const headings: string[] = [];
  let fence: string | undefined;
  let blockStart = 0;
  let offset = 0;

  const push = (end: number) => {
    if (end > blockStart) {
      blocks.push({
        start: blockStart,
        end,
        headingPath: headings.filter(Boolean),
      });
    }
    blockStart = end;
  };

  for (const line of content.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    const heading = !fence
      ? /^\s{0,3}(#{1,6})\s+(.+?)\s*$/u.exec(line)
      : undefined;
    if (heading) {
      push(offset);
      const level = heading[1]!.length;
      headings.splice(level - 1);
      headings[level - 1] = heading[2]!;
    }
    offset += line.length;
    if (!line.trim()) push(offset);
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = undefined;
    }
  }
  push(content.length);
  return blocks;
}

function splitOversizedBlock(
  content: string,
  block: SourceBlock,
): SourceBlock[] {
  const ranges: SourceBlock[] = [];
  let start = block.start;
  while (start < block.end) {
    let end = Math.min(block.end, start + MAX_CHUNK_CHARS);
    if (
      end < block.end &&
      content.charCodeAt(end - 1) >= 0xd800 &&
      content.charCodeAt(end - 1) <= 0xdbff
    ) {
      end -= 1;
    }
    ranges.push({ start, end, headingPath: block.headingPath });
    if (end === block.end) break;
    start = Math.max(start + 1, end - OVERSIZED_BLOCK_OVERLAP_CHARS);
    if (
      content.charCodeAt(start) >= 0xdc00 &&
      content.charCodeAt(start) <= 0xdfff
    ) {
      start += 1;
    }
  }
  return ranges;
}

function sameHeadingPath(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isConversationHeading(headingPath: readonly string[]): boolean {
  return /^\d{4}-\d{2}-\d{2}T[^\n]+ · /u.test(headingPath.at(-1) ?? "");
}

function sourceLineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}
