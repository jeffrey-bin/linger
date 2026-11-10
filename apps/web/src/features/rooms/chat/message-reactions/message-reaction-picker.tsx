import {
  Apple01Icon,
  BulbIcon,
  Car01Icon,
  ChampionIcon,
  FavouriteIcon,
  Flag01Icon,
  PawPrintIcon,
  Search01Icon,
  SmileIcon,
  StarIcon,
} from "@hugeicons/core-free-icons";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { Icon, type IconSvgElement } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import type { TeamHubMessageReactionId } from "@/features/teamhub/teamhub-types";

import {
  type ReactionCatalogEntry,
  searchReactionCatalog,
  useReactionCatalog,
} from "./reaction-catalog";
import {
  animateTransform,
  animationsEnabled,
  EASE_OUT,
} from "./reaction-motion";

const COLUMNS = 8;
const PANEL_WIDTH = 352;
/** Quick row: this many Reactions not yet on the Message, plus Search. */
const QUICK_COUNT = 6;
const QUICK_SLOT = 36;
const QUICK_WIDTH = (QUICK_COUNT + 1) * QUICK_SLOT + 12;
/** Gaps between the Add reaction button and the panel opening above it. */
const QUICK_GAP = 4;
const PANEL_GAP = 14;
/** Quick row stagger: emoji pop in left to right, fold away right to left. */
const ENTER_STAGGER = 45;
const EXIT_STAGGER = 28;
const VIEWPORT_MARGIN = 8;

const SECTION_ICONS: Readonly<Record<string, IconSvgElement>> = {
  recommended: StarIcon,
  people: SmileIcon,
  nature: PawPrintIcon,
  foods: Apple01Icon,
  activity: ChampionIcon,
  places: Car01Icon,
  objects: BulbIcon,
  symbols: FavouriteIcon,
  flags: Flag01Icon,
};

interface Section {
  id: string;
  label: string;
  entries: readonly ReactionCatalogEntry[];
}

/**
 * Reaction picker above the Add reaction button. It opens as a quick row of
 * six Reactions not yet on the Message, defaults first: the bar unfolds and
 * the emoji pop in one by one. Search grows it into search, category tabs, a
 * Recommended row and the full emoji grid. Closing plays the entrance back. Arrow keys move through visible
 * emoji, Enter picks, and Esc or an outside press closes and returns focus.
 */
export function MessageReactionPicker({
  anchor,
  isSelected,
  onClose,
  onSelect,
  reacted,
}: {
  anchor: HTMLElement;
  /** Own Reactions, ringed in the full grid. */
  isSelected: (id: TeamHubMessageReactionId) => boolean;
  /** Reactions already on the Message, left out of the quick row. */
  reacted: ReadonlySet<string>;
  onClose: () => void;
  onSelect: (id: TeamHubMessageReactionId) => void;
}) {
  const catalog = useReactionCatalog();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({
    left: VIEWPORT_MARGIN,
    top: VIEWPORT_MARGIN,
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const expandFromRef = useRef<DOMRect | null>(null);
  const closingRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const sections = useMemo<Section[]>(() => {
    if (!catalog) return [];
    if (query.trim()) {
      return [
        {
          id: "search",
          label: "Search results",
          entries: searchReactionCatalog(catalog, query),
        },
      ];
    }
    return [
      { id: "recommended", label: "Recommended", entries: catalog.recommended },
      ...catalog.categories,
    ];
  }, [catalog, query]);
  const visible = useMemo(
    () => sections.flatMap((section) => section.entries),
    [sections],
  );
  const active = visible[Math.min(activeIndex, visible.length - 1)];

  // Frozen at open, so a pick does not reshuffle the row as it folds away.
  const [openedWith] = useState(reacted);
  const quick = useMemo(() => {
    if (!catalog) return [];
    const seen = new Set<string>();
    return [
      ...catalog.recommended,
      ...catalog.categories.flatMap((category) => category.entries),
    ]
      .filter((entry) => {
        if (seen.has(entry.id) || openedWith.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      })
      .slice(0, QUICK_COUNT);
  }, [catalog, openedWith]);
  const width = expanded ? PANEL_WIDTH : QUICK_WIDTH;

  // Above the Add reaction button, left aligned with it.
  useLayoutEffect(() => {
    const button =
      anchor.querySelector<HTMLElement>('button[aria-label="Add reaction"]') ??
      anchor;
    const buttonRect = button.getBoundingClientRect();
    // offsetHeight ignores the entrance scale.
    const height = panelRef.current?.offsetHeight ?? 0;
    setPosition({
      left: Math.max(
        VIEWPORT_MARGIN,
        Math.min(
          buttonRect.left,
          window.innerWidth - width - VIEWPORT_MARGIN * 2,
        ),
      ),
      top: Math.max(
        VIEWPORT_MARGIN,
        buttonRect.top - height - (expanded ? PANEL_GAP : QUICK_GAP),
      ),
    });
  }, [anchor, catalog, expanded, width]);

  // The bar fades in while its emoji pop in one by one.
  const quickReady = Boolean(catalog);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!quickReady || !panel || !animationsEnabled(panel)) return;
    const entrance = [...panel.querySelectorAll("button")].map(
      (button, index) =>
        animateTransform(button, ["scale(0)", "scale(1)"], [0, 1], {
          delay: index * ENTER_STAGGER,
          duration: 320,
          easing: "spring",
          fadeDuration: 150,
        }),
    );
    return () => entrance.forEach((animation) => animation.cancel());
  }, [quickReady]);

  // Runs once the expanded panel has its final position.
  useLayoutEffect(() => {
    const from = expandFromRef.current;
    const panel = panelRef.current;
    if (!from || !panel) return;
    expandFromRef.current = null;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const to = panel.getBoundingClientRect();
    const animation = panel.animate?.(
      [
        {
          transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
        },
        {
          transform: "none",
        },
      ],
      { duration: 200, easing: EASE_OUT },
    );
    return () => animation?.cancel();
  }, [position]);

  useEffect(() => {
    if (expanded) searchRef.current?.focus({ preventScroll: true });
    else
      panelRef.current
        ?.querySelector<HTMLElement>("button")
        ?.focus({ preventScroll: true });
  }, [expanded, catalog]);

  useEffect(() => {
    document
      .getElementById(`${listId}-${activeIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !anchor.contains(target))
        dismiss(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  });

  /** Plays the entrance backwards, then unmounts the picker. */
  function dismiss(restoreFocus: boolean) {
    if (closingRef.current) return;
    closingRef.current = true;
    const finish = () => {
      onClose();
      if (restoreFocus)
        anchor
          .querySelector<HTMLElement>("button")
          ?.focus({ preventScroll: true });
    };
    const panel = panelRef.current;
    if (!panel || !animationsEnabled(panel)) {
      finish();
      return;
    }
    panel.style.pointerEvents = "none";
    if (expanded) {
      void animateTransform(panel, ["none", "scale(0.9)"], [1, 0], {
        duration: 200,
        easing: "out",
        fadeDuration: 180,
      }).finished.then(finish);
      return;
    }
    const buttons = [...panel.querySelectorAll("button")];
    const last = buttons.length - 1;
    buttons.forEach((button, index) => {
      animateTransform(button, ["scale(1)", "scale(0)"], [1, 0], {
        delay: (last - index) * EXIT_STAGGER,
        duration: 220,
        easing: "out",
        fadeDuration: 160,
      });
    });
    void animateTransform(panel, ["scaleX(1)", "scaleX(0)"], [1, 0], {
      delay: last * EXIT_STAGGER,
      duration: 300,
      easing: "out",
      fadeDuration: 200,
    }).finished.then(finish);
  }

  function close() {
    dismiss(true);
  }

  function pick(entry: ReactionCatalogEntry) {
    if (closingRef.current) return;
    onSelect(entry.id);
    dismiss(false);
  }

  function jumpTo(sectionId: string) {
    setQuery("");
    gridRef.current
      ?.querySelector(`[data-section="${sectionId}"]`)
      ?.scrollIntoView?.({ block: "start" });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const moves: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: COLUMNS,
      ArrowUp: -COLUMNS,
    };
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active) pick(active);
    } else if (event.key in moves && visible.length) {
      event.preventDefault();
      setActiveIndex((current) =>
        Math.min(visible.length - 1, Math.max(0, current + moves[event.key]!)),
      );
    }
  }

  const sectionStarts = sections.reduce<number[]>(
    (starts, section, index) => [
      ...starts,
      index === 0
        ? 0
        : starts[index - 1]! + sections[index - 1]!.entries.length,
    ],
    [],
  );

  if (!expanded) {
    return createPortal(
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape closes this dialog; its controls are keyboard-accessible buttons
      <div
        ref={panelRef}
        aria-label="Add reaction"
        className="app-floating-enter fixed z-[110] flex origin-left items-center rounded-lg bg-popover p-1.5 shadow-lg"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
        role="dialog"
        style={{ ...position, width }}
      >
        {catalog ? (
          <>
            {quick.map((entry) => (
              <button
                aria-label={entry.name}
                className="flex size-9 items-center justify-center rounded-full text-[22px] leading-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-app-focus"
                key={entry.id}
                onClick={() => pick(entry)}
                title={entry.name}
                type="button"
              >
                {entry.glyph}
              </button>
            ))}
            <button
              aria-label="Search all emoji"
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-app-focus"
              onClick={() => {
                expandFromRef.current =
                  panelRef.current?.getBoundingClientRect() ?? null;
                setExpanded(true);
              }}
              title="Search all emoji"
              type="button"
            >
              <Icon icon={Search01Icon} size={20} />
            </button>
          </>
        ) : (
          <span className="flex h-9 items-center px-3">
            <Spinner size={14} />
          </span>
        )}
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={panelRef}
      aria-label="Add reaction"
      className="fixed z-[110] origin-top-left rounded-xl bg-popover p-2 font-(family-name:--app-room-font) shadow-lg"
      role="dialog"
      style={{ ...position, width: PANEL_WIDTH }}
    >
      <input
        ref={searchRef}
        aria-activedescendant={active ? `${listId}-${activeIndex}` : undefined}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded="true"
        aria-label="Search emoji"
        className="h-8 w-full rounded-md border border-input bg-card px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground hover:border-border-hover focus-visible:border-foreground/40"
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Search emoji"
        role="combobox"
        type="text"
        value={query}
      />
      <div
        aria-label="Emoji categories"
        className="my-1.5 flex items-center justify-between px-0.5"
        role="toolbar"
      >
        {catalog
          ? [
              { id: "recommended", label: "Recommended" },
              ...catalog.categories,
            ].map((section) => {
              const sectionIcon = SECTION_ICONS[section.id] ?? SmileIcon;
              return (
                <button
                  aria-label={section.label}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-app-focus"
                  key={section.id}
                  onClick={() => jumpTo(section.id)}
                  tabIndex={-1}
                  title={section.label}
                  type="button"
                >
                  <Icon icon={sectionIcon} size={14} />
                </button>
              );
            })
          : null}
      </div>
      <div
        ref={gridRef}
        aria-label="Emoji"
        className="workspace-scrollbar h-72 overflow-y-auto"
        id={listId}
        role="listbox"
      >
        {!catalog ? (
          <p className="flex items-center justify-center gap-2 px-1 py-6 text-center text-xs text-app-muted">
            <Spinner size={14} />
            Loading emoji…
          </p>
        ) : visible.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-app-muted">
            No matching emoji
          </p>
        ) : (
          sections.map((section, sectionIndex) =>
            section.entries.length ? (
              <div
                aria-label={section.label}
                data-section={section.id}
                key={section.id}
                role="group"
              >
                <p className="sticky top-0 bg-popover px-1 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                  {section.label}
                </p>
                <div className="grid grid-cols-8">
                  {section.entries.map((entry, index) => {
                    const flatIndex = sectionStarts[sectionIndex]! + index;
                    const isActive = flatIndex === activeIndex;
                    return (
                      <button
                        aria-label={entry.name}
                        aria-selected={isActive}
                        className={`flex size-10 items-center justify-center rounded-md text-[22px] leading-none hover:bg-accent ${
                          isActive ? "bg-accent" : ""
                        } ${isSelected(entry.id) ? "ring-1 ring-border-hover" : ""}`}
                        id={`${listId}-${flatIndex}`}
                        key={`${section.id}:${entry.id}`}
                        onClick={() => pick(entry)}
                        onMouseEnter={() => setActiveIndex(flatIndex)}
                        role="option"
                        tabIndex={-1}
                        title={entry.name}
                        type="button"
                      >
                        {entry.glyph}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null,
          )
        )}
      </div>
    </div>,
    document.body,
  );
}
