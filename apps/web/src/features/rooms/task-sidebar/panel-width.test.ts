// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  clampPanelSidebarWidth,
  PANEL_SIDEBAR_DEFAULT_WIDTH,
  panelSidebarMaxWidth,
  PANEL_SIDEBAR_MIN_WIDTH,
  readPanelSidebarWidth,
  writePanelSidebarWidth,
} from "./panel-width";

describe("panel sidebar width", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return store.size;
        },
        clear() {
          store.clear();
        },
        getItem(key: string) {
          return store.get(key) ?? null;
        },
        key(index: number) {
          return [...store.keys()][index] ?? null;
        },
        removeItem(key: string) {
          store.delete(key);
        },
        setItem(key: string, value: string) {
          store.set(key, value);
        },
      } satisfies Storage,
    });
  });

  it("keeps the default width and allows expansion beyond half the viewport", () => {
    expect(PANEL_SIDEBAR_MIN_WIDTH).toBe(272);
    expect(PANEL_SIDEBAR_DEFAULT_WIDTH).toBe(430);
    expect(panelSidebarMaxWidth()).toBe(
      Math.max(540, Math.round(window.innerWidth * 0.6)),
    );
    expect(readPanelSidebarWidth()).toBe(PANEL_SIDEBAR_DEFAULT_WIDTH);
    expect(clampPanelSidebarWidth(200)).toBe(PANEL_SIDEBAR_MIN_WIDTH);
    expect(clampPanelSidebarWidth(2000)).toBe(panelSidebarMaxWidth());
    expect(clampPanelSidebarWidth(480)).toBe(480);
    globalThis.localStorage.setItem("linger.panel-sidebar.width", "400");
    expect(readPanelSidebarWidth()).toBe(PANEL_SIDEBAR_DEFAULT_WIDTH);
  });

  it("keeps continuous widths instead of snapping to presets", () => {
    expect(clampPanelSidebarWidth(500)).toBe(500);
    expect(clampPanelSidebarWidth(273)).toBe(273);
  });

  it("persists a clamped width for the next session", () => {
    writePanelSidebarWidth(500, "account-a");
    expect(readPanelSidebarWidth("account-a")).toBe(500);
    expect(readPanelSidebarWidth("account-b")).toBe(
      PANEL_SIDEBAR_DEFAULT_WIDTH,
    );
    writePanelSidebarWidth(120, "account-a");
    expect(readPanelSidebarWidth("account-a")).toBe(PANEL_SIDEBAR_MIN_WIDTH);
  });

  it("restores 400px when it was saved under the current account key", () => {
    writePanelSidebarWidth(400, "account-a");

    expect(readPanelSidebarWidth("account-a")).toBe(400);
  });
});
