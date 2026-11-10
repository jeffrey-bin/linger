import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { LibrarySidebar } from "./library-sidebar";

describe("LibrarySidebar", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("shares the Message list width and persists pointer and keyboard resizing", () => {
    const key = "linger:chat-navigation-width:tenant-northstar";
    window.localStorage.removeItem(key);
    const { unmount } = renderSidebar();
    const sidebar = screen.getByRole("complementary", {
      name: "Library sidebar",
    });
    const separator = screen.getByRole("separator", {
      name: "Resize Library sidebar",
    });

    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("240px");
    fireEvent.pointerDown(separator, { button: 0, clientX: 240, pointerId: 7 });
    fireEvent.pointerMove(separator, { clientX: 400, pointerId: 7 });
    fireEvent.pointerUp(separator, { clientX: 400, pointerId: 7 });
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("360px");
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    expect(window.localStorage.getItem(key)).toBe("360");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("352px");
    unmount();
    renderSidebar();
    expect(
      screen
        .getByRole("complementary", { name: "Library sidebar" })
        .style.getPropertyValue("--sidebar-width"),
    ).toBe("352px");
    window.localStorage.removeItem(key);
  });

  it("opens with a Back to Library header instead of a title and Overview link", () => {
    renderSidebar();
    expect(
      screen.getByRole("link", { name: "Back to Library" }),
    ).toHaveAttribute("href", "/t/tenant-northstar/library");
    expect(
      screen.queryByRole("heading", { level: 2, name: "Library" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Overview" })).toBeNull();
  });

  it("keeps the tree visible without a collapse control, including older saved preferences", () => {
    window.sessionStorage.setItem(
      "linger:library-sidebar-collapsed:tenant-northstar",
      "true",
    );
    renderSidebar();
    expect(screen.getByText("Tree")).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: /(?:Collapse|Expand) Library sidebar/,
      }),
    ).not.toBeInTheDocument();
  });

  it("leaves Meetings in Workspace and removes its old Wiki destination", () => {
    renderSidebar();
    expect(screen.queryByRole("link", { name: "Open Wiki" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Meetings" })).toHaveAttribute(
      "href",
      "/t/tenant-northstar/library?tab=meetings&meetings=7d",
    );
    expect(
      screen.queryByRole("link", { name: "Open Memory" }),
    ).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "keeps the document tree close to Memory (mobileOpen=%s)",
    (mobileOpen) => {
      renderSidebar({ mobileOpen });
      // The document tree sits directly under the header, and the
      // knowledge collections follow it closely.
      const treeContainer = screen.getByText("Tree").parentElement!;
      expect(treeContainer.previousElementSibling).toContainElement(
        screen.getByRole("link", { name: "Back to Library" }),
      );
      const knowledge = treeContainer.nextElementSibling;
      expect(knowledge).toHaveClass("mt-1");
      expect(knowledge).not.toHaveClass("mt-4");
    },
  );
});

function renderSidebar(input: { mobileOpen?: boolean } = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <LibrarySidebar
          active="my-documents"
          mobileOpen={input.mobileOpen}
          tenantId="tenant-northstar"
        >
          <p>Tree</p>
        </LibrarySidebar>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
