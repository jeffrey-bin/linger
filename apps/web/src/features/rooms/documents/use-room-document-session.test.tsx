import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import * as Y from "yjs";

import {
  createHttpTeamHubClient,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";
import { artifactPreviewCache } from "../files/artifact-preview-cache";
import type { RoomDocumentCollaborationSession } from "./room-document-collaboration";
import { useRoomDocumentSession } from "./use-room-document-session";

vi.mock("./document-editor-preload", () => ({
  preloadDocumentEditor: vi.fn(async () => undefined),
}));

const fakes = vi.hoisted(() => ({
  deleteCopies: vi.fn(async () => undefined),
  destroy: vi.fn(async () => undefined),
  open: vi.fn(),
}));

vi.mock("./room-document-collaboration", async (loadOriginal) => {
  const original =
    await loadOriginal<typeof import("./room-document-collaboration")>();
  return { ...original, openRoomDocumentSession: fakes.open };
});

vi.mock("./room-document-local-copies", async (loadOriginal) => {
  const original =
    await loadOriginal<typeof import("./room-document-local-copies")>();
  return { ...original, deleteRoomDocumentLocalCopies: fakes.deleteCopies };
});

describe("useRoomDocumentSession lifecycle", () => {
  beforeEach(() => {
    fakes.deleteCopies.mockClear();
    fakes.destroy.mockClear();
    fakes.open.mockReset();
    fakes.open.mockImplementation(async (input: { readOnly: boolean }) =>
      collaborationSession({ readOnly: input.readOnly }),
    );
  });

  it("does not reissue credentials or rebuild a session for unrelated rerenders", async () => {
    const createCredential = vi.fn((_: TestRouteRequest): unknown => ({
      collaboration_credential: "credential-one",
      document_id: "document-one",
      expires_at: "2099-01-01T00:00:00Z",
    }));
    const openDocument = vi.fn((_: TestRouteRequest): unknown => ({
      document: nativeDocument({
        draftCapability: "write",
        id: "document-one",
        write: true,
      }),
      collaboration_credential: {
        collaboration_credential: "credential-one",
        document_id: "document-one",
        expires_at: "2099-01-01T00:00:00Z",
      },
    }));
    const { client, server } = sessionClient(oneActorIdentity, (server) =>
      server
        .on("POST", "/v0/documents/{documentId}/open", openDocument)
        .on(
          "POST",
          "/v0/documents/{documentId}/collaboration-credentials",
          createCredential,
        ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    let documentId = "document-one";
    const { rerender, result } = renderHook(
      () =>
        useRoomDocumentSession({
          client,
          documentId,
          documentRuntimeUrl: "wss://runtime.test",
          tenantId: "tenant-one",
        }),
      { wrapper, reactStrictMode: true },
    );
    await waitFor(() => expect(result.current.session).not.toBeNull());
    const resyncSession = result.current.resyncSession;
    rerender();
    rerender();
    await Promise.resolve();
    expect(result.current.resyncSession).toBe(resyncSession);
    expect(openDocument).toHaveBeenCalledOnce();
    expect(server.requestsTo("GET", "/v0/documents/{documentId}")).toHaveLength(
      0,
    );
    expect(createCredential).not.toHaveBeenCalled();
    expect(fakes.open).toHaveBeenCalledOnce();
    expect(fakes.destroy).not.toHaveBeenCalled();
    // A reopened editor keeps its local copy and saves it under the new token.
    expect(fakes.deleteCopies).not.toHaveBeenCalled();
    const refresh = fakes.open.mock.calls[0]?.[0]?.refreshCredential as
      | (() => Promise<unknown>)
      | undefined;
    await expect(refresh?.()).resolves.toBe("credential-one");
    expect(createCredential).toHaveBeenCalledOnce();
    expect(fakes.open).toHaveBeenCalledOnce();
    expect(fakes.destroy).not.toHaveBeenCalled();
    createCredential.mockReturnValueOnce({
      collaboration_credential: "credential-other-document",
      document_id: "document-other",
      expires_at: "2099-01-01T00:00:00Z",
    });
    await expect(refresh?.()).rejects.toThrow(
      "TeamHub returned inconsistent Document session metadata.",
    );
    createCredential.mockReturnValueOnce({
      collaboration_credential: "credential-invalid-expiry",
      document_id: "document-one",
      expires_at: "not-a-timestamp",
    });
    await expect(refresh?.()).rejects.toThrow(
      "TeamHub returned inconsistent Document session metadata.",
    );
    const recover = fakes.open.mock.calls[0]?.[0]
      ?.onLocalCopiesDeleted as () => void;
    act(() => recover());
    await waitFor(() => expect(fakes.open).toHaveBeenCalledTimes(2));
    expect(fakes.destroy).toHaveBeenCalledOnce();
    openDocument.mockReturnValueOnce({
      document: nativeDocument({
        draftCapability: "write",
        id: "document-two",
        write: true,
      }),
      collaboration_credential: {
        collaboration_credential: "credential-two",
        document_id: "document-two",
        expires_at: "2099-01-01T00:00:00Z",
      },
    });
    documentId = "document-two";
    rerender();
    await waitFor(() => expect(fakes.open).toHaveBeenCalledTimes(3));
    expect(fakes.destroy).toHaveBeenCalledTimes(2);
    expect(result.current.document?.id).toBe("document-two");
    expect(server.requestsTo("GET", "/v0/documents/{documentId}")).toHaveLength(
      0,
    );
  });

  it("opens a read-only native session without requesting write authority", async () => {
    const createReadCredential = vi.fn(() => ({
      collaboration_credential: "read-credential",
      document_id: "document-read",
      expires_at: "2099-01-01T00:00:00Z",
    }));
    const openDocument = vi.fn(() => ({
      document: nativeDocument({
        draftCapability: "read",
        id: "document-read",
        write: false,
      }),
      collaboration_credential: {
        collaboration_credential: "read-credential",
        document_id: "document-read",
        expires_at: "2099-01-01T00:00:00Z",
      },
    }));
    const { client, server } = sessionClient(oneActorIdentity, (server) =>
      server
        .on("POST", "/v0/documents/{documentId}/open", openDocument)
        .on(
          "POST",
          "/v0/documents/{documentId}/read-session-credentials",
          createReadCredential,
        ),
    );
    const writeCredentialRequests = () =>
      server.requestsTo(
        "POST",
        "/v0/documents/{documentId}/collaboration-credentials",
      );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useRoomDocumentSession({
          client,
          documentId: "document-read",
          documentRuntimeUrl: "wss://runtime.test",
          tenantId: "tenant-one",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.session).not.toBeNull());
    expect(result.current.session?.readOnly).toBe(true);
    expect(openDocument).toHaveBeenCalledOnce();
    expect(server.requestsTo("GET", "/v0/documents/{documentId}")).toHaveLength(
      0,
    );
    expect(createReadCredential).not.toHaveBeenCalled();
    expect(writeCredentialRequests()).toHaveLength(0);
    expect(fakes.open).toHaveBeenCalledOnce();
    expect(fakes.open.mock.calls[0]?.[0]).toMatchObject({ readOnly: true });
    const refresh = fakes.open.mock.calls[0]?.[0]?.refreshCredential as
      | (() => Promise<unknown>)
      | undefined;
    await expect(refresh?.()).resolves.toBe("read-credential");
    expect(createReadCredential).toHaveBeenCalledOnce();
    expect(writeCredentialRequests()).toHaveLength(0);

    result.current.resyncSession();
    await waitFor(() => expect(openDocument).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fakes.open).toHaveBeenCalledTimes(2));
    expect(fakes.destroy).toHaveBeenCalledOnce();
  });

  it("drops the local copy and reopens when access is revoked while open", async () => {
    const { client, createCredential, openDocument } = writableClient();
    const { result } = renderSessionHook(client);
    await waitFor(() => expect(result.current.session).not.toBeNull());
    fakes.deleteCopies.mockClear();
    createCredential.mockReturnValueOnce(
      teamHubErrorResponse(404, "NOT_FOUND", "gone"),
    );
    openDocument.mockReturnValueOnce(
      teamHubErrorResponse(404, "NOT_FOUND", "gone"),
    );
    const opened = fakes.open.mock.calls[0]?.[0] as {
      onLocalCopiesDeleted: () => void;
      refreshCredential: () => Promise<unknown>;
    };
    // Deleting the copies closes the open session, which asks to reopen.
    fakes.deleteCopies.mockImplementationOnce(async () => {
      opened.onLocalCopiesDeleted();
    });

    await expect(opened.refreshCredential()).rejects.toThrow("gone");
    expect(fakes.deleteCopies).toHaveBeenCalledWith({
      actorIds: ["actor-one"],
      documentId: "document-one",
    });
    await waitFor(() =>
      expect(result.current.error).toBe("Document is unavailable."),
    );
    expect(openDocument).toHaveBeenCalledTimes(2);
  });

  it("reopens when another tab deletes the local copy", async () => {
    const { client, openDocument } = writableClient();
    const { result } = renderSessionHook(client);
    await waitFor(() => expect(result.current.session).not.toBeNull());
    const deleted = fakes.open.mock.calls[0]?.[0]
      ?.onLocalCopiesDeleted as () => void;

    act(() => deleted());
    await waitFor(() => expect(fakes.open).toHaveBeenCalledTimes(2));
    expect(openDocument).toHaveBeenCalledTimes(2);
  });

  it("returns the open Version and drops prefetched bytes when open is denied", async () => {
    const actor = {
      display_name: "One",
      id: "actor-one",
      kind: "human" as const,
      tenant_id: "tenant-one",
    };
    const file = {
      ...nativeDocument({
        draftCapability: "read",
        id: "file-one",
        write: false,
      }),
      draft_capability: "none" as const,
      format: "docx" as const,
      representation_format: "binary",
    };
    const currentVersion = {
      created_at: "2026-08-27T00:00:00Z",
      created_by: actor,
      document_id: "file-one",
      filename: "brief.docx",
      id: "version-one",
      media_type: "application/octet-stream",
      representation_format: "binary",
      sha256: "a".repeat(64),
      size_bytes: 3,
      source: "ordinary_upload" as const,
      version_number: 1,
    };
    const openDocument = vi
      .fn<(request: TestRouteRequest) => unknown>()
      .mockReturnValueOnce({
        document: file,
        current_version: currentVersion,
      })
      .mockReturnValueOnce(teamHubErrorResponse(404, "NOT_FOUND", "gone"));
    const { client } = sessionClient(
      {
        account: { id: "account-one", email: "one@example.com" },
        actors: [actor],
      },
      (server) =>
        server
          .on("POST", "/v0/documents/{documentId}/open", openDocument)
          .on("GET", "/v0/documents/{documentId}", () => file),
    );
    const clear = vi.spyOn(artifactPreviewCache, "clear");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useRoomDocumentSession({
          client,
          documentId: "file-one",
          documentRuntimeUrl: "wss://runtime.test",
          tenantId: "tenant-one",
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.currentVersion).toEqual(currentVersion),
    );
    expect(clear).not.toHaveBeenCalled();
    act(() => result.current.resyncSession());
    await waitFor(() =>
      expect(result.current.error).toBe("Document is unavailable."),
    );
    expect(result.current.currentVersion).toBeUndefined();
    expect(clear).toHaveBeenCalledOnce();
    // Access lost while the tab was away: the copy goes before the error.
    expect(fakes.deleteCopies).toHaveBeenCalledWith({
      actorIds: ["actor-one"],
      documentId: "file-one",
    });
    clear.mockRestore();
  });
});

function writableClient() {
  const credential = {
    collaboration_credential: "credential-one",
    document_id: "document-one",
    expires_at: "2099-01-01T00:00:00Z",
  };
  const createCredential = vi.fn((_: TestRouteRequest): unknown => credential);
  const openDocument = vi.fn((_: TestRouteRequest): unknown => ({
    document: nativeDocument({
      draftCapability: "write",
      id: "document-one",
      write: true,
    }),
    collaboration_credential: credential,
  }));
  const { client } = sessionClient(oneActorIdentity, (server) =>
    server
      .on("POST", "/v0/documents/{documentId}/open", openDocument)
      .on(
        "POST",
        "/v0/documents/{documentId}/collaboration-credentials",
        createCredential,
      ),
  );
  return { client, createCredential, openDocument };
}

function renderSessionHook(client: TeamHubClient) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useRoomDocumentSession({
        client,
        documentId: "document-one",
        documentRuntimeUrl: "wss://runtime.test",
        tenantId: "tenant-one",
      }),
    { wrapper },
  );
}

function collaborationSession(
  input: { readOnly?: boolean } = {},
): RoomDocumentCollaborationSession {
  return {
    awareness: null,
    destroy: fakes.destroy,
    document: new Y.Doc(),
    getSaveSnapshot: () => ({ canEdit: true, status: "Saved" }),
    readOnly: input.readOnly ?? false,
    subscribeSaveState: () => () => undefined,
    user: { actorId: "actor-one", color: "#000", name: "One" },
  };
}

function nativeDocument(input: {
  draftCapability: "read" | "write";
  id: string;
  write: boolean;
}) {
  const actor = {
    display_name: "One",
    id: "actor-one",
    kind: "human" as const,
    tenant_id: "tenant-one",
  };
  return {
    can_edit_native_content: true,
    capabilities: {
      comment: true,
      delete: false,
      duplicate: true,
      export: true,
      manage: false,
      read: true,
      use_as_context: true,
      write: input.write,
    },
    created_at: "2026-08-27T00:00:00Z",
    creator: actor,
    current_version: null,
    draft_capability: input.draftCapability,
    format: "blocknote" as const,
    from: [],
    id: input.id,
    owner: actor,
    representation_format: "markdown",
    status: "active" as const,
    tenant_id: "tenant-one",
    title: "One",
    updated_at: "2026-08-27T00:00:00Z",
  };
}

const oneActorIdentity = {
  account: { id: "account-one", email: "one@example.com" },
  actors: [
    {
      display_name: "One",
      id: "actor-one",
      kind: "human",
      tenant_id: "tenant-one",
    },
  ],
};

/** A TeamHub client whose API answers the current identity and the routes a test declares. */
function sessionClient(
  identity: unknown,
  routes: (server: TeamHubTestServer) => TeamHubTestServer,
) {
  const server = routes(
    new TeamHubTestServer().on("GET", "/v0/me", () => identity),
  );
  const client = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
  return { client, server };
}
