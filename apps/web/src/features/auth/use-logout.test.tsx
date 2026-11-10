import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { browserRoomMessageOutbox } from "@/features/rooms/chat/room-message-outbox";
import {
  readRoomComposerDraft,
  writeRoomComposerDraft,
} from "@/features/rooms/room-drafts";
import { teamHubAuthenticationSignals } from "@/features/teamhub/teamhub-authentication";
import { LOGOUT_UNSAVED_DOCUMENT_MESSAGE, useLogout } from "./use-logout";

const localCopies = vi.hoisted(() => ({
  delete: vi.fn(async (_input: { actorIds: readonly string[] }) => undefined),
  unsaved: vi.fn(() => false),
}));

vi.mock("@/features/rooms/documents/room-document-local-copies", () => ({
  deleteRoomDocumentLocalCopies: localCopies.delete,
  hasUnsavedRoomDocumentChanges: localCopies.unsaved,
}));

beforeEach(() => {
  localCopies.delete.mockClear();
  localCopies.unsaved.mockReset().mockReturnValue(false);
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } satisfies Storage,
  });
});

afterEach(() => vi.restoreAllMocks());

describe("useLogout", () => {
  it("keeps the authenticated state when TeamHub cannot revoke the Session", async () => {
    const runtime = await testRuntime();
    const clearOutbox = vi
      .spyOn(browserRoomMessageOutbox, "clearAccount")
      .mockResolvedValue(undefined);
    const identity = runtime.seed.identity;
    const queryClient = new QueryClient();
    queryClient.setQueryData(["teamhub", "session"], { id: "session-1" });
    const draftScope = {
      accountId: identity.account.id,
      roomId: "room-all",
      tenantId: "tenant-northstar",
    };
    writeRoomComposerDraft(draftScope, {
      body: "private draft",
      documentContexts: [],
      documentReferences: [],
      mentions: [],
      skillReferences: [],
    });
    runtime.server.on("POST", "/v0/auth/logout", () => {
      throw new Error("TeamHub is offline.");
    });

    renderLogout(runtime, "/t/tenant-northstar/settings/security", queryClient);
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));

    expect(
      await screen.findByText("Could not confirm logout. Please retry."),
    ).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/t/tenant-northstar/settings/security",
    );
    expect(queryClient.getQueryData(["teamhub", "session"])).toEqual({
      id: "session-1",
    });
    expect(readRoomComposerDraft(draftScope).body).toBe("private draft");
    expect(localCopies.delete).not.toHaveBeenCalled();
    expect(clearOutbox).toHaveBeenCalledOnce();
    expect(clearOutbox).toHaveBeenCalledWith(identity.account.id);
    expect(screen.getByRole("button", { name: "Log out" })).toBeEnabled();
  });

  it("orders outbox, revocation, navigation, local cleanup and broadcast; ignores duplicate requests", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const queryClient = new QueryClient();
    queryClient.setQueryData(["teamhub", "private"], "cached");
    const scope = {
      accountId: identity.account.id,
      tenantId: "tenant-northstar",
      roomId: "room-all",
    };
    writeRoomComposerDraft(scope, {
      body: "private draft",
      documentContexts: [],
      documentReferences: [],
      mentions: [],
      skillReferences: [],
    });
    window.localStorage.setItem(
      "global-search-recent.v2:tenant-northstar",
      JSON.stringify({ queries: ["private customer query"], opened: {} }),
    );
    let finishOutbox!: () => void;
    const clearOutbox = vi
      .spyOn(browserRoomMessageOutbox, "clearAccount")
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishOutbox = resolve;
          }),
      );
    let finishLogout!: () => void;
    const revoke = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLogout = resolve;
        }),
    );
    runtime.server.on("POST", "/v0/auth/logout", revoke);
    const broadcast = vi
      .spyOn(teamHubAuthenticationSignals, "broadcast")
      .mockImplementation(() => {
        expect(screen.getByTestId("location")).toHaveTextContent("/login");
        expect(
          queryClient.getQueryData(["teamhub", "private"]),
        ).toBeUndefined();
        expect(readRoomComposerDraft(scope).body).toBe("");
        expect(
          window.localStorage.getItem(
            "global-search-recent.v2:tenant-northstar",
          ),
        ).toBeNull();
        expect(localCopies.delete).toHaveBeenCalledExactlyOnceWith({
          actorIds: identity.actors.map((actor) => actor.id),
        });
      });
    renderLogout(runtime, undefined, queryClient);
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(clearOutbox).toHaveBeenCalledOnce());
    expect(revoke).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Log out" })).toBeDisabled();
    await act(async () => finishOutbox());
    await waitFor(() => expect(revoke).toHaveBeenCalledOnce());
    expect(screen.getByTestId("location")).not.toHaveTextContent("/login");
    expect(localCopies.delete).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["teamhub", "private"])).toBe("cached");
    expect(broadcast).not.toHaveBeenCalled();
    await act(async () => finishLogout());
    await waitFor(() => expect(broadcast).toHaveBeenCalledOnce());
    expect(
      window.localStorage.getItem("global-search-recent.v2:tenant-northstar"),
    ).toBeNull();
    expect(clearOutbox).toHaveBeenCalledWith(identity.account.id);
  });

  it("does not retry ambiguous logout failures even when global mutation retries are enabled", async () => {
    const runtime = await testRuntime();
    vi.spyOn(browserRoomMessageOutbox, "clearAccount").mockResolvedValue();
    const revoke = vi.fn(() => {
      throw new Error("Response lost");
    });
    runtime.server.on("POST", "/v0/auth/logout", revoke);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 2, retryDelay: 0 } },
    });
    renderLogout(runtime, undefined, queryClient);
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("asks before discarding unsaved Document edits", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    vi.spyOn(browserRoomMessageOutbox, "clearAccount").mockResolvedValue();
    const revoke = vi.fn(() => undefined);
    runtime.server.on("POST", "/v0/auth/logout", revoke);
    localCopies.unsaved.mockReturnValue(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderLogout(runtime);

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(confirm).toHaveBeenCalledWith(LOGOUT_UNSAVED_DOCUMENT_MESSAGE);
    expect(revoke).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Log out" })).toBeEnabled();

    confirm.mockClear().mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(confirm).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(/^\/login$/),
    );
    expect(revoke).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(localCopies.delete).toHaveBeenCalledWith({
        actorIds: identity.actors.map((actor) => actor.id),
      }),
    );
  });

  it("rejects an external return destination", async () => {
    const runtime = await testRuntime();
    runtime.server.on("POST", "/v0/auth/logout", () => undefined);
    vi.spyOn(browserRoomMessageOutbox, "clearAccount").mockResolvedValue();
    renderLogout(
      runtime,
      "/start?return_to=https%3A%2F%2Fevil.example%2Fconnect-computer%3Fx%3D1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(/^\/login$/),
    );
  });

  it("keeps the Session active when explicit logout cannot clear the local Outbox", async () => {
    const runtime = await testRuntime();
    vi.spyOn(browserRoomMessageOutbox, "clearAccount").mockRejectedValue(
      new Error("IndexedDB transaction aborted."),
    );

    renderLogout(runtime, "/t/tenant-northstar/settings/security");
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));

    expect(
      await screen.findByText("Could not confirm logout. Please retry."),
    ).toBeVisible();
    expect(runtime.server.requestsTo("POST", "/v0/auth/logout")).toHaveLength(
      0,
    );
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/t/tenant-northstar/settings/security",
    );
  });
});
async function testRuntime() {
  const runtime = createTestTeamHubRuntime();

  return runtime;
}
function LogoutProbe() {
  const logout = useLogout({
    returnTo:
      new URLSearchParams(useLocation().search).get("return_to") ?? undefined,
  });
  return (
    <>
      <button
        disabled={logout.isPending}
        onClick={() => {
          logout.mutate();
          logout.mutate();
        }}
      >
        Log out
      </button>
      {logout.error ? (
        <p role="alert">Could not confirm logout. Please retry.</p>
      ) : null}
    </>
  );
}
function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}
function renderLogout(
  runtime: Awaited<ReturnType<typeof testRuntime>>,
  initialEntry = "/t/tenant-northstar/settings/security",
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/login" element={<p>Signed out</p>} />
            <Route path="*" element={<LogoutProbe />} />
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}
