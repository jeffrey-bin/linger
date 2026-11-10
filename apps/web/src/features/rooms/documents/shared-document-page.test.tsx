import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, expect, it, vi } from "vitest";
import {
  createHttpTeamHubClient,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import { TeamHubTestServer } from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { SharedDocumentPage } from "./shared-document-page";

afterEach(cleanup);
const token = `doc_link_${"a".repeat(43)}`;
function renderPage(
  role: "viewer" | "editor",
  readOnly = false,
  downloadError?: unknown,
) {
  const download = vi.fn();
  if (downloadError) download.mockRejectedValue(downloadError);
  else
    download.mockResolvedValue({
      documentId: "doc-1",
      versionId: "version-1",
      filename: "shared.txt",
      representationFormat: "plain_text",
      readOnly,
      access: { role },
      mediaType: "text/plain",
      blob: { size: 11, text: async () => "initial text" },
    });
  const uploadDocumentVersion = vi
    .fn()
    .mockRejectedValue(new Error("Link revoked"));
  const server = new TeamHubTestServer().on("GET", "/v0/session", () => ({
    account_id: "account-1",
  }));
  const client = {
    api: createHttpTeamHubClient({
      fetchRequest: server.fetch,
      onAuthenticationRequired: () => undefined,
    }).api,
    documentLinks: { download },
    uploadDocumentVersion,
  } as unknown as TeamHubClient;
  const router = createMemoryRouter(
    [{ path: "/shared-documents", element: <SharedDocumentPage /> }],
    { initialEntries: [`/shared-documents#${token}`] },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider
        runtime={{
          client,
          runStatuses: { subscribe: () => () => undefined },
          events: {
            subscribeRoom: () => () => undefined,
            subscribeSignals: () => () => undefined,
          },
        }}
      >
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { download, uploadDocumentVersion };
}

it.each([
  ["viewer", false],
  ["editor", true],
] as const)("keeps %s native=%s content read only", async (role, native) => {
  renderPage(role, native);
  expect(await screen.findByText("initial text")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.queryByLabelText("Upload version")).toBeNull();
});

it("saves with the exact downloaded base and capability, preserving edits on revocation", async () => {
  const { uploadDocumentVersion } = renderPage("editor");
  const editor = await screen.findByRole("textbox", { name: "File content" });
  fireEvent.change(editor, { target: { value: "changed text" } });
  expect(screen.getByRole("button", { name: "Refresh file" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(uploadDocumentVersion).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({
        expectedCurrentVersionId: "version-1",
        linkToken: token,
        representationFormat: "plain_text",
      }),
      expect.any(String),
    ),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Link revoked");
  expect(editor).toHaveValue("changed text");
});

it.each([
  [
    new TeamHubError({
      code: "NOT_FOUND",
      message: "link missing",
      status: 404,
    }),
    "This link is unavailable or has been revoked.",
  ],
  [
    new TeamHubError({
      code: "FORBIDDEN",
      message: "Access denied",
      status: 403,
    }),
    "Access denied",
  ],
])("shows the matching download failure text", async (error, text) => {
  renderPage("viewer", false, error);
  expect(await screen.findByRole("alert")).toHaveTextContent(text);
});
