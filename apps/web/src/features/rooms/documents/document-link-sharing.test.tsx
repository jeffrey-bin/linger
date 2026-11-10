import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { DocumentLinkPolicy } from "@/features/teamhub/teamhub-document-links";
import { DocumentLinkSharing } from "./document-link-sharing";

it("creates a read link, changes its role, and revokes the current version", async () => {
  let policy: DocumentLinkPolicy | null = null;
  const get = vi.fn(async () => policy);
  const set = vi.fn(async (_id, input) => {
    policy = {
      id: "link-1",
      document_id: "doc-1",
      role: input.role,
      status: "active",
      version: input.expected_version + 1,
    };
    return {
      ...policy,
      ...(input.expected_version === 0
        ? { url: "https://web.test/shared-documents#test" }
        : {}),
    };
  });
  const revoke = vi.fn(async () => {
    policy = { ...policy!, status: "revoked", version: policy!.version + 1 };
  });
  const client = {
    documentLinks: { get, set, revoke },
  } as unknown as TeamHubClient;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocumentLinkSharing client={client} documentId="doc-1" />
    </QueryClientProvider>,
  );
  const control = screen.getByRole("combobox", { name: "Link access" });
  await waitFor(() => expect(control).toBeEnabled());
  fireEvent.click(control);
  fireEvent.click(await screen.findByRole("option", { name: "Can view" }));
  expect(
    await screen.findByRole("button", { name: "Copy shared link" }),
  ).toBeEnabled();
  expect(set).toHaveBeenLastCalledWith("doc-1", {
    role: "viewer",
    expected_version: 0,
    reset: false,
  });
  fireEvent.click(control);
  fireEvent.click(await screen.findByRole("option", { name: "Can edit" }));
  await waitFor(() => expect(control).toHaveValue("editor"));
  expect(set).toHaveBeenLastCalledWith("doc-1", {
    role: "editor",
    expected_version: 1,
    reset: false,
  });
  fireEvent.click(control);
  fireEvent.click(await screen.findByRole("option", { name: "Disabled" }));
  await waitFor(() => expect(control).toHaveValue("disabled"));
  expect(revoke).toHaveBeenCalledWith("doc-1", { expected_version: 2 });
  expect(screen.queryByRole("button", { name: "Copy shared link" })).toBeNull();
});
