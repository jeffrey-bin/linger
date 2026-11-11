import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { TeamHubLoginPage } from "./teamhub-login-page";

afterEach(() => vi.useRealTimers());

describe("TeamHubLoginPage", () => {
  it.each(["login", "getSession"] as const)(
    "recovers a pending %s after ten seconds and ignores its late result",
    async (stage) => {
      vi.useFakeTimers();
      let release!: (value: unknown) => void;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const onAuthenticated = vi.fn();
      const queryClient = new QueryClient();
      queryClient.setQueryData(["teamhub", "identity"], {
        account: { id: "old" },
      });
      const operation = vi.fn<TestRouteHandler>().mockReturnValue(pending);
      renderAuthenticationPage(
        {
          login: vi.fn(() => ({ id: "login-result" })),
          [stage]: operation,
        },
        { onAuthenticated, queryClient },
      );
      fillSignIn();
      fireEvent.submit(
        screen.getByRole("button", { name: "Sign in" }).closest("form")!,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_999);
      });
      expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByRole("alert")).toHaveTextContent(/timed out/i);
      expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
      expect(operation.mock.calls[0]![0].request.signal.aborted).toBe(true);
      await act(async () => {
        release({ id: "late-session", identity: { actors: [] } });
      });
      expect(onAuthenticated).not.toHaveBeenCalled();
      expect(queryClient.getQueryData(["teamhub", "identity"])).toEqual({
        account: { id: "old" },
      });
      expect(queryClient.getQueryData(["teamhub", "session"])).toBeUndefined();
    },
  );

  it("seeds only the Cookie-verified Session and identity after clearing old data", async () => {
    const verified = {
      id: "verified-session",
      account_id: "new-account",
      identity: { account: { id: "new-account" }, actors: [] },
    };
    const queryClient = new QueryClient();
    queryClient.setQueryData(["teamhub", "old-private-data"], "secret");
    const onAuthenticated = vi.fn();
    renderAuthenticationPage(
      {
        login: () => ({ id: "unverified" }),
        getSession: () => verified,
      },
      { queryClient, onAuthenticated },
    );
    fillSignIn();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(onAuthenticated).toHaveBeenCalledWith({
        kind: "login",
        session: verified,
      }),
    );
    expect(
      queryClient.getQueryData(["teamhub", "old-private-data"]),
    ).toBeUndefined();
    expect(queryClient.getQueryData(["teamhub", "session"])).toEqual(verified);
    expect(queryClient.getQueryData(["teamhub", "identity"])).toEqual(
      verified.identity,
    );
  });
  it("does not publish or cache a session after unmount", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const queryClient = new QueryClient();
    const onAuthenticated = vi.fn();
    const view = renderAuthenticationPage(
      { login: () => pending },
      { queryClient, onAuthenticated },
    );
    fillSignIn();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    view.unmount();
    await act(async () => release({ id: "late", identity: { actors: [] } }));
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["teamhub", "session"])).toBeUndefined();
  });
  it("keeps a retry locked when the timed-out login resolves late", async () => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    const login = vi
      .fn<TestRouteHandler>()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      )
      .mockReturnValue(new Promise(() => {}));
    const onAuthenticated = vi.fn();
    renderAuthenticationPage({ login }, { onAuthenticated });
    fillSignIn();
    const form = screen
      .getByRole("button", { name: "Sign in" })
      .closest("form")!;
    fireEvent.submit(form);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    fireEvent.submit(form);
    await act(async () => release({ id: "late", identity: { actors: [] } }));
    fireEvent.submit(form);
    expect(login).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
  it("leaves the password length to TeamHub, which counts bytes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const login = vi
      .fn<TestRouteHandler>()
      .mockReturnValue(new Promise(() => {}));
    renderAuthenticationPage({ login });
    expect(screen.getByLabelText("Password")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "jenny@example.com" },
    });
    // Four euro signs are 12 UTF-8 bytes, inside TeamHub's 8-byte minimum.
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "€€€€" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(login).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { identifier: "jenny@example.com", password: "€€€€" },
        }),
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("synchronously rejects duplicate form submissions", async () => {
    const login = vi
      .fn<TestRouteHandler>()
      .mockReturnValue(new Promise(() => {}));
    renderAuthenticationPage({ login });
    fillSignIn();
    const form = screen
      .getByRole("button", { name: "Sign in" })
      .closest("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(login).toHaveBeenCalled());
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("does not put fixture credentials into the shared login form", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamHubRuntimeProvider runtime={createTestTeamHubRuntime()}>
          <MemoryRouter>
            <TeamHubLoginPage />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("Email")).toHaveValue("");
    expect(
      screen.getByLabelText("Password", { selector: "input" }),
    ).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Show password" }),
    ).toHaveAttribute("type", "button");
    expect(
      screen.queryByText("Product fixture environment"),
    ).not.toBeInTheDocument();
  });

  it("submits TeamHub credentials and completes authentication", async () => {
    const login = vi.fn(() => ({ id: "session-1" }));
    const queryClient = new QueryClient();
    queryClient.setQueryData(["teamhub", "identity"], {
      account: { id: "previous-account" },
    });
    queryClient.setQueryData(
      ["teamhub", "account-profile", "tenant-northstar"],
      { name: "Previous Owner" },
    );
    queryClient.setQueryData(
      ["teamhub", "personal-profile", "tenant-northstar"],
      {
        current: { id: "previous-owner-profile" },
      },
    );
    const onAuthenticated = vi.fn(() => {
      expect(
        queryClient.getQueryData([
          "teamhub",
          "account-profile",
          "tenant-northstar",
        ]),
      ).toBeUndefined();
      expect(
        queryClient.getQueryData([
          "teamhub",
          "personal-profile",
          "tenant-northstar",
        ]),
      ).toBeUndefined();
      expect(queryClient.getQueryData(["teamhub", "identity"])).toBeUndefined();
    });

    renderAuthenticationPage({ login }, { onAuthenticated, queryClient });

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "jenny@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith(
        expect.objectContaining({
          body: {
            identifier: "jenny@example.com",
            password: "secret-password",
          },
        }),
      );
      expect(onAuthenticated).toHaveBeenCalledOnce();
    });
  });

  it("returns a switched account to the pending Local Computer setup", async () => {
    const returnTo =
      "/connect-computer?code_challenge=challenge&redirect_uri=callback&state=state";
    const login = () => ({ id: "session-1" });

    renderAuthenticationPage(
      { login },
      {
        initialEntry: `/login?return_to=${encodeURIComponent(returnTo)}`,
        showLocation: true,
      },
    );

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "second@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(returnTo),
    );
  });

  it("does not follow an external return target after authentication", async () => {
    const login = () => ({
      id: "session-1",
      identity: { actors: [] },
    });

    renderAuthenticationPage(
      { login },
      {
        initialEntry:
          "/login?return_to=https%3A%2F%2Fevil.example%2Fconnect-computer",
        showLocation: true,
      },
    );

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "jenny@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/"),
    );
  });

  it("explains when login succeeds but the browser Session is unavailable", async () => {
    const onAuthenticated = vi.fn();

    renderAuthenticationPage(
      {
        getSession: () =>
          teamHubErrorResponse(
            401,
            "UNAUTHENTICATED",
            "authentication required",
          ),
        login: () => ({ id: "session-without-cookie" }),
      },
      { onAuthenticated },
    );

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "jenny@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Linger could not establish a browser session. Use the secure workspace address or contact your workspace administrator.",
    );
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("sends a signed-in Human to Rooms", async () => {
    renderAuthenticationPage(
      {
        login: () => ({
          id: "session-login",
          identity: { actors: [{ tenant_id: "tenant-existing" }] },
        }),
      },
      { showLocation: true },
    );
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "jenny@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/t/tenant-existing/rooms",
      ),
    );
  });

  it("explains when the current Session expired", () => {
    renderAuthenticationPage(
      {},
      { initialEntry: "/login?reason=session-expired" },
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your session has expired. Sign in again to continue.",
    );
  });
});

describe("TeamHubLoginPage in the desktop app", () => {
  const LOCAL_BUTTON = "Sign in with this computer's account";
  const desktop = (localAccount: {
    available: () => Promise<boolean>;
    signIn: () => Promise<unknown>;
  }) => {
    Object.assign(window, { lingerDesktop: { localAccount } });
    return localAccount;
  };
  afterEach(() => {
    delete (window as { lingerDesktop?: unknown }).lingerDesktop;
  });

  it("offers no account button in a browser", () => {
    renderAuthenticationPage({});
    expect(
      screen.queryByRole("button", { name: LOCAL_BUTTON }),
    ).not.toBeInTheDocument();
  });

  it("offers no account button for a server this computer did not install", async () => {
    const account = desktop({
      available: vi.fn(async () => false),
      signIn: vi.fn(),
    });
    renderAuthenticationPage({});
    await waitFor(() => expect(account.available).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: LOCAL_BUTTON }),
    ).not.toBeInTheDocument();
  });

  it("signs in with one click and confirms the Session the desktop set", async () => {
    const verified = {
      id: "local-session",
      identity: { account: { id: "owner" }, actors: [] },
    };
    const login = vi.fn();
    const account = desktop({
      available: async () => true,
      signIn: vi.fn(async () => ({ ok: true })),
    });
    const onAuthenticated = vi.fn();
    renderAuthenticationPage(
      { login, getSession: () => verified },
      { onAuthenticated },
    );
    fireEvent.click(await screen.findByRole("button", { name: LOCAL_BUTTON }));
    await waitFor(() =>
      expect(onAuthenticated).toHaveBeenCalledWith({
        kind: "login",
        session: verified,
      }),
    );
    expect(account.signIn).toHaveBeenCalledOnce();
    expect(login).not.toHaveBeenCalled();
  });

  it("shows why the desktop could not sign in", async () => {
    desktop({
      available: async () => true,
      signIn: async () => ({
        ok: false,
        message: "The account file of Linger on this computer is missing.",
      }),
    });
    const onAuthenticated = vi.fn();
    renderAuthenticationPage({}, { onAuthenticated });
    fireEvent.click(await screen.findByRole("button", { name: LOCAL_BUTTON }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The account file of Linger on this computer is missing.",
    );
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: LOCAL_BUTTON })).toBeEnabled();
  });

  it("asks for the email and password when the desktop call fails", async () => {
    desktop({
      available: async () => true,
      signIn: async () => {
        throw new Error("Not allowed");
      },
    });
    renderAuthenticationPage({});
    fireEvent.click(await screen.findByRole("button", { name: LOCAL_BUTTON }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This computer's account could not be used. Log in with your email and password.",
    );
  });
});

/**
 * Answers login and the Session check from the given handlers. Without a
 * Session handler, the Session echoes the latest login result.
 */
function renderAuthenticationPage(
  routes: { getSession?: TestRouteHandler; login?: TestRouteHandler },
  options: {
    initialEntry?: string;
    onAuthenticated?: Parameters<typeof TeamHubLoginPage>[0]["onAuthenticated"];
    queryClient?: QueryClient;
    showLocation?: boolean;
  } = {},
) {
  const runtime = createTestTeamHubRuntime();
  let loginResult: Promise<{ identity?: unknown } | undefined> | undefined;
  const { login } = routes;
  if (login)
    runtime.server.on("POST", "/v0/auth/login", (request) => {
      loginResult = Promise.resolve(
        login(request) as { identity?: unknown } | undefined,
      );
      return loginResult;
    });
  runtime.server.on(
    "GET",
    "/v0/session",
    routes.getSession ??
      (async () => {
        if (!loginResult)
          return { id: "session-confirmed", identity: { actors: [] } };
        const session = await loginResult;
        return { ...session, identity: session?.identity ?? { actors: [] } };
      }),
  );
  return render(
    <QueryClientProvider client={options.queryClient ?? new QueryClient()}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter initialEntries={[options.initialEntry ?? "/login"]}>
          <TeamHubLoginPage onAuthenticated={options.onAuthenticated} />
          {options.showLocation ? <LocationProbe /> : null}
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
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

function fillSignIn() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "jenny@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password", { selector: "input" }), {
    target: { value: "secret-password" },
  });
}
