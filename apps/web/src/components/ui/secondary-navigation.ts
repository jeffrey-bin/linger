/**
 * Workspace and Wiki open their secondary navigation with a 57px title row,
 * the height of Message's tool row and level with the rail's brand row, so
 * switching between pages never moves the first list item.
 */
export const secondaryNavigationHeaderClass =
  "flex h-(--app-header-height) shrink-0 items-center justify-between gap-2 px-2";

export const secondaryNavigationTitleClass =
  "min-w-0 truncate text-lg leading-6 text-foreground";
