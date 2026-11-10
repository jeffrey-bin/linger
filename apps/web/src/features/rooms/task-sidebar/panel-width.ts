export const PANEL_SIDEBAR_DEFAULT_WIDTH = 430;
export const PANEL_SIDEBAR_MIN_WIDTH = 272;
export function panelSidebarMaxWidth() {
  return Math.max(
    540,
    Math.round((typeof window === "undefined" ? 0 : window.innerWidth) * 0.6),
  );
}

function storageKey(accountId: string) {
  return `linger.panel-sidebar.width:v2:${encodeURIComponent(accountId)}`;
}

export function clampPanelSidebarWidth(width: number) {
  if (!Number.isFinite(width)) {
    width = PANEL_SIDEBAR_DEFAULT_WIDTH;
  }
  return Math.min(
    panelSidebarMaxWidth(),
    Math.max(PANEL_SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

export function readPanelSidebarWidth(accountId = "default") {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(accountId));
    if (!raw) return PANEL_SIDEBAR_DEFAULT_WIDTH;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return PANEL_SIDEBAR_DEFAULT_WIDTH;
    }
    return clampPanelSidebarWidth(parsed);
  } catch {
    return PANEL_SIDEBAR_DEFAULT_WIDTH;
  }
}

export function writePanelSidebarWidth(width: number, accountId = "default") {
  const next = clampPanelSidebarWidth(width);
  try {
    globalThis.localStorage?.setItem(storageKey(accountId), String(next));
  } catch {
    // session-only fallback
  }
  return next;
}
