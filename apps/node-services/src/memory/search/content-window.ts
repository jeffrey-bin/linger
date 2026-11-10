import { tokenizeSearchText } from "../../bm25.js";

/**
 * The paragraphs of a long chunk from its best query match on, after the Room
 * message heading (time and speaker) that encloses the match. Without a match
 * the chunk start is kept, as before.
 */
export function contentWindow(
  content: string,
  terms: ReadonlySet<string>,
  maxChars: number,
): string {
  if (content.length <= maxChars) return content;
  const paragraphs = [...content.matchAll(/[^\n]+(?:\n(?!\n)[^\n]*)*/gu)].map(
    (match) => ({ text: match[0], start: match.index }),
  );
  const hits = paragraphs.map(
    ({ text }) =>
      new Set(tokenizeSearchText(text).filter((term) => terms.has(term))).size,
  );
  const best = hits.indexOf(Math.max(0, ...hits));
  if (best < 0 || hits[best] === 0) return `${content.slice(0, maxChars - 1)}…`;
  let heading = -1;
  for (let index = best; index >= 0; index -= 1)
    if (paragraphs[index]!.text.startsWith("## ")) {
      heading = index;
      break;
    }
  const parts: string[] = [];
  if (heading >= 0 && heading < best - 1)
    parts.push(paragraphs[heading]!.text, "…");
  let index = heading >= 0 && heading >= best - 1 ? heading : best;
  let length = parts.join("\n\n").length;
  while (index < paragraphs.length && length < maxChars) {
    parts.push(paragraphs[index]!.text);
    length += paragraphs[index]!.text.length + 2;
    index += 1;
  }
  let window = parts.join("\n\n");
  if (window.length > maxChars) window = `${window.slice(0, maxChars - 1)}…`;
  else if (index < paragraphs.length) window += "\n\n…";
  return (heading >= 0 ? paragraphs[heading]! : paragraphs[best]!).start > 0
    ? `…\n\n${window}`
    : window;
}
