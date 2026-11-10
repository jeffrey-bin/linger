import {
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  Cancel01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";

import {
  emptyDetail,
  SCOPES,
  type GlobalSearchTab,
  type GroupTab,
  type ResultSection,
  type SearchResult,
  type TargetContext,
} from "./global-search-model";
import {
  EmptyState,
  ResultRow,
  ScopeCard,
  ShortcutKey,
  SkeletonRows,
} from "./global-search-rows";

type Scope = (typeof SCOPES)[GroupTab];

/** The search field row with its scope chip, and the progress bar under it. */
export function GlobalSearchField({
  activeIndex,
  enterScope,
  inputRef,
  onClose,
  onInputKeyDown,
  onQueryChange,
  pending,
  query,
  rowCount,
  scope,
  tab,
}: {
  activeIndex: number;
  enterScope: (next: GlobalSearchTab) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onInputKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onQueryChange: (value: string) => void;
  pending: boolean;
  query: string;
  rowCount: number;
  scope: Scope | undefined;
  tab: GlobalSearchTab;
}) {
  const placeholder = scope
    ? scope.placeholder
    : "Search messages, docs, members and rooms";
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 pl-4 pr-3">
        <span
          aria-hidden
          className="global-search-lead relative size-4 shrink-0 text-app-subtle"
          data-loading={pending || undefined}
        >
          <Icon
            className="global-search-lead-idle"
            icon={Search01Icon}
            size={16}
          />
          <Spinner className="global-search-lead-busy" size={14} />
        </span>
        {scope && tab !== "all" ? (
          <span className="ml-1 inline-flex h-8 shrink-0 items-center gap-2 rounded-full bg-(--app-field-surface) pl-2.5 pr-1 text-xs font-medium text-foreground shadow-outline">
            <Icon className="text-app-subtle" icon={scope.icon} size={16} />
            {scope.label}
            <button
              aria-label={`Remove ${scope.label} scope`}
              className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
              onClick={() => enterScope("all")}
              type="button"
            >
              <Icon icon={Cancel01Icon} size={12} />
            </button>
          </span>
        ) : null}
        <input
          aria-activedescendant={
            rowCount > 0 ? `global-search-result-${activeIndex}` : undefined
          }
          aria-controls="global-search-results"
          aria-expanded={rowCount > 0}
          aria-label="Search messages, docs, people, agents and rooms"
          className="ml-1 h-full min-w-0 flex-1 bg-transparent text-sm text-app-ink outline-none placeholder:text-muted-foreground"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={placeholder}
          ref={inputRef}
          role="combobox"
          value={query}
        />
        <button
          className="h-7 shrink-0 rounded-full border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:border-foreground/15 hover:bg-accent hover:text-foreground"
          onClick={onClose}
          type="button"
        >
          Esc
        </button>
      </div>
      <div
        aria-hidden
        className="global-search-progress shrink-0"
        data-loading={pending || undefined}
      />
    </>
  );
}

/** The listbox: an error, an empty state, or the result sections. */
export function GlobalSearchResultList({
  activeIndex,
  debouncedQuery,
  debouncedRaw,
  enterScope,
  error,
  highlightShown,
  hoverRow,
  indicatorRef,
  inputRef,
  listRef,
  onListLeave,
  onListScroll,
  openResult,
  scope,
  sections,
  tab,
  targetContext,
}: {
  activeIndex: number;
  debouncedQuery: string;
  debouncedRaw: string;
  enterScope: (next: GlobalSearchTab) => void;
  error: Error | null;
  highlightShown: boolean;
  hoverRow: (index: number) => void;
  indicatorRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  onListLeave: () => void;
  onListScroll: () => void;
  openResult: (result: SearchResult) => Promise<void>;
  scope: Scope | undefined;
  sections: ResultSection[];
  tab: GlobalSearchTab;
  targetContext: TargetContext;
}) {
  let rowIndex = 0;
  return (
    <div
      onMouseLeave={onListLeave}
      className="grid h-[min(392px,calc(100dvh-160px))] min-h-0"
    >
      <div
        className="workspace-scrollbar relative min-h-0 overflow-y-auto p-2"
        id="global-search-results"
        onScroll={onListScroll}
        ref={listRef}
        role="listbox"
      >
        <div
          aria-hidden
          className="global-search-indicator"
          ref={indicatorRef}
        />
        {error ? (
          <EmptyState
            detail={error.message || "Search is unavailable."}
            title="Search failed"
            tone="danger"
          />
        ) : sections.length === 0 ? (
          <EmptyState
            action={
              tab !== "all" && debouncedQuery !== ""
                ? {
                    label: "Search everywhere",
                    onSelect: () => enterScope("all"),
                  }
                : undefined
            }
            detail={emptyDetail(tab, debouncedQuery)}
            title={
              debouncedQuery === ""
                ? `Search ${scope?.label.toLocaleLowerCase() ?? ""}`.trim()
                : `No results for “${debouncedRaw}”`
            }
          />
        ) : (
          sections.map((section) => (
            <section className="global-search-group" key={section.key}>
              <SectionHeader
                enterScope={enterScope}
                inputRef={inputRef}
                section={section}
              />
              {section.loading ? (
                <SkeletonRows />
              ) : section.layout === "scopes" ? (
                <div className="grid grid-cols-2 gap-2 px-3 pb-1 pt-1">
                  {section.items.map((result) => {
                    const index = rowIndex++;
                    return result.kind === "scope" ? (
                      <ScopeCard
                        active={index === activeIndex}
                        highlighted={highlightShown && index === activeIndex}
                        index={index}
                        key={result.id}
                        onActivate={() => hoverRow(index)}
                        onOpen={() => void openResult(result)}
                        tab={result.tab}
                      />
                    ) : null;
                  })}
                </div>
              ) : (
                section.items.map((result) => {
                  const index = rowIndex++;
                  return (
                    <ResultRow
                      active={index === activeIndex}
                      highlighted={highlightShown && index === activeIndex}
                      context={targetContext}
                      enterIndex={index}
                      index={index}
                      key={result.id}
                      onActivate={() => hoverRow(index)}
                      onOpen={() => void openResult(result)}
                      query={debouncedQuery}
                      result={result}
                    />
                  );
                })
              )}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

/** A section's label with its See all or Clear action. */
function SectionHeader({
  enterScope,
  inputRef,
  section,
}: {
  enterScope: (next: GlobalSearchTab) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  section: ResultSection;
}) {
  return (
    <div className="flex h-7 items-center px-3 text-xs text-app-subtle">
      {section.label}
      {section.seeAll ? (
        <button
          className="-mr-1.5 ml-auto inline-flex h-6 items-center gap-0.5 rounded-md px-1.5 text-xs text-app-subtle transition-colors hover:bg-app-hover hover:text-app-ink"
          onClick={() => enterScope(section.seeAll!)}
          type="button"
        >
          See all in {SCOPES[section.seeAll].label}
          <Icon icon={ArrowRight01Icon} size={14} />
        </button>
      ) : section.action ? (
        <button
          aria-label={`${section.action.label} ${section.label.toLocaleLowerCase()} searches`}
          className="-mr-1.5 ml-auto inline-flex h-6 items-center rounded-md px-1.5 text-xs text-app-subtle transition-colors hover:bg-app-hover hover:text-app-ink"
          onClick={() => {
            section.action!.onSelect();
            inputRef.current?.focus();
          }}
          type="button"
        >
          {section.action.label}
        </button>
      ) : null}
    </div>
  );
}

/** The open error, when a hit failed to open, and the keyboard legend. */
export function GlobalSearchFooter({
  openError,
}: {
  openError: string | null;
}) {
  return (
    <>
      {openError ? (
        <p
          className="border-t border-border/60 px-5 py-2 text-xs text-app-danger"
          role="alert"
        >
          {openError}
        </p>
      ) : null}
      <div className="flex h-10 shrink-0 items-center gap-4 border-t border-border/60 px-5 text-xs text-app-subtle">
        <span className="flex items-center gap-2">
          <span className="flex gap-0.5">
            <ShortcutKey>↑</ShortcutKey>
            <ShortcutKey>↓</ShortcutKey>
          </span>
          Navigate
        </span>
        <span className="flex items-center gap-2">
          <ShortcutKey>
            <Icon icon={ArrowTurnBackwardIcon} size={12} />
          </ShortcutKey>
          Open
        </span>
        <span className="flex items-center gap-2">
          <ShortcutKey>Tab</ShortcutKey>
          Search in type
        </span>
      </div>
    </>
  );
}
