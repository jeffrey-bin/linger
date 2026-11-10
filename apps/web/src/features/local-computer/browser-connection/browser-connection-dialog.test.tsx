import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createTeamHubApi } from "@/features/teamhub/teamhub-api";
import {
  fetchDouble,
  type SentRequestInit,
} from "@/features/teamhub/teamhub-client-test-support";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubBrowserConnectionStatus } from "@/features/teamhub/teamhub-types";

import { BrowserConnectionDialog } from "./browser-connection-dialog";

const tenantId = "tenant-northstar";
const token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U_-";
const isolated: TeamHubBrowserConnectionStatus = {
  mode: "isolated",
  platform: "darwin",
  state: "isolated",
};
const connected: TeamHubBrowserConnectionStatus = {
  browser: "chrome",
  message: "Chrome 147 connected",
  mode: "user_chrome",
  platform: "darwin",
  state: "connected",
};

type BrowserRoute = (
  method: string,
  body: unknown,
) => Promise<TeamHubBrowserConnectionStatus>;

function setup(browser: BrowserRoute) {
  const route = vi.fn(browser);
  const request = vi.fn(async (path: string, init: SentRequestInit) => {
    const match =
      /^\/v0\/tenants\/[^/]+\/local-computers\/([^/]+)\/browser-connection$/.exec(
        path,
      );
    if (!match || match[1] !== "computer-mac") throw new Error(path);
    return route(
      init.method ?? "GET",
      init.body ? JSON.parse(init.body as string) : undefined,
    );
  });
  const api = createTeamHubApi({
    baseUrl: new URL("https://teamhub.test/"),
    fetchRequest: fetchDouble(async (url, init) => {
      try {
        return Response.json(await request(new URL(url).pathname, init));
      } catch (error) {
        if (!(error instanceof TeamHubError)) throw error;
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error.status },
        );
      }
    }),
    onAuthenticationRequired: vi.fn(),
  });
  const client = {
    listTenantLocalComputers: vi.fn().mockResolvedValue({
      items: [
        {
          computer_id: "computer-mac",
          display_name: "Alice's Mac",
          status: "online",
        },
      ],
    }),
    api,
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={{ client } as never}>
        <BrowserConnectionDialog onClose={onClose} tenantId={tenantId} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { onClose, queryClient, request, route };
}

describe("BrowserConnectionDialog", () => {
  it("connects with the pasted line and keeps the token out of caches and storage", async () => {
    const { queryClient, request, route } = setup(async (method) =>
      method === "PUT" ? connected : isolated,
    );

    expect(
      await screen.findByText(
        "Not connected. Agents use a separate browser without your sign-ins.",
      ),
    ).toBeVisible();
    // The only online Computer is selected.
    expect(screen.getByRole("combobox", { name: "Computer" })).toHaveAttribute(
      "value",
      "computer-mac",
    );
    expect(
      screen.getByRole("link", { name: /Playwright Extension/ }),
    ).toHaveAttribute(
      "href",
      "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm",
    );
    const input = screen.getByLabelText("Extension token");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
    const pasted = ` PLAYWRIGHT_MCP_EXTENSION_TOKEN=${token} `;
    fireEvent.change(input, { target: { value: pasted } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(input).toHaveValue("");
    expect(
      await screen.findByText(
        "Connected. Browser tasks use your Chrome and its sign-ins.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Chrome 147 connected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reconfigure" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();
    expect(route).toHaveBeenCalledWith("PUT", { extension_token: pasted });
    expect(request).not.toHaveBeenCalledWith(
      expect.stringContaining(token),
      expect.anything(),
    );

    const cached = JSON.stringify([
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => [query.queryKey, query.state.data]),
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    ]);
    expect(cached).not.toContain(token);
    expect(JSON.stringify({ ...localStorage })).not.toContain(token);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(token);
  });

  it("disconnects a connected Chrome", async () => {
    const { route } = setup(async (method) =>
      method === "DELETE" ? isolated : connected,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));

    expect(
      await screen.findByText(
        "Not connected. Agents use a separate browser without your sign-ins.",
      ),
    ).toBeVisible();
    expect(route).toHaveBeenCalledWith("DELETE", undefined);
  });

  it("explains a rejected token and asks for a new paste", async () => {
    setup(async (method) => {
      if (method === "GET") return { ...connected, state: "token_invalid" };
      throw new TeamHubError({
        code: "INVALID_BROWSER_TOKEN",
        message: "Paste the token shown by the Playwright Extension",
        status: 400,
      });
    });

    expect(
      await screen.findByText(
        "Token expired. Copy a new token from the extension, then reconnect.",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reconfigure" }));
    const input = screen.getByLabelText("Extension token");
    fireEvent.change(input, { target: { value: "not a token" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Can't read this token",
    );
    expect(input).toHaveValue("");
  });

  it("tells a token the extension refused apart from a retryable failure", async () => {
    setup(async (method) => {
      if (method === "GET") return isolated;
      throw new TeamHubError({
        code: "BROWSER_TOKEN_REJECTED",
        message: "The Playwright Extension did not accept this token",
        status: 502,
      });
    });

    fireEvent.change(await screen.findByLabelText("Extension token"), {
      target: { value: token },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The extension didn't accept this token",
    );
  });

  it("lets a new paste replace a damaged saved connection", async () => {
    const { route } = setup(async (method) => {
      if (method === "PUT") return connected;
      throw new TeamHubError({
        code: "BROWSER_CONNECTION_INVALID",
        message:
          "The saved browser connection is invalid; connect the browser again",
        status: 502,
      });
    });

    fireEvent.change(await screen.findByLabelText("Extension token"), {
      target: { value: token },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByText(
        "Connected. Browser tasks use your Chrome and its sign-ins.",
      ),
    ).toBeVisible();
    expect(route).toHaveBeenCalledWith("PUT", { extension_token: token });
  });

  it("offers no form when the Computer cannot reuse Chrome", async () => {
    setup(async () => ({ ...isolated, state: "unsupported" }));

    expect(
      await screen.findByText(
        "This Computer can't use your browser. Agents use a separate browser without your sign-ins.",
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByLabelText("Extension token")).toBeNull(),
    );
  });
});
