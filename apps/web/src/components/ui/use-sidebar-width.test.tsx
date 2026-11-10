import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useSecondaryNavigationWidth } from "./use-sidebar-width";

const KEY = "linger:chat-navigation-width:tenant-a";

afterEach(() => window.localStorage.removeItem(KEY));

function Navigation({ label }: { label: string }) {
  const width = useSecondaryNavigationWidth("tenant-a");
  return (
    <div
      data-testid={label}
      ref={(node) => {
        width.styleRef.current = node;
      }}
      style={width.style}
    >
      <div {...width.handleProps} aria-label={`Resize ${label}`} />
    </div>
  );
}

describe("useSecondaryNavigationWidth", () => {
  it("gives a navigation that stays mounted the width saved beside it", () => {
    render(
      <>
        <Navigation label="Message" />
        <Navigation label="Workspace" />
      </>,
    );
    const workspace = screen.getByRole("separator", {
      name: "Resize Workspace",
    });
    fireEvent.keyDown(workspace, { key: "ArrowRight", shiftKey: true });

    expect(window.localStorage.getItem(KEY)).toBe("272");
    expect(
      screen.getByTestId("Message").style.getPropertyValue("--sidebar-width"),
    ).toBe("272px");
    expect(
      screen.getByRole("separator", { name: "Resize Message" }),
    ).toHaveAttribute("aria-valuenow", "272");
  });

  it("leaves focus where it was when dragging with the mouse", () => {
    render(
      <>
        <input aria-label="Composer" />
        <Navigation label="Message" />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    const handle = screen.getByRole("separator", { name: "Resize Message" });
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 140, pointerId: 1 });
    expect(
      screen.getByTestId("Message").style.getPropertyValue("--sidebar-width"),
    ).toBe("280px");
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(handle).not.toHaveFocus();
    expect(composer).toHaveFocus();
    expect(window.localStorage.getItem(KEY)).toBe("280");
  });
});
