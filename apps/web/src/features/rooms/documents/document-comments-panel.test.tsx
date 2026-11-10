import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  createHttpTeamHubClient,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
} from "@/test/teamhub-test-server";
import { commentThreadResponse as threadFixture } from "./document-comment-test-data";

import { DocumentCommentsPanel } from "./document-comments-panel";

describe("Version Document Comments panel", () => {
  it("renders the selected excerpt as a reference without a filename or status tabs", async () => {
    const server = new TeamHubTestServer().on(
      "GET",
      "/v0/documents/{documentId}/comment-threads",
      () => ({
        items: [
          threadFixture(
            "thread_reference",
            "“Selected excerpt”\n\nReview text",
          ),
        ],
        page: { has_more: false },
      }),
    );
    renderPanel({ client: testClient(server) });
    expect(await screen.findByText("Selected excerpt")).toBeVisible();
    expect(screen.getByText("Review text")).toBeVisible();
    expect(screen.queryByText("review.pdf")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /\d+ (Open|Resolved)/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reply" })).toBeVisible();
  });

  it("renders Markdown in version comments using the message renderer", async () => {
    const server = new TeamHubTestServer().on(
      "GET",
      "/v0/documents/{documentId}/comment-threads",
      () => ({
        items: [
          threadFixture(
            "thread_markdown",
            "**Review passed**\n\n- Check again",
          ),
        ],
        page: { has_more: false },
      }),
    );
    renderPanel({ client: testClient(server) });
    expect((await screen.findByText("Review passed")).tagName).toBe("STRONG");
    expect(screen.getByRole("listitem")).toHaveTextContent("Check again");
  });

  it("submits a selected Version excerpt with Enter while preserving IME and Shift+Enter", async () => {
    const created = threadFixture("thread_selection", "Selected review");
    const createRoomDocumentCommentThread = vi.fn(() => created);
    const server = emptyThreadServer().on(
      "POST",
      "/v0/documents/{documentId}/comment-threads",
      createRoomDocumentCommentThread,
    );
    const onSelectionConsumed = vi.fn();
    renderPanel({
      client: testClient(server),
      onSelectionConsumed,
      selectionQuote: "selected paragraph",
    });
    const composer = await screen.findByLabelText("New Document comment");
    expect(screen.getByText("selected paragraph")).toBeVisible();
    fireEvent.change(composer, { target: { value: "Please revise this." } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    fireEvent.compositionStart(composer);
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.compositionEnd(composer);
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    fireEvent.keyDown(composer, { key: "Enter", keyCode: 229 });
    expect(createRoomDocumentCommentThread).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() =>
      expect(createRoomDocumentCommentThread).toHaveBeenCalledOnce(),
    );
    expect(createRoomDocumentCommentThread).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { documentId: "document_1" },
        body: expect.objectContaining({
          document_version_id: "version_1",
          initial_comment: {
            segments: [
              {
                content: "“selected paragraph”\n\nPlease revise this.",
                type: "text",
              },
            ],
          },
        }),
      }),
    );
    expect(onSelectionConsumed).toHaveBeenCalledOnce();
  });

  it("keeps the whole-Document Comment draft when creation fails", async () => {
    const createRoomDocumentCommentThread = vi.fn(() =>
      teamHubErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Comment service unavailable",
      ),
    );
    const server = emptyThreadServer().on(
      "POST",
      "/v0/documents/{documentId}/comment-threads",
      createRoomDocumentCommentThread,
    );
    renderPanel({ client: testClient(server) });

    const composer = await screen.findByLabelText("New Document comment");
    fireEvent.change(composer, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Comment service unavailable",
    );
    expect(composer).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Add comment" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    await waitFor(() =>
      expect(createRoomDocumentCommentThread).toHaveBeenCalledTimes(2),
    );
  });
});

function renderPanel({
  client,
  onSelectionConsumed,
  selectionQuote,
}: {
  client: TeamHubClient;
  onSelectionConsumed?: () => void;
  selectionQuote?: string;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DocumentCommentsPanel
        client={client}
        documentId="document_1"
        documentVersionId="version_1"
        onClose={() => undefined}
        onSelectionConsumed={onSelectionConsumed}
        open
        portalTarget={document.body}
        roomId="room_1"
        scopeId="room_1"
        selectionQuote={selectionQuote}
        tenantId="tenant_1"
      />
    </QueryClientProvider>,
  );
}

function emptyThreadServer() {
  return new TeamHubTestServer().on(
    "GET",
    "/v0/documents/{documentId}/comment-threads",
    () => ({ items: [], page: { has_more: false } }),
  );
}

function testClient(server: TeamHubTestServer) {
  return createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
}
