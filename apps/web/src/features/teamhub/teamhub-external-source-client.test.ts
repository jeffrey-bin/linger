import { sentRequests } from "./teamhub-client-test-support";
import { describe, expect, it, vi } from "vitest";

import { createHttpTeamHubClient } from "./teamhub-client";
import type { TeamHubExternalConnection } from "./teamhub-types";
import { requestBodyText, requestUrlText } from "@linger/service-kit";

describe("TeamHub External Source client", () => {
  it.each(["gmail", "outlook", "notion"])(
    "sends only the app key when connecting %s",
    async (provider) => {
      const fetchRequest = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(connectionFixture(), 201));
      const client = createHttpTeamHubClient({
        baseUrl: "https://teamhub.example.test",
        fetchRequest,
      });
      await client.createExternalConnection(provider);
      expect(
        JSON.parse((await sentRequests(fetchRequest))[0]?.[1]?.body as string),
      ).toEqual({ app_key: provider });
    },
  );

  it("maps connection and selection pagination to V1 routes", async () => {
    const connection = connectionFixture();
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(connection, 201))
      .mockResolvedValueOnce(
        jsonResponse({
          conversations: [
            {
              id: "C01",
              is_private: false,
              kind: "public_channel",
              name: "general",
            },
          ],
          next_cursor: "page-2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          channels: [{ id: "D01", kind: "text", name: "general" }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          calendars: [
            {
              access_role: "owner",
              id: "primary",
              primary: true,
              selected: true,
              summary: "Primary",
            },
          ],
          next_page_token: "calendar-page-2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          next_cursor: "repo-page-2",
          repositories: [
            {
              default_branch: "main",
              description: "Workspace",
              full_name: "jenny/workspace",
              html_url: "https://github.com/jenny/workspace",
              id: "1001",
              language: "TypeScript",
              name: "workspace",
              updated_at: "2026-08-06T08:00:00.000Z",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          next_cursor: "notion-page-2",
          resources: [
            {
              id: "page-1",
              kind: "notion_page",
              title: "About me",
              url: "https://www.notion.so/about-me",
            },
          ],
        }),
      );
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      fetchRequest,
    });

    await client.createExternalConnection("slack");
    await client.listSlackConversations("connection/a", {
      cursor: "cursor/a",
      limit: 25,
    });
    await client.listDiscordChannels("connection/a");
    await client.listGoogleCalendars("connection/a", {
      limit: 100,
      pageToken: "page/a",
    });
    await client.listGitHubRepositories("connection/a", {
      cursor: "repo/a",
      limit: 50,
    });
    await client.listNotionResources("connection/a", {
      cursor: "notion/a",
      limit: 50,
    });

    expect(
      (await sentRequests(fetchRequest)).map(([url, init]) => ({
        body: init?.body ? JSON.parse(requestBodyText(init.body)) : undefined,
        idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
        method: init?.method,
        url: requestUrlText(url),
      })),
    ).toEqual([
      {
        body: { app_key: "slack" },
        idempotencyKey: null,
        method: "POST",
        url: "https://teamhub.example.test/v0/external-connections",
      },
      {
        body: undefined,
        idempotencyKey: null,
        method: "GET",
        url: "https://teamhub.example.test/v0/external-connections/connection%2Fa/slack/conversations?cursor=cursor%2Fa&limit=25",
      },
      {
        body: undefined,
        idempotencyKey: null,
        method: "GET",
        url: "https://teamhub.example.test/v0/external-connections/connection%2Fa/discord/channels",
      },
      {
        body: undefined,
        idempotencyKey: null,
        method: "GET",
        url: "https://teamhub.example.test/v0/external-connections/connection%2Fa/google-calendar/calendars?limit=100&page_token=page%2Fa",
      },
      {
        body: undefined,
        idempotencyKey: null,
        method: "GET",
        url: "https://teamhub.example.test/v0/external-connections/connection%2Fa/github/repositories?cursor=repo%2Fa&limit=50",
      },
      {
        body: undefined,
        idempotencyKey: null,
        method: "GET",
        url: "https://teamhub.example.test/v0/external-connections/connection%2Fa/notion/resources?cursor=notion%2Fa&limit=50",
      },
    ]);
  });

  it("loads the curated external application catalog", async () => {
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        apps: [
          {
            allows_multiple_connections: true,
            availability: "available",
            capabilities: ["connect", "personal_wiki_import"],
            description: "Connect email for Personal Wiki imports.",
            display_name: "Gmail",
            key: "gmail",
          },
        ],
      }),
    );
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      fetchRequest,
    });

    await expect(client.listExternalApps()).resolves.toMatchObject({
      apps: [{ key: "gmail" }],
    });
    expect(await sentRequests(fetchRequest)).toContainEqual([
      "https://teamhub.example.test/v0/external-apps",
      expect.objectContaining({ method: "GET" }),
    ]);
  });

  it("asks for status checks, reauthorizations and disconnects on the connection", async () => {
    const connection = {
      auto_reminders: true,
      created_at: "2026-08-06T08:00:00.000Z",
      id: "connection/a",
      provider: "gmail",
      revision: 3,
      status: "expired",
      updated_at: "2026-08-06T08:00:00.000Z",
    };
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { ...connection, status_check_requested_at: connection.updated_at },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ...connection,
            reauthorizing: true,
            reauthorization_connect_url: "https://connect.example.test/a",
            reauthorization_connect_expires_at: "2026-08-06T08:10:00.000Z",
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { ...connection, revision: 4, status: "disconnecting" },
          202,
        ),
      );
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      fetchRequest,
    });

    expect(
      (await client.createExternalConnectionStatusCheck("connection/a", 3))
        .status_check_requested_at,
    ).toBe(connection.updated_at);
    expect(
      (await client.createExternalConnectionReauthorization("connection/a", 3))
        .reauthorization_connect_url,
    ).toBe("https://connect.example.test/a");
    expect(
      (
        await client.disconnectExternalConnection("connection/a", {
          expected_revision: 3,
        })
      ).status,
    ).toBe("disconnecting");

    expect(
      (await sentRequests(fetchRequest)).map(([url, init]) => ({
        body: init?.body ? JSON.parse(requestBodyText(init.body)) : undefined,
        idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
        method: init?.method,
        url: requestUrlText(url),
      })),
    ).toEqual([
      {
        body: { expected_revision: 3 },
        idempotencyKey: null,
        method: "POST",
        url: "https://teamhub.example.test/v0/external-connections/connection%2Fa/status-checks",
      },
      {
        body: { expected_revision: 3 },
        idempotencyKey: null,
        method: "POST",
        url: "https://teamhub.example.test/v0/external-connections/connection%2Fa/reauthorizations",
      },
      {
        body: { expected_revision: 3 },
        idempotencyKey: null,
        method: "POST",
        url: "https://teamhub.example.test/v0/external-connections/connection%2Fa/disconnects",
      },
    ]);
  });

  it("maps connection-level AnotherMe access routes", async () => {
    const access = {
      agent_actor_id: "actor/anotherme",
      agent_management_id: "anotherme-1",
      agent_display_name: "My AnotherMe",
      tenant_id: "tenant-1",
      granted: false,
      revision: 0,
    };
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ agents: [access] }))
      .mockResolvedValueOnce(
        jsonResponse({ ...access, granted: true, revision: 1 }),
      );
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      fetchRequest,
    });

    await client.listExternalConnectionAgentAccess("connection/a");
    await client.setExternalConnectionAgentAccess(
      "connection/a",
      "actor/anotherme",
      true,
    );

    expect(
      (await sentRequests(fetchRequest)).map(([url, init]) => ({
        body: init?.body ? JSON.parse(requestBodyText(init.body)) : undefined,
        idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
        method: init?.method,
        url: requestUrlText(url),
      })),
    ).toEqual([
      {
        body: undefined,
        idempotencyKey: null,
        method: "GET",
        url: "https://teamhub.example.test/v0/external-connections/connection%2Fa/agent-grants",
      },
      {
        body: { granted: true },
        idempotencyKey: null,
        method: "PUT",
        url: "https://teamhub.example.test/v0/external-connections/connection%2Fa/agent-grants/actor%2Fanotherme",
      },
    ]);
  });

  it("reports a finished OAuth popup with or without its upstream account", async () => {
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      fetchRequest,
    });

    await client.completeExternalConnectionAuthorization("ca_123");
    await client.completeExternalConnectionAuthorization();

    expect(
      (await sentRequests(fetchRequest)).map(([url, init]) => ({
        body: JSON.parse(requestBodyText(init?.body ?? "")),
        method: init?.method,
        url: requestUrlText(url),
      })),
    ).toEqual([
      {
        body: { connected_account_id: "ca_123" },
        method: "POST",
        url: "https://teamhub.example.test/v0/external-connection-completions",
      },
      {
        body: {},
        method: "POST",
        url: "https://teamhub.example.test/v0/external-connection-completions",
      },
    ]);
  });
});

function connectionFixture(): TeamHubExternalConnection {
  return {
    auto_reminders: true,
    connect_url: "https://connect.example.test/slack",
    created_at: "2026-08-06T08:00:00.000Z",
    id: "connection/a",
    provider: "slack",
    revision: 1,
    status: "pending",
    updated_at: "2026-08-06T08:00:00.000Z",
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}
