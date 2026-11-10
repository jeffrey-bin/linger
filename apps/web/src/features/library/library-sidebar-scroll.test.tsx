import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { LibrarySidebar } from "./library-sidebar";

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

it.each([false, true])(
  "restores pending sidebar scroll unless the user takes control (interrupted=%s)",
  async (interrupted) => {
    const positions = new WeakMap<Element, number>();
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(
      function (this: Element) {
        return positions.get(this) ?? 0;
      },
    );
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(
      function (this: Element, value: number) {
        positions.set(
          this,
          Math.min(value, this.querySelector("[data-loaded]") ? 500 : 0),
        );
      },
    );
    const runtime = createTestTeamHubRuntime();

    const client = new QueryClient();
    window.sessionStorage.setItem(
      "linger:library-sidebar-scroll:tenant-northstar",
      "240",
    );
    const tree = (loaded: boolean, identity = "wiki") => (
      <QueryClientProvider client={client}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <LibrarySidebar
              active={null}
              key={identity}
              tenantId="tenant-northstar"
            >
              {loaded ? (
                <div data-loaded>Files loaded</div>
              ) : (
                <p>Loading files</p>
              )}
            </LibrarySidebar>
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const view = render(tree(false));
    const sidebar = screen.getByRole("complementary", {
      name: "Library sidebar",
    });
    expect(sidebar.scrollTop).toBe(0);
    if (interrupted) fireEvent.wheel(sidebar);
    view.rerender(tree(true));
    await act(() => Promise.resolve());
    expect(sidebar.scrollTop).toBe(interrupted ? 0 : 240);
    sidebar.scrollTop = 320;
    fireEvent.scroll(sidebar);
    view.rerender(tree(true, "document"));
    expect(
      screen.getByRole("complementary", { name: "Library sidebar" }).scrollTop,
    ).toBe(320);
  },
);
