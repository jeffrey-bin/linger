import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { LibraryLayout } from "./library-layout";

function createTestStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("Library layout", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createTestStorage(),
    });
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows no sidebar on the Workspace home", () => {
    renderWorkspace("/t/tenant-northstar/library");

    expect(screen.getByText("Workspace home")).toBeVisible();
    expect(
      screen.queryByRole("complementary", { name: "Library sidebar" }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Owned by Me tree" }),
    ).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Library mobile navigation" }),
    ).toBeNull();
  });

  it("renders the switching sidebar beside an open Document without a title bar", () => {
    renderWorkspace("/t/tenant-northstar/documents/document-plan");

    expect(screen.getByText("Document page")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Search documents" }),
    ).not.toBeInTheDocument();
    // The Workspace has no title bar; the sidebar is the whole chrome.
    expect(
      screen.queryByRole("heading", { level: 1, name: "Library" }),
    ).toBeNull();
    const workspaceSidebar = screen.getByRole("complementary", {
      name: "Library sidebar",
    });
    expect(
      within(workspaceSidebar).getByRole("link", { name: "Back to Library" }),
    ).toHaveAttribute("href", "/t/tenant-northstar/library");
    expect(
      within(workspaceSidebar).queryByRole("navigation", {
        name: "Library navigation",
      }),
    ).toBeNull();
    const ownedTree = within(workspaceSidebar).getByRole("region", {
      name: "Owned by Me tree",
    });
    const sharedTree = within(workspaceSidebar).getByRole("region", {
      name: "Shared with me tree",
    });
    const meetingsTree = within(workspaceSidebar).getByRole("region", {
      name: "Meetings tree",
    });
    expect(ownedTree.compareDocumentPosition(sharedTree)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(sharedTree.compareDocumentPosition(meetingsTree)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      within(workspaceSidebar).queryByRole("region", { name: "Wiki tree" }),
    ).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Library mobile navigation" }),
    ).toBeNull();
  });

  it("shows Wiki routes without any sidebar", async () => {
    const runtime = createTestTeamHubRuntime();

    const router = createMemoryRouter(
      [
        {
          path: "/t/:tenantId/library",
          element: <LibraryLayout />,
          children: [
            {
              path: "wiki/*",
              element: <TestLibrarySurface>Wiki page</TestLibrarySurface>,
            },
          ],
        },
      ],
      { initialEntries: ["/t/tenant-northstar/library/wiki/example"] },
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <RouterProvider router={router} />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText("Wiki page")).toBeVisible();
    expect(document.getElementById("workspace-new-page-slot")).toBeNull();
    expect(screen.queryByText("Pages")).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Library navigation" }),
    ).toBeNull();
    expect(
      screen.queryByRole("complementary", { name: "Wiki sidebar" }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Owned by Me tree" }),
    ).toBeNull();
  });

  it("keeps My pages shut when a Document opens the sidebar", async () => {
    renderWorkspace("/t/tenant-northstar/documents/document-plan");

    expect(
      await screen.findByRole("button", { name: "Expand Owned by Me" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("opens My pages to show where an opened Document of mine is kept", async () => {
    renderWorkspace("/t/tenant-northstar/documents/document-room-agent-flow");

    expect(
      await screen.findByRole("button", { name: "Collapse Owned by Me" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the desktop app the same Library as the browser", () => {
    const desktop = window as { lingerDesktop?: unknown };
    desktop.lingerDesktop = {};
    try {
      const home = renderWorkspace("/t/tenant-northstar/library");
      expect(screen.getByText("Workspace home")).toBeVisible();
      expect(
        screen.queryByRole("complementary", { name: "Library sidebar" }),
      ).toBeNull();
      home.unmount();

      renderWorkspace("/t/tenant-northstar/documents/document-plan");
      const sidebar = screen.getByRole("complementary", {
        name: "Library sidebar",
      });
      expect(
        within(sidebar).getByRole("link", { name: "Back to Library" }),
      ).toHaveAttribute("href", "/t/tenant-northstar/library");
      expect(
        within(sidebar).queryByRole("link", { name: "Overview" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Library list$/ }),
      ).toBeNull();
    } finally {
      delete desktop.lingerDesktop;
    }
  });
});

function renderWorkspace(initialEntry: string) {
  const runtime = createTestTeamHubRuntime();
  const router = createMemoryRouter(
    [
      {
        children: [
          {
            element: <TestLibrarySurface>Workspace home</TestLibrarySurface>,
            path: "library",
          },
          {
            element: <TestLibrarySurface>Document page</TestLibrarySurface>,
            path: "documents/:documentId",
          },
        ],
        element: <LibraryLayout />,
        path: "/t/:tenantId",
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

function TestLibrarySurface({ children }: { children: string }) {
  return <p>{children}</p>;
}
