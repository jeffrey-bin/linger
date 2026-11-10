import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Select, SelectItem } from "./select";
import { SelectPopup } from "./select-popup";
import { selectPopupFrame, selectPopupPosition } from "./select-popup-layout";

describe("Select", () => {
  it("renders its option list in a portal and commits a pointer selection", async () => {
    function Example() {
      const [value, setValue] = useState("");
      return (
        <Select
          aria-label="Runtime"
          onValueChange={setValue}
          placeholder="Choose a runtime"
          value={value}
        >
          <SelectItem value="codex">Codex</SelectItem>
          <SelectItem value="claude">Claude</SelectItem>
        </Select>
      );
    }

    render(<Example />);
    const trigger = screen.getByRole("combobox", { name: "Runtime" });
    expect(trigger).toHaveTextContent("Choose a runtime");

    fireEvent.click(trigger);
    const option = await screen.findByRole("option", { name: "Claude" });
    expect(option.closest("[data-select-portal]")?.parentElement).toBe(
      document.body,
    );
    fireEvent.click(option);

    expect(trigger).toHaveTextContent("Claude");
    expect(trigger).toHaveValue("claude");
  });

  it("keeps its option portal inside a modal dialog top layer", async () => {
    render(
      <dialog open>
        <Select aria-label="Runtime" onValueChange={vi.fn()} value="codex">
          <SelectItem value="codex">Codex - Ready</SelectItem>
          <SelectItem value="claude">Claude - Sign in required</SelectItem>
          <SelectItem disabled value="pi">
            Pi - Not installed
          </SelectItem>
        </Select>
      </dialog>,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Runtime" }));

    const dialog = screen.getByRole("dialog");
    expect(
      await within(dialog).findByRole("option", {
        name: "Claude - Sign in required",
      }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("option", { name: "Pi - Not installed" }),
    ).toBeDisabled();
    expect(dialog.querySelector("[data-select-portal]")).not.toBeNull();
  });

  it("supports keyboard selection and disabled triggers", async () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <Select aria-label="Model" onValueChange={onValueChange} value="first">
        <SelectItem value="first">First</SelectItem>
        <SelectItem value="second">Second</SelectItem>
      </Select>,
    );
    const trigger = screen.getByRole("combobox", { name: "Model" });

    fireEvent.click(trigger);
    const second = await screen.findByRole("option", { name: "Second" });
    second.focus();
    fireEvent.keyDown(second, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("second");

    rerender(
      <Select
        aria-label="Model"
        disabled
        onValueChange={onValueChange}
        value="first"
      >
        <SelectItem value="first">First</SelectItem>
      </Select>,
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
  });

  it("sizes the option list to the trigger and stays attached below until the real menu height is known", () => {
    expect(
      selectPopupPosition(
        { left: 24, top: 80, right: 224, bottom: 112, width: 200 },
        { width: 400, height: 720 },
      ),
    ).toEqual({ left: 24, top: 116, width: 200 });
    expect(
      selectPopupPosition(
        { left: 80, top: 400, right: 280, bottom: 432, width: 200 },
        { width: 400, height: 500 },
      ),
    ).toEqual({ left: 80, top: 436, width: 200 });
    expect(
      selectPopupPosition(
        { left: 80, top: 400, right: 280, bottom: 432, width: 200 },
        { width: 400, height: 500 },
        200,
      ),
    ).toEqual({ left: 80, top: 196, width: 200 });
  });

  it("converts trigger coordinates into a dialog containing block", () => {
    expect(
      selectPopupFrame(
        { left: 140, top: 220, right: 340, bottom: 252, width: 200 },
        { height: 600, left: 24, top: 16, width: 800 },
        { height: 900, width: 1200 },
      ),
    ).toEqual({
      trigger: { bottom: 236, left: 116, right: 316, top: 204, width: 200 },
      viewport: { height: 600, width: 800 },
    });
  });

  it("truncates long trigger and option labels without changing control width", async () => {
    render(
      <Select aria-label="Workspace" onValueChange={vi.fn()} value="long">
        <SelectItem value="long">
          A workspace name that is intentionally much longer than the control
        </SelectItem>
      </Select>,
    );

    expect(
      screen
        .getByRole("combobox", { name: "Workspace" })
        .querySelector(".truncate"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "Workspace" }));
    expect(
      (await screen.findByRole("option")).querySelector(".truncate"),
    ).toBeInTheDocument();
  });

  it("does not resubscribe the outside pointer listener when its close callback changes", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const options = [{ children: "First", value: "first" }];
    const addListener = vi.spyOn(document, "addEventListener");
    const removeListener = vi.spyOn(document, "removeEventListener");
    const { rerender } = render(
      <>
        <button ref={triggerRef} type="button" />
        <SelectPopup
          id="model-options"
          onChoose={vi.fn()}
          onClose={vi.fn()}
          options={options}
          triggerRef={triggerRef}
          value="first"
        />
      </>,
    );
    addListener.mockClear();
    removeListener.mockClear();

    rerender(
      <>
        <button ref={triggerRef} type="button" />
        <SelectPopup
          id="model-options"
          onChoose={vi.fn()}
          onClose={vi.fn()}
          options={options}
          triggerRef={triggerRef}
          value="first"
        />
      </>,
    );

    expect(addListener).not.toHaveBeenCalledWith(
      "pointerdown",
      expect.any(Function),
    );
    expect(removeListener).not.toHaveBeenCalledWith(
      "pointerdown",
      expect.any(Function),
    );
  });
});
