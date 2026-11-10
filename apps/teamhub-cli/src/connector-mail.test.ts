import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { displayText } from "./display-text.js";
import { requestUrlText } from "./test-support/fetch-text.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "teamhub-connectors-"));
  roots.push(cwd);
  const output: string[] = [],
    errors: string[] = [],
    calls: { url: string; body: Record<string, unknown> }[] = [];
  let authorization = false,
    ambiguous = false,
    unknown = false,
    fullPages = false;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(displayText(init?.body ?? "{}"));
    const endpoint = requestUrlText(url);
    calls.push({ url: endpoint, body });
    if (endpoint.endsWith("/apps/account"))
      return Response.json(
        authorization
          ? {
              status: "authorization_required",
              room_id: "room_one",
              message_id: "message_card",
              interaction_id: "interaction_one",
            }
          : ambiguous
            ? {
                status: "account_ambiguous",
                candidates: [
                  {
                    connection_id: "connection_two",
                    identity_label: "work@example.com",
                  },
                ],
              }
            : {
                status: "ready",
                account: {
                  connection_id: "connection_one",
                  app_key: "gmail",
                  display_name: "Personal",
                  identity_label: "owner@example.com",
                },
              },
      );
    if (endpoint.endsWith("/apps/tools/bind"))
      return Response.json({
        tools: (body.tool_slugs as string[]).map((tool_slug) => ({
          tool_slug,
          tool_version: "20261015_00",
          app_key: "gmail",
          input_schema: { type: "object", additionalProperties: true },
        })),
      });
    if (endpoint.endsWith("/apps/mail-body"))
      return Response.json({ html: "<h1>Weekly</h1>\n" });
    if (endpoint.endsWith("/apps/tools/execute")) {
      if (unknown) throw new Error("transport lost");
      if (body.tool_slug === "GMAIL_CREATE_EMAIL_DRAFT")
        return Response.json({
          data: {
            id: "draft_one",
            message: { id: "message_one", threadId: "thread_one" },
          },
        });
      if (fullPages) {
        const args = body.arguments as {
          max_results: number;
          page_token?: string;
        };
        const size = args.max_results;
        const page = Number((args.page_token ?? "page_0").slice(5));
        return Response.json({
          data: {
            messages: Array.from({ length: size }, (_, i) => ({
              messageId: `message_${page}_${i}`,
            })),
            nextPageToken: `page_${page + 1}`,
          },
        });
      }
      return Response.json({
        data: {
          messages: [
            {
              messageId: "message_one",
              subject: "Weekly",
              sender: "Alice <alice@example.com>",
              labelIds: ["UNREAD"],
            },
          ],
          nextPageToken: "page_two",
        },
      });
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  });
  const dependencies = {
    cwd,
    env: {
      TEAMHUB_URL: "https://teamhub.example",
      TEAMHUB_TOKEN: "th_agent_fixture",
    },
    fetch: fetcher,
    stdout: (s: string) => {
      output.push(s);
    },
    stderr: (s: string) => {
      errors.push(s);
    },
  };
  return {
    dependencies,
    calls,
    output,
    errors,
    fetcher,
    authorization: () => {
      authorization = true;
    },
    ambiguous: () => {
      ambiguous = true;
    },
    unknown: () => {
      unknown = true;
    },
    fullPages: () => {
      fullPages = true;
    },
  };
}
describe("Connector mail business commands", () => {
  it("shows offline help/schema without reading configuration or contacting TeamHub", async () => {
    const f = await fixture();
    expect(
      await runCli(["gmail", "draft", "--help"], {
        ...f.dependencies,
        env: {},
      }),
    ).toBe(0);
    expect(f.output.join("")).toContain("--markdown");
    expect(
      await runCli(["gmail", "draft", "--schema", "--json"], {
        ...f.dependencies,
        env: {},
      }),
    ).toBe(0);
    expect(f.calls).toEqual([]);
  });
  it("requests a card before discovering or executing any external action", async () => {
    const f = await fixture();
    f.authorization();
    expect(
      await runCli(
        ["gmail", "list", "--account", "work@example.com", "--json"],
        f.dependencies,
      ),
    ).toBe(4);
    expect(f.calls.map((x) => x.url.split("/v1/")[1])).toEqual([
      "apps/account",
    ]);
    expect(f.calls[0]!.body).toEqual({
      app_key: "gmail",
      account: "work@example.com",
    });
    expect(JSON.parse(f.errors.join("")).error).toMatchObject({
      code: "authorization_required",
      details: { message_id: "message_card" },
    });
  });
  it("passes an explicit selector and preserves the list page and account", async () => {
    const f = await fixture();
    expect(
      await runCli(
        [
          "gmail",
          "list",
          "--unread",
          "--query",
          "from:alice@example.com",
          "--account",
          "connection_one",
          "--json",
        ],
        f.dependencies,
      ),
    ).toBe(0);
    const result = JSON.parse(f.output.join(""));
    expect(result).toMatchObject({
      account: { connectionId: "connection_one" },
      messages: [{ messageId: "message_one", unread: true }],
      hasMore: true,
    });
    expect(f.calls.at(-1)!.body).toMatchObject({
      connection_id: "connection_one",
      tool_slug: "GMAIL_FETCH_EMAILS",
      tool_version: "20261015_00",
      arguments: {
        query: "(from:alice@example.com) in:inbox is:unread",
        max_results: 20,
        include_payload: false,
      },
    });
  });
  it("fetches a large Gmail list page in bounded provider pages", async () => {
    const f = await fixture();
    f.fullPages();
    expect(
      await runCli(
        ["gmail", "list", "--limit", "45", "--json"],
        f.dependencies,
      ),
    ).toBe(0);
    const executions = f.calls.filter((x) =>
      x.url.endsWith("/apps/tools/execute"),
    );
    expect(
      executions.map((x) => x.body.arguments as Record<string, unknown>),
    ).toMatchObject([
      { max_results: 20 },
      { max_results: 20, page_token: "page_1" },
      { max_results: 5, page_token: "page_2" },
    ]);
    const result = JSON.parse(f.output.join(""));
    expect(result.messages).toHaveLength(45);
    expect(result.hasMore).toBe(true);
  });
  it("renders Markdown on the backend before creating a draft", async () => {
    const f = await fixture();
    expect(
      await runCli(
        [
          "gmail",
          "draft",
          "--to",
          "alice@example.com",
          "--subject",
          "Weekly",
          "--markdown",
          "--content",
          "# Weekly",
          "--json",
        ],
        f.dependencies,
      ),
    ).toBe(0);
    expect(
      f.calls.find((x) => x.url.endsWith("/apps/mail-body"))?.body,
    ).toEqual({ content: "# Weekly" });
    expect(f.calls.at(-1)!.body).toMatchObject({
      arguments: { body: "<h1>Weekly</h1>\n", is_html: true },
    });
    expect(JSON.parse(f.output.join(""))).toMatchObject({
      result: { action: "drafted", draftId: "draft_one", acknowledged: true },
    });
  });
  it("validates conflicting formats before posting a card", async () => {
    const f = await fixture();
    expect(
      await runCli(
        [
          "gmail",
          "draft",
          "--to",
          "alice@example.com",
          "--subject",
          "Weekly",
          "--markdown",
          "--html",
          "--content",
          "# Weekly",
        ],
        f.dependencies,
      ),
    ).toBe(2);
    expect(f.calls).toEqual([]);
  });
  it("reports an uncertain external write as unknown without resending it", async () => {
    const f = await fixture();
    f.unknown();
    const command = [
      "gmail",
      "draft",
      "--to",
      "alice@example.com",
      "--subject",
      "Weekly",
      "--content",
      "Ready",
      "--json",
    ];
    expect(await runCli(command, f.dependencies)).toBe(1);
    expect(
      f.calls.filter((call) => call.url.endsWith("/apps/tools/execute")),
    ).toHaveLength(1);
    expect(JSON.parse(f.errors.at(-1)!).error.code).toBe("outcome_unknown");
  });
});
