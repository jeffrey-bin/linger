import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTeamHubApi } from "@/features/teamhub/teamhub-api";
import { fetchDouble } from "@/features/teamhub/teamhub-client-test-support";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { DecisionCard, type DecisionMessageCard } from "./decision-card";

type Card = DecisionMessageCard;
interface Entry {
  id: string;
  state: string;
  prompt: string;
  relaunch_required: boolean;
}
const card: Card = {
  card_type: "personal_notice",
  intent: "decision_requested",
  version: 1,
  decision_id: "permission-1",
  kind: "computer_permission",
  status: "pending",
  title: "Grant macOS permissions.",
  computer_permission: {
    computer_id: "computer-mac",
    subject: "linger",
    permissions: ["screen_recording", "accessibility"],
    reason: "Take a screenshot of the report",
  },
  decision_owner: { id: "alice", display_name: "Alice", kind: "human" },
  requester: { id: "writer", display_name: "Writer", kind: "agent" },
};
const permissionsPath =
  "/v0/tenants/tenant_one/local-computers/computer-mac/permissions";

function entry(id: string, state: string, options: Partial<Entry> = {}): Entry {
  return {
    id,
    state,
    prompt: "available",
    relaunch_required: false,
    ...options,
  };
}
function status(...permissions: Entry[]) {
  return {
    platform: "darwin",
    host: "desktop",
    subjects: [{ subject: "linger", permissions }],
  };
}

function desktopOn(computerId: string, act?: (step: unknown) => unknown) {
  (window as { lingerDesktop?: unknown }).lingerDesktop = {
    ...(act ? { permissions: { act } } : {}),
    computer: {
      enroll: vi.fn(),
      getStatus: vi.fn().mockResolvedValue({
        activeOperations: 0,
        bridge: "connected",
        computerId,
        runtime: "running",
      }),
      onStatus: vi.fn(() => () => undefined),
    },
  };
}

afterEach(() => {
  delete (window as { lingerDesktop?: unknown }).lingerDesktop;
});

function setup({
  actorId = "alice",
  live = status(
    entry("screen_recording", "not_determined"),
    entry("accessibility", "denied"),
  ),
  liveError,
  next = card,
}: {
  actorId?: string;
  live?: ReturnType<typeof status>;
  liveError?: { status: number; code: string; message: string };
  next?: Card;
} = {}) {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const api = createTeamHubApi({
    baseUrl: new URL("https://teamhub.test/"),
    fetchRequest: fetchDouble(async (url, init) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      if (path !== permissionsPath) throw new Error(path);
      requests.push({
        method,
        path,
        ...(typeof init?.body === "string"
          ? { body: JSON.parse(init.body) as unknown }
          : {}),
      });
      return liveError
        ? Response.json(
            {
              error: {
                code: liveError.code,
                message: liveError.message,
                request_id: "request-1",
              },
            },
            { status: liveError.status },
          )
        : Response.json(live);
    }),
    onAuthenticationRequired: vi.fn(),
  });
  const decision = vi.fn().mockResolvedValue(undefined);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider
        runtime={
          {
            client: {
              api,
              listTenantLocalComputers: vi.fn().mockResolvedValue({
                items: [
                  { computer_id: "computer-mac", display_name: "Alice's Mac" },
                ],
              }),
            },
          } as never
        }
      >
        <DecisionCard
          card={next}
          currentActorId={actorId}
          messageId="message-1"
          onDecision={decision}
          roomId="room-1"
          tenantId="tenant_one"
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { decision, requests };
}

describe("Computer permission card", () => {
  it("shows the owner on that Mac one step per permission", async () => {
    desktopOn("computer-mac");
    const { requests } = setup();
    // The title heads the box once.
    const box = await screen.findByRole("region", {
      name: "System permission requested",
    });
    expect(
      within(box).getByRole("heading", {
        level: 3,
        name: "Grant macOS permissions.",
      }),
    ).toBeVisible();
    expect(screen.getAllByText("Grant macOS permissions.")).toHaveLength(1);
    expect(document.querySelector(".card-prompt")).toBeNull();
    expect(screen.queryByText(/Asks you|wants to use/)).not.toBeInTheDocument();
    expect(screen.getByText("Linger · Screen Recording")).toBeVisible();
    expect(screen.getByText("Linger · Accessibility")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Request" }));
    // One step runs at a time; the next button returns once it answered.
    const settings = screen.getByRole("button", { name: "Open Settings" });
    await waitFor(() => expect(settings).toBeEnabled());
    fireEvent.click(settings);
    await waitFor(() =>
      expect(requests.filter(({ method }) => method === "POST")).toEqual([
        {
          method: "POST",
          path: permissionsPath,
          body: {
            action: "prompt",
            subject: "linger",
            permission: "screen_recording",
          },
        },
        {
          method: "POST",
          path: permissionsPath,
          body: {
            action: "open_settings",
            subject: "linger",
            permission: "accessibility",
          },
        },
      ]),
    );
    expect(screen.getByRole("button", { name: "Don't allow" })).toHaveClass(
      "bg-secondary",
    );
  });

  it("shows only the title as the heading when there is no reason", async () => {
    desktopOn("computer-mac");
    setup({
      next: {
        ...card,
        computer_permission: { ...card.computer_permission!, reason: "" },
      },
    });
    const box = await screen.findByRole("region", {
      name: "System permission requested",
    });
    expect(
      within(box).getByRole("heading", {
        level: 3,
        name: "Grant macOS permissions.",
      }),
    ).toBeVisible();
    expect(screen.getAllByText("Grant macOS permissions.")).toHaveLength(1);
    expect(document.querySelector(".card-prompt")).toBeNull();
  });

  it("offers a relaunch and marks granted permissions", async () => {
    desktopOn("computer-mac");
    const { requests } = setup({
      live: status(
        entry("screen_recording", "denied", { relaunch_required: true }),
        entry("accessibility", "granted"),
      ),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Relaunch Linger" }),
    );
    expect(screen.getByText("Relaunch Linger to apply")).toBeVisible();
    expect(screen.getByText("Granted")).toBeVisible();
    await waitFor(() =>
      expect(requests.at(-1)).toEqual({
        method: "POST",
        path: permissionsPath,
        body: { action: "relaunch", subject: "linger" },
      }),
    );
  });

  it("opens Settings when the Mac can only open the pane", async () => {
    desktopOn("computer-mac");
    setup({
      live: status(
        entry("screen_recording", "unknown", { prompt: "settings_only" }),
        entry("accessibility", "granted"),
      ),
    });
    expect(
      await screen.findByRole("button", { name: "Open Settings" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Request" }),
    ).not.toBeInTheDocument();
  });

  it("takes the desktop app's own steps over IPC", async () => {
    const act = vi.fn().mockResolvedValue(undefined);
    desktopOn("computer-mac", act);
    const { requests } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Request" }));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        action: "prompt",
        subject: "linger",
        permission: "screen_recording",
      }),
    );
    expect(requests.filter(({ method }) => method === "POST")).toEqual([]);
    expect(screen.queryByText(/^Opens on/)).not.toBeInTheDocument();
  });

  it("sends CuaDriver's prompt to the daemon even in the desktop app", async () => {
    const act = vi.fn().mockResolvedValue(undefined);
    desktopOn("computer-mac", act);
    const { requests } = setup({
      next: {
        ...card,
        computer_permission: {
          computer_id: "computer-mac",
          subject: "computer_use",
          permissions: ["accessibility"],
        },
      },
      live: {
        platform: "darwin",
        host: "desktop",
        subjects: [
          {
            subject: "computer_use",
            permissions: [entry("accessibility", "not_determined")],
          },
        ],
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Request" }));
    await waitFor(() =>
      expect(requests.filter(({ method }) => method === "POST")).toEqual([
        {
          method: "POST",
          path: permissionsPath,
          body: {
            action: "prompt",
            subject: "computer_use",
            permission: "accessibility",
          },
        },
      ]),
    );
    expect(act).not.toHaveBeenCalled();
  });

  it("lets the owner act from a browser and names the Mac", async () => {
    const { requests } = setup();
    expect(await screen.findByText("Opens on Alice's Mac")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Request" }));
    await waitFor(() =>
      expect(requests.filter(({ method }) => method === "POST")).toEqual([
        {
          method: "POST",
          path: permissionsPath,
          body: {
            action: "prompt",
            subject: "linger",
            permission: "screen_recording",
          },
        },
      ]),
    );
  });

  it("sends the owner to that Mac while it is offline", async () => {
    setup({
      liveError: {
        status: 503,
        code: "LOCAL_COMPUTER_OFFLINE",
        message: "Local Computer is offline",
      },
    });
    expect(
      await screen.findByText(
        "Open Linger on that Mac to grant these permissions.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Request" }),
    ).not.toBeInTheDocument();
  });

  it("declines with a deny decision", async () => {
    const { decision } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Don't allow" }));
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith({
        decision: "deny",
        expectedVersion: 1,
        messageId: "message-1",
        requestId: "permission-1",
      }),
    );
  });

  it("gives other members no buttons", async () => {
    desktopOn("computer-mac");
    const { requests } = setup({ actorId: "bob" });
    expect(await screen.findByText("Linger · Screen Recording")).toBeVisible();
    expect(screen.queryByText(/Waiting for Alice/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it.each([
    [
      { status: "answered", answer: { decision: "granted" } },
      "Granted",
      "text-app-success",
    ],
    [
      {
        status: "denied",
        answer: { decision: "deny" },
        decided_by: card.decision_owner,
      },
      "Declined",
      "text-app-muted",
    ],
    [{ status: "expired" }, "Expired", "text-app-muted"],
  ] as const)(
    "puts a done line in place of the actions for %j",
    async (settled, done, tone) => {
      desktopOn("computer-mac");
      const { requests } = setup({ next: { ...card, ...settled } });
      // A granted card marks each row Granted too; the done line is last.
      const line = (await screen.findAllByText(done)).at(-1)!;
      expect(line.closest("p")?.querySelector("svg")).toHaveClass(tone);
      expect(screen.getByText("Linger · Screen Recording")).toBeVisible();
      expect(
        screen.getByRole("heading", {
          level: 3,
          name: "Grant macOS permissions.",
        }),
      ).toBeVisible();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(requests).toEqual([]);
    },
  );
});
