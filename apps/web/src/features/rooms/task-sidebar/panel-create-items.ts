import type { PanelTabKind } from "./panel-tab-types";

const ALL_PANEL_CREATE_ITEMS = [
  {
    kind: "file",
    label: "Documents",
  },
  {
    kind: "agentInfo",
    label: "Agent info",
  },
  {
    kind: "roomInfo",
    label: "Room info",
  },
  {
    kind: "collaboration",
    label: "Collaboration",
  },
] as const satisfies { kind: PanelTabKind; label: string }[];

export type PanelCreateChoice = (typeof ALL_PANEL_CREATE_ITEMS)[number]["kind"];

/** Keep the general launcher focused on Documents; Agent info is DM-scoped. */
export const PANEL_HIDDEN_CREATE_KINDS = new Set<PanelCreateChoice>([
  "roomInfo",
]);

export function panelCreateItems(includeAgentInfo = false) {
  return ALL_PANEL_CREATE_ITEMS.filter((item) =>
    isPanelCreateChoiceEnabled(item.kind, includeAgentInfo),
  );
}

export function isPanelCreateChoiceEnabled(
  choice: PanelCreateChoice,
  includeAgentInfo = false,
) {
  return (
    !PANEL_HIDDEN_CREATE_KINDS.has(choice) &&
    (choice !== "agentInfo" || includeAgentInfo)
  );
}
