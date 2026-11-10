import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { MessageCard } from "./message-card";
import { anotherMeQueryKey } from "@/features/rooms/room-queries";
import type { TeamHubApi } from "@/features/teamhub/teamhub-api";
import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import { TeamHubTestServer } from "@/test/teamhub-test-server";

import { profilePreview, useProfileCardContent } from "./profile-card-content";

const emptyModule = { overview: "", points: [] };
function profileDocument(backgroundOverview: string) {
  return {
    name: "Jenny",
    background: { overview: backgroundOverview, points: [], timeline: [] },
    communication_style: emptyModule,
    working_style: emptyModule,
    preferences: emptyModule,
    writing_style: emptyModule,
  };
}

const runtime = vi.hoisted(() => ({
  client: {
    api: undefined as TeamHubApi | undefined,
    getPersonalProfile: vi.fn(),
    listExternalApps: vi.fn(),
  },
}));
vi.mock("@/features/teamhub/teamhub-runtime", () => ({
  useOptionalTeamHubRuntime: () => runtime,
}));

beforeEach(() => {
  const server = new TeamHubTestServer().on(
    "GET",
    "/v0/tenants/{tenantId}/another-me",
    () => ({ room_id: "room-1", agent_actor_id: "agent-1" }),
  );
  runtime.client.api = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  }).api;
});

function CardDetails({ roomId = "room-1" }: { roomId?: string }) {
  const content = useProfileCardContent({
    children: "Original summary",
    tenantId: "tenant-1",
    roomId,
    authorId: "agent-1",
  });
  return (
    <div>
      {content.body}
      {content.sources}
    </div>
  );
}

function renderDetails() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CardDetails />
    </QueryClientProvider>,
  );
}

describe("Profile card content", () => {
  it.each([
    ["room-1", "agent-1", true],
    ["shared-room", "agent-1", false],
    ["room-1", "other-agent", false],
  ])(
    "only enhances the owner's delivery in room %s by %s",
    async (roomId, authorId, enhanced) => {
      runtime.client.getPersonalProfile
        .mockClear()
        .mockResolvedValue({ current: null });
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <MessageCard
              title="Jenny"
              files={[]}
              profile={{
                actorId: "human-1",
                wikiPath: "/wiki",
                tenantId: "tenant-1",
                roomId,
                authorId,
                subtitle: "Role",
              }}
              profileChildren={<p>Enhanced summary</p>}
            >
              <p>Role — Original summary</p>
            </MessageCard>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      if (enhanced) {
        expect(
          await screen.findByRole("link", { name: "Open" }),
        ).toHaveAttribute("href", "/wiki");
        expect(screen.getByText("Role")).toBeVisible();
        expect(screen.getByText("Enhanced summary")).toBeVisible();
      } else {
        await vi.waitFor(() =>
          expect(
            client.getQueryState(anotherMeQueryKey("tenant-1"))?.status,
          ).toBe("success"),
        );
        expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
        expect(screen.queryByRole("img", { name: "Jenny avatar" })).toBeNull();
        expect(runtime.client.getPersonalProfile).not.toHaveBeenCalled();
        expect(screen.getByText("Role — Original summary")).toBeVisible();
        expect(screen.queryByText("Enhanced summary")).toBeNull();
      }
    },
  );

  it("takes the first long enough overview, then point text, from the fields", () => {
    const detailed =
      "This is a sufficiently detailed profile paragraph about a person's work.";
    expect(
      profilePreview({
        ...profileDocument(detailed),
        preferences: {
          overview: "Other long enough details that come later.",
          points: [],
        },
      }),
    ).toBe(detailed);
    expect(
      profilePreview({
        ...profileDocument("Short note"),
        writing_style: {
          overview: "Writes in a deliberately compact, plain style.",
          points: [],
        },
      }),
    ).toBe("Writes in a deliberately compact, plain style.");
    const nonAscii = "\u9879\u76ee".repeat(25);
    expect(
      profilePreview({
        ...profileDocument(""),
        working_style: {
          overview: "",
          points: [{ title: "Focus", text: nonAscii, items: [] }],
        },
      }),
    ).toBe(nonAscii);
    expect(profilePreview(profileDocument("x".repeat(300)))).toBe(
      `${"x".repeat(280)}…`,
    );
    expect(profilePreview(profileDocument("Short note"))).toBeUndefined();
  });

  it("shows the published excerpt", async () => {
    runtime.client.getPersonalProfile.mockResolvedValue({
      current: {
        profile: profileDocument(
          "A sufficiently detailed paragraph drawn directly from the published profile.",
        ),
      },
    });
    renderDetails();
    expect(
      await screen.findByText(/drawn directly from the published profile/),
    ).toBeVisible();
  });

  it("shows all recorded apps and excludes other available apps without reading the summary", async () => {
    runtime.client.getPersonalProfile.mockResolvedValue({
      current: {
        profile: profileDocument(
          "A sufficiently detailed description of the subject's work.",
        ),
        source_apps: ["gmail", "github"],
      },
    });
    runtime.client.listExternalApps.mockResolvedValue({
      apps: [
        { key: "gmail", display_name: "Gmail" },
        { key: "github", display_name: "GitHub" },
        { key: "outlook", display_name: "Outlook" },
      ],
    });
    renderDetails();
    expect(
      await screen.findByRole("img", { name: "Gmail icon" }),
    ).toBeVisible();
    expect(screen.getByRole("img", { name: "GitHub icon" })).toBeVisible();
    expect(screen.queryByRole("img", { name: "Outlook icon" })).toBeNull();
  });

  it("keeps the original summary if the Profile is unavailable", async () => {
    runtime.client.getPersonalProfile.mockRejectedValue(
      new Error("unavailable"),
    );
    renderDetails();
    expect(await screen.findByText("Original summary")).toBeVisible();
    expect(screen.queryByRole("list", { name: /Profile sources/ })).toBeNull();
  });

  it("does not infer sources for a Profile whose source record is unknown", async () => {
    runtime.client.listExternalApps.mockClear();
    runtime.client.getPersonalProfile.mockResolvedValue({
      current: {
        profile: profileDocument(
          "A long enough description mentioning Gmail but with no source record.",
        ),
      },
    });
    renderDetails();
    expect(await screen.findByText(/mentioning Gmail/)).toBeVisible();
    expect(screen.queryByRole("list", { name: "Profile sources" })).toBeNull();
    expect(runtime.client.listExternalApps).not.toHaveBeenCalled();
  });

  it("does not show cached personal Profile data in a different room", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["teamhub", "personal-profile", "tenant-1"], {
      current: {
        profile: profileDocument(
          "Private profile content that must not appear in another room.",
        ),
      },
    });
    render(
      <QueryClientProvider client={client}>
        <CardDetails roomId="shared-room" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Original summary")).toBeVisible();
    expect(screen.queryByText(/Private profile content/)).toBeNull();
  });
});
