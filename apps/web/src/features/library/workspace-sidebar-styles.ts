/**
 * One heading row for every Library sidebar collection (My pages, Shared
 * with me, Wiki, Meetings). It matches the Overview row above them in
 * height, 14px label, and 14px glyph, with a 28px trailing action, so the
 * whole sidebar reads as one list.
 */
export const WORKSPACE_HEADING_ICON_SIZE = 14;

/**
 * A top-level navigation row in a secondary sidebar (Library Overview, the
 * Wiki directory). Same 33px height, 14px/18px label and grey tone as the
 * collection headings, so Library and Wiki read as the same list.
 */
export const workspaceNavRowClass =
  "flex h-[33px] w-full items-center gap-2 rounded-lg px-2 text-sm leading-[18px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus motion-reduce:transition-none";

export const workspaceNavRowCurrentClass = "bg-muted text-foreground";

export const workspaceNavRowIdleClass =
  "text-muted-foreground hover:bg-muted/70 hover:text-foreground";

export const workspaceHeadingToggleClass =
  "flex h-[33px] min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[14px] leading-[18px] text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus";

export const workspaceHeadingActionClass =
  "mr-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus";

/** Folder chevrons, and the gap files keep where a chevron would sit. */
export const WORKSPACE_TREE_CHEVRON_SIZE = 14;
