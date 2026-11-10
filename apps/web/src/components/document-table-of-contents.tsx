import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import type { RefObject } from "react";

import { Button } from "./ui/button";
import type { DocumentHeading } from "./document-headings";

export function DocumentTableOfContents({
  contentRef,
  headings,
  id,
  onClose,
}: {
  contentRef: RefObject<HTMLElement | null>;
  headings: DocumentHeading[];
  id?: string;
  onClose: () => void;
}) {
  const baseLevel = Math.min(...headings.map((heading) => heading.level), 6);
  return (
    <aside
      className="absolute inset-y-0 right-0 z-30 w-[min(300px,calc(100vw-24px))] border-l border-app-border bg-app-surface shadow-xl sm:relative sm:z-auto sm:shrink-0 sm:shadow-none"
      id={id}
    >
      <header className="flex h-12 items-center justify-between border-b border-app-border/60 px-3">
        <h3 className="text-sm font-semibold">Table of contents</h3>
        <Button
          aria-label="Close table of contents"
          onClick={onClose}
          size="icon"
          tone="ghost"
        >
          <Icon icon={Cancel01Icon} />
        </Button>
      </header>
      <nav
        aria-label="Document table of contents"
        className="workspace-scrollbar h-[calc(100%-48px)] overflow-y-auto p-2"
      >
        {headings.length === 0 ? (
          <p className="px-2 py-6 text-sm text-app-muted">No headings</p>
        ) : (
          headings.map((heading) => (
            <button
              className="block h-8 w-full truncate rounded-lg px-2 text-left text-sm text-app-body transition-colors duration-300 hover:bg-muted/70 hover:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              key={heading.id}
              onClick={() =>
                contentRef.current
                  ?.querySelector(`[data-id="${CSS.escape(heading.id)}"]`)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              style={{
                paddingLeft: `${8 + (heading.level - baseLevel) * 12}px`,
              }}
              type="button"
            >
              {heading.text}
            </button>
          ))
        )}
      </nav>
    </aside>
  );
}
