import { Fragment, type ReactNode } from "react";

/** Wrap every case-insensitive occurrence of the query in <mark>. */
export function HighlightedText({
  query,
  text,
}: {
  query: string;
  text: string;
}): ReactNode {
  if (!query) return text;
  const lower = text.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = lower.indexOf(query);
  while (index >= 0) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark
        className="rounded-sm bg-(--app-comment-highlight)/25 px-px text-foreground"
        key={`${index}-${parts.length}`}
      >
        {text.slice(index, index + query.length)}
      </mark>,
    );
    cursor = index + query.length;
    index = lower.indexOf(query, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.map((part, position) => (
    <Fragment key={position}>{part}</Fragment>
  ));
}
