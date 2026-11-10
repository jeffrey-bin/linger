import {
  respond,
  documentSeeds,
  showDocument,
  createDocumentTestRuntime,
  seedRoomDocument,
  seedNativeDocument,
  seedRoomUpload,
  seedUploadedDocument,
  seedFolder,
} from "@/test/document-scenarios";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";
import { teamHubData } from "@/features/teamhub/teamhub-api";

import {
  createHttpTeamHubClient,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import {
  TeamHubRuntimeProvider,
  type TeamHubRuntime,
} from "@/features/teamhub/teamhub-runtime";
import { WikiGraphPage } from "@/features/memory/wiki-graph-page";
import { LibraryLayout } from "@/features/library/library-layout";
import { openLocalDocumentSession } from "@/test/local-document-session";

import * as collaboration from "./room-document-collaboration";
import { UnifiedDocumentPage } from "./room-document-surface";
import { serveWikiDocuments } from "@/features/wiki/wiki.test-support";
import type {
  TeamHubDocument,
  TeamHubDocumentShareViewV2,
} from "@/features/teamhub/teamhub-types";
import {
  commentActor,
  commentThreadResponse,
} from "./document-comment-test-data";

// PDF canvas rendering belongs to its adapter tests, not Document controls.
vi.mock("@/features/rooms/files/pdf-preview-adapter-loader", () => ({
  PdfPreviewAdapterLoader: () => <div>PDF preview</div>,
}));

const ownerManagementCapabilities = {
  can_change_ownership: true,
  can_update_external_policy: true,
  can_update_link_policy: true,
};

const wikiLink = vi.hoisted(() => ({
  href: "../projects/project.md#working-preferences",
}));

vi.mock("./room-document-collaboration", async (importOriginal) => {
  const { openLocalDocumentSession } =
    await import("@/test/local-document-session");
  return {
    ...(await importOriginal<typeof import("./room-document-collaboration")>()),
    openRoomDocumentSession: vi.fn(openLocalDocumentSession),
  };
});

vi.mock("./room-document-blocknote-editor-loader", () => ({
  RoomDocumentBlockNoteEditor: ({
    commentsOpen,
    editable,
    knowledgeDocumentTitle,
    surfaceEditorRef,
    onCanvasSentChange,
    onHeadingsChange,
  }: {
    commentsOpen?: boolean;
    editable: boolean;
    knowledgeDocumentTitle?: string;
    surfaceEditorRef?: {
      current: {
        document: { id: string }[];
        focus: () => void;
        replaceBlocks: ReturnType<typeof vi.fn>;
        setTextCursorPosition: ReturnType<typeof vi.fn>;
        tryParseMarkdownToBlocks: ReturnType<typeof vi.fn>;
      } | null;
    };
    onCanvasSentChange?: (sent: boolean) => void;
    onHeadingsChange: (headings: unknown[]) => void;
  }) => {
    const editor = {
      document: [{ id: "block-1" }],
      focus: () =>
        window.document
          .querySelector<HTMLElement>("[data-testid='document-body']")
          ?.focus(),
      replaceBlocks: vi.fn(),
      setTextCursorPosition: vi.fn(),
      tryParseMarkdownToBlocks: vi.fn(() => []),
    };
    if (surfaceEditorRef) surfaceEditorRef.current = editor;
    return (
      <div
        className="bn-editor"
        data-editable={String(editable)}
        data-knowledge-title={knowledgeDocumentTitle}
        data-testid="document-body"
        tabIndex={-1}
      >
        Room BlockNote editor
        {knowledgeDocumentTitle ? (
          <a href={wikiLink.href}>
            <span>Open linked Wiki project</span>
          </a>
        ) : null}
        {knowledgeDocumentTitle ? (
          <>
            <div
              className="bn-block-outer"
              data-id="source-outer"
              style={{ display: "none" }}
            >
              <div data-id="source-outer">
                <h2>Sources</h2>
              </div>
              <div data-id="source-child">
                <h3>Source details</h3>
              </div>
            </div>
            <div data-id="readable-section">
              <h2>Working preferences</h2>
            </div>
          </>
        ) : null}
        {commentsOpen ? (
          <aside aria-label="All Document comments">Comments</aside>
        ) : null}
        <button
          onClick={() =>
            onHeadingsChange([
              { id: "heading-1", level: 1, text: "Decision summary" },
            ])
          }
          type="button"
        >
          Emit headings
        </button>
        <button onClick={() => onCanvasSentChange?.(true)} type="button">
          Report sent canvas
        </button>
      </div>
    );
  },
}));

describe("Unified Document legacy convergence", () => {
  beforeEach(() => {
    wikiLink.href = "../projects/project.md#working-preferences";
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      "linger:library-shared-collapsed:v2:tenant-northstar",
      "false",
    );
  });

  it("keeps the selected Wiki collection while opening and switching Wiki documents", async () => {
    window.sessionStorage.clear();
    const runtime = createDocumentTestRuntime();

    const documents = await Promise.all(
      ["first", "second"].map(async (name) => {
        const document = seedRoomDocument(runtime, `sidebar-wiki-${name}`);
        return {
          ...document,
          title: `${name}.md`,
          from: [
            {
              binding_kind: "wiki_page" as const,
              context_id: "wiki-jenny",
              page_key: `projects/nested/${name}.md`,
            },
          ],
        };
      }),
    );
    for (const document of documents) showDocument(runtime, document);
    serveWikiDocuments(runtime).mockResolvedValue({
      items: documents,
      page: { has_more: false },
    });
    const { router } = renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${documents[0]!.id}`,
    );
    await screen.findByRole("navigation", { name: "Projects files" });
    for (const document of documents) {
      fireEvent.click(
        await within(
          screen.getByRole("navigation", { name: "Projects files" }),
        ).findByRole("link", {
          name: new RegExp(`^${document.title.replace(".md", "")}$`),
        }),
      );
      expect(
        await screen.findByRole("heading", {
          name: document.title.replace(".md", ""),
        }),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe(
        `/t/tenant-northstar/documents/${document.id}`,
      );
      expect(
        screen.getByRole("complementary", { name: "Wiki sidebar" }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Back to Wiki" }),
      ).toBeVisible();
      expect(
        screen.getByRole("navigation", { name: "Projects files" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Expand Owned by Me" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Expand Shared with me" }),
      ).not.toBeInTheDocument();
    }
  });

  it("keeps a sent mail canvas in Read mode", async () => {
    const runtime = createDocumentTestRuntime();
    const document = seedRoomDocument(runtime, "sent-mail-canvas");
    showDocument(runtime, { ...document, can_edit_native_content: true });
    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );
    const body = await screen.findByTestId("document-body");
    expect(body).toHaveAttribute("data-editable", "true");

    fireEvent.click(screen.getByRole("button", { name: "Report sent canvas" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Document mode" }),
      ).toHaveTextContent("Read mode"),
    );
    expect(screen.getByTestId("document-body")).toHaveAttribute(
      "data-editable",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Document mode" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeDisabled();
  });

  it.each(["wiki_page", "wiki_source"] as const)(
    "defaults only generated Wiki pages to knowledge reading, not %s source editing",
    async (bindingKind) => {
      const runtime = createDocumentTestRuntime();

      const document = seedRoomDocument(runtime, `wiki-reading-${bindingKind}`);
      const isWikiPage = bindingKind === "wiki_page";
      showDocument(runtime, {
        ...document,
        can_edit_native_content: !isWikiPage,
        capabilities: isWikiPage
          ? {
              comment: false,
              delete: false,
              duplicate: false,
              export: false,
              manage: false,
              read: true,
              use_as_context: false,
              write: false,
            }
          : document.capabilities,
        draft_capability: isWikiPage ? "read" : document.draft_capability,
        title: "Casey example.md",
        from: [{ binding_kind: bindingKind, context_id: "wiki-jenny" }],
      });
      renderUnifiedDocumentPage(
        runtime,
        `/t/tenant-northstar/documents/${document.id}`,
      );
      const body = await screen.findByTestId("document-body");
      expect(body).toHaveAttribute("data-editable", String(!isWikiPage));
      if (!isWikiPage) {
        expect(body).not.toHaveAttribute("data-knowledge-title");
        expect(
          screen.getByRole("button", { name: "Document mode" }),
        ).toHaveTextContent("Edit mode");
        expect(
          screen.getByRole("status", { name: /people in this document/ }),
        ).toBeVisible();
        expect(
          screen.getByText(`By ${document.owner.display_name}`),
        ).toBeVisible();
        return;
      }
      expect(body).toHaveAttribute("data-knowledge-title", "Casey example");
      expect(
        screen.getByRole("heading", { name: "Casey example" }),
      ).toBeVisible();
      const layout = within(
        body.closest(".room-document-layout") as HTMLElement,
      );
      expect(layout.queryByText(/^By /)).toBeNull();
      expect(layout.queryByText("Saved")).toBeNull();
      expect(layout.queryByText("Casey example.md")).toBeNull();
      expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "More Document actions" }),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Table of contents" }),
      );
      const toc = screen.getByRole("navigation", {
        name: "Document table of contents",
      });
      expect(within(toc).getByText("Working preferences")).toBeVisible();
      expect(within(toc).queryByText("Sources")).toBeNull();
      expect(within(toc).queryByText("Source details")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Document mode" }),
      ).toBeNull();
      expect(
        screen.queryByRole("status", { name: /people in this document/ }),
      ).toBeNull();
      const actions = window.document.querySelector(
        ".room-document-header-actions",
      );
      expect(actions).not.toBeNull();
      expect(within(actions as HTMLElement).getAllByRole("button")).toEqual([
        screen.getByRole("button", { name: "Table of contents" }),
      ]);
      expect(body).toHaveAttribute("data-editable", "false");
      expect(body).toHaveAttribute("data-knowledge-title", "Casey example");
    },
  );

  it("keeps legacy Wiki pages read-only and hides collaboration controls even with writable metadata", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedRoomDocument(runtime, "legacy-wiki-toolbar");
    showDocument(runtime, {
      ...document,
      from: [{ binding_kind: "wiki_page", context_id: "wiki-jenny" }],
    });
    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );
    expect(await screen.findByTestId("document-body")).toHaveAttribute(
      "data-editable",
      "false",
    );
    const actions = window.document.querySelector(
      ".room-document-header-actions",
    ) as HTMLElement;
    expect(within(actions).getAllByRole("button")).toEqual([
      screen.getByRole("button", { name: "Table of contents" }),
    ]);
    expect(
      within(actions).queryByRole("status", {
        name: /people in this document/,
      }),
    ).toBeNull();
  });

  it.each(
    ["click", "keyboard"].flatMap((action) => [
      {
        action,
        href: "../projects/project.md",
        pageKey: "projects/project.md",
      },
      { action, href: "../projects/project", pageKey: "projects/project.md" },
      {
        action,
        href: "../projects/project",
        pageKey: "projects/project/index.md",
      },
      {
        action,
        href: "../projects/project/",
        pageKey: "projects/project/index.md",
      },
    ]),
  )(
    "opens $href as $pageKey by Document identity using $action",
    async ({ action, href, pageKey }) => {
      wikiLink.href = `${href}#working-preferences`;
      const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
      const runtime = createDocumentTestRuntime();

      const source = seedRoomDocument(runtime, `source-${action}`);
      const project = seedRoomDocument(runtime, `target-${action}`);
      const sourceDocument = {
        ...source,
        title: "Casey example.md",
        from: [
          {
            binding_kind: "wiki_page" as const,
            context_id: "wiki-jenny",
            page_key: "people/casey-example.md",
          },
        ],
      };
      const projectDocument = {
        ...project,
        title: "Linked project.md",
        from: [
          {
            binding_kind: "wiki_page" as const,
            context_id: "wiki-jenny",
            page_key: pageKey,
          },
        ],
      };
      showDocument(runtime, sourceDocument);
      showDocument(runtime, projectDocument);
      const list = serveWikiDocuments(runtime).mockImplementation(
        async ({ query }) =>
          query.get("cursor")
            ? { items: [projectDocument], page: { has_more: false } }
            : {
                items: [sourceDocument],
                page: { has_more: true, next_cursor: "projects" },
              },
      );
      const { router } = renderUnifiedDocumentPage(
        runtime,
        `/t/tenant-northstar/documents/${source.id}`,
      );
      const link = await screen.findByRole("link", {
        name: "Open linked Wiki project",
      });
      if (action === "click")
        fireEvent.click(within(link).getByText("Open linked Wiki project"));
      else fireEvent.keyDown(link, { key: "Enter" });
      expect(
        await screen.findByRole("heading", { name: "Linked project" }),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe(
        `/t/tenant-northstar/documents/${project.id}`,
      );
      expect(router.state.location.hash).toBe("#working-preferences");
      await waitFor(() =>
        expect(scroll).toHaveBeenCalledWith({
          behavior: "smooth",
          block: "start",
        }),
      );
      expect(
        list.mock.calls.map(([request]) => ({
          params: request.params,
          query: Object.fromEntries(request.query),
        })),
      ).toContainEqual({
        params: { tenantId: "tenant-northstar" },
        query: { cursor: "projects", limit: "100" },
      });
    },
  );

  it("opens a cited Room message in its Room", async () => {
    wikiLink.href =
      "/t/tenant-northstar/rooms/room-launch/chat?message=message-a";
    const runtime = createDocumentTestRuntime();
    const source = seedRoomDocument(runtime, "wiki-citation-source");
    const sourceDocument = {
      ...source,
      title: "Launch session.md",
      from: [
        {
          binding_kind: "wiki_page" as const,
          context_id: "wiki-jenny",
          page_key: "sessions/2026-11-04/room-launch.md",
        },
      ],
    };
    showDocument(runtime, sourceDocument);
    const { router } = renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${source.id}`,
    );
    const link = await screen.findByRole("link", {
      name: "Open linked Wiki project",
    });
    fireEvent.click(within(link).getByText("Open linked Wiki project"));
    expect(await screen.findByText("Room chat")).toBeVisible();
    expect(router.state.location.pathname).toBe(
      "/t/tenant-northstar/rooms/room-launch/chat",
    );
    expect(router.state.location.search).toBe("?message=message-a");
  });

  it("keeps the current Wiki content when a link is missing and allows retry", async () => {
    const runtime = createDocumentTestRuntime();

    const source = seedRoomDocument(runtime, "wiki-missing-source");
    const target = seedRoomDocument(runtime, "wiki-retry-target");
    const sourceDocument = {
      ...source,
      title: "Current Wiki.md",
      from: [
        {
          binding_kind: "wiki_page" as const,
          context_id: "wiki-jenny",
          page_key: "people/person.md",
        },
      ],
    };
    const targetDocument = {
      ...target,
      title: "Recovered project.md",
      from: [
        {
          binding_kind: "wiki_page" as const,
          context_id: "wiki-jenny",
          page_key: "projects/project.md",
        },
      ],
    };
    showDocument(runtime, sourceDocument);
    showDocument(runtime, targetDocument);
    const list = serveWikiDocuments(runtime).mockResolvedValue({
      items: [],
      page: { has_more: false },
    });
    const sourceUrl = `/t/tenant-northstar/documents/${source.id}`;
    const { router } = renderUnifiedDocumentPage(runtime, sourceUrl);
    fireEvent.click(
      await screen.findByRole("link", { name: "Open linked Wiki project" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "linked Wiki page could not be opened",
    );
    expect(router.state.location.pathname).toBe(sourceUrl);
    expect(screen.getByRole("heading", { name: "Current Wiki" })).toBeVisible();
    list.mockResolvedValue({
      items: [targetDocument],
      page: { has_more: false },
    });
    fireEvent.click(
      screen.getByRole("link", { name: "Open linked Wiki project" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Recovered project" }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe(
      `/t/tenant-northstar/documents/${target.id}`,
    );
  });

  it("copies the canonical Document URL without transient route state", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedRoomDocument(runtime, "canonical-document-copy-link");
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(
      Navigator.prototype,
      "clipboard",
    );
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      renderUnifiedDocumentPage(
        runtime,
        `/t/tenant-northstar/documents/${document.id}?panel=history#revision`,
      );
      await screen.findByText("Room BlockNote editor");
      await chooseDocumentAction("Copy link");

      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/t/tenant-northstar/documents/${document.id}`,
      );
      expect(
        runtime.server.requestsTo(
          "POST",
          "/v0/documents/{documentId}/collaborators",
        ),
      ).toHaveLength(0);
      expect(
        runtime.server.requestsTo(
          "PUT",
          "/v0/rooms/{roomId}/documents/{documentId}",
        ),
      ).toHaveLength(0);
    } finally {
      if (originalClipboard) {
        Object.defineProperty(
          Navigator.prototype,
          "clipboard",
          originalClipboard,
        );
      } else {
        Reflect.deleteProperty(Navigator.prototype, "clipboard");
      }
    }
  });

  it("opens a newly created Room Document through its stable identity", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedRoomDocument(runtime, "stable-room-document-create");

    expect(
      (
        await teamHubData(
          runtime.client.api.GET("/v0/rooms/{roomId}/documents", {
            params: { path: { roomId: "room-all" } },
          }),
        )
      ).items,
    ).toContainEqual(expect.objectContaining({ id: document.id }));
    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );
    expect(await screen.findByText("Room BlockNote editor")).toBeVisible();
  });

  it("updates an open outline when the preview body arrives later", async () => {
    const document = versionDocumentResponse();
    const { runtime, unexpectedRequest } = versionDocumentRuntime(document);
    const view = renderUnifiedDocumentPage(
      runtime,
      `/t/tenant_1/documents/${document.id}`,
    );
    const preview = await screen.findByText("PDF preview");
    fireEvent.click(screen.getByRole("button", { name: "Table of contents" }));
    const outline = screen.getByRole("navigation", {
      name: "Document table of contents",
    });
    expect(within(outline).getByText("No headings")).toBeVisible();
    const heading = window.document.createElement("h1");
    heading.textContent = "Delayed preview heading";
    act(() => preview.append(heading));
    expect(
      await within(outline).findByRole("button", {
        name: "Delayed preview heading",
      }),
    ).toBeVisible();
    act(() => {
      heading.textContent = "Updated preview heading";
    });
    expect(
      await within(outline).findByRole("button", {
        name: "Updated preview heading",
      }),
    ).toBeVisible();
    act(() => heading.remove());
    expect(await within(outline).findByText("No headings")).toBeVisible();
    view.unmount();
    expect(unexpectedRequest).not.toHaveBeenCalled();
  });

  it("submits a Version Comment without requesting collaboration", async () => {
    const document = versionDocumentResponse();
    const { runtime, server, unexpectedRequest } =
      versionDocumentRuntime(document);
    const listComments = vi.fn((_: TestRouteRequest) => ({
      items: [],
      page: { has_more: false },
    }));
    server.on(
      "GET",
      "/v0/documents/{documentId}/comment-threads",
      listComments,
    );
    const createComment = vi.fn(() =>
      commentThreadResponse("thread_1", "Review the stable file"),
    );
    server.on(
      "POST",
      "/v0/documents/{documentId}/comment-threads",
      createComment,
    );
    renderUnifiedDocumentPage(runtime, `/t/tenant_1/documents/${document.id}`);
    fireEvent.click(await screen.findByRole("button", { name: "Comments" }));
    expect(await screen.findByText("No comments")).toBeVisible();
    fireEvent.change(screen.getByLabelText("New Document comment"), {
      target: { value: "Review the stable file" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(await screen.findByText("Review the stable file")).toBeVisible();
    expect(createComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        params: { documentId: document.id },
        body: {
          document_version_id: "version_1",
          initial_comment: {
            segments: [{ content: "Review the stable file", type: "text" }],
          },
        },
      }),
    );
    expect(listComments).toHaveBeenCalledOnce();
    expect(listComments.mock.calls[0]?.[0].params).toEqual({
      documentId: document.id,
    });
    expect(listComments.mock.calls[0]?.[0].query.get("limit")).toBe("100");
    expect(screen.getByLabelText("New Document comment")).toHaveValue("");
    expect(
      server.requestsTo(
        "POST",
        "/v0/documents/{documentId}/collaboration-credentials",
      ),
    ).toHaveLength(0);
    expect(unexpectedRequest).not.toHaveBeenCalled();
  });

  it("keeps internal Versions and manual checkpoints out of Page History", async () => {
    const runtime = createDocumentTestRuntime();

    const document = await seedRoomUpload(
      runtime,
      "stable-room-version-create",
      {
        file: new File(["version bytes"], "release.txt", {
          type: "text/plain",
        }),
        representationFormat: "plain_text",
      },
    );
    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    await screen.findByText("version bytes");
    await chooseDocumentAction("Page history");
    expect(await screen.findByText("No page history saved yet.")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Page history" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Page history" })).toBeVisible();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Published Versions")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save checkpoint" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Restore checkpoint" }),
    ).not.toBeInTheDocument();
    expect(
      runtime.server.requestsTo("GET", "/v0/documents/{documentId}/versions"),
    ).toHaveLength(0);
  });

  it("shows a retryable Comments error for a Version-only PDF", async () => {
    const document = versionDocumentResponse();
    const { runtime, server, unexpectedRequest } =
      versionDocumentRuntime(document);
    const listComments = vi
      .fn<(request: TestRouteRequest) => unknown>()
      .mockReturnValueOnce(
        teamHubErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Comment service unavailable",
        ),
      )
      .mockReturnValueOnce({ items: [], page: { has_more: false } });
    server.on(
      "GET",
      "/v0/documents/{documentId}/comment-threads",
      listComments,
    );
    renderUnifiedDocumentPage(runtime, `/t/tenant_1/documents/${document.id}`);
    fireEvent.click(await screen.findByRole("button", { name: "Comments" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Comments could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No comments")).toBeVisible();
    expect(listComments).toHaveBeenCalledTimes(2);
    expect(unexpectedRequest).not.toHaveBeenCalled();
  });

  it("does not expose a Human Publish action for an owned native Draft", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(
      runtime,
      "stable-no-human-publish-create",
    );
    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    expect(await screen.findByText("Room BlockNote editor")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Publish" }),
    ).not.toBeInTheDocument();
  });

  it("fails closed when the stable Document read fails", async () => {
    const runtime = createDocumentTestRuntime();

    runtime.server.on("GET", "/v0/documents/{documentId}", () =>
      teamHubErrorResponse(500, "INTERNAL", "Document read failed safely."),
    );

    renderUnifiedDocumentPage(
      runtime,
      "/t/tenant-northstar/documents/document-unavailable",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Document read failed safely.",
    );
    expect(screen.queryByText("Room BlockNote editor")).not.toBeInTheDocument();
  });
});

describe("Unified Document page", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      "linger:library-shared-collapsed:v2:tenant-northstar",
      "false",
    );
  });

  it.each([false, true])(
    "offers a fresh authorized session after connection failure (readOnly=%s)",
    async (readOnly) => {
      const runtime = createDocumentTestRuntime();

      const document = seedNativeDocument(runtime, "connection-failure-retry");
      if (readOnly) {
        document.capabilities = { ...document.capabilities, write: false };
        document.draft_capability = "read";
      }
      let destroyFailedSession = vi.fn(async (): Promise<void> => undefined);
      const openSession = vi
        .mocked(collaboration.openRoomDocumentSession)
        .mockClear()
        .mockImplementationOnce(async (input) => {
          const session = await openLocalDocumentSession(input);
          destroyFailedSession = vi.fn(session.destroy);
          return {
            ...session,
            destroy: destroyFailedSession,
            getSaveSnapshot: () => failedSnapshot,
          };
        });
      const failedSnapshot = {
        canEdit: false,
        status: "Connection failed" as const,
      };
      const openRequests = () =>
        runtime.server.requestsTo("POST", "/v0/documents/{documentId}/open");
      try {
        renderUnifiedDocumentPage(
          runtime,
          `/t/tenant-northstar/documents/${document.id}`,
        );
        await waitFor(() => expect(openRequests()).toHaveLength(1));
        expect(
          await screen.findByRole("status", {
            name: "Document connection status",
          }),
        ).toHaveTextContent("Connection failed");
        expect(screen.getByTestId("document-body")).toHaveAttribute(
          "data-editable",
          "false",
        );
        fireEvent.click(
          screen.getByRole("button", { name: "Retry connection" }),
        );
        await waitFor(() => expect(openRequests()).toHaveLength(2));
        await waitFor(() =>
          expect(
            screen.queryByText("Connection failed"),
          ).not.toBeInTheDocument(),
        );
        expect(destroyFailedSession).toHaveBeenCalledOnce();
        expect(openSession).toHaveBeenCalledTimes(2);
      } finally {
        openSession.mockClear();
      }
    },
  );

  it("opens first-class Share and explains effective Direct and Context access", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(runtime, "share-panel-document");
    let resolveShare!: (value: TeamHubDocumentShareViewV2) => void;
    const share = new Promise<TeamHubDocumentShareViewV2>((resolve) => {
      resolveShare = resolve;
    });
    runtime.server.on(
      "GET",
      "/v0/documents/{documentId}/collaborators",
      () => share,
    );

    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    expect(
      screen.getByRole("status", { name: "Share loading" }),
    ).toHaveTextContent("Loading access");
    resolveShare({
      caller_content_role: "owner",
      can_manage_collaborators: true,
      management_capabilities: ownerManagementCapabilities,
      schema_version: 2,
      sources: [
        {
          label: "Alex",
          source: {
            created_at: "2026-08-29T08:00:00Z",
            grantor_actor_id: document.owner.id,
            provenance: { kind: "direct_grant", schema_version: 2 },
            role: "editor",
            schema_version: 2,
            source_id: "direct-alex",
            source_kind: "direct",
            source_version: 1,
            status: "active",
            target: { id: "actor-alex", kind: "agent" },
            updated_at: "2026-08-29T08:00:00Z",
          },
          target_actor: {
            display_name: "Alex",
            id: "actor-alex",
            kind: "agent",
            tenant_id: "tenant-northstar",
          },
        },
        {
          label: "Product Room",
          source: {
            created_at: "2026-08-29T08:00:00Z",
            provenance: {
              binding_kind: "room",
              context_id: "room-product",
              kind: "context_binding",
              schema_version: 2,
            },
            role: "editor",
            schema_version: 2,
            source_id: "binding-product",
            source_kind: "context",
            source_version: 1,
            status: "active",
            updated_at: "2026-08-29T08:00:00Z",
          },
        },
      ],
    });

    expect(await screen.findByText("Your access: Owner")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Share" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Invite collaborators" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Manage 2 active collaborators" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Document link" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "Link sharing scope" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Link content role" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Advanced access details"),
    ).not.toBeInTheDocument();
  });

  it("copies Restricted canonical access and groups source explanations without granting access", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(
      runtime,
      "restricted-share-panel-document",
    );
    runtime.server.on(
      "GET",
      "/v0/documents/{documentId}/collaborators",
      () => ({
        caller_content_role: "editor",
        can_manage_collaborators: false,
        general_access: {
          canonical_url: `/t/tenant-northstar/documents/${document.id}`,
          scope: "restricted",
        },
        schema_version: 2,
        sources: [
          {
            caller_access_state: "remaining",
            label: "Alex",
            source_group: "direct",
            source: {
              created_at: "2026-08-29T08:00:00Z",
              provenance: { kind: "direct_grant", schema_version: 2 },
              role: "viewer",
              schema_version: 2,
              source_id: "direct-alex",
              source_kind: "direct",
              source_version: 1,
              status: "active",
              target: { id: "actor-alex", kind: "agent" },
              updated_at: "2026-08-29T08:00:00Z",
            },
          },
          {
            caller_access_state: "winning",
            label: "Product Room",
            source_group: "context",
            source: {
              created_at: "2026-08-29T08:00:00Z",
              provenance: {
                binding_kind: "room",
                context_id: "room-product",
                kind: "context_binding",
                schema_version: 2,
              },
              role: "editor",
              schema_version: 2,
              source_id: "binding-product",
              source_kind: "context",
              source_version: 1,
              status: "active",
              updated_at: "2026-08-29T08:00:00Z",
            },
          },
          {
            caller_access_state: "winning",
            label: "Tenant link policy",
            source_group: "link",
            source: {
              created_at: "2026-08-29T08:00:00Z",
              provenance: { kind: "link_policy", schema_version: 2 },
              role: "editor",
              schema_version: 2,
              source_id: "link-policy",
              source_kind: "link",
              source_version: 1,
              status: "active",
              updated_at: "2026-08-29T08:00:00Z",
            },
          },
        ],
      }),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(
      Navigator.prototype,
      "clipboard",
    );
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      renderUnifiedDocumentPage(
        runtime,
        `/t/tenant-northstar/documents/${document.id}`,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Share" }));

      expect(
        await screen.findByText(
          "Copying the link does not change who can access this document.",
        ),
      ).toBeVisible();
      expect(screen.queryByText("General access")).not.toBeInTheDocument();
      expect(screen.queryByText("Tenant link policy")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith(
          `${window.location.origin}/t/tenant-northstar/documents/${document.id}`,
        ),
      );
      expect(
        runtime.server.requestsTo(
          "POST",
          "/v0/documents/{documentId}/collaborators",
        ),
      ).toHaveLength(0);
    } finally {
      if (originalClipboard) {
        Object.defineProperty(
          Navigator.prototype,
          "clipboard",
          originalClipboard,
        );
      } else {
        Reflect.deleteProperty(Navigator.prototype, "clipboard");
      }
    }
  });

  it("keeps the Item 02 Share shape readable during producer-first rollout", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(runtime, "legacy-share-view-document");
    runtime.server.on(
      "GET",
      "/v0/documents/{documentId}/collaborators",
      () => ({
        caller_content_role: "owner",
        can_manage_collaborators: true,
        schema_version: 2,
        sources: [],
      }),
    );

    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    expect(
      await screen.findByRole("heading", { name: "Invite collaborators" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Collaborator management" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a missing Restricted Document non-disclosing in Share", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(
      runtime,
      "missing-restricted-share-document",
    );
    runtime.server.on("GET", "/v0/documents/{documentId}/collaborators", () =>
      teamHubErrorResponse(404, "NOT_FOUND", "Document was not found"),
    );

    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sharing settings are unavailable.",
    );
    expect(screen.queryByText("General access")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Document was not found"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("opens collaborator management and updates Direct access with CAS", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(runtime, "share-conflict-document");
    const source = {
      created_at: "2026-08-29T08:00:00Z",
      grantor_actor_id: document.owner.id,
      provenance: { kind: "direct_grant" as const, schema_version: 2 as const },
      role: "editor" as const,
      schema_version: 2 as const,
      source_id: "direct-alex",
      source_kind: "direct" as const,
      source_version: 3,
      status: "active" as const,
      target: { id: "actor-alex", kind: "agent" as const },
      updated_at: "2026-08-29T08:00:00Z",
    };
    runtime.server.on(
      "GET",
      "/v0/documents/{documentId}/collaborators",
      () => ({
        caller_content_role: "owner",
        can_manage_collaborators: true,
        management_capabilities: ownerManagementCapabilities,
        schema_version: 2,
        sources: [{ label: "Alex", source }],
      }),
    );
    const update = vi
      .fn<(request: TestRouteRequest) => unknown>()
      .mockReturnValueOnce(
        teamHubErrorResponse(
          409,
          "DOCUMENT_COLLABORATOR_CONFLICT",
          "stale source",
        ),
      )
      .mockReturnValue({ ...source, role: "viewer", source_version: 4 });
    runtime.server.on(
      "PATCH",
      "/v0/documents/{documentId}/collaborators/{sourceId}",
      update,
    );
    const revoke = vi.fn(() => ({
      ...source,
      source_version: 4,
      status: "revoked",
    }));
    runtime.server.on(
      "POST",
      "/v0/documents/{documentId}/collaborators/{sourceId}/revoke",
      revoke,
    );

    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    const manage = await screen.findByRole("button", {
      name: "Manage 1 active collaborators",
    });
    expect(manage).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "Alex permission" }),
    ).not.toBeInTheDocument();
    fireEvent.click(manage);
    expect(
      screen.getByRole("heading", { name: "Manage collaborators" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("combobox", { name: "Alex permission" }));
    fireEvent.click(await screen.findByRole("option", { name: "Viewer" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { expected_version: 3, role: "viewer" },
          params: { documentId: document.id, sourceId: source.source_id },
        }),
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The collaborator permission could not be updated.",
    );
    expect(revoke).not.toHaveBeenCalled();
  });

  it("removes the Document from a shared Room with the binding version", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(runtime, "share-room-removal-document");
    runtime.server.on(
      "GET",
      "/v0/documents/{documentId}/collaborators",
      () => ({
        caller_content_role: "owner",
        can_manage_collaborators: true,
        management_capabilities: ownerManagementCapabilities,
        schema_version: 2,
        sources: [
          {
            label: "Launch Room",
            source: {
              created_at: "2026-08-29T08:00:00Z",
              provenance: {
                binding_kind: "room",
                context_id: "room-launch",
                kind: "context_binding",
                schema_version: 2,
              },
              role: "editor",
              schema_version: 2,
              source_id: "room-binding-launch",
              source_kind: "context",
              source_version: 7,
              status: "active",
              updated_at: "2026-08-29T08:00:00Z",
            },
          },
        ],
      }),
    );
    const remove = vi.fn(() => ({ document }));
    runtime.server.on(
      "POST",
      "/v0/documents/{documentId}/room-bindings/{roomId}/remove",
      remove,
    );

    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove from Room" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { expected_version: 7 },
          params: { documentId: document.id, roomId: "room-launch" },
        }),
      ),
    );
  });

  it("shares the Document with a picked Agent", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(runtime, "share-with-agent-document");
    runtime.server.on(
      "GET",
      "/v0/documents/{documentId}/collaborators",
      () => ({
        caller_content_role: "owner",
        can_manage_collaborators: true,
        management_capabilities: ownerManagementCapabilities,
        schema_version: 2,
        sources: [],
      }),
    );
    runtime.server.on("GET", "/v0/tenants/{tenantId}/actors", () => ({
      items: [
        {
          created_at: "2026-08-29T08:00:00Z",
          display_name: "Research Agent",
          id: "actor-research-agent",
          kind: "agent",
          tenant_id: "tenant-northstar",
        },
      ],
      page: { has_more: false },
    }));
    const create = vi.fn(() => ({
      created_at: "2026-08-29T08:00:00Z",
      provenance: { kind: "direct_grant", schema_version: 2 },
      role: "viewer",
      schema_version: 2,
      source_id: "direct-research-agent",
      source_kind: "direct",
      source_version: 1,
      status: "active",
      target: { id: "actor-research-agent", kind: "agent" },
      updated_at: "2026-08-29T08:00:00Z",
    }));
    runtime.server.on(
      "POST",
      "/v0/documents/{documentId}/collaborators",
      create,
    );

    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Add collaborators" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Research Agent/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Invite (1)" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { role: "viewer", target_actor_id: "actor-research-agent" },
          params: { documentId: document.id },
        }),
      ),
    );
  });

  it("previews an ordinary Wiki source Version without opening collaboration", async () => {
    // Exercise the real preview without timing its cold module transform.
    await import("@/components/read-only-blocknote-document");
    const runtime = createDocumentTestRuntime();

    const document = await seedRoomUpload(
      runtime,
      "upload-wiki-source-stable-route",
      {
        file: new File(["# Source notes\n\nStable bytes."], "source.md", {
          type: "text/markdown",
        }),
        representationFormat: "markdown",
      },
      "tenant-northstar",
    );
    const previewSession = vi.fn(() => ({
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      preview_url: "https://preview.example.test/source.md",
    }));
    runtime.server.on(
      "POST",
      "/v0/document-versions/{documentVersionId}/preview-sessions",
      previewSession,
    );
    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );
    await waitFor(() => expect(previewSession).toHaveBeenCalled());

    expect(
      await screen.findByRole("heading", { name: "Source notes" }),
    ).toBeVisible();
    expect(screen.getByText("Stable bytes.")).toBeVisible();
    expect(
      runtime.server.requestsTo(
        "POST",
        "/v0/documents/{documentId}/collaboration-credentials",
      ),
    ).toHaveLength(0);
  });

  it("opens one native Document by stable identity with empty separated timelines", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(runtime, "create-stable-document");

    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    expect(await screen.findByText("Room BlockNote editor")).toBeVisible();
    expect(screen.getByRole("heading", { name: "untitled" })).toBeVisible();
    expect(screen.queryByText(/Publish/i)).not.toBeInTheDocument();

    expect(
      screen.queryByRole("button", {
        name: "Page history and published versions",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Export Document" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Duplicate Document" }),
    ).not.toBeInTheDocument();
    await chooseDocumentAction("Page history");
    expect(screen.getByRole("heading", { name: "Page history" })).toBeVisible();
    expect(await screen.findByText("No page history saved yet.")).toBeVisible();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("derives native Edit and Comments controls from capabilities", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(
      runtime,
      "native-document-capability-controls",
    );
    showDocument(runtime, {
      ...document,
      can_edit_native_content: true,
      capabilities: {
        ...document.capabilities,
        comment: true,
        read: true,
        write: false,
      },
      draft_capability: "read",
    });

    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    expect(await screen.findByText("Room BlockNote editor")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Document mode" }),
      ).toHaveTextContent("Read mode"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Document mode" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /Read/ })).toBeEnabled();
    expect(screen.getByLabelText("Current mode")).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: /Read/ }));
    expect(screen.getByRole("button", { name: "Comments" })).toBeVisible();
    expect(
      screen.getByRole("status", { name: "Document access mode" }),
    ).toHaveTextContent("Read only");
    expect(screen.getByTestId("document-body")).toHaveAttribute(
      "data-editable",
      "false",
    );
    expect(
      runtime.server.requestsTo(
        "POST",
        "/v0/documents/{documentId}/read-session-credentials",
      ),
    ).toHaveLength(0);
    expect(
      runtime.server.requestsTo(
        "POST",
        "/v0/documents/{documentId}/collaboration-credentials",
      ),
    ).toHaveLength(0);
  });

  it("previews legacy New HTML as a read-only HTML snapshot", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(
      runtime,
      "create-native-html-document",
      { representation_format: "html" },
    );

    respond(vi.spyOn(runtime.client, "downloadLatestDocument"), {
      blob: new Blob(["<p>Legacy HTML</p>"], { type: "text/html" }),
      mediaType: "text/html",
      sha256: "0".repeat(64),
    });
    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    expect(await screen.findByTitle("Preview untitled.html")).toHaveAttribute(
      "sandbox",
      "allow-scripts",
    );
    expect(screen.queryByText("Room BlockNote editor")).not.toBeInTheDocument();
    // The open Document's collection opens on its own.
    expect(
      screen.getByRole("button", { name: "Collapse Owned by Me" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "untitled.html" })).toBeVisible();
    expect(
      screen.queryByText("Document preview is unavailable."),
    ).not.toBeInTheDocument();
  });

  it("edits the native Draft title against the durable head and shows its Placement breadcrumb", async () => {
    const runtime = createDocumentTestRuntime();

    const folderA = seedFolder(runtime, "draft-title-folder-company", {
      name: "Company",
    });
    const folderB = seedFolder(runtime, "draft-title-folder-product", {
      name: "Product",
      parent_id: folderA.id,
    });
    const folderC = seedFolder(runtime, "draft-title-folder-decisions", {
      name: "Decisions",
      parent_id: folderB.id,
    });
    const document = seedNativeDocument(
      runtime,
      "draft-title-document-create",
      { parent_id: folderC.id },
    );
    const renamed = { ...document, title: "Canonical decisions" };
    const updateTitle = vi.fn<(request: TestRouteRequest) => unknown>();
    runtime.server.on(
      "PATCH",
      "/v0/documents/{documentId}/draft-title",
      updateTitle,
    );
    respond(updateTitle, renamed, () => {
      showDocument(runtime, renamed);
    });
    const { router } = renderUnifiedDocumentPage(runtime, {
      pathname: `/t/tenant-northstar/documents/${document.id}`,
      state: { editDocumentTitle: true, selectTitleBaseName: true },
    });

    expect(await screen.findByText("Room BlockNote editor")).toBeVisible();
    const input = screen.getByLabelText("Document title");
    expect(input).toHaveFocus();
    expect(input).toHaveValue("untitled");
    expect(input).toHaveProperty("selectionStart", 0);
    expect(input).toHaveProperty("selectionEnd", "untitled".length);
    await waitFor(() => expect(router.state.location.state).toBeNull());
    expect(input).toHaveClass("room-document-page-title");
    const breadcrumb = await screen.findByRole("navigation", {
      name: "Breadcrumb",
    });
    expect(breadcrumb).toHaveTextContent("Owned by Me");
    expect(breadcrumb).toHaveTextContent(/untitled\.md/i);
    expect(breadcrumb).toHaveTextContent("Product");
    expect(breadcrumb).toHaveTextContent("Decisions");

    const renderedReadTitles: string[] = [];
    const titleObserver = new MutationObserver(() => {
      const title = window.document.querySelector("h1")?.textContent;
      if (title) renderedReadTitles.push(title);
    });
    titleObserver.observe(window.document.body, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    fireEvent.change(input, { target: { value: "Canonical decisions" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(updateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { title: "Canonical decisions" },
          params: { documentId: document.id },
        }),
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Canonical decisions" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Canonical decisions" }),
    ).toHaveClass("room-document-page-title");
    titleObserver.disconnect();
    expect(renderedReadTitles).not.toContain("untitled");
    // The open Document's collection opens on its own.
    expect(
      screen.getByRole("button", { name: "Collapse Owned by Me" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Canonical decisions.md" }),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: "untitled.md" })).toBeNull();
    expect(updateTitle).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Document title")).not.toBeInTheDocument();

    showDocument(runtime, { ...document, title: "Concurrent decisions" });
    updateTitle.mockReturnValueOnce(
      teamHubErrorResponse(
        409,
        "DOCUMENT_TREE_CONFLICT",
        "Document tree changed concurrently.",
      ),
    );

    fireEvent.click(screen.getByTitle("Rename document"));
    const staleInput = screen.getByLabelText("Document title");
    fireEvent.change(staleInput, { target: { value: "Stale overwrite" } });
    fireEvent.submit(staleInput.closest("form")!);
    const conflict = await screen.findByText(
      "Document tree changed concurrently.",
    );
    expect(conflict).toBeVisible();
    expect(conflict).toHaveAttribute("role", "alert");
    await expect(readDocument(runtime.client, document.id)).resolves.toEqual(
      expect.objectContaining({ title: "Concurrent decisions" }),
    );
  });

  it("shows the actor-private Shared tree and breadcrumb for a shared Document", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedRoomDocument(runtime, "shared-deep-link-document");
    runtime.server.on("GET", "/v0/documents/{documentId}", ({ params }) => {
      const value = runtime.seed.documents.get(params.documentId!);
      if (!value) return teamHubErrorResponse(404, "NOT_FOUND");
      return params.documentId === document.id
        ? {
            ...value,
            owner: {
              ...value.owner,
              display_name: "Another owner",
              id: "actor_other_owner",
              kind: "agent" as const,
            },
          }
        : value;
    });
    const originalTree = await teamHubData(
      runtime.client.api.GET("/v0/tenants/{tenantId}/me/document-tree", {
        params: { path: { tenantId: "tenant-northstar" } },
      }),
    );
    runtime.server.on("GET", "/v0/tenants/{tenantId}/me/document-tree", () => ({
      items: originalTree.items.filter(
        (item) =>
          item.node_kind !== "document" || item.document_id !== document.id,
      ),
    }));
    const now = new Date().toISOString();
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/me/shared-document-tree",
      () => ({
        items: [
          {
            created_at: now,
            id: "shared-folder-review",
            name: "Review",
            node_kind: "folder",
            sort_key: "shared-folder-review",
            updated_at: now,
          },
          {
            created_at: now,
            document: {
              can_edit_native_content: document.can_edit_native_content,
              capabilities: document.capabilities,
              format: document.format,
              id: document.id,
              owner: {
                ...document.owner,
                display_name: "Another owner",
                id: "actor_other_owner",
                kind: "agent" as const,
              },
              representation_format: document.representation_format,
              status: document.status,
              title: document.title,
              updated_at: document.updated_at,
            },
            document_id: document.id,
            id: "shared-document-review",
            node_kind: "document",
            parent_id: "shared-folder-review",
            sort_key: "shared-document-review",
            updated_at: now,
          },
        ],
      }),
    );

    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    expect(
      await screen.findByRole("button", { name: "Collapse Shared with me" }),
    ).toBeVisible();
    const breadcrumb = await screen.findByRole("navigation", {
      name: "Breadcrumb",
    });
    await waitFor(() => {
      expect(breadcrumb).toHaveTextContent("Shared with me");
      expect(breadcrumb).toHaveTextContent("Review");
    });
    expect(breadcrumb).toHaveTextContent(/untitled\.md/i);
    expect(
      screen
        .getByRole("link", { name: /untitled\.md/i })
        .querySelector('[data-kind="code"]'),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Document mode" }),
    ).toHaveTextContent("Edit mode");
    expect(screen.getByRole("button", { name: "Comments" })).toBeVisible();
    expect(screen.getByTestId("document-body")).toHaveAttribute(
      "data-editable",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Document mode" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Read" }));
    fireEvent.click(screen.getByRole("button", { name: "Document mode" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /Read/ })).toHaveFocus(),
    );
    expect(
      within(screen.getByRole("menuitem", { name: /Read/ })).getByLabelText(
        "Current mode",
      ),
    ).toBeVisible();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByTestId("document-body")).toHaveAttribute(
      "data-editable",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Document mode" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Document mode" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /Edit/ })).toHaveFocus(),
    );
    expect(
      within(screen.getByRole("menuitem", { name: /Edit/ })).getByLabelText(
        "Current mode",
      ),
    ).toBeVisible();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByTestId("document-body")).toHaveAttribute(
      "data-editable",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(
      screen.getByRole("complementary", { name: "All Document comments" }),
    ).toBeVisible();
  });

  it("commits the native logical title when the user presses Enter", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(
      runtime,
      "draft-title-enter-document-create",
      { representation_format: "markdown" },
    );
    const renamed = { ...document, title: "Enter title" };
    const updateTitle = vi.fn<(request: TestRouteRequest) => unknown>();
    runtime.server.on(
      "PATCH",
      "/v0/documents/{documentId}/draft-title",
      updateTitle,
    );
    respond(updateTitle, renamed, () => {
      showDocument(runtime, renamed);
    });
    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    expect(await screen.findByText("Room BlockNote editor")).toBeVisible();
    fireEvent.click(screen.getByTitle("Rename document"));
    const input = screen.getByLabelText("Document title");
    expect(input).toHaveProperty(
      "selectionStart",
      (input as HTMLInputElement).selectionEnd,
    );
    fireEvent.change(input, { target: { value: "Enter title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(updateTitle).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("document-body")).toHaveFocus(),
    );
    expect(
      await screen.findByRole("heading", { name: "Enter title" }),
    ).toBeVisible();
  });

  it("shows a History author and timestamp without exposing checkpoint trigger copy", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(runtime, "history-actions");
    const entry = {
      contributors: [document.owner],
      created_at: document.created_at,
      created_by: document.owner,
      document_id: document.id,
      id: "history-manual",
      persisted_seq: 1,
      revision_id: "revision-manual",
      trigger: "manual" as const,
    };
    runtime.server.on("GET", "/v0/documents/{documentId}/history", () => ({
      items: [entry],
      page: { has_more: false },
    }));
    runtime.server.on(
      "GET",
      "/v0/document-history/{historyEntryId}/content",
      () => ({
        asset_manifest: [],
        full_state_fingerprint: "0".repeat(64),
        history_entry: entry,
        state_bytes: "AAA=",
        state_bytes_sha256:
          "96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7",
        state_vector: "AA==",
      }),
    );
    const restore = vi.fn<(request: TestRouteRequest) => unknown>();
    runtime.server.on(
      "POST",
      "/v0/documents/{documentId}/history/{historyEntryId}/restore",
      restore,
    );
    respond(restore, {
      history_entry: entry,
      status: "already_current",
    });
    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    expect(await screen.findByText("Room BlockNote editor")).toBeVisible();
    await chooseDocumentAction("Page history");
    const history = await screen.findByRole("dialog", { name: "Page history" });
    const avatar = await within(history).findByRole("img", {
      name: "Jenny Bin avatar",
    });
    expect(avatar).toBeVisible();
    expect(screen.getAllByText("Jenny Bin").length).toBeGreaterThan(0);
    expect(screen.queryByText("No page history saved yet.")).toBeNull();
    expect(avatar.closest("button")).not.toHaveTextContent(
      /checkpoint|manual/i,
    );
    expect(
      await screen.findByRole("region", { name: "History preview" }),
    ).toBeVisible();
    expect(screen.getByText("This checkpoint has no content.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Restore checkpoint" }));

    expect(await screen.findByText("Already current.")).toBeVisible();
    await expect(
      teamHubData(
        runtime.client.api.GET("/v0/documents/{documentId}/history", {
          params: { path: { documentId: document.id } },
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ trigger: "manual" })],
      }),
    );
  });

  it("requests the latest download and keeps the empty History view", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(runtime, "export-action");
    respond(vi.spyOn(runtime.client, "downloadLatestDocument"), {
      blob: new Blob(["# untitled"]),
      mediaType: "text/markdown",
      sha256: "0".repeat(64),
    });
    const downloadLatest = vi.spyOn(runtime.client, "downloadLatestDocument");
    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    expect(await screen.findByText("Room BlockNote editor")).toBeVisible();
    await chooseDocumentAction("Download");

    await waitFor(() => expect(downloadLatest).toHaveBeenCalledOnce());
    await expect(
      readDocument(runtime.client, document.id),
    ).resolves.toMatchObject({
      current_version: null,
    });
    await chooseDocumentAction("Page history");
    expect(await screen.findByText("No page history saved yet.")).toBeVisible();
    expect(screen.queryByText("Published Versions")).not.toBeInTheDocument();
    expect(downloadLatest).toHaveBeenCalledOnce();
  });

  it("downloads an ordinary Document current Version", async () => {
    const runtime = createDocumentTestRuntime();

    const document = await seedRoomUpload(
      runtime,
      "ordinary-document-download",
      {
        file: new File(["# Stable upload\n"], "stable-upload.md", {
          type: "text/markdown",
        }),
        representationFormat: "markdown",
      },
    );
    runtime.server.on(
      "POST",
      "/v0/document-versions/{documentVersionId}/preview-sessions",
      () => ({
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        preview_url: "https://preview.example.test/stable-upload.md",
      }),
    );
    // TeamHub serves an ordinary Document's current Version as its download.
    runtime.server.on("GET", "/v0/documents/{documentId}/downloads", () =>
      runtime.server.fetch(
        `http://localhost/v0/document-versions/${document.current_version!.id}/content`,
      ),
    );
    const downloadLatest = vi.spyOn(runtime.client, "downloadLatestDocument");
    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    expect(
      await screen.findByRole("heading", { name: "Stable upload" }),
    ).toBeVisible();
    await chooseDocumentAction("Download");

    await waitFor(() => expect(downloadLatest).toHaveBeenCalledOnce());
    await expect(downloadLatest.mock.results[0]!.value).resolves.toMatchObject({
      sha256: document.current_version!.sha256,
    });
  });

  it("duplicates by Document identity and opens the new stable route", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(runtime, "duplicate-and-context");
    const copied = {
      ...document,
      id: "document-copy",
      title: "untitled (copy)",
    };
    showDocument(runtime, copied);
    const duplicate = vi.fn(() => copied);
    runtime.server.on(
      "POST",
      "/v0/documents/{documentId}/duplicates",
      duplicate,
    );
    const { router } = renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    expect(await screen.findByText("Room BlockNote editor")).toBeVisible();
    await chooseDocumentAction("Duplicate");
    await waitFor(() => expect(duplicate).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(
        /^\/t\/tenant-northstar\/documents\/document-/,
      ),
    );
  });

  it("does not expose the retired Use as context action", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(runtime, "context-bindings");
    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    expect(await screen.findByText("Room BlockNote editor")).toBeVisible();
    fireEvent.click(
      await screen.findByRole("button", { name: "More Document actions" }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "Use as context" }),
    ).not.toBeInTheDocument();
  });

  it("fails closed when the stable route Tenant does not own the Document", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(
      runtime,
      "create-cross-tenant-document",
    );

    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-other/documents/${document.id}`,
    );

    expect(
      await screen.findByText("The requested TeamHub resource is unavailable."),
    ).toBeVisible();
    expect(screen.queryByText("Room BlockNote editor")).not.toBeInTheDocument();
  });

  it("confirms owner-only deletion and opens the next Document in My pages", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedNativeDocument(runtime, "trash");
    const trash = vi.fn((_request: { params: Record<string, string> }) => {
      showDocument(runtime, { ...document, status: "trashed" });
    });
    runtime.server.on("DELETE", "/v0/documents/{documentId}", trash);
    const { router } = renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    expect(await screen.findByText("Room BlockNote editor")).toBeVisible();
    await chooseDocumentAction("Delete");
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
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(
        /^\/t\/tenant-northstar\/(?:documents\/|library$)/,
      ),
    );
    expect(router.state.location.pathname).not.toContain(document.id);
  });

  it("keeps the personal tree collapsed until opened and reveals ancestors on a stable Document deep link", async () => {
    const runtime = createDocumentTestRuntime();

    const folder = seedFolder(runtime, "folder-create", {
      name: "Projects",
    });
    const document = seedNativeDocument(runtime, "document-create");
    const placement = (
      await teamHubData(
        runtime.client.api.GET("/v0/tenants/{tenantId}/me/document-tree", {
          params: { path: { tenantId: "tenant-northstar" } },
        }),
      )
    ).items.find(
      (item) =>
        item.node_kind === "document" && item.document_id === document.id,
    )!;
    documentSeeds(runtime).tree.items = [
      folder,
      { ...placement, parent_id: folder.id },
    ];

    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    renderUnifiedDocumentPage(
      runtime,
      `/t/tenant-northstar/documents/${document.id}`,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Expand Owned by Me" }),
    );
    const tree = await screen.findByRole("tree", { name: "Owned by Me" });
    expect(
      screen.getByRole("button", { name: "Collapse Owned by Me" }),
    ).toBeVisible();
    const current = await screen.findByRole("link", { name: "untitled.md" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("treeitem", { name: "Projects" })).toContainElement(
      current,
    );
    expect(tree).toContainElement(current);
    expect(scrollIntoView).not.toHaveBeenCalled();

    const treeToggle = screen.getByRole("button", {
      name: "Open Library pages",
    });
    expect(treeToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(treeToggle);
    expect(treeToggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Close Owned by Me" }));
    expect(treeToggle).toHaveAttribute("aria-expanded", "false");
  });
});

async function chooseDocumentAction(action: string) {
  fireEvent.click(
    screen.getByRole("button", { name: "More Document actions" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: action }));
}

it("renames binary metadata from the detail menu and refreshes its tree and breadcrumb", async () => {
  const runtime = createDocumentTestRuntime();

  const document = await seedUploadedDocument(
    runtime,
    "upload-detail-rename-binary",
    {
      file: new File(["archive"], "sample.zip", { type: "application/zip" }),
      representationFormat: "binary",
    },
  );
  const renamed = { ...document, title: "renamed.zip" };
  runtime.server.on("PATCH", "/v0/documents/{documentId}", () => {
    showDocument(runtime, renamed);
    return renamed;
  });
  renderUnifiedDocumentPage(
    runtime,
    `/t/tenant-northstar/documents/${document.id}`,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "More Document actions" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const dialog = screen.getByRole("dialog", { name: "Rename file" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "File name" }), {
    target: { value: "renamed.zip" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Rename file" })).toBeNull(),
  );
  expect(
    within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText(
      "renamed.zip",
    ),
  ).toBeVisible();
  const ownedToggle = screen.getByRole("button", {
    name: /^(Expand|Collapse) Owned by Me$/,
  });
  if (ownedToggle.getAttribute("aria-expanded") === "false")
    fireEvent.click(ownedToggle);
  expect(
    await screen.findByRole("treeitem", { name: "renamed.zip" }),
  ).toBeVisible();
  expect(
    runtime.server.requestsTo(
      "PATCH",
      "/v0/documents/{documentId}/draft-title",
    ),
  ).toHaveLength(0);
});

it("disables binary rename when metadata management is not permitted", async () => {
  const runtime = createDocumentTestRuntime();

  const document = await seedUploadedDocument(
    runtime,
    "upload-no-rename-permission",
    {
      file: new File(["archive"], "managed.zip", { type: "application/zip" }),
      representationFormat: "binary",
    },
  );
  showDocument(runtime, {
    ...document,
    capabilities: { ...document.capabilities, manage: false },
  });
  renderUnifiedDocumentPage(
    runtime,
    `/t/tenant-northstar/documents/${document.id}`,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "More Document actions" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "Rename" }),
  ).toBeDisabled();
});

it("routes native menu rename through the existing Draft title editor", async () => {
  const runtime = createDocumentTestRuntime();

  const document = seedNativeDocument(runtime, "create-native-menu-rename");
  const renamed = { ...document, title: "Native renamed" };
  const updateTitle = vi.fn<(request: TestRouteRequest) => unknown>();
  runtime.server.on(
    "PATCH",
    "/v0/documents/{documentId}/draft-title",
    updateTitle,
  );
  respond(updateTitle, renamed, () => {
    showDocument(runtime, renamed);
  });
  renderUnifiedDocumentPage(
    runtime,
    `/t/tenant-northstar/documents/${document.id}`,
  );
  await screen.findByText("Room BlockNote editor");
  fireEvent.click(
    screen.getByRole("button", { name: "More Document actions" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const title = await screen.findByRole("textbox", { name: "Document title" });
  expect(title).toHaveFocus();
  fireEvent.change(title, { target: { value: "Native renamed" } });
  fireEvent.keyDown(title, { key: "Enter" });
  await waitFor(async () =>
    expect((await readDocument(runtime.client, document.id)).title).toBe(
      "Native renamed",
    ),
  );
  expect(
    runtime.server.requestsTo("PATCH", "/v0/documents/{documentId}"),
  ).toHaveLength(0);
});

function renderUnifiedDocumentPage(
  runtime: TeamHubRuntime,
  initialEntry: string | { pathname: string; state?: Record<string, unknown> },
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        element: <LibraryLayout />,
        children: [
          {
            element: <UnifiedDocumentPage />,
            path: "/t/:tenantId/documents/:documentId",
          },
          { element: <p>Library</p>, path: "/t/:tenantId/library" },
          {
            element: <WikiGraphPage />,
            path: "/t/:tenantId/library/wiki/:collection?",
          },
          {
            element: <p>Library</p>,
            path: "/t/:tenantId/library/my-documents",
          },
          {
            element: <p>Shared</p>,
            path: "/t/:tenantId/library/shared-with-me",
          },
        ],
      },
      { element: <p>Room chat</p>, path: "/t/:tenantId/rooms/:roomId/chat" },
    ],
    { initialEntries: [initialEntry] },
  );
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, router };
}

const versionCreatedAt = "2026-08-28T00:00:00Z";
const emptyVersionSha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function versionDocumentResponse(): TeamHubDocument {
  return {
    id: "document_1",
    tenant_id: "tenant_1",
    title: "review.pdf",
    format: "binary",
    representation_format: "binary",
    owner: commentActor,
    creator: commentActor,
    status: "active",
    current_version: {
      id: "version_1",
      version_number: 1,
      sha256: emptyVersionSha256,
    },
    can_edit_native_content: false,
    draft_capability: "none",
    from: [],
    capabilities: {
      read: true,
      comment: true,
      write: false,
      manage: false,
      delete: false,
      duplicate: false,
      export: false,
      use_as_context: false,
    },
    created_at: versionCreatedAt,
    updated_at: versionCreatedAt,
  };
}

function versionDocumentRuntime(document: TeamHubDocument) {
  const unexpectedRequest = vi.fn((): never => {
    throw new Error("Undeclared Document request");
  });
  // Each declared read answers once; a repeated read is an undeclared request.
  const once = (value: unknown) => {
    let answered = false;
    return () => {
      if (answered) return unexpectedRequest();
      answered = true;
      return value;
    };
  };
  const server = new TeamHubTestServer();
  const client = createHttpTeamHubClient({ fetchRequest: server.fetch });
  const identity = {
    account: {
      id: "account_1",
      email: "alice@example.com",
      created_at: document.created_at,
    },
    actors: [{ ...commentActor, created_at: document.created_at }],
  };
  server.on("GET", "/v0/me", once(identity));
  server.on(
    "GET",
    "/v0/tenants/{tenantId}/me/document-tree",
    once({ items: [] }),
  );
  server.on(
    "GET",
    "/v0/tenants/{tenantId}/me/shared-document-tree",
    once({ items: [] }),
  );
  server.on("GET", "/v0/documents/{documentId}", once(document));
  server.on("POST", "/v0/documents/{documentId}/open", once({ document }));
  server.on(
    "GET",
    "/v0/session",
    once({
      id: "session_1",
      account_id: identity.account.id,
      identity,
      created_at: document.created_at,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  server.on(
    "GET",
    "/v0/document-versions/{documentVersionId}",
    once({
      id: "version_1",
      document_id: document.id,
      version_number: 1,
      filename: document.title,
      representation_format: "binary",
      media_type: "application/octet-stream",
      size_bytes: 0,
      sha256: emptyVersionSha256,
      created_by: commentActor,
      source: "ordinary_upload",
      created_at: document.created_at,
    }),
  );
  vi.spyOn(client, "downloadDocumentVersion").mockResolvedValueOnce({
    blob: new Blob([]),
    mediaType: "application/octet-stream",
  });
  const runtime: TeamHubRuntime = {
    client,
    runStatuses: { subscribe: unexpectedRequest },
    events: {
      subscribeRoom: unexpectedRequest,
      subscribeSignals: unexpectedRequest,
    },
  };
  return { runtime, server, unexpectedRequest };
}

function readDocument(client: TeamHubClient, documentId: string) {
  return teamHubData(
    client.api.GET("/v0/documents/{documentId}", {
      params: { path: { documentId } },
    }),
  );
}
