import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";
import { requestBodyText, requestUrlText } from "./test-support/fetch-text.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// TeamHub reads the canvas header; the CLI only forwards what it was given.
async function fixture(saveDraft?: () => Promise<Response>) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "teamhub-canvas-draft-"));
  roots.push(cwd);
  const output: string[] = [],
    errors: string[] = [],
    calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const endpoint = requestUrlText(url);
    const body = init?.body ? JSON.parse(requestBodyText(init.body)) : {};
    calls.push({ url: endpoint.split("/v1/")[1]!, body });
    if (endpoint.endsWith("/apps/account"))
      return Response.json({
        status: "ready",
        account: {
          connection_id: "connection_one",
          app_key: "gmail",
          display_name: "Personal",
          identity_label: "owner@example.com",
        },
      });
    if (endpoint.endsWith("/apps/gmail/canvas-draft") && saveDraft)
      return saveDraft();
    if (endpoint.endsWith("/apps/gmail/canvas-draft"))
      return Response.json({
        draft_id: body.draft_id ?? "r-1",
        message_id: "m-1",
        inline_images: 1,
        attachments: ["plan.pdf"],
      });
    throw new Error(`Unexpected endpoint ${endpoint}`);
  });
  return {
    calls,
    output,
    errors,
    run: (args: string[]) =>
      runCli(args, {
        cwd,
        env: {
          TEAMHUB_URL: "https://teamhub.example",
          TEAMHUB_TOKEN: "th_agent_fixture",
          TEAMHUB_STATE_ROOT: cwd,
        },
        fetch: fetcher,
        stdout: (s: string) => void output.push(s),
        stderr: (s: string) => void errors.push(s),
      }),
  };
}

describe("teamhub gmail canvas-draft", () => {
  it("leaves the canvas header to TeamHub and updates the same draft", async () => {
    const f = await fixture();
    expect(
      await f.run(["gmail", "canvas-draft", "document_canvas", "--json"]),
      f.errors.join(""),
    ).toBe(0);
    expect(f.calls.map((call) => call.url)).toEqual([
      "apps/account",
      "apps/gmail/canvas-draft",
    ]);
    expect(f.calls[1]!.body).toEqual({
      connection_id: "connection_one",
      document_id: "document_canvas",
    });
    expect(JSON.parse(f.output.join(""))).toMatchObject({
      result: {
        action: "drafted",
        acknowledged: true,
        draftId: "r-1",
        inlineImages: 1,
        attachments: ["plan.pdf"],
      },
    });

    expect(
      await f.run([
        "gmail",
        "canvas-draft",
        "document_canvas",
        "--update",
        "r-1",
        "--subject",
        "Revised subject",
        "--to",
        "lisa@acme.example",
        "--cc",
        "sam@acme.example",
      ]),
    ).toBe(0);
    expect(f.calls.at(-1)).toEqual({
      url: "apps/gmail/canvas-draft",
      body: {
        connection_id: "connection_one",
        document_id: "document_canvas",
        to: ["lisa@acme.example"],
        cc: ["sam@acme.example"],
        subject: "Revised subject",
        draft_id: "r-1",
      },
    });
  });

  it.each([
    [
      "the connection drops",
      () => Promise.reject(new TypeError("fetch failed")),
    ],
    [
      "TeamHub reports an unconfirmed provider result",
      () =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: "tool_execution_failed",
                message: "The connected app did not confirm the result",
              },
            },
            { status: 502 },
          ),
        ),
    ],
  ])(
    "reports an unknown outcome when %s after dispatch",
    async (_case, saveDraft) => {
      const f = await fixture(saveDraft);
      const command = ["gmail", "canvas-draft", "document_canvas", "--json"];
      expect(await f.run(command)).not.toBe(0);
      // The CLI never saves a second draft by itself: the first may exist.
      expect(
        f.calls.filter((call) => call.url === "apps/gmail/canvas-draft"),
      ).toHaveLength(1);
      expect(f.errors.join("")).toContain("outcome_unknown");
      expect(f.errors.join("")).toContain("Check the connected application");
    },
  );

  it("lets the Agent run again after TeamHub refuses a Document that is not a Gmail canvas", async () => {
    const refusal =
      "This Document is not a Gmail canvas; pass --to, --cc and --subject";
    const f = await fixture(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              code: "invalid_input",
              message: refusal,
              request_id: "request_one",
              issues: [
                {
                  path: "document_id",
                  code: "not_gmail_canvas",
                  message: refusal,
                },
              ],
            },
          },
          { status: 400 },
        ),
      ),
    );
    const command = ["gmail", "canvas-draft", "document_plain", "--json"];
    expect(await f.run(command)).not.toBe(0);
    expect(f.errors.join("")).toContain("not a Gmail canvas");
    // A refusal is definite, so a corrected run reaches TeamHub again.
    expect(await f.run(command)).not.toBe(0);
    expect(
      f.calls.filter((call) => call.url === "apps/gmail/canvas-draft"),
    ).toHaveLength(2);
  });
});
