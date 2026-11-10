import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PanelTabStrip } from "./panel-tab-strip";
import type { PanelTab } from "./panel-tab-types";

const tabs: PanelTab[] = [
  {
    id: "thread:msg-a",
    kind: "thread",
    anchorMessageId: "msg-a",
    title: "Alpha task",
    lastActivatedAt: 1,
  },
  {
    id: "file:doc-1",
    kind: "file",
    documentId: "doc-1",
    title: "notes.md",
    lastActivatedAt: 2,
  },
];

describe("PanelTabStrip", () => {
  it("renders the compact Figma tab bar with a launcher control", () => {
    const onActivate = vi.fn();
    const onCreate = vi.fn();
    render(
      <PanelTabStrip
        activeTabId="file:doc-1"
        launcherOpen={false}
        onActivate={onActivate}
        onClose={vi.fn()}
        onCollapse={vi.fn()}
        onCreate={onCreate}
        onToggleMaximize={vi.fn()}
        tabs={tabs}
      />,
    );

    const tablist = screen.getByRole("tablist", { name: "Panel tabs" });
    const strip = tablist.parentElement?.parentElement;
    expect(strip).toHaveClass("h-11", "bg-sidebar");
    expect(strip).not.toHaveClass("border-b");
    expect(tablist).toHaveClass("overflow-x-auto", "overflow-y-hidden");
    expect(tablist).toHaveClass("items-center", "gap-1");
    const firstTab = within(tablist).getByRole("tab", { name: /Alpha task/ });
    expect(firstTab.parentElement).not.toHaveClass("border-r");
    const selectedTab = within(tablist).getByRole("tab", { name: /notes.md/ });
    expect(firstTab).toHaveAttribute("tabindex", "-1");
    expect(selectedTab).toHaveAttribute("tabindex", "0");
    expect(selectedTab).toHaveAttribute(
      "aria-controls",
      "panel-view-file:doc-1",
    );
    expect(selectedTab).toHaveAttribute("data-active", "true");
    expect(selectedTab.parentElement).toHaveClass(
      "h-7",
      "rounded-full",
      "bg-card",
    );
    expect(selectedTab.parentElement).not.toHaveClass(
      "shadow-[var(--app-nav-selected-shadow)]",
    );
    expect(selectedTab).toHaveClass(
      "focus-visible:outline-none",
      "focus-visible:ring-1",
      "pl-1.5",
      "text-xs",
    );
    expect(selectedTab.querySelector("svg")).toHaveAttribute("width", "16");
    expect(screen.getByRole("button", { name: "Close notes.md" })).toHaveClass(
      "size-5",
    );
    const add = screen.getByRole("button", { name: "Add panel view" });
    const reset = screen.getByRole("button", { name: "Maximize sidebar" });
    expect(add.parentElement).toBe(tablist.parentElement);
    expect(add.previousElementSibling).toBe(tablist);
    expect(add).toHaveClass("size-7");
    expect(add.querySelector("svg")).toHaveAttribute("width", "16");
    expect(add.querySelector("svg")).toHaveAttribute("stroke-width", "2");
    expect(reset.parentElement).not.toBe(add.parentElement);
    expect(reset.parentElement).not.toHaveClass("border-l");
    expect(reset).toHaveClass("size-7");
    expect(reset.querySelector("svg")).toHaveAttribute("width", "16");
    const hide = screen.getByRole("button", { name: "Hide sidebar" });
    expect(hide).toHaveClass("size-7", "rounded-lg", "bg-card");
    expect(
      hide.querySelector('[data-testid="sidebar-visibility-fill"]'),
    ).toBeTruthy();
    firstTab.focus();
    fireEvent.keyDown(firstTab, { key: "ArrowRight" });
    expect(onActivate).toHaveBeenCalledWith("file:doc-1");
    expect(selectedTab).toHaveFocus();
    fireEvent.click(add);
    expect(screen.getByRole("menuitem", { name: "Documents" })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "Documents" }));
    expect(onCreate).toHaveBeenCalledWith("file");
  });

  it("opens a create menu without replacing the active tab", () => {
    render(
      <PanelTabStrip
        activeTabId="file:doc-1"
        launcherOpen={false}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCollapse={vi.fn()}
        onCreate={vi.fn()}
        onToggleMaximize={vi.fn()}
        tabs={tabs}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add panel view" }));
    expect(screen.getByRole("menu", { name: "Add panel view" })).toBeVisible();
  });

  it("closes a tab from the strip", () => {
    const onClose = vi.fn();
    render(
      <PanelTabStrip
        activeTabId="thread:msg-a"
        launcherOpen={false}
        onActivate={vi.fn()}
        onClose={onClose}
        onCollapse={vi.fn()}
        onCreate={vi.fn()}
        onToggleMaximize={vi.fn()}
        tabs={tabs}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Alpha task" }));
    expect(onClose).toHaveBeenCalledWith("thread:msg-a");
  });

  it("exposes Hide sidebar on the far right of the tab strip", () => {
    const onCollapse = vi.fn();
    render(
      <PanelTabStrip
        activeTabId="thread:msg-a"
        launcherOpen={false}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCollapse={onCollapse}
        onCreate={vi.fn()}
        onToggleMaximize={vi.fn()}
        tabs={tabs}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(onCollapse).toHaveBeenCalled();
  });

  it("renders the launcher as a dedicated compact toolbar", () => {
    const onToggleMaximize = vi.fn();
    const onCreate = vi.fn();
    render(
      <PanelTabStrip
        activeTabId={null}
        launcherOpen
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCollapse={vi.fn()}
        onCreate={onCreate}
        onToggleMaximize={onToggleMaximize}
        tabs={tabs}
      />,
    );

    const toolbar = screen.getByTestId("panel-launcher-toolbar");
    expect(toolbar).toHaveClass("h-11");
    expect(toolbar).not.toHaveClass("border-b");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add panel view" });
    expect(add).toHaveClass("size-7", "text-muted-foreground");
    expect(add).not.toHaveClass("bg-card");
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(screen.getByRole("menu", { name: "Add panel view" })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "Documents" }));
    expect(onCreate).toHaveBeenCalledWith("file");

    fireEvent.click(screen.getByRole("button", { name: "Maximize sidebar" }));
    expect(onToggleMaximize).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveClass(
      "size-7",
      "rounded-lg",
      "bg-card",
    );
  });
});

it("scrolls with a mouse wheel and reorders only local tab drags", () => {
  const onReorder = vi.fn();
  render(
    <PanelTabStrip
      activeTabId={tabs[0]!.id}
      launcherOpen={false}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onCollapse={vi.fn()}
      onCreate={vi.fn()}
      onToggleMaximize={vi.fn()}
      onReorder={onReorder}
      tabs={tabs}
    />,
  );
  const strip = screen.getByRole("tablist");
  Object.defineProperties(strip, {
    scrollWidth: { value: 600 },
    clientWidth: { value: 200 },
  });
  fireEvent.wheel(strip, { deltaY: 80 });
  expect(strip.scrollLeft).toBe(80);
  fireEvent.wheel(strip, { deltaX: 30, deltaY: 2 });
  expect(strip.scrollLeft).toBe(110);
  fireEvent.wheel(strip, { deltaY: 50, ctrlKey: true });
  expect(strip.scrollLeft).toBe(110);
  const [first, second] = screen.getAllByRole("tab");
  [first, second].forEach((tab, index) => {
    vi.spyOn(tab!.parentElement!, "getBoundingClientRect").mockReturnValue({
      x: index * 104,
      y: 0,
      left: index * 104,
      right: index * 104 + 100,
      top: 0,
      bottom: 28,
      width: 100,
      height: 28,
      toJSON: () => ({}),
    });
  });
  const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  fireEvent.drop(second!, { dataTransfer });
  expect(onReorder).not.toHaveBeenCalled();
  fireEvent.dragStart(first!, { dataTransfer });
  fireEvent.dragOver(second!, { dataTransfer, clientX: 154 });
  expect(first!.parentElement).toHaveAttribute("data-drag-placeholder", "true");
  expect(first!.parentElement).toHaveStyle({ transform: "translateX(104px)" });
  expect(second!.parentElement).toHaveStyle({
    transform: "translateX(-104px)",
  });
  expect(onReorder).not.toHaveBeenCalled();
  fireEvent.drop(second!, { dataTransfer });
  expect(onReorder).toHaveBeenCalledWith(tabs[0]!.id, tabs[1]!.id);
  onReorder.mockClear();
  fireEvent.dragEnd(first!);
  expect(first!.parentElement).not.toHaveAttribute("data-drag-placeholder");
  fireEvent.drop(second!, { dataTransfer });
  expect(onReorder).not.toHaveBeenCalled();
  fireEvent.keyDown(first!, {
    key: "ArrowRight",
    altKey: true,
    shiftKey: true,
  });
  expect(onReorder).toHaveBeenCalledWith(tabs[0]!.id, tabs[1]!.id);
});

it("keeps the wheel listener stable across tab changes and removes it when hidden", () => {
  const props = {
    activeTabId: tabs[0]!.id,
    launcherOpen: false,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onCollapse: vi.fn(),
    onCreate: vi.fn(),
    onToggleMaximize: vi.fn(),
    tabs,
  };
  const { rerender, unmount } = render(<PanelTabStrip {...props} />);
  const strip = screen.getByRole("tablist");
  const add = vi.spyOn(strip, "addEventListener");
  const remove = vi.spyOn(strip, "removeEventListener");
  rerender(
    <PanelTabStrip
      {...props}
      activeTabId={tabs[1]!.id}
      tabs={[...tabs].reverse()}
    />,
  );
  expect(add).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  rerender(<PanelTabStrip {...props} launcherOpen />);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith("wheel", expect.any(Function));
  unmount();
  expect(remove).toHaveBeenCalledTimes(1);
});
