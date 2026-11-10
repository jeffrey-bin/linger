import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { useLocation } from "react-router";

import { extractRenderedDocumentHeadings } from "./document-headings";

const unavailableSectionMessage =
  "This section is unavailable in the current document.";

export function scrollToDocumentAnchor(root: HTMLElement | null, hash: string) {
  if (!root || !hash.startsWith("#")) return false;
  let target: string;
  try {
    target = decodeURIComponent(hash.slice(1));
  } catch {
    return false;
  }
  if (!target) {
    root.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  }
  const used = new Set<string>();
  for (const heading of extractRenderedDocumentHeadings(root)) {
    const base = heading.text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, "")
      .replace(/\s/gu, "-");
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug);
    const block = root.querySelector<HTMLElement>(
      `[data-id="${CSS.escape(heading.id)}"]`,
    );
    const explicit = block?.matches("h1,h2,h3,h4,h5,h6")
      ? block.id
      : block?.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6")?.id;
    if (target === slug || target === heading.id || target === explicit) {
      block?.scrollIntoView({ behavior: "smooth", block: "start" });
      return Boolean(block);
    }
  }
  return false;
}

export function useDocumentAnchorLinks(
  rootRef: RefObject<HTMLElement | null>,
  identity: string | undefined,
) {
  const { hash, key } = useLocation();
  const pendingObserver = useRef<MutationObserver | null>(null);
  const [failure, setFailure] = useState<{
    identity: string;
    message: string;
  } | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!identity || !hash || !root) return;
    const update = () => {
      if (
        !root.querySelector(
          '.bn-editor, [data-content-renderer="blocknote"], [data-knowledge-scope]',
        )
      )
        return;
      const found = scrollToDocumentAnchor(root, hash);
      setFailure((previous) =>
        found
          ? null
          : previous?.identity === identity
            ? previous
            : { identity, message: unavailableSectionMessage },
      );
      if (found) observer.disconnect();
    };
    const observer = new MutationObserver(update);
    pendingObserver.current = observer;
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    update();
    return () => {
      observer.disconnect();
      if (pendingObserver.current === observer) pendingObserver.current = null;
    };
  }, [hash, identity, key, rootRef]);

  function openAnchor(event: SyntheticEvent) {
    const anchor =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    const reference = anchor?.getAttribute("href")?.trim();
    if (
      !identity ||
      !reference?.startsWith("#") ||
      !rootRef.current?.contains(anchor)
    )
      return false;
    event.preventDefault();
    event.stopPropagation();
    pendingObserver.current?.disconnect();
    setFailure(
      scrollToDocumentAnchor(rootRef.current, reference)
        ? null
        : { identity, message: unavailableSectionMessage },
    );
    return true;
  }
  return {
    error: failure?.identity === identity ? failure?.message : undefined,
    openAnchor,
  };
}
