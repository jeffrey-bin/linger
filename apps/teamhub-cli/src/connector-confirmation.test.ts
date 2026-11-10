import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestBodyText, requestUrlText } from "./test-support/fetch-text.js";
import schemas from "./test-support/connector-tool-inputs.json" with { type: "json" };
import { runCli } from "./cli.js";
import { appKeys, connectorVersions, type Json } from "./connector-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// The writes TeamHub holds for confirmation in these scenarios; TeamHub, not
// the CLI, classifies each call.
const held = new Set([
  "GMAIL_SEND_EMAIL",
  "OUTLOOK_SEND_DRAFT",
  "GITHUB_CREATE_AN_ISSUE",
]);

async function fixture(
  app: string,
  handle: (slug: string, args: Json) => unknown,
  confirmation: () => Response = () =>
    Response.json({
      status: "confirmation_pending",
      room_id: "room_fixture",
      message_id: "message_card",
      interaction_id: "interaction_card",
    }),
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "connector-confirmation-"));
  roots.push(cwd);
  let output = "",
    errors = "";
  const executed: string[] = [],
    submitted: Json[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(
      init?.body == null ? "{}" : requestBodyText(init.body),
    ) as Json;
    const endpoint = requestUrlText(url);
    if (endpoint.endsWith("/apps/account"))
      return Response.json({
        status: "ready",
        account: {
          connection_id: "connection_" + app,
          app_key: appKeys[app],
          display_name: app,
          identity_label: "owner@example.com",
        },
      });
    if (endpoint.endsWith("/apps/tools/bind"))
      return Response.json({
        tools: (body.tool_slugs as string[]).map((slug) => ({
          tool_slug: slug,
          tool_version: connectorVersions[app],
          app_key: appKeys[app],
          input_schema: (schemas as Record<string, unknown>)[slug] ?? {
            type: "object",
          },
        })),
      });
    const slug = String(body.tool_slug);
    if (held.has(slug)) {
      submitted.push(body);
      return confirmation();
    }
    executed.push(slug);
    return Response.json({ data: handle(slug, body.arguments as Json) });
  });
  const deps = {
    cwd,
    env: {
      TEAMHUB_URL: "https://teamhub.invalid",
      TEAMHUB_TOKEN: "th_agent_fixture",
    },
    fetch: fetcher,
    stdout: (s: string) => {
      output += s;
    },
    stderr: (s: string) => {
      errors += s;
    },
  };
  async function run(args: string[]) {
    output = "";
    errors = "";
    const code = await runCli(args, deps);
    return { code, output, errors };
  }
  return { run, executed, submitted };
}

describe("connector confirmation", () => {
  it("ends a Gmail send that TeamHub holds for confirmation", async () => {
    const f = await fixture("gmail", () => {
      throw new Error("nothing may run");
    });
    const result = await f.run([
      "gmail",
      "send",
      "--to",
      "bob@example.com",
      "--subject",
      "Plan",
      "--content",
      "Hello",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(f.executed).toEqual([]);
    expect(f.submitted).toEqual([
      {
        connection_id: "connection_gmail",
        tool_slug: "GMAIL_SEND_EMAIL",
        tool_version: connectorVersions.gmail,
        arguments: expect.objectContaining({
          recipient_email: "bob@example.com",
          subject: "Plan",
          body: "Hello",
        }),
      },
    ]);
    expect(JSON.parse(result.output).result).toEqual({
      action: "confirmation_requested",
      confirmation: {
        status: "pending",
        interactionId: "interaction_card",
        messageId: "message_card",
        roomId: "room_fixture",
      },
    });
    const text = await f.run([
      "gmail",
      "send",
      "--to",
      "bob@example.com",
      "--subject",
      "Plan",
      "--content",
      "Hello",
    ]);
    expect(text.output).toContain("Confirmation requested");
    expect(text.output).toContain("Do not run this command again");
  });

  it("prepares an Outlook reply draft and only its send is held", async () => {
    const f = await fixture("outlook", (slug) => {
      if (slug === "OUTLOOK_GET_MESSAGE")
        return { id: "message_one", parentFolderId: "inbox" };
      return { id: "draft_reply" };
    });
    const result = await f.run([
      "outlook",
      "reply",
      "message_one",
      "--content",
      "Thanks",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(f.executed).toEqual([
      "OUTLOOK_GET_MESSAGE",
      "OUTLOOK_CREATE_DRAFT_REPLY",
      "OUTLOOK_UPDATE_EMAIL",
    ]);
    expect(f.submitted).toMatchObject([
      {
        tool_slug: "OUTLOOK_SEND_DRAFT",
        arguments: { message_id: "draft_reply" },
      },
    ]);
  });

  it("still runs an allowed write directly", async () => {
    const f = await fixture("gmail", () => ({
      id: "draft_one",
      message: { id: "message_one", threadId: "thread_one" },
    }));
    const result = await f.run([
      "gmail",
      "draft",
      "--to",
      "bob@example.com",
      "--subject",
      "Plan",
      "--content",
      "Hello",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(f.executed).toEqual(["GMAIL_CREATE_EMAIL_DRAFT"]);
    expect(f.submitted).toEqual([]);
  });

  it("ends a GitHub issue that TeamHub holds after checking the repository", async () => {
    const f = await fixture("github", (slug) => {
      expect(slug).toBe("GITHUB_GET_A_REPOSITORY");
      return { full_name: "octo/api", has_issues: true };
    });
    const result = await f.run([
      "github",
      "create-issue",
      "--repo",
      "https://github.com/octo/api",
      "--title",
      "Login fails",
      "--content",
      "Steps",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(f.executed).toEqual(["GITHUB_GET_A_REPOSITORY"]);
    expect(f.submitted.map((call) => call.arguments)).toEqual([
      { owner: "octo", repo: "api", title: "Login fails", body: "Steps" },
    ]);
    expect(JSON.parse(result.output).result).toMatchObject({
      action: "confirmation_requested",
      confirmation: { status: "pending", messageId: "message_card" },
    });
  });

  it("reports a refused confirmation as a rejected operation", async () => {
    const f = await fixture(
      "gmail",
      () => {
        throw new Error("nothing may run");
      },
      () =>
        Response.json(
          {
            error: {
              code: "forbidden",
              message: "Confirmation is unavailable in this chat",
            },
          },
          { status: 403 },
        ),
    );
    const result = await f.run([
      "gmail",
      "send",
      "--to",
      "bob@example.com",
      "--subject",
      "Plan",
      "--content",
      "Hello",
      "--json",
    ]);
    expect(result.code).not.toBe(0);
    expect(f.executed).toEqual([]);
    expect(JSON.parse(result.errors).error.code).toBe("forbidden");
  });
});
