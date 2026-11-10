import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDocumentTestRuntime,
  seedRoomDocument,
  seedRoomUpload,
} from "@/test/document-scenarios";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import { ConnectedFilePanelTab, FilePanelTab } from "./file-panel-tab";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

beforeAll(async () => {
  // Exercise the real preview without timing its cold module transform.
  await import("@/components/read-only-blocknote-document");
});

const voiceMaterials = vi.hoisted(() => ({
  acceptsDocuments: true,
  enabled: false,
  voiceModeEntered: true,
  addSelection: vi.fn(),
}));

vi.mock(
  "@/features/rooms/documents/room-document-collaboration",
  async (importOriginal) => {
    const { openLocalDocumentSession } =
      await import("@/test/local-document-session");
    return {
      ...(await importOriginal<
        typeof import("@/features/rooms/documents/room-document-collaboration")
      >()),
      openRoomDocumentSession: openLocalDocumentSession,
    };
  },
);

vi.mock("@/features/rooms/chat/voice-mode/voice-materials-context", () => ({
  useOptionalVoiceMaterials: () =>
    voiceMaterials.enabled ? voiceMaterials : undefined,
}));

beforeEach(() => {
  voiceMaterials.enabled = false;
  voiceMaterials.addSelection.mockReset().mockReturnValue(true);
  window.getSelection()?.removeAllRanges();
});

vi.mock(
  "@/features/rooms/documents/room-document-blocknote-editor-loader",
  () => ({
    RoomDocumentBlockNoteEditor: ({ editable }: { editable: boolean }) => (
      <section aria-label="Room Document editor">
        <div className="bn-editor" data-editable={String(editable)}>
          Room BlockNote editor
        </div>
      </section>
    ),
  }),
);

describe("FilePanelTab", () => {
  it("opens an ordinary Document Version preview in place without a close X", async () => {
    const runtime = createDocumentTestRuntime();

    const document = await seedRoomUpload(
      runtime,
      "file-panel-upload-ordinary-1",
      {
        file: new File(["# Architecture"], "architecture.md", {
          type: "text/markdown",
        }),
        representationFormat: "markdown",
      },
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <FilePanelTab document={document} />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId(`panel-tab-file-${document.id}`)).toBeVisible();
    });

    expect(
      await screen.findByRole("heading", { name: "Architecture" }),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: "Open document" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Comments" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Table of contents" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: "More Document actions",
      }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "More Document actions" }),
    );
    for (const name of [
      "Copy link",
      "Rename",
      "Download",
      "Duplicate",
      "Page history",
      "Delete",
    ]) {
      expect(screen.getByRole("menuitem", { name })).toBeVisible();
    }
    expect(
      screen.queryByRole("button", { name: "Open Library pages" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "previews HTML in the sidebar (pinned=%s)",
    async (pinned) => {
      const runtime = createDocumentTestRuntime();

      const document = await seedRoomUpload(
        runtime,
        "ordinary-document-with-pinned-html-version",
        {
          file: new File(["<h1>Interior design</h1>"], "interior-design.html", {
            type: "text/html",
          }),
          representationFormat: "html",
        },
      );
      const version = await readDocumentVersion(
        runtime.client,
        document.current_version!.id,
      );

      render(
        <MemoryRouter>
          <QueryClientProvider client={new QueryClient()}>
            <TeamHubRuntimeProvider runtime={runtime}>
              <FilePanelTab
                document={document}
                versionId={pinned ? version.id : undefined}
              />
            </TeamHubRuntimeProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );

      expect(
        await screen.findByTitle(`Preview ${version.filename}`),
      ).toBeVisible();
      expect(screen.queryByText("Room BlockNote editor")).toBeNull();
    },
  );

  it("opens a native Draft in Edit in the sidebar and switches to Read", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedRoomDocument(runtime, "empty-native-sidebar-preview");

    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <TeamHubRuntimeProvider runtime={runtime}>
            <FilePanelTab currentActorId="actor-jenny" document={document} />
          </TeamHubRuntimeProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId(`panel-tab-file-${document.id}`)).toBeVisible();
    });

    expect(await screen.findByText("Room BlockNote editor")).toHaveAttribute(
      "data-editable",
      "true",
    );
    expect(screen.getByRole("button", { name: "Share" })).toBeVisible();
    for (const name of [
      "Comments",
      "Table of contents",
      "Open Library pages",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    const actions = screen.getByRole("button", {
      name: "More Document actions",
    });
    const mode = screen.getByRole("button", { name: "Document mode" });
    expect(
      mode.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Document mode" }),
    );
    const read = await screen.findByRole("menuitem", {
      name: "Read",
    });
    expect(read).toBeEnabled();
    fireEvent.click(read);
    expect(screen.getByText("Room BlockNote editor")).toHaveAttribute(
      "data-editable",
      "false",
    );
    expect(
      screen.queryByRole("button", { name: "Close file preview" }),
    ).toBeNull();
  });

  it("offers a bottom voice-material action only inside a visible authorized native Document", async () => {
    voiceMaterials.enabled = true;
    const runtime = createDocumentTestRuntime();

    const document = seedRoomDocument(runtime, "native-voice-selection");
    const queryClient = new QueryClient();
    const panel = (hidden: boolean) => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <TeamHubRuntimeProvider runtime={runtime}>
            <ConnectedFilePanelTab
              documentId={document.id}
              tenantId={document.tenant_id}
              hidden={hidden}
            />
          </TeamHubRuntimeProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
    const view = render(panel(false));
    const editor = await screen.findByText("Room BlockNote editor");
    selectPanelText(editor);
    fireEvent.click(screen.getByRole("button", { name: "Add to voice" }));
    expect(voiceMaterials.addSelection).toHaveBeenCalledExactlyOnceWith({
      documentId: document.id,
      title: document.title,
      quote: "Room BlockNote editor",
    });
    selectPanelText(editor);
    view.rerender(panel(true));
    expect(
      screen.queryByRole("button", {
        name: "Add to voice",
        hidden: true,
      }),
    ).toBeNull();
    expect(screen.getByTestId(`panel-tab-file-${document.id}`)).toHaveAttribute(
      "inert",
    );
  });

  it.each([true, false])(
    "uses the %s Version for text-preview selections",
    async (pinned) => {
      voiceMaterials.enabled = true;
      const runtime = createDocumentTestRuntime();

      const document = await seedRoomUpload(
        runtime,
        "version-voice-selection",
        {
          file: new File(["A selected source paragraph"], "source.txt", {
            type: "text/plain",
          }),
          representationFormat: "text",
        },
      );
      const versionId = document.current_version!.id;
      render(
        <MemoryRouter>
          <QueryClientProvider client={new QueryClient()}>
            <TeamHubRuntimeProvider runtime={runtime}>
              <ConnectedFilePanelTab
                documentId={document.id}
                tenantId={document.tenant_id}
                versionId={pinned ? versionId : undefined}
                previewCurrentVersion={!pinned}
              />
            </TeamHubRuntimeProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
      selectPanelText(await screen.findByText("A selected source paragraph"));
      fireEvent.click(screen.getByRole("button", { name: "Add to voice" }));
      expect(voiceMaterials.addSelection).toHaveBeenCalledExactlyOnceWith({
        documentId: document.id,
        title: document.title,
        quote: "A selected source paragraph",
        versionId,
      });
    },
  );

  it("does not mount the selection action before access is confirmed or after access is denied", async () => {
    voiceMaterials.enabled = true;
    const runtime = createDocumentTestRuntime();

    let deny!: (response: Response) => void;
    const denied = new Promise<Response>((resolve) => {
      deny = resolve;
    });
    runtime.server.on("POST", "/v0/documents/{documentId}/open", () => denied);
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <TeamHubRuntimeProvider runtime={runtime}>
            <ConnectedFilePanelTab
              documentId="document-denied"
              tenantId="tenant-northstar"
            />
          </TeamHubRuntimeProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Opening document");
    expect(screen.queryByRole("button", { name: "Add to voice" })).toBeNull();
    deny(teamHubErrorResponse(403, "FORBIDDEN", "Document denied"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Document denied",
    );
    expect(screen.queryByRole("button", { name: "Add to voice" })).toBeNull();
    expect(voiceMaterials.addSelection).not.toHaveBeenCalled();
  });
});

function selectPanelText(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
}

function readDocumentVersion(client: TeamHubClient, documentVersionId: string) {
  return teamHubData(
    client.api.GET("/v0/document-versions/{documentVersionId}", {
      params: { path: { documentVersionId } },
    }),
  );
}
