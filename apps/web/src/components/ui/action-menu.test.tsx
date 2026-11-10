import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActionMenu } from "./action-menu";

describe("ActionMenu", () => {
  it("keeps hover menus reachable without stealing focus and closes after leaving", async () => {
    render(
      <>
        <input aria-label="Composer" />
        <ActionMenu
          openOnHover
          label="Agent"
          items={[{ label: "Open Agent Info" }]}
        />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    const trigger = screen.getByRole("button", { name: "Agent" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    expect(screen.getByRole("menu")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(composer).toHaveFocus();
    fireEvent.pointerLeave(trigger);
    fireEvent.pointerEnter(screen.getByRole("menu"));
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(screen.getByRole("menu")).toBeVisible();
    fireEvent.pointerLeave(screen.getByRole("menu"));
    await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
  it("dismisses a hover card with Escape while retaining the original input focus", () => {
    render(
      <>
        <input aria-label="Composer" />
        <ActionMenu
          openOnHover
          label="Agent"
          items={[{ label: "Open Agent Info" }]}
        />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Agent" }), {
      pointerType: "mouse",
    });
    expect(screen.getByRole("menu")).toBeVisible();
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(composer).toHaveFocus();
  });
  it.each([
    { initialFocusIndex: 1, disabled: false, expected: "Read" },
    { initialFocusIndex: 1, disabled: true, expected: "Edit" },
    { initialFocusIndex: 5, disabled: false, expected: "Edit" },
    { initialFocusIndex: undefined, disabled: false, expected: "Edit" },
  ])(
    "opens on $expected with initial focus $initialFocusIndex (disabled=$disabled)",
    async ({ initialFocusIndex, disabled, expected }) => {
      render(
        <ActionMenu
          initialFocusIndex={initialFocusIndex}
          items={[{ label: "Edit" }, { label: "Read", disabled }]}
          label="Mode"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Mode" }));
      await vi.waitFor(() =>
        expect(screen.getByRole("menuitem", { name: expected })).toHaveFocus(),
      );
    },
  );

  it("shows a non-action identity header and restores focus on Escape", async () => {
    render(
      <ActionMenu
        header={<p>Jenny Bin · jenny@example.com</p>}
        label="Account menu"
        items={[{ label: "Settings" }, { label: "Log out" }]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Account menu" });
    fireEvent.click(trigger);
    expect(screen.getByText("Jenny Bin · jenny@example.com")).toBeVisible();
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it.each([
    { triggerLeft: 180, expectedLeft: 218 },
    { triggerLeft: 960, expectedLeft: 722 },
  ])(
    "positions right-start beside the trigger with edge fallback: $triggerLeft",
    ({ triggerLeft, expectedLeft }) => {
      const originalWidth = window.innerWidth;
      const originalHeight = window.innerHeight;
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1024,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 768,
      });
      const bounds = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          const trigger = this.tagName === "BUTTON";
          return {
            x: trigger ? triggerLeft : 0,
            y: 700,
            left: trigger ? triggerLeft : 0,
            right: trigger ? triggerLeft + 32 : 232,
            top: 700,
            bottom: trigger ? 732 : 900,
            width: trigger ? 32 : 232,
            height: trigger ? 32 : 200,
            toJSON: () => undefined,
          };
        });
      try {
        render(
          <ActionMenu
            placement="right-start"
            label="Create beside"
            items={[{ label: "New Folder" }]}
          />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Create beside" }));
        expect(screen.getByRole("menu", { name: "Create beside" })).toHaveStyle(
          { left: `${expectedLeft}px`, top: "560px" },
        );
      } finally {
        bounds.mockRestore();
        Object.defineProperty(window, "innerWidth", {
          configurable: true,
          value: originalWidth,
        });
        Object.defineProperty(window, "innerHeight", {
          configurable: true,
          value: originalHeight,
        });
      }
    },
  );

  it("opens nested choices with pointer and keyboard navigation", async () => {
    const selectMarkdown = vi.fn();
    render(
      <ActionMenu
        items={[
          {
            children: [
              { label: "md", onSelect: selectMarkdown },
              { label: "html", onSelect: vi.fn() },
            ],
            label: "New File",
          },
        ]}
        label="Create"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const menu = await screen.findByRole("menu", { name: "Create" });
    const newFile = within(menu).getByRole("menuitem", { name: "New File" });
    expect(newFile).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.keyDown(newFile, { key: "ArrowRight" });

    let submenu = await screen.findByRole("menu", { name: "New File" });
    expect(submenu).toHaveClass("max-sm:static", "max-sm:w-full");
    await vi.waitFor(() =>
      expect(
        within(submenu).getByRole("menuitem", { name: "md" }),
      ).toHaveFocus(),
    );
    fireEvent.keyDown(submenu, { key: "ArrowLeft" });
    expect(screen.queryByRole("menu", { name: "New File" })).toBeNull();
    expect(newFile).toHaveFocus();
    fireEvent.keyDown(newFile, { key: "ArrowRight" });
    submenu = await screen.findByRole("menu", { name: "New File" });
    fireEvent.click(within(submenu).getByRole("menuitem", { name: "md" }));
    expect(selectMarkdown).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens a nested menu inward when the trigger is near the right edge", async () => {
    const originalInnerWidth = window.innerWidth;
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        bottom: 48,
        height: 40,
        left: 760,
        right: 992,
        top: 8,
        width: 232,
        x: 760,
        y: 8,
        toJSON: () => undefined,
      });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    render(
      <ActionMenu
        items={[{ children: [{ label: "md" }], label: "New Page" }]}
        label="Create"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New Page" }));

    expect(screen.getByRole("menu", { name: "New Page" })).toHaveClass(
      "right-[calc(100%+4px)]",
    );
    bounds.mockRestore();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
    });
  });

  it("stays open when a nested surface scrolls and still closes on viewport resize", () => {
    render(
      <div data-testid="nested-scroll" style={{ height: 48, overflow: "auto" }}>
        <div style={{ height: 240 }}>tall content</div>
        <ActionMenu
          label="Create"
          items={[{ label: "Create Agent" }, { label: "Create Room" }]}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(
      screen.getByRole("menuitem", { name: "Create Agent" }),
    ).toBeVisible();
    screen.getByTestId("nested-scroll").dispatchEvent(new Event("scroll"));
    expect(
      screen.getByRole("menuitem", { name: "Create Agent" }),
    ).toBeVisible();
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
