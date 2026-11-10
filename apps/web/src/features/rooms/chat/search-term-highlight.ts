const HIGHLIGHT_NAME = "search-term";

type HighlightRegistry = Map<string, unknown>;
type HighlightConstructor = new (...ranges: Range[]) => unknown;

function highlightSupport(): {
  registry: HighlightRegistry;
  Highlight: HighlightConstructor;
} | null {
  const scope = globalThis as {
    CSS?: { highlights?: HighlightRegistry };
    Highlight?: HighlightConstructor;
  };
  if (!scope.CSS?.highlights || typeof scope.Highlight !== "function") {
    return null;
  }
  return { registry: scope.CSS.highlights, Highlight: scope.Highlight };
}

/**
 * Paints every case-insensitive occurrence of `term` inside `root` with the
 * CSS Custom Highlight API, styled like a text selection (see globals.css
 * `::highlight(search-term)`). It never mutates the DOM, so React rerenders
 * stay safe; browsers without the API simply show no highlight. Returns the
 * cleanup that removes the highlight.
 */
export function applySearchTermHighlight(root: Element, term: string) {
  const support = highlightSupport();
  const needle = term.trim();
  if (!support || !needle) return () => {};
  const ranges: Range[] = [];
  const pattern = new RegExp(
    needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (const match of text.matchAll(pattern)) {
      const range = root.ownerDocument.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      ranges.push(range);
    }
  }
  if (ranges.length === 0) return () => {};
  support.registry.set(HIGHLIGHT_NAME, new support.Highlight(...ranges));
  return () => {
    support.registry.delete(HIGHLIGHT_NAME);
  };
}
