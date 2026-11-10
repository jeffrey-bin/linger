import {
  respond,
  documentSeeds,
  showDocument,
  seedRoomUpload,
  createDocumentTestRuntime,
  seedNativeDocument,
  seedUploadedDocument,
  seedFolder,
} from "@/test/document-scenarios";
import {
  teamHubErrorResponse,
  type TestRouteMethod,
} from "@/test/teamhub-test-server";
import {
  useQuery,
  useQueryClient,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  teamHubData,
  type TeamHubApiPath,
} from "@/features/teamhub/teamhub-api";
import {
  useTeamHubRuntime,
  TeamHubRuntimeProvider,
} from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubDocument,
  TeamHubDocumentPage,
  TeamHubDocumentPlacementNode,
} from "@/features/teamhub/teamhub-types";
import * as documentRoutePreload from "@/features/rooms/documents/document-route-preload";

import { LibraryLayout } from "./library-layout";
import { LibrarySidebar } from "./library-sidebar";
import { documentFileName } from "./document-display-name";
import { resetTenantUploadsForTest } from "./library-upload-queue";
import {
  MyDocumentsTree,
  LibraryDocumentsPage,
} from "./library-documents-page";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { formatUpdatedAt } from "@/lib/date-format";

describe("Library Documents", () => {
  it("titles the Workspace home without Wiki entry points or a sidebar", async () => {
    const runtime = await signedInRuntime();
    renderPage(runtime);

    const heading = await screen.findByRole("heading", {
      level: 2,
      name: "Library",
    });
    expect(screen.queryByRole("heading", { name: "My Files" })).toBeNull();
    expect(
      screen.queryByRole("complementary", { name: "Library sidebar" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Open Wiki" })).toBeNull();
    const header = heading.closest("header")!;
    expect(header).toHaveClass("workspace-files-heading");
    expect(within(header).queryByRole("link")).not.toBeInTheDocument();
    expect(
      within(header).getByRole("button", { name: "Create in My pages" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Open Owned by Me/ }),
    ).toBeNull();
  });

  it("starts document folders collapsed in the sidebar beside a Document and expands them on click", async () => {
    const runtime = await signedInRuntime();
    for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
      seedFolder(
        runtime,
        `library-default-collapsed-${name.toLowerCase()}-12345678`,
        { name },
      );
    }
    renderPage(
      runtime,
      undefined,
      "/t/tenant-northstar/documents/document-product-v0-brief",
    );
    const sidebar = await screen.findByRole("complementary", {
      name: "Library sidebar",
    });
    fireEvent.click(
      await within(sidebar).findByRole("button", {
        name: "Expand Owned by Me",
      }),
    );
    const tree = await within(sidebar).findByRole("tree", {
      name: "Owned by Me",
    });

    for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
      expect(
        await within(tree).findByRole("treeitem", { name }),
      ).toHaveAttribute("aria-expanded", "false");
    }

    const alpha = within(tree).getByRole("treeitem", { name: "Alpha" });
    fireEvent.click(within(alpha).getAllByRole("button")[0]!);
    expect(alpha).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps Back to Library above collapsible document collections", async () => {
    const runtime = await signedInRuntime();
    renderTree(runtime);

    const sidebar = await screen.findByRole("complementary", {
      name: "Library sidebar",
    });
    const back = within(sidebar).getByRole("link", {
      name: "Back to Library",
    });
    expect(back).toHaveAttribute("href", "/t/tenant-northstar/library");
    expect(
      within(sidebar).queryByRole("navigation", {
        name: "Library navigation",
      }),
    ).toBeNull();
    expect(
      within(sidebar).queryByRole("link", { name: "Overview" }),
    ).toBeNull();
    expect(
      within(sidebar).queryByRole("link", { name: "Open Memory" }),
    ).toBeNull();
    const ownedTree = await within(sidebar).findByRole("region", {
      name: "Owned by Me tree",
    });
    expect(ownedTree).toBeVisible();
    expect(back.compareDocumentPosition(ownedTree)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(sidebar).getByText("No documents yet.")).toBeVisible();
    const myDocuments = within(sidebar).getByRole("button", {
      name: "Collapse Owned by Me",
    });
    fireEvent.click(myDocuments);
    expect(myDocuments).toHaveAttribute("aria-expanded", "false");
    expect(within(sidebar).queryByText("No documents yet.")).toBeNull();
    expect(
      within(sidebar).getByRole("button", {
        name: "Collapse Shared with me",
      }),
    ).toBeVisible();
    expect(
      within(sidebar).queryByRole("link", { name: "Shared with me" }),
    ).toBeNull();
    const openPages = screen.getByRole("button", {
      name: "Open Library pages",
    });
    expect(openPages).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(openPages);
    expect(openPages).toHaveAttribute("aria-expanded", "true");
    expect(sidebar).toHaveClass("max-sm:block");
    expect(
      within(sidebar).getByRole("button", { name: "Close Owned by Me" }),
    ).toBeVisible();
  });

  it("preserves the Owned by Me collection collapse state across route remounts", async () => {
    const runtime = await signedInRuntime();
    const first = renderTree(runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: "Collapse Owned by Me" }),
    );
    expect(
      screen.getByRole("button", { name: "Expand Owned by Me" }),
    ).toHaveAttribute("aria-expanded", "false");
    first.unmount();

    renderTree(runtime);

    expect(
      await screen.findByRole("button", { name: "Expand Owned by Me" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
  beforeEach(() => {
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      "linger:library-shared-collapsed:v2:tenant-northstar",
      "false",
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetTenantUploadsForTest();
  });

  it("keeps Shared with me as an Actor-private tree without a global route", async () => {
    const runtime = await signedInRuntime();
    const owned = (await listOwnedDocuments(runtime)).items[0]!;
    const shared = {
      ...owned,
      id: "document-shared-tree",
      owner: { ...owned.owner, id: "actor-shared-owner" },
      title: "Shared roadmap",
    };
    const sharedDrag = {
      ...shared,
      id: "document-shared-drag",
      title: "Shared drag sample",
    };
    const now = "2026-08-26T10:00:00.000Z";
    let items: TeamHubDocumentPlacementNode[] = [
      {
        created_at: now,
        id: "shared-folder-drop-zone",
        name: "Drop zone",
        node_kind: "folder",
        sort_key: "shared-folder-drop-zone",
        updated_at: now,
      },
      {
        created_at: now,
        id: "shared-folder-source",
        name: "Source folder",
        node_kind: "folder",
        sort_key: "shared-folder-source",
        updated_at: now,
      },
      {
        created_at: now,
        document: {
          can_edit_native_content: sharedDrag.can_edit_native_content,
          capabilities: sharedDrag.capabilities,
          format: sharedDrag.format,
          id: sharedDrag.id,
          owner: sharedDrag.owner,
          representation_format: sharedDrag.representation_format,
          status: sharedDrag.status,
          title: sharedDrag.title,
          updated_at: sharedDrag.updated_at,
        },
        document_id: sharedDrag.id,
        id: "shared-document-drag",
        node_kind: "document",
        parent_id: "shared-folder-source",
        sort_key: sharedDrag.id,
        updated_at: now,
      },
      {
        created_at: now,
        document: {
          access_sources: [
            {
              created_at: now,
              provenance: { kind: "direct_grant", schema_version: 2 },
              role: "viewer",
              schema_version: 2,
              source_id: "shared-direct-roadmap",
              source_kind: "direct",
              source_version: 1,
              status: "active",
              updated_at: now,
            },
            {
              created_at: now,
              provenance: {
                binding_kind: "room",
                context_id: "room-roadmap",
                kind: "context_binding",
                schema_version: 2,
              },
              role: "editor",
              schema_version: 2,
              source_id: "shared-context-roadmap",
              source_kind: "context",
              source_version: 1,
              status: "active",
              updated_at: now,
            },
          ],
          can_edit_native_content: shared.can_edit_native_content,
          capabilities: shared.capabilities,
          format: shared.format,
          id: shared.id,
          owner: shared.owner,
          representation_format: shared.representation_format,
          status: shared.status,
          title: shared.title,
          updated_at: shared.updated_at,
        },
        document_id: shared.id,
        id: "shared-document-roadmap",
        node_kind: "document",
        sort_key: shared.id,
        updated_at: now,
      },
    ];
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/me/shared-document-tree",
      () => ({ items: structuredClone(items) }),
    );
    runtime.server.on(
      "POST",
      "/v0/tenants/{tenantId}/me/shared-document-folders",
      ({ body }) => {
        const folder = {
          created_at: now,
          id: "shared-folder-roadmaps",
          name: (body as { name: string }).name,
          node_kind: "folder" as const,
          sort_key: "shared-folder-roadmaps",
          updated_at: now,
        };
        items = [folder, ...items];
        return folder;
      },
    );
    runtime.server.on(
      "PATCH",
      "/v0/tenants/{tenantId}/me/shared-document-folders/{folderId}",
      ({ body, params }) => {
        const folder = items.find(
          (item) => item.id === params.folderId && item.node_kind === "folder",
        ) as Extract<TeamHubDocumentPlacementNode, { node_kind: "folder" }>;
        const updated = {
          ...folder,
          name: (body as { name?: string }).name ?? folder.name,
        };
        items = items.map((item) =>
          item.id === params.folderId ? updated : item,
        );
        return updated;
      },
    );
    const move = vi.fn(
      ({ body, params }: { body: unknown; params: Record<string, string> }) => {
        const current = items.find(
          (item) =>
            item.node_kind === "document" &&
            item.document_id === params.documentId,
        )!;
        const updated = {
          ...current,
          parent_id: (body as { parent_id?: string }).parent_id,
        };
        items = items.map((item) => (item.id === current.id ? updated : item));
        return updated;
      },
    );
    runtime.server.on(
      "PUT",
      "/v0/tenants/{tenantId}/me/shared-documents/{documentId}",
      move,
    );
    const preload = vi
      .spyOn(documentRoutePreload, "preloadUnifiedDocumentPage")
      .mockResolvedValue({} as never);
    renderTree(runtime);

    const sharedLink = await screen.findByRole("link", {
      name: /Shared roadmap/,
    });
    expect(sharedLink).toHaveAttribute(
      "href",
      "/t/tenant-northstar/documents/document-shared-tree",
    );
    expect(
      screen.getByText("Direct Viewer + Room context Editor"),
    ).toBeVisible();
    fireEvent.pointerEnter(sharedLink);
    sharedLink.focus();
    expect(preload).toHaveBeenCalled();
    expect(
      runtime.server.requestsTo("GET", "/v0/documents/{documentId}"),
    ).toHaveLength(0);
    expect(screen.getByRole("tree", { name: "Shared with me" })).toHaveClass(
      "ml-4",
    );
    expect(screen.queryByRole("link", { name: "Shared with me" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Actions for shared document Shared roadmap",
      }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Copy link" }),
    ).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Download" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    await chooseMenuAction("Organize Shared with me", "New folder");
    const rename = await screen.findByRole("textbox", {
      name: "Rename shared folder",
    });
    expect(rename).toHaveFocus();
    expect(rename).toHaveProperty("selectionStart", 0);
    fireEvent.change(rename, { target: { value: "Roadmaps" } });
    fireEvent.keyDown(rename, { key: "Enter" });
    expect(
      await screen.findByRole("treeitem", { name: "Roadmaps" }),
    ).toBeVisible();

    const transfer = createDataTransfer();
    const readDragData = transfer.getData.bind(transfer);
    let dragDataProtected = false;
    transfer.getData = (type: string) =>
      dragDataProtected ? "" : readDragData(type);
    const sharedTreeItem = screen.getByRole("treeitem", {
      name: "Shared drag sample",
    });
    const sharedFolder = screen.getByRole("treeitem", { name: "Drop zone" });
    fireEvent.dragStart(sharedTreeItem, { dataTransfer: transfer });
    dragDataProtected = true;
    expect(fireEvent.dragOver(sharedFolder, { dataTransfer: transfer })).toBe(
      false,
    );
    dragDataProtected = false;
    expect(readDragData("application/x-linger-shared-placement")).toBe(
      "shared-document-drag",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("treeitem", { name: "Drop zone" }).firstElementChild,
      ).toHaveClass("bg-app-selected"),
    );
    fireEvent.drop(screen.getByRole("treeitem", { name: "Drop zone" }), {
      dataTransfer: transfer,
    });
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { parent_id: "shared-folder-drop-zone" },
          params: { documentId: sharedDrag.id, tenantId: "tenant-northstar" },
        }),
      ),
    );
    move.mockClear();

    await chooseMenuAction(
      "Actions for shared document Shared roadmap",
      "Move",
    );
    const sharedMove = screen.getByRole("dialog", {
      name: "Move Shared roadmap to…",
    });
    expect(within(sharedMove).getByText("Current")).toBeVisible();
    expect(
      within(sharedMove).getByRole("button", { name: "Move here" }),
    ).toBeDisabled();
    fireEvent.change(
      within(sharedMove).getByRole("searchbox", { name: "Search folders" }),
      { target: { value: "Roadmaps" } },
    );
    fireEvent.click(
      within(sharedMove).getByRole("button", { name: "Select Roadmaps" }),
    );
    fireEvent.click(
      within(sharedMove).getByRole("button", { name: "Move here" }),
    );
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { parent_id: "shared-folder-roadmaps" },
          params: { documentId: shared.id, tenantId: "tenant-northstar" },
        }),
      ),
    );
  });

  it("keeps Shared with me loading and not-found states actor-private", async () => {
    const loadingRuntime = await signedInRuntime();
    loadingRuntime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/me/shared-document-tree",
      () => new Promise(() => undefined),
    );
    const loading = renderTree(loadingRuntime);
    expect(await screen.findByText("Loading tree…")).toBeVisible();
    expect(screen.queryByRole("tree", { name: "Shared with me" })).toBeNull();
    loading.unmount();

    const missingRuntime = await signedInRuntime();
    missingRuntime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/me/shared-document-tree",
      () =>
        teamHubErrorResponse(
          404,
          "NOT_FOUND",
          "Shared with me is unavailable.",
        ),
    );
    renderTree(missingRuntime);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Shared with me is unavailable.",
    );
    expect(screen.queryByRole("tree", { name: "Shared with me" })).toBeNull();
  });

  it("keeps accessible non-owned Documents out of My pages", async () => {
    const runtime = await signedInRuntime();
    const base = (await listOwnedDocuments(runtime)).items[0]!;
    const shared = {
      ...base,
      capabilities: {
        ...base.capabilities,
        delete: false,
        manage: false,
        write: false,
      },
      from: [
        {
          binding_kind: "room" as const,
          context_id: "room-product",
          label: "Product room",
        },
      ],
      id: "document-shared-design",
      owner: {
        ...base.owner,
        display_name: "Maya Chen",
        id: "actor-maya",
      },
      title: "Shared design",
    };
    seedNativeDocument(runtime, "my-pages-own-document");
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/me/shared-document-tree",
      () => ({ items: [treeDocumentNode(shared)] }),
    );
    const listOwnedOrRecent = await Promise.all(
      (["owned", "recent"] as const).map((view) =>
        teamHubData(
          runtime.client.api.GET("/v0/library/documents", {
            params: { query: { view } },
          }),
        ),
      ),
    );
    runtime.server.on("GET", "/v0/library/documents", ({ query }) =>
      query.get("view") === "shared"
        ? { items: [shared], page: { has_more: false } }
        : listOwnedOrRecent[query.get("view") === "owned" ? 0 : 1],
    );
    renderPage(runtime);
    fireEvent.click(await screen.findByRole("tab", { name: "Shared with me" }));

    const sharedList = await screen.findByLabelText("Shared with me documents");
    expect(
      within(sharedList).getByRole("link", { name: documentFileName(shared) }),
    ).toBeVisible();
    expect(
      within(sharedList).getByText("Visible in Product room"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "My pages" }));
    const ownList = await screen.findByLabelText("My pages documents");
    expect(
      within(ownList).getByRole("link", { name: "untitled.md" }),
    ).toBeVisible();
    expect(ownList).not.toHaveTextContent("Shared design");
  });

  it("renders Owned by Me summaries without per-node Document detail reads", async () => {
    const runtime = await signedInRuntime();
    seedNativeDocument(runtime, "owned-tree-summary-without-detail-read");
    renderTree(runtime);

    expect(
      within(
        await screen.findByRole("tree", { name: "Owned by Me" }),
      ).getAllByRole("link", { name: "untitled.md" })[0],
    ).toBeVisible();
    expect(
      runtime.server.requestsTo("GET", "/v0/documents/{documentId}"),
    ).toHaveLength(0);
  });

  it.each([
    ["Recent", null, "recent", "No recently updated documents"],
    ["My pages", "My pages", "owned", "No documents created by you"],
    [
      "Shared with me",
      "Shared with me",
      "shared",
      "No documents shared with you",
    ],
  ] as const)(
    "loads the %s Workspace list through the canonical Document list",
    async (_name, tab, view, emptyText) => {
      const runtime = await signedInRuntime();
      runtime.server.on("GET", "/v0/library/documents", () => ({
        items: [],
        page: { has_more: false },
      }));
      renderPage(runtime);

      if (tab) fireEvent.click(screen.getByRole("tab", { name: tab }));

      expect((await screen.findAllByText(emptyText))[0]).toBeVisible();
      await waitFor(() =>
        expect(
          runtime.server
            .requestsTo("GET", "/v0/library/documents")
            .map((request) =>
              Object.fromEntries(new URL(request.url).searchParams),
            ),
        ).toContainEqual(expect.objectContaining({ limit: "50", view })),
      );
    },
  );

  it("does not expose Favorite controls or views", async () => {
    const runtime = await signedInRuntime();
    renderPage(runtime);

    expect(await screen.findByRole("tab", { name: "My pages" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Favorites" })).toBeNull();
    expect(screen.queryByLabelText(/Favorites/i)).toBeNull();
  });

  it("names missing context only when another listed Document has one", async () => {
    const runtime = await signedInRuntime();
    seedNativeDocument(runtime, "unlinked-row");
    const linked = seedNativeDocument(runtime, "linked-row");
    linked.title = "Linked plan";
    linked.from = [
      { binding_kind: "room", context_id: "room-all", label: "Planning" },
    ];
    renderPage(runtime);

    const files = await screen.findByLabelText("My pages documents");
    expect(await within(files).findByText("Visible in Planning")).toBeVisible();
    expect(within(files).getByText("No linked context")).toBeVisible();
  });

  it("renders Workspace file rows with owner, time, download, and more actions", async () => {
    const runtime = await signedInRuntime();
    const seeded = seedNativeDocument(runtime, "workspace-file-row");
    const document = (await listOwnedDocuments(runtime)).items.find(
      (item) => item.id === seeded.id,
    )!;
    renderPage(runtime);

    const files = await screen.findByLabelText("My pages documents");
    expect(
      within(files).getByRole("link", { name: documentFileName(document) }),
    ).toBeVisible();
    // With no Document in the list linked anywhere, the row says nothing about it.
    expect(within(files).queryByText("No linked context")).toBeNull();
    expect(within(files).getByText(document.owner.display_name)).toBeVisible();
    // Download lives in the row's actions menu, not as its own button.
    expect(
      within(files).queryByRole("button", {
        name: `Download ${documentFileName(document)}`,
      }),
    ).toBeNull();
    expect(
      within(files).getByRole("button", {
        name: `Actions for ${document.title}`,
      }),
    ).toBeVisible();
    expect(files.querySelector("time")).toHaveAttribute(
      "dateTime",
      document.updated_at,
    );
    expect(files.querySelector("time")?.textContent).toBe(
      formatUpdatedAt(document.updated_at),
    );
  });

  it("reuses the complete detail menu and canonical delete confirmation from Recent", async () => {
    const runtime = await signedInRuntime();
    const document = seedNativeDocument(runtime, "overview-menu-document");
    const trash = declareTrashResponse(runtime, document);
    renderPage(runtime);
    const recent = await screen.findByRole("region", { name: "Recent" });
    fireEvent.click(
      await within(recent).findByRole("button", {
        name: `Actions for ${document.title}`,
      }),
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "Copy link",
      "Rename",
      "Download",
      "Duplicate",
      "Page history",
      "Delete",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete Document?",
    });
    expect(trash).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(trash).toHaveBeenCalledWith(
        expect.objectContaining({ params: { documentId: document.id } }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryAllByRole("button", {
          name: `Actions for ${document.title}`,
        }),
      ).toEqual([]),
    );
  });

  it("keeps detail menu permissions and Copy to My Documents in the Shared tab", async () => {
    const runtime = await signedInRuntime();
    const base = (await listOwnedDocuments(runtime)).items[0]!;
    const shared = {
      ...base,
      id: "shared-menu-document",
      title: "Shared menu document",
      owner: { ...base.owner, id: "another-owner" },
      capabilities: {
        ...base.capabilities,
        write: false,
        manage: false,
        delete: false,
        export: false,
        duplicate: true,
      },
    };
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/me/shared-document-tree",
      () => ({ items: [treeDocumentNode(shared)] }),
    );
    runtime.server.on("GET", "/v0/library/documents", () => ({
      items: [shared],
      page: { has_more: false },
    }));
    renderPage(runtime);
    fireEvent.click(screen.getByRole("tab", { name: "Shared with me" }));
    fireEvent.click(
      within(
        await screen.findByLabelText("Shared with me documents"),
      ).getByRole("button", {
        name: `Actions for ${shared.title}`,
      }),
    );
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Download" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toBeEnabled();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy to My Documents" }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: "Copy to My Documents",
      }),
    ).toBeVisible();
  });

  it("creates a Folder first, then selects its inline name for editing", async () => {
    const runtime = await signedInRuntime();
    declareFolderResponse(runtime, "New Folder");
    declareFolderRename(runtime, "Roadmaps");
    renderTree(runtime);

    await chooseCreateAction("New folder");
    const input = await screen.findByRole("textbox", { name: "Rename folder" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("New Folder");
    expect(input).toHaveProperty("selectionStart", 0);
    expect(input).toHaveProperty("selectionEnd", "New Folder".length);
    fireEvent.change(input, { target: { value: "Roadmaps" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      await screen.findByRole("treeitem", { name: "Roadmaps" }),
    ).toBeVisible();
  });

  it("creates and inline-renames a nested Folder from the parent Folder menu", async () => {
    const runtime = await signedInRuntime();
    const parent = seedFolder(runtime, "nested-folder-parent", {
      name: "Plans",
    });
    declareFolderResponse(runtime, "New Folder", parent.id);
    declareFolderRename(runtime, "Milestones");
    renderTree(runtime);

    await chooseNodeAction("Plans", "New folder");
    const input = await screen.findByRole("textbox", { name: "Rename folder" });
    fireEvent.change(input, { target: { value: "Milestones" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      await screen.findByRole("treeitem", { name: "Milestones" }),
    ).toBeVisible();
    await expect(readMyDocumentTree(runtime)).resolves.toEqual({
      items: expect.arrayContaining([
        expect.objectContaining({
          name: "Milestones",
          parent_id: parent.id,
        }),
      ]),
    });
  });

  it("creates a nested Markdown page from the parent Folder menu", async () => {
    const runtime = await signedInRuntime();
    const parent = seedFolder(runtime, "nested-page-parent", {
      name: "Plans",
    });
    const createdResponse = seedNativeDocument(runtime, "created-nested-page", {
      parent_id: parent.id,
    });
    const placement = documentSeeds(runtime).tree.items.pop()!;
    const createDocument = vi.fn(() => {
      documentSeeds(runtime).tree.items.push(placement);
      return createdResponse;
    });
    runtime.server.on(
      "POST",
      "/v0/tenants/{tenantId}/documents",
      createDocument,
    );
    const bound = {
      ...createdResponse,
      from: [
        { binding_kind: "wiki_source" as const, context_id: "wiki-jenny" },
      ],
    };
    const bindWiki = vi.fn(() => {
      showDocument(runtime, bound);
      return bound;
    });
    runtime.server.on(
      "PUT",
      "/v0/tenants/{tenantId}/personal-wiki/documents/{documentId}",
      bindWiki,
    );
    const { router } = renderTree(runtime);

    await chooseNodeAction("Plans", "New file");
    fireEvent.click(await screen.findByRole("menuitem", { name: "md" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/\/documents\/document-/u),
    );
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { parent_id: parent.id, representation_format: "markdown" },
        params: { tenantId: "tenant-northstar" },
      }),
    );
    const created = createdResponse;
    expect(bindWiki).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { documentId: created.id, tenantId: "tenant-northstar" },
      }),
    );
    await expect(readDocument(runtime.client, created.id)).resolves.toEqual(
      expect.objectContaining({
        from: expect.arrayContaining([
          expect.objectContaining({ binding_kind: "wiki_source" }),
        ]),
      }),
    );
    await expect(readMyDocumentTree(runtime)).resolves.toEqual({
      items: expect.arrayContaining([
        expect.objectContaining({
          node_kind: "document",
          parent_id: parent.id,
        }),
      ]),
    });
  });

  it("imports a My pages file as a versioned Wiki source", async () => {
    const runtime = await signedInRuntime();
    const upload = vi.spyOn(runtime.client, "uploadPersonalWikiDocument");
    await declareWikiUpload(runtime, "notes.md", "markdown");
    renderTree(runtime);

    fireEvent.click(
      screen.getByRole("button", { name: "Create in Owned by Me" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Import" }));
    const input = document.querySelector('input[hidden][type="file"]');
    expect(input).toBeTruthy();
    fireEvent.change(input!, {
      target: {
        files: [new File(["# Notes\n"], "notes.md", { type: "text/markdown" })],
      },
    });

    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    const uploaded = await upload.mock.results[0]?.value;
    expect(uploaded).toEqual(
      expect.objectContaining({
        current_version: expect.objectContaining({ version_number: 1 }),
        from: [expect.objectContaining({ binding_kind: "wiki_source" })],
        title: "notes.md",
      }),
    );
  });

  it("offers Markdown but no native HTML creation in folders", async () => {
    const runtime = await signedInRuntime();
    seedFolder(runtime, "native-html-parent", { name: "HTML Plans" });
    const uploadWiki = vi.spyOn(runtime.client, "uploadPersonalWikiDocument");
    renderTree(runtime);

    await chooseNodeAction("HTML Plans", "New file");
    expect(await screen.findByRole("menuitem", { name: "md" })).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "html" }),
    ).not.toBeInTheDocument();
    expect(
      runtime.server.requestsTo("POST", "/v0/tenants/{tenantId}/documents"),
    ).toHaveLength(0);
    expect(
      runtime.server.requestsTo(
        "POST",
        "/v0/tenants/{tenantId}/documents/uploads",
      ),
    ).toHaveLength(0);
    expect(uploadWiki).not.toHaveBeenCalled();
    expect(
      runtime.server.requestsTo(
        "PUT",
        "/v0/tenants/{tenantId}/personal-wiki/documents/{documentId}",
      ),
    ).toHaveLength(0);
  });

  it("projects one logical native title as a format-aware tree filename", async () => {
    const runtime = await signedInRuntime();
    const document = seedNativeDocument(runtime, "logical-title", {
      representation_format: "markdown",
    });
    renderTree(runtime);

    expect(document.title).toBe("untitled");
    expect(document.representation_format).toBe("markdown");
    expect(
      await screen.findByRole("treeitem", { name: "untitled.md" }),
    ).toBeVisible();
  });

  it("keeps the created Folder when its initial rename is canceled", async () => {
    const runtime = await signedInRuntime();
    declareFolderResponse(runtime, "New Folder");
    renderTree(runtime);

    await chooseCreateAction("New folder");
    fireEvent.keyDown(
      await screen.findByRole("textbox", { name: "Rename folder" }),
      { key: "Escape" },
    );

    expect(
      screen.queryByRole("textbox", { name: "Rename folder" }),
    ).not.toBeInTheDocument();
    expect(
      runtime.server.requestsTo(
        "POST",
        "/v0/tenants/{tenantId}/me/document-folders",
      ),
    ).toHaveLength(1);
    expect(screen.getByRole("treeitem", { name: "New Folder" })).toBeVisible();
  });

  it("selects the next available default name when New Folder already exists", async () => {
    const runtime = await signedInRuntime();
    seedFolder(runtime, "folder-existing-default", {
      name: "New Folder",
    });
    declareFolderResponse(runtime, "New Folder 2");
    renderTree(runtime);

    await chooseCreateAction("New folder");

    const input = await screen.findByRole("textbox", { name: "Rename folder" });
    expect(input).toHaveValue("New Folder 2");
    expect(input).toHaveProperty("selectionStart", 0);
    expect(input).toHaveProperty("selectionEnd", "New Folder 2".length);
  });

  it("keeps a blank initial Folder rename editable without a second mutation", async () => {
    const runtime = await signedInRuntime();
    declareFolderResponse(runtime, "New Folder");
    renderTree(runtime);

    await chooseCreateAction("New folder");
    const input = await screen.findByRole("textbox", { name: "Rename folder" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      runtime.server.requestsTo(
        "POST",
        "/v0/tenants/{tenantId}/me/document-folders",
      ),
    ).toHaveLength(1);
    expect(
      runtime.server.requestsTo(
        "PATCH",
        "/v0/tenants/{tenantId}/me/document-placements/{placementId}",
      ),
    ).toHaveLength(0);
    expect(input).toHaveFocus();
  });

  it("does not render a Folder draft when creation fails", async () => {
    const runtime = await signedInRuntime();
    runtime.server.on(
      "POST",
      "/v0/tenants/{tenantId}/me/document-folders",
      () =>
        teamHubErrorResponse(
          503,
          "FOLDER_CREATION_UNAVAILABLE",
          "Folder creation is unavailable.",
        ),
    );
    renderTree(runtime);

    await chooseCreateAction("New folder");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Folder creation is unavailable.",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("No documents yet.")).toBeVisible();
  });

  it("renames a personal Folder inline without changing its placement identity", async () => {
    const runtime = await signedInRuntime();
    const folder = seedFolder(runtime, "folder-rename-create", {
      name: "Plans",
    });
    const updated = { ...folder, name: "Roadmaps" };
    respondToPlacementUpdate(runtime, () => {
      documentSeeds(runtime).tree.items = [updated];
      return updated;
    });
    renderTree(runtime);

    await chooseNodeAction("Plans", "Rename");
    const input = screen.getByRole("textbox", { name: "Rename folder" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "Roadmaps" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      await screen.findByRole("treeitem", { name: "Roadmaps" }),
    ).toBeVisible();
    await expect(readMyDocumentTree(runtime)).resolves.toEqual({
      items: expect.arrayContaining([
        expect.objectContaining({ id: folder.id, name: "Roadmaps" }),
      ]),
    });
  });

  it("cancels a Folder rename with Escape", async () => {
    const runtime = await signedInRuntime();
    seedFolder(runtime, "folder-rename-cancel", { name: "Plans" });
    renderTree(runtime);

    await chooseNodeAction("Plans", "Rename");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename folder" }), {
      key: "Escape",
    });

    expect(
      screen.queryByRole("textbox", { name: "Rename folder" }),
    ).not.toBeInTheDocument();
    expect(
      runtime.server.requestsTo(
        "PATCH",
        "/v0/tenants/{tenantId}/me/document-placements/{placementId}",
      ),
    ).toHaveLength(0);
  });

  it("keeps a blank Folder rename editable without sending a mutation", async () => {
    const runtime = await signedInRuntime();
    seedFolder(runtime, "folder-rename-blank", { name: "Plans" });
    renderTree(runtime);

    await chooseNodeAction("Plans", "Rename");
    const input = screen.getByRole("textbox", { name: "Rename folder" });
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      runtime.server.requestsTo(
        "PATCH",
        "/v0/tenants/{tenantId}/me/document-placements/{placementId}",
      ),
    ).toHaveLength(0);
    expect(input).toHaveFocus();
  });

  it("keeps a failed Folder rename editable and exposes the error", async () => {
    const runtime = await signedInRuntime();
    seedFolder(runtime, "folder-rename-failure", { name: "Plans" });
    respondToPlacementUpdate(runtime, () =>
      teamHubErrorResponse(
        503,
        "FOLDER_RENAME_UNAVAILABLE",
        "Folder rename is unavailable.",
      ),
    );
    renderTree(runtime);

    await chooseNodeAction("Plans", "Rename");
    const input = screen.getByRole("textbox", { name: "Rename folder" });
    fireEvent.change(input, { target: { value: "Roadmaps" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Folder rename is unavailable.",
    );
    expect(screen.getByRole("textbox", { name: "Rename folder" })).toHaveValue(
      "Roadmaps",
    );
  });

  it("deletes an empty personal Folder and removes it from the ARIA tree", async () => {
    const runtime = await signedInRuntime();
    const folder = seedFolder(runtime, "folder-delete-create", {
      name: "Scratch",
    });
    runtime.server.on(
      "DELETE",
      "/v0/tenants/{tenantId}/me/document-folders/{placementId}",
      () => {
        documentSeeds(runtime).tree.items = [];
      },
    );
    renderTree(runtime);

    await chooseNodeAction("Scratch", "Delete");

    await waitFor(() => {
      expect(
        screen.queryByRole("treeitem", { name: "Scratch" }),
      ).not.toBeInTheDocument();
    });
    await expect(readMyDocumentTree(runtime)).resolves.toEqual({
      items: expect.not.arrayContaining([
        expect.objectContaining({ id: folder.id }),
      ]),
    });
  });

  it("keeps a Folder visible when deletion fails", async () => {
    const runtime = await signedInRuntime();
    seedFolder(runtime, "folder-delete-failure", { name: "Scratch" });
    runtime.server.on(
      "DELETE",
      "/v0/tenants/{tenantId}/me/document-folders/{placementId}",
      () =>
        teamHubErrorResponse(
          503,
          "FOLDER_DELETION_UNAVAILABLE",
          "Folder deletion is unavailable.",
        ),
    );
    renderTree(runtime);

    await chooseNodeAction("Scratch", "Delete");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Folder deletion is unavailable.",
    );
    expect(screen.getByRole("treeitem", { name: "Scratch" })).toBeVisible();
  });

  it("moves a Folder inside the personal tree without changing its identity", async () => {
    const runtime = await signedInRuntime();
    const projects = seedFolder(runtime, "folder-projects-create", {
      name: "Projects",
    });
    const drafts = seedFolder(runtime, "folder-drafts-create", {
      name: "Drafts",
    });
    const moved = { ...drafts, parent_id: projects.id };
    respondToPlacementUpdate(runtime, () => {
      documentSeeds(runtime).tree.items = [projects, moved];
      return moved;
    });
    renderTree(runtime);

    expect(
      await screen.findByRole("tree", { name: "Owned by Me" }),
    ).toHaveClass("ml-4");
    await chooseNodeAction("Drafts", "Move");
    const moveDialog = screen.getByRole("dialog", {
      name: "Move Drafts to…",
    });
    expect(
      within(moveDialog).getByRole("button", { name: "Select Projects" }),
    ).toBeVisible();
    expect(
      within(moveDialog).queryByRole("button", { name: "Select Drafts" }),
    ).toBeNull();
    fireEvent.click(
      within(moveDialog).getByRole("button", { name: "Select Projects" }),
    );
    fireEvent.click(
      within(moveDialog).getByRole("button", { name: "Move here" }),
    );

    await waitFor(async () => {
      await expect(readMyDocumentTree(runtime)).resolves.toEqual({
        items: expect.arrayContaining([
          expect.objectContaining({
            id: drafts.id,
            parent_id: projects.id,
          }),
        ]),
      });
    });
    expect(screen.getByRole("treeitem", { name: "Projects" })).toContainElement(
      screen.getByRole("treeitem", { name: "Drafts" }),
    );
  });

  it("keeps the current Placement when a Folder move fails", async () => {
    const runtime = await signedInRuntime();
    seedFolder(runtime, "folder-move-failure-projects", {
      name: "Projects",
    });
    seedFolder(runtime, "folder-move-failure-drafts", { name: "Drafts" });
    respondToPlacementUpdate(runtime, () =>
      teamHubErrorResponse(
        503,
        "FOLDER_MOVE_UNAVAILABLE",
        "Folder move is unavailable.",
      ),
    );
    renderTree(runtime);

    await chooseNodeAction("Drafts", "Move");
    const moveDialog = screen.getByRole("dialog", {
      name: "Move Drafts to…",
    });
    fireEvent.click(
      within(moveDialog).getByRole("button", { name: "Select Projects" }),
    );
    fireEvent.click(
      within(moveDialog).getByRole("button", { name: "Move here" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Folder move is unavailable.",
    );
    const personalTree = screen.getByRole("tree", { name: "Owned by Me" });
    expect(
      within(personalTree).getByRole("treeitem", { name: "Projects" }),
    ).not.toContainElement(
      within(personalTree).getByRole("treeitem", { name: "Drafts" }),
    );
  });

  it("supports keyboard expansion and descendant focus in the ARIA tree", async () => {
    const runtime = await signedInRuntime();
    const projects = seedFolder(runtime, "keyboard-projects-create", {
      name: "Projects",
    });
    seedFolder(runtime, "keyboard-drafts-create", {
      name: "Drafts",
      parent_id: projects.id,
    });
    renderTree(runtime);

    const parent = await screen.findByRole("treeitem", { name: "Projects" });
    parent.focus();
    fireEvent.keyDown(parent, { key: "ArrowLeft" });
    expect(parent).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("treeitem", { name: "Drafts" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(parent, { key: "ArrowRight" });
    expect(parent).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(parent, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { name: "Drafts" })).toHaveFocus();
  });

  it.each([
    ["Charlie", "ArrowDown", "Bravo"],
    ["Bravo", "ArrowUp", "Charlie"],
    ["Alpha", "Home", "Charlie"],
  ] as const)(
    "moves tree focus through the rendered order from %s with %s",
    async (initialName, key, expectedName) => {
      const runtime = await signedInRuntime();
      for (const [index, name] of ["Alpha", "Bravo", "Charlie"].entries()) {
        seedFolder(runtime, `library-tree-keyboard-${index}-12345678`, {
          name,
        });
      }
      renderTree(runtime);
      const initial = await screen.findByRole("treeitem", {
        name: initialName,
      });
      initial.focus();

      fireEvent.keyDown(initial, { key });

      expect(
        screen.getByRole("treeitem", { name: expectedName }),
      ).toHaveFocus();
    },
  );

  it.each(["Enter", " "])("toggles a Folder with the %s key", async (key) => {
    const runtime = await signedInRuntime();
    const parent = seedFolder(
      runtime,
      `library-tree-toggle-${key === " " ? "space" : "enter"}-parent-12345678`,
      { name: "Projects" },
    );
    seedFolder(
      runtime,
      `library-tree-toggle-${key === " " ? "space" : "enter"}-child-12345678`,
      { name: "Drafts", parent_id: parent.id },
    );
    renderTree(runtime);
    const treeitem = await screen.findByRole("treeitem", { name: "Projects" });
    treeitem.focus();

    fireEvent.keyDown(treeitem, { key });

    expect(treeitem).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("treeitem", { name: "Drafts" }),
    ).not.toBeInTheDocument();
  });

  it("moves an owned Document by dropping it on a legal Folder target", async () => {
    const runtime = await signedInRuntime();
    const folder = seedFolder(runtime, "drag-drop-target-folder", {
      name: "Drop target",
    });
    seedNativeDocument(runtime, "drag-drop-source-document");
    renderTree(runtime);
    const source = await screen.findByRole("treeitem", { name: "untitled.md" });
    const target = screen.getByRole("treeitem", { name: "Drop target" });
    const transfer = createDataTransfer();
    const readDragData = transfer.getData.bind(transfer);
    let dragDataProtected = false;
    transfer.getData = (type: string) =>
      dragDataProtected ? "" : readDragData(type);

    fireEvent.dragStart(source, { dataTransfer: transfer });
    dragDataProtected = true;
    expect(fireEvent.dragOver(target, { dataTransfer: transfer })).toBe(false);
    dragDataProtected = false;
    fireEvent.drop(target, { dataTransfer: transfer });

    await waitFor(async () =>
      expect(
        await sentBodies(
          runtime,
          "PATCH",
          "/v0/tenants/{tenantId}/me/document-placements/{placementId}",
        ),
      ).toContainEqual({ parent_id: folder.id }),
    );
  });

  it("uploads external OS files into Owned by Me root in stable order", async () => {
    const runtime = await signedInRuntime();
    const upload = vi.spyOn(runtime.client, "uploadPersonalWikiDocument");
    await declareWikiUpload(runtime, "first.md", "markdown");
    await declareWikiUpload(runtime, "second.txt", "plain_text");
    renderTree(runtime);
    const root = screen.getByRole("region", { name: "Owned by Me tree" });
    const files = [
      new File(["# First"], "first.md", { type: "text/markdown" }),
      new File(["second"], "second.txt", { type: "text/plain" }),
    ];
    const transfer = createDataTransfer(files);

    fireEvent.dragEnter(root, { dataTransfer: transfer });
    expect(screen.queryByRole("status")).toBeNull();
    expect(root).not.toHaveClass("bg-app-selected/60");
    fireEvent.drop(root, { dataTransfer: transfer });

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls.map((call) => call[1].file.name)).toEqual([
      "first.md",
      "second.txt",
    ]);
    expect(upload.mock.calls[0]?.[1].representationFormat).toBe("markdown");
    expect(upload.mock.calls[1]?.[1].representationFormat).toBe("plain_text");
    const uploaded = await Promise.all(
      upload.mock.results.map((result) => result.value),
    );
    expect(uploaded).toEqual([
      expect.objectContaining({
        current_version: expect.objectContaining({ version_number: 1 }),
        from: [expect.objectContaining({ binding_kind: "wiki_source" })],
        title: "first.md",
      }),
      expect.objectContaining({
        current_version: expect.objectContaining({ version_number: 1 }),
        from: [expect.objectContaining({ binding_kind: "wiki_source" })],
        title: "second.txt",
      }),
    ]);
  });

  it("uploads OS files dropped on the Workspace file area into My pages", async () => {
    const runtime = await signedInRuntime();
    const upload = vi.spyOn(runtime.client, "uploadPersonalWikiDocument");
    await declareWikiUpload(runtime, "dropped.md", "markdown");
    renderPage(runtime);
    const target = await screen.findByTestId("workspace-file-drop-target");
    const file = new File(["# Dropped"], "dropped.md", {
      type: "text/markdown",
    });
    const transfer = createDataTransfer([file]);

    await waitFor(() => {
      fireEvent.dragEnter(target, { dataTransfer: transfer });
      expect(screen.getByText("Release to upload to My pages")).toBeVisible();
    });
    fireEvent.drop(target, { dataTransfer: transfer });

    expect(screen.queryByText("Release to upload to My pages")).toBeNull();
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    expect(upload.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ file, representationFormat: "markdown" }),
    );
    expect(upload.mock.calls[0]?.[1]).not.toHaveProperty("parentId");
  });

  it("hides the Workspace drop overlay on dragleave and ignores in-app drags", async () => {
    const runtime = await signedInRuntime();
    renderPage(runtime);
    const target = await screen.findByTestId("workspace-file-drop-target");
    const transfer = createDataTransfer([new File(["x"], "x.txt")]);

    await waitFor(() => {
      fireEvent.dragEnter(target, { dataTransfer: transfer });
      expect(screen.getByText("Release to upload to My pages")).toBeVisible();
    });
    fireEvent.dragLeave(target, { dataTransfer: transfer });
    expect(screen.queryByText("Release to upload to My pages")).toBeNull();

    const internal = createDataTransfer();
    internal.setData("application/x-linger-placement", "placement-1");
    fireEvent.dragEnter(target, { dataTransfer: internal });
    expect(screen.queryByText("Release to upload to My pages")).toBeNull();
  });

  it("does not accept dropped files outside My pages", async () => {
    const runtime = await signedInRuntime();
    const upload = vi.spyOn(runtime.client, "uploadPersonalWikiDocument");
    renderPage(runtime);
    fireEvent.click(await screen.findByRole("tab", { name: "Shared with me" }));
    const target = screen.getByTestId("workspace-file-drop-target");
    const transfer = createDataTransfer([new File(["x"], "x.txt")]);

    fireEvent.dragEnter(target, { dataTransfer: transfer });
    expect(screen.queryByText("Release to upload to My pages")).toBeNull();
    fireEvent.drop(target, { dataTransfer: transfer });
    expect(upload).not.toHaveBeenCalled();
  });

  it("uploads Excel and PowerPoint into My pages with Office representation formats", async () => {
    const runtime = await signedInRuntime();
    const upload = vi.spyOn(runtime.client, "uploadPersonalWikiDocument");
    await declareWikiUpload(runtime, "budget.xlsx", "xlsx");
    await declareWikiUpload(runtime, "deck.pptx", "pptx");
    renderTree(runtime);
    const root = screen.getByRole("region", { name: "Owned by Me tree" });
    const files = [
      new File(["workbook"], "budget.xlsx"),
      new File(["slides"], "deck.pptx"),
    ];
    fireEvent.drop(root, { dataTransfer: createDataTransfer(files) });

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls.map((call) => call[1].file.name)).toEqual([
      "budget.xlsx",
      "deck.pptx",
    ]);
    expect(upload.mock.calls[0]?.[1].representationFormat).toBe("xlsx");
    expect(upload.mock.calls[1]?.[1].representationFormat).toBe("pptx");
  });

  it("adds incremental suffixes when uploaded filenames already exist", async () => {
    const runtime = await signedInRuntime();
    const upload = vi.spyOn(runtime.client, "uploadPersonalWikiDocument");
    await declareWikiUpload(runtime, "sample.md", "markdown");
    await declareWikiUpload(runtime, "sample (2).md", "markdown");
    await declareWikiUpload(runtime, "sample (3).md", "markdown");
    renderTree(runtime);
    const root = screen.getByRole("region", { name: "Owned by Me tree" });
    const uploadSample = () =>
      fireEvent.drop(root, {
        dataTransfer: createDataTransfer([
          new File(["sample"], "sample.md", { type: "text/markdown" }),
        ]),
      });

    uploadSample();
    await screen.findByRole("link", { name: "sample.md" });
    uploadSample();
    await screen.findByRole("link", { name: "sample (2).md" });
    uploadSample();
    await screen.findByRole("link", { name: "sample (3).md" });
    expect(upload.mock.calls.map((call) => call[1].file.name)).toEqual([
      "sample.md",
      "sample (2).md",
      "sample (3).md",
    ]);
  });

  it("projects queued and uploading rows until an external upload settles", async () => {
    const runtime = await signedInRuntime();
    const uploaded = await seedRoomUpload(
      runtime,
      "pending",
      {
        file: new File(["video"], "pending.mp4", { type: "video/mp4" }),
        representationFormat: "binary",
      },
      "wiki-jenny",
    );
    const placement = documentSeeds(runtime).tree.items.pop()!;
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    vi.spyOn(runtime.client, "uploadPersonalWikiDocument").mockImplementation(
      async () => {
        await uploadGate;
        documentSeeds(runtime).tree.items.push(placement);
        return uploaded;
      },
    );
    renderTree(runtime);
    const root = screen.getByRole("region", { name: "Owned by Me tree" });
    // The queued row lasts one paint; wait for the initial tree before dropping.
    await within(root).findByText("No documents yet.");
    const transfer = createDataTransfer([
      new File(["video"], "pending.mp4", { type: "video/mp4" }),
    ]);

    fireEvent.drop(root, { dataTransfer: transfer });
    expect(
      await screen.findByRole("treeitem", {
        name: "pending.mp4 upload queued",
      }),
    ).toBeVisible();
    expect(
      await screen.findByRole("treeitem", {
        name: "pending.mp4 upload uploading",
      }),
    ).toBeVisible();
    releaseUpload();

    await waitFor(() =>
      expect(
        screen.queryByRole("treeitem", { name: /pending\.mp4 upload/ }),
      ).toBeNull(),
    );
    expect(
      await screen.findByRole("link", { name: "pending.mp4" }),
    ).toBeVisible();
  });

  it("uploads an external file into a nested Folder and clears on Escape", async () => {
    const runtime = await signedInRuntime();
    const folder = seedFolder(runtime, "external-drop-folder", {
      name: "Incoming",
    });
    const upload = vi.spyOn(runtime.client, "uploadPersonalWikiDocument");
    await declareWikiUpload(runtime, "asset.bin", "binary", folder.id);
    renderTree(runtime);
    const target = await screen.findByRole("treeitem", { name: "Incoming" });
    const transfer = createDataTransfer([new File(["x"], "asset.bin")]);

    fireEvent.dragEnter(target, { dataTransfer: transfer });
    expect(target.firstElementChild).toHaveClass("bg-app-selected");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(target.firstElementChild).not.toHaveClass("bg-app-selected");
    fireEvent.dragEnter(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });

    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    expect(upload).toHaveBeenCalledWith(
      "tenant-northstar",
      expect.objectContaining({ parentId: folder.id }),
      expect.any(String),
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
  });

  it("clears the external Folder ghost when the pointer leaves its bounds", async () => {
    const runtime = await signedInRuntime();
    seedFolder(runtime, "external-leave-folder", {
      name: "Leave target",
    });
    renderTree(runtime);
    const target = await screen.findByRole("treeitem", {
      name: "Leave target",
    });
    const transfer = createDataTransfer([new File(["x"], "asset.bin")]);

    fireEvent.dragEnter(target, { dataTransfer: transfer });
    expect(target.firstElementChild).toHaveClass("bg-app-selected");
    fireEvent.dragEnter(target.querySelector("button")!, {
      dataTransfer: transfer,
    });
    fireEvent.dragLeave(target, {
      dataTransfer: transfer,
      relatedTarget: null,
    });

    expect(target.firstElementChild).not.toHaveClass("bg-app-selected");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps uploading the rest of a drop after one file fails and names the failure", async () => {
    const runtime = await signedInRuntime();
    await declareWikiUpload(runtime, "one.txt", "plain_text");
    const upload = vi
      .spyOn(runtime.client, "uploadPersonalWikiDocument")
      .mockRejectedValueOnce(new Error("Second upload failed safely."));
    renderTree(runtime);
    const root = screen.getByRole("region", { name: "Owned by Me tree" });
    const transfer = createDataTransfer([
      new File(["one"], "one.txt"),
      new File(["two"], "two.txt"),
      new File(["three"], "three.txt"),
    ]);

    fireEvent.drop(root, { dataTransfer: transfer });

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "two.txt: Second upload failed safely.",
    );
    expect(upload.mock.calls.map((call) => call[1].file.name)).toEqual([
      "one.txt",
      "two.txt",
      "three.txt",
    ]);
    expect(screen.queryByRole("treeitem", { name: /upload/ })).toBeNull();
  });

  it("reports a Files drop with no supported file entries", async () => {
    const runtime = await signedInRuntime();
    renderTree(runtime);
    const root = screen.getByRole("region", { name: "Owned by Me tree" });
    const transfer = createDataTransfer([], true);

    fireEvent.drop(root, { dataTransfer: transfer });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No supported files were found in the drop.",
    );
  });

  it("recreates a dropped folder tree and uploads each file into its folder", async () => {
    const runtime = await signedInRuntime();
    seedFolder(runtime, "existing-meetings-folder", { name: "Meetings" });
    const createFolder = mockFolderCreation(runtime);
    const upload = vi.spyOn(runtime.client, "uploadPersonalWikiDocument");
    await declareWikiUpload(runtime, "notes.md", "markdown");
    renderTree(runtime);
    const root = screen.getByRole("region", { name: "Owned by Me tree" });
    await within(root).findByRole("treeitem", { name: "Meetings" });
    const transfer = createEntryTransfer([
      directoryEntry("Meetings", [
        fileEntry(new File(["# Notes"], "notes.md")),
        fileEntry(new File([""], ".DS_Store")),
        directoryEntry("2026", [fileEntry(new File(["x"], "agenda.txt"))]),
      ]),
    ]);

    fireEvent.drop(root, { dataTransfer: transfer });

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(createFolder.mock.calls.map((call) => call[0].body)).toEqual([
      { name: "Meetings (2)" },
      { name: "2026", parent_id: "created-Meetings (2)" },
    ]);
    expect(
      upload.mock.calls.map((call) => [call[1].file.name, call[1].parentId]),
    ).toEqual([
      ["notes.md", "created-Meetings (2)"],
      ["agenda.txt", "created-2026"],
    ]);
  });

  it("keeps uploading other folders when one folder or entry cannot be created or read", async () => {
    const runtime = await signedInRuntime();
    const createFolder = mockFolderCreation(runtime);
    createFolder.mockReturnValueOnce(
      teamHubErrorResponse(409, "FOLDER_NAME_TAKEN", "Folder name is taken."),
    );
    const upload = vi.spyOn(runtime.client, "uploadPersonalWikiDocument");
    await declareWikiUpload(runtime, "kept.md", "markdown");
    renderTree(runtime);
    const root = screen.getByRole("region", { name: "Owned by Me tree" });
    await within(root).findByText("No documents yet.");
    const unreadable = {
      file: (_resolve: unknown, reject: (error: Error) => void) =>
        reject(new Error("Permission denied.")),
      isDirectory: false,
      isFile: true,
      name: "locked.md",
    };
    const transfer = createEntryTransfer([
      directoryEntry("Broken", [fileEntry(new File(["x"], "lost.md"))]),
      directoryEntry("Kept", [
        fileEntry(new File(["# Kept"], "kept.md")),
        unreadable,
        directoryEntry("Empty", []),
      ]),
    ]);

    fireEvent.drop(root, { dataTransfer: transfer });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "3 files could not be uploaded (Kept/locked.md, Broken/, Broken/lost.md)",
    );
    expect(createFolder.mock.calls.map((call) => call[0].body)).toEqual([
      { name: "Broken" },
      { name: "Kept" },
      { name: "Empty", parent_id: "created-Kept" },
    ]);
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ parentId: "created-Kept" }),
    );
  });

  it("uploads a folder chosen from the Library New menu with its relative paths", async () => {
    const runtime = await signedInRuntime();
    const createFolder = mockFolderCreation(runtime);
    const upload = vi.spyOn(runtime.client, "uploadPersonalWikiDocument");
    await declareWikiUpload(runtime, "brief.md", "markdown");
    renderPage(runtime);
    const input = await screen.findByTestId("library-folder-upload-input");
    expect(input).toHaveAttribute("webkitdirectory");
    const files = [
      pickedFile("Reports/brief.md"),
      pickedFile("Reports/.git/config"),
      pickedFile("Reports/Q3/summary.md"),
    ];

    fireEvent.change(input, { target: { files } });

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(createFolder.mock.calls.map((call) => call[0].body)).toEqual([
      { name: "Reports" },
      { name: "Q3", parent_id: "created-Reports" },
    ]);
    expect(upload.mock.calls.map((call) => call[1].parentId)).toEqual([
      "created-Reports",
      "created-Q3",
    ]);
  });

  it("creates a named folder from the Library New menu and browses into it", async () => {
    const runtime = await signedInRuntime();
    const createFolder = mockFolderCreation(runtime);
    const { router } = renderPage(runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: "Create in My pages" }),
    );
    const newFolder = await screen.findByRole("menuitem", {
      name: "New folder",
    });
    await waitFor(() => expect(newFolder).toBeEnabled());
    fireEvent.click(newFolder);
    const name = await screen.findByRole("textbox", { name: "Folder name" });
    expect(name).toHaveValue("New Folder");
    fireEvent.change(name, { target: { value: "Design" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(createFolder).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { name: "Design" },
          params: { tenantId: "tenant-northstar" },
        }),
      ),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open folder Design" }),
    );
    expect(router.state.location.search).toBe("?folder=created-Design");
    expect(
      await screen.findByRole("navigation", { name: "Folder path" }),
    ).toHaveTextContent("My pagesDesign");
    expect(await screen.findByText("This folder is empty")).toBeVisible();
  });

  it("keeps the upload queue visible after leaving and reopening the Library", async () => {
    const runtime = await signedInRuntime();
    let releaseUpload!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const uploaded = await seedRoomUpload(
      runtime,
      "slow",
      {
        file: new File(["# Slow"], "slow.md"),
        representationFormat: "markdown",
      },
      "wiki-jenny",
    );
    const placement = documentSeeds(runtime).tree.items.pop()!;
    vi.spyOn(runtime.client, "uploadPersonalWikiDocument").mockImplementation(
      async () => {
        await gate;
        documentSeeds(runtime).tree.items.push(placement);
        return uploaded;
      },
    );
    const first = renderPage(runtime);
    const target = await screen.findByTestId("workspace-file-drop-target");
    const transfer = createDataTransfer([new File(["# Slow"], "slow.md")]);
    await waitFor(() => {
      fireEvent.dragEnter(target, { dataTransfer: transfer });
      expect(screen.getByText("Release to upload to My pages")).toBeVisible();
    });
    fireEvent.drop(target, { dataTransfer: transfer });
    expect(
      await screen.findByRole("status", { name: "Upload progress" }),
    ).toHaveTextContent("1 file left");
    first.unmount();

    renderPage(runtime);

    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Upload progress" }),
      ).toHaveTextContent("Uploading slow.md"),
    );
    releaseUpload();
    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Upload progress" }),
      ).toBeNull(),
    );
  });

  it("does not treat an internal placement drag as an external upload", async () => {
    const runtime = await signedInRuntime();
    const folder = seedFolder(runtime, "internal-drop-target", {
      name: "Internal target",
    });
    seedNativeDocument(runtime, "internal-drop-source");
    const upload = vi.spyOn(runtime.client, "uploadPersonalWikiDocument");
    renderTree(runtime);
    const source = await screen.findByRole("treeitem", { name: "untitled.md" });
    const target = screen.getByRole("treeitem", { name: "Internal target" });
    const transfer = createDataTransfer();

    fireEvent.dragStart(source, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });

    await waitFor(() =>
      expect(readMyDocumentTree(runtime)).resolves.toEqual(
        expect.objectContaining({ items: expect.any(Array) }),
      ),
    );
    expect(folder.id).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it("moves a personal Document into a Folder without changing its identity", async () => {
    const runtime = await signedInRuntime();
    const document = seedNativeDocument(runtime, "document-create");
    const folder = seedFolder(runtime, "folder-create", {
      name: "Roadmaps",
    });
    const nested = seedFolder(runtime, "folder-nested-create", {
      name: "2026",
      parent_id: folder.id,
    });
    const seeds = documentSeeds(runtime);
    const moved = {
      ...seeds.tree.items.find((item) => item.node_kind === "document")!,
      parent_id: nested.id,
    };
    respondToPlacementUpdate(runtime, () => {
      seeds.tree.items = [folder, nested, moved];
      return moved;
    });
    renderTree(runtime);

    await chooseNodeAction("untitled.md", "Move");
    const moveDialog = screen.getByRole("dialog", {
      name: "Move untitled.md to…",
    });
    expect(
      within(moveDialog).getByRole("button", { name: "Select Roadmaps" }),
    ).toBeVisible();
    expect(within(moveDialog).getByText("Current")).toBeVisible();
    expect(
      within(moveDialog).getByRole("button", { name: "Move here" }),
    ).toBeDisabled();
    fireEvent.change(
      within(moveDialog).getByRole("searchbox", { name: "Search folders" }),
      { target: { value: "2026" } },
    );
    expect(within(moveDialog).getByText("Roadmaps / 2026")).toBeVisible();
    fireEvent.click(
      within(moveDialog).getByRole("button", {
        name: "Select Roadmaps / 2026",
      }),
    );
    fireEvent.click(
      within(moveDialog).getByRole("button", { name: "Move here" }),
    );

    await waitFor(async () => {
      await expect(readMyDocumentTree(runtime)).resolves.toEqual({
        items: expect.arrayContaining([
          expect.objectContaining({
            document_id: document.id,
            parent_id: nested.id,
          }),
        ]),
      });
    });
  });

  it("uses one unclipped action menu per Folder and Document with typed items", async () => {
    const runtime = await signedInRuntime();
    seedFolder(runtime, "menu-folder-create", { name: "Plans" });
    seedNativeDocument(runtime, "menu-document-create");
    renderTree(runtime);

    const folderRow = await screen.findByRole("treeitem", { name: "Plans" });
    const documentRow = await screen.findByRole("treeitem", {
      name: "untitled.md",
    });
    expect(folderRow.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(
      1,
    );
    expect(documentRow.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(
      1,
    );
    expect(within(folderRow).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(documentRow).queryByRole("combobox")).not.toBeInTheDocument();

    fireEvent.click(within(folderRow).getByRole("button", { name: /Actions/ }));
    const folderMenu = await screen.findByRole("menu");
    expect(folderMenu.closest("aside")).toBeNull();
    expect(
      within(folderMenu).getByRole("menuitem", { name: "Rename" }),
    ).toBeVisible();
    expect(
      within(folderMenu).getByRole("menuitem", { name: "Move" }),
    ).toBeVisible();
    expect(
      within(folderMenu).getByRole("menuitem", { name: "Delete" }),
    ).toBeVisible();
    expect(
      within(folderMenu).getByRole("menuitem", { name: "New file" }),
    ).toBeVisible();
    expect(
      within(folderMenu).getByRole("menuitem", { name: "Import" }),
    ).toBeVisible();
    expect(
      within(folderMenu).queryByRole("menuitem", { name: "Download" }),
    ).toBeNull();
    expect(
      within(folderMenu).queryByRole("menuitem", { name: "Copy link" }),
    ).toBeNull();
    expect(
      within(folderMenu).queryByRole("menuitem", { name: "Duplicate" }),
    ).toBeNull();
    fireEvent.keyDown(folderMenu, { key: "Escape" });

    fireEvent.click(
      within(documentRow).getByRole("button", { name: /Actions/ }),
    );
    const documentMenu = await screen.findByRole("menu");
    expect(
      within(documentMenu).getByRole("menuitem", { name: "Copy link" }),
    ).toBeVisible();
    expect(
      within(documentMenu).getByRole("menuitem", { name: "Duplicate" }),
    ).toBeVisible();
    expect(
      within(documentMenu).getByRole("menuitem", { name: "Download" }),
    ).toBeVisible();
    expect(
      within(documentMenu).queryByRole("menuitem", {
        name: /New (Document|File)/,
      }),
    ).toBeNull();
    expect(
      within(documentMenu).getByRole("menuitem", { name: "Delete" }),
    ).toBeVisible();
    expect(
      within(documentMenu).getByRole("menuitem", { name: "Rename" }),
    ).toBeEnabled();
  });

  it.each([true, false])(
    "uses server delete capability for a shared Document (delete=%s)",
    async (canDelete) => {
      const runtime = await signedInRuntime();
      const document = seedNativeDocument(runtime, "shared-delete-capability");
      const trash = declareTrashResponse(runtime, document);
      runtime.server.on(
        "GET",
        "/v0/tenants/{tenantId}/me/shared-document-tree",
        () => ({
          items: trash.mock.calls.length
            ? []
            : [
                {
                  id: "shared-delete-node",
                  document_id: document.id,
                  node_kind: "document",
                  sort_key: document.id,
                  created_at: document.created_at,
                  updated_at: document.updated_at,
                  document: {
                    ...document,
                    title: "Shared manager page",
                    owner: { ...document.owner, id: "agent-owner" },
                    capabilities: {
                      ...document.capabilities,
                      delete: canDelete,
                    },
                  },
                },
              ],
        }),
      );
      renderTree(runtime);
      fireEvent.click(
        await screen.findByRole("button", {
          name: /Actions for shared document Shared manager page/,
        }),
      );
      if (!canDelete) {
        expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
        return;
      }
      fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
      expect(trash).not.toHaveBeenCalled();
      expect(
        screen.getByRole("dialog", { name: "Delete Document?" }),
      ).toHaveTextContent("all Rooms and shared locations");
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() =>
        expect(trash).toHaveBeenCalledWith(
          expect.objectContaining({ params: { documentId: document.id } }),
        ),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("link", { name: /Shared manager page/ }),
        ).toBeNull(),
      );
    },
  );

  it("requires the shared confirmation dialog before deleting a tree Document", async () => {
    const runtime = await signedInRuntime();
    const document = seedNativeDocument(runtime, "confirm-delete");
    const trash = declareTrashResponse(runtime, document);
    renderTree(runtime);

    await chooseNodeAction(`${document.title}.md`, "Delete");
    expect(trash).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Delete Document?" }),
    ).toBeVisible();
    expect(screen.getByText(/cannot currently be restored/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(trash).toHaveBeenCalledWith(
        expect.objectContaining({ params: { documentId: document.id } }),
      ),
    );
  });

  it("sorts newest folders first and documents last within a tree level", async () => {
    const runtime = await signedInRuntime();
    seedNativeDocument(runtime, "tree-sort-document");
    seedFolder(runtime, "tree-sort-folder-old", { name: "Older Folder" });
    seedFolder(runtime, "tree-sort-folder-new", {
      name: "Newest Folder",
    });
    renderTree(runtime);

    const tree = await screen.findByRole("tree", { name: "Owned by Me" });
    const labels = within(tree)
      .getAllByRole("treeitem")
      .map((item) => item.getAttribute("aria-label"));
    expect(labels.indexOf("Newest Folder")).toBeLessThan(
      labels.indexOf("Older Folder"),
    );
    expect(labels.indexOf("Older Folder")).toBeLessThan(
      labels.findIndex((label) => label?.toLowerCase().includes("untitled")),
    );
  });

  it("fails closed when the smart view is unavailable", async () => {
    const runtime = await signedInRuntime();
    runtime.server.on("GET", "/v0/library/documents", () =>
      teamHubErrorResponse(
        503,
        "DOCUMENT_LIST_UNAVAILABLE",
        "Document list is unavailable.",
      ),
    );
    renderPage(runtime);

    expect(
      (await screen.findAllByRole("alert")).some((alert) =>
        alert.textContent?.includes("Document list is unavailable."),
      ),
    ).toBe(true);
    expect(
      screen.queryByRole("link", { name: "product-v0-brief.md" }),
    ).not.toBeInTheDocument();
  });

  it("fails closed when the personal Document tree is unavailable", async () => {
    const runtime = await signedInRuntime();
    runtime.server.on("GET", "/v0/tenants/{tenantId}/me/document-tree", () =>
      teamHubErrorResponse(
        503,
        "DOCUMENT_TREE_UNAVAILABLE",
        "Document tree is unavailable.",
      ),
    );
    renderTree(runtime);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Document tree is unavailable.",
    );
    expect(
      screen.queryByRole("treeitem", { name: "product-v0-brief.md" }),
    ).not.toBeInTheDocument();
  });

  it("lists one folder level at a time, matching the My pages tree", async () => {
    const runtime = await signedInRuntime();
    const folder = seedFolder(runtime, "level-folder", { name: "Specs" });
    await seedUploadedDocument(runtime, "level-root", {
      file: new File(["root"], "root-notes.md", { type: "text/markdown" }),
      representationFormat: "markdown",
    });
    await seedUploadedDocument(runtime, "level-nested", {
      file: new File(["nested"], "nested-spec.md", { type: "text/markdown" }),
      parentId: folder.id,
      representationFormat: "markdown",
    });
    renderPage(runtime);

    const root = await screen.findByLabelText("My pages documents");
    expect(
      within(root).getByRole("link", { name: "root-notes.md" }),
    ).toBeVisible();
    expect(
      within(root).queryByRole("link", { name: "nested-spec.md" }),
    ).toBeNull();
    fireEvent.click(
      within(root).getByRole("button", { name: "Open folder Specs" }),
    );

    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Specs documents")).getByRole("link", {
          name: "nested-spec.md",
        }),
      ).toBeVisible(),
    );
    expect(
      within(screen.getByLabelText("Specs documents")).queryByRole("link", {
        name: "root-notes.md",
      }),
    ).toBeNull();
  });

  it("browses Shared with me folders one level at a time", async () => {
    const runtime = await signedInRuntime();
    const base = (await listOwnedDocuments(runtime)).items[0]!;
    const rootShared = {
      ...base,
      id: "shared-root-document",
      owner: { ...base.owner, id: "actor-shared-owner" },
      title: "Shared root",
    };
    const nestedShared = {
      ...rootShared,
      id: "shared-nested-document",
      title: "Shared nested",
    };
    const now = "2026-08-26T10:00:00.000Z";
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/me/shared-document-tree",
      () => ({
        items: [
          {
            created_at: now,
            id: "shared-level-folder",
            name: "Partner docs",
            node_kind: "folder",
            sort_key: "shared-level-folder",
            updated_at: now,
          },
          treeDocumentNode(rootShared),
          treeDocumentNode(nestedShared, "shared-level-folder"),
        ],
      }),
    );
    renderPage(runtime);
    fireEvent.click(await screen.findByRole("tab", { name: "Shared with me" }));

    const root = await screen.findByLabelText("Shared with me documents");
    expect(root).toHaveTextContent("Shared root");
    expect(root).not.toHaveTextContent("Shared nested");
    fireEvent.click(
      within(root).getByRole("button", { name: "Open folder Partner docs" }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Partner docs documents")).toHaveTextContent(
        "Shared nested",
      ),
    );
    expect(
      screen.getByLabelText("Partner docs documents"),
    ).not.toHaveTextContent("Shared root");
    expect(screen.getByRole("tab", { name: "Shared with me" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("does not expose an Undo receipt for a completed deletion", async () => {
    const runtime = await signedInRuntime();
    const document = seedNativeDocument(
      runtime,
      "library-undo-document-create",
    );
    showDocument(runtime, { ...document, status: "trashed" });
    renderPage(runtime, {
      trashedDocumentId: document.id,
      trashedDocumentTitle: document.title,
    });

    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Trash" }),
    ).not.toBeInTheDocument();
    await expect(
      readDocument(runtime.client, document.id),
    ).resolves.toMatchObject({
      status: "trashed",
    });
  });

  it("ignores legacy trash receipt state instead of promising restore", async () => {
    const runtime = await signedInRuntime();
    const document = seedNativeDocument(
      runtime,
      "library-undo-failure-document-create",
    );
    showDocument(runtime, { ...document, status: "trashed" });
    renderPage(runtime, {
      trashedDocumentId: document.id,
      trashedDocumentTitle: document.title,
    });

    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(
      runtime.server.requestsTo("POST", "/v0/documents/{documentId}/restore"),
    ).toHaveLength(0);
  });
});

it("renames a binary file from its tree menu and keeps failures editable", async () => {
  const runtime = await signedInRuntime();
  const document = await seedUploadedDocument(
    runtime,
    "upload-rename-binary-file",
    {
      file: new File(["video"], "sample.mp4", { type: "video/mp4" }),
      representationFormat: "binary",
    },
  );
  const renamed = { ...document, title: "review.mp4" };
  let renameAttempts = 0;
  runtime.server.on("PATCH", "/v0/documents/{documentId}", () => {
    renameAttempts += 1;
    if (renameAttempts === 1)
      return teamHubErrorResponse(409, "RENAME_FAILED", "Rename failed");
    showDocument(runtime, renamed);
    return renamed;
  });
  renderTree(runtime);
  await chooseNodeAction("sample.mp4", "Rename");
  const dialog = screen.getByRole("dialog", { name: "Rename file" });
  const input = within(dialog).getByRole("textbox", { name: "File name" });
  fireEvent.change(input, { target: { value: "   " } });
  expect(within(dialog).getByRole("button", { name: "Rename" })).toBeDisabled();
  fireEvent.change(input, { target: { value: "review.mp4" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Rename failed",
  );
  expect(input).toHaveValue("review.mp4");
  fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Rename file" })).toBeNull(),
  );
  expect(
    await screen.findByRole("treeitem", { name: "review.mp4" }),
  ).toBeVisible();
  expect((await readDocument(runtime.client, document.id)).title).toBe(
    "review.mp4",
  );
});

async function chooseCreateAction(action: "New folder" | "New file") {
  fireEvent.click(
    screen.getByRole("button", { name: "Create in Owned by Me" }),
  );
  const item = await screen.findByRole("menuitem", { name: action });
  await waitFor(() => expect(item).toBeEnabled());
  fireEvent.click(item);
}

async function chooseNodeAction(nodeName: string, action: string) {
  const tree = await screen.findByRole("tree", { name: "Owned by Me" });
  fireEvent.click(
    within(tree).getByRole("button", { name: `Actions for ${nodeName}` }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: action }));
}

async function chooseMenuAction(menuLabel: string, action: string) {
  fireEvent.click(screen.getByRole("button", { name: menuLabel }));
  fireEvent.click(await screen.findByRole("menuitem", { name: action }));
}

type TreeNodeSource = TeamHubDocumentPage["items"][number];

function treeDocumentNode(
  document: TreeNodeSource,
  parentId?: string,
): TeamHubDocumentPlacementNode {
  return {
    created_at: document.updated_at,
    document: {
      can_edit_native_content: document.can_edit_native_content,
      capabilities: document.capabilities,
      format: document.format,
      id: document.id,
      owner: document.owner,
      representation_format: document.representation_format,
      status: document.status,
      title: document.title,
      updated_at: document.updated_at,
    },
    document_id: document.id,
    id: `placement-${document.id}`,
    node_kind: "document",
    ...(parentId ? { parent_id: parentId } : {}),
    sort_key: document.id,
    updated_at: document.updated_at,
  };
}

async function signedInRuntime() {
  const runtime = createDocumentTestRuntime();
  // Wiki inputs without a declared response publish as new source Documents.
  let uploads = 0;
  runtime.server.on(
    "POST",
    "/v0/tenants/{tenantId}/personal-wiki/documents/uploads",
    () =>
      Response.json(
        {
          ...runtime.seed.documents.values().next().value!,
          current_version: {
            id: `wiki-input-${++uploads}`,
            sha256: "a".repeat(64),
            version_number: 1,
          },
          id: `wiki-source-${uploads}`,
        },
        { status: 201 },
      ),
  );
  // A drop moves the placement in the seeded tree.
  runtime.server.on(
    "PATCH",
    "/v0/tenants/{tenantId}/me/document-placements/{placementId}",
    ({ body, params }) => {
      const tree = documentSeeds(runtime).tree;
      const index = tree.items.findIndex(
        (item) => item.id === params.placementId,
      );
      if (index < 0)
        return teamHubErrorResponse(404, "DOCUMENT_PLACEMENT_NOT_FOUND");
      const moved = {
        ...tree.items[index]!,
        parent_id: (body as { parent_id?: string }).parent_id,
      };
      tree.items[index] = moved;
      return moved;
    },
  );
  return runtime;
}

function renderTree(
  runtime: Awaited<ReturnType<typeof signedInRuntime>>,
  state?: Record<string, string>,
  pathname = "/t/tenant-northstar/library",
) {
  return renderPage(runtime, state, pathname, true);
}

function TreeSurface() {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);
  const queryKey = ["teamhub", "tenant-northstar", "document-tree"];
  const tree = useQuery({
    queryKey,
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/me/document-tree", {
          params: { path: { tenantId: "tenant-northstar" } },
        }),
      ),
  });
  return (
    <>
      <button
        aria-label="Open Library pages"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        Pages
      </button>
      <LibrarySidebar
        active="overview"
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        tenantId="tenant-northstar"
      >
        <MyDocumentsTree
          items={tree.data?.items ?? []}
          loadError={tree.error}
          pending={tree.isPending}
          tenantId="tenant-northstar"
          onChanged={() => queryClient.invalidateQueries({ queryKey })}
        />
      </LibrarySidebar>
    </>
  );
}

function renderPage(
  runtime: Awaited<ReturnType<typeof signedInRuntime>>,
  state?: Record<string, string>,
  pathname = "/t/tenant-northstar/library",
  treeOnly = false,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const routes = [
    {
      element: treeOnly ? <TreeSurface /> : <LibraryDocumentsPage />,
      path: "/t/:tenantId/library/*",
    },
    {
      element: <p>Document detail</p>,
      path: "/t/:tenantId/documents/:documentId",
    },
  ];
  const router = createMemoryRouter(
    treeOnly ? routes : [{ children: routes, element: <LibraryLayout /> }],
    {
      initialEntries: [{ pathname, state }],
    },
  );

  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <div id="workspace-new-page-slot" />
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient, router };
}

function mockFolderCreation(
  runtime: Awaited<ReturnType<typeof signedInRuntime>>,
) {
  const createFolder = vi.fn(({ body }: { body: unknown }): unknown => {
    const input = body as { name: string; parent_id?: string };
    return seedFolder(runtime, `created-${input.name}`, {
      name: input.name,
      parent_id: input.parent_id,
    });
  });
  runtime.server.on(
    "POST",
    "/v0/tenants/{tenantId}/me/document-folders",
    createFolder,
  );
  return createFolder;
}

function pickedFile(relativePath: string) {
  const file = new File(["x"], relativePath.split("/").at(-1)!);
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}

function fileEntry(file: File) {
  return {
    file: (resolve: (value: File) => void) => resolve(file),
    isDirectory: false,
    isFile: true,
    name: file.name,
  };
}

function directoryEntry(name: string, children: unknown[]) {
  return {
    createReader: () => {
      let read = false;
      return {
        readEntries: (resolve: (entries: unknown[]) => void) => {
          resolve(read ? [] : children);
          read = true;
        },
      };
    },
    isDirectory: true,
    isFile: false,
    name,
  };
}

/** A Chromium-style folder drop: `files` holds an unreadable directory stub. */
function createEntryTransfer(entries: unknown[]) {
  const transfer = createDataTransfer([new File([], "folder-stub")]);
  return Object.assign(transfer, {
    items: entries.map((entry) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
    })),
  });
}

function createDataTransfer(files: File[] = [], forceFilesType = false) {
  const values = new Map<string, string>();
  const types = files.length > 0 || forceFilesType ? ["Files"] : [];
  return {
    dropEffect: "none",
    effectAllowed: "uninitialized",
    files,
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => {
      values.set(type, value);
      if (!types.includes(type)) types.push(type);
    },
    types,
  } as unknown as DataTransfer;
}

// Fixed responses for component scenarios. No request-driven persistence or validation.
function declareFolderResponse(
  runtime: Awaited<ReturnType<typeof signedInRuntime>>,
  name: string,
  parentId?: string,
) {
  const folder = seedFolder(runtime, `folder-response-${name}`, {
    name,
    parent_id: parentId,
  });
  documentSeeds(runtime).tree.items.pop();
  runtime.server.on(
    "POST",
    "/v0/tenants/{tenantId}/me/document-folders",
    () => {
      documentSeeds(runtime).tree.items.push(folder);
      return folder;
    },
  );
}
function declareFolderRename(
  runtime: Awaited<ReturnType<typeof signedInRuntime>>,
  name: string,
) {
  const folder = {
    created_at: "2026-08-26T10:00:00Z",
    updated_at: "2026-08-26T10:00:00Z",
    id: "folder-response-New Folder",
    sort_key: "00000",
    node_kind: "folder" as const,
    name,
  };
  respondToPlacementUpdate(runtime, () => {
    documentSeeds(runtime).tree.items = documentSeeds(runtime).tree.items.map(
      (item) => (item.id === folder.id ? { ...item, name } : item),
    );
    return folder;
  });
}
async function declareWikiUpload(
  runtime: Awaited<ReturnType<typeof signedInRuntime>>,
  filename: string,
  representationFormat: string,
  parentId?: string,
) {
  const uploaded = await seedRoomUpload(
    runtime,
    filename,
    { file: new File([filename], filename), representationFormat, parentId },
    "wiki-jenny",
  );
  uploaded.from = [{ binding_kind: "wiki_source", context_id: "wiki-jenny" }];
  const placement = documentSeeds(runtime).tree.items.pop()!;
  respond(
    vi.spyOn(runtime.client, "uploadPersonalWikiDocument"),
    uploaded,
    () => {
      documentSeeds(runtime).tree.items.push(placement);
    },
  );
}
function declareTrashResponse(
  runtime: Awaited<ReturnType<typeof signedInRuntime>>,
  document: TeamHubDocument,
) {
  const trash = vi.fn((_request: { params: Record<string, string> }) => {
    showDocument(runtime, { ...document, status: "trashed" });
  });
  runtime.server.on("DELETE", "/v0/documents/{documentId}", trash);
  return trash;
}

function respondToPlacementUpdate(
  runtime: Awaited<ReturnType<typeof signedInRuntime>>,
  respond: () => unknown,
) {
  runtime.server.on(
    "PATCH",
    "/v0/tenants/{tenantId}/me/document-placements/{placementId}",
    respond,
  );
}

function readMyDocumentTree(
  runtime: Awaited<ReturnType<typeof signedInRuntime>>,
) {
  return teamHubData(
    runtime.client.api.GET("/v0/tenants/{tenantId}/me/document-tree", {
      params: { path: { tenantId: "tenant-northstar" } },
    }),
  );
}

function listOwnedDocuments(
  runtime: Awaited<ReturnType<typeof signedInRuntime>>,
) {
  return teamHubData(
    runtime.client.api.GET("/v0/library/documents", {
      params: { query: { view: "owned" } },
    }),
  );
}

function sentBodies(
  runtime: Awaited<ReturnType<typeof signedInRuntime>>,
  method: TestRouteMethod,
  path: TeamHubApiPath,
) {
  return Promise.all(
    runtime.server
      .requestsTo(method, path)
      .map((request) => request.clone().json() as Promise<unknown>),
  );
}

function readDocument(client: TeamHubClient, documentId: string) {
  return teamHubData(
    client.api.GET("/v0/documents/{documentId}", {
      params: { path: { documentId } },
    }),
  );
}
