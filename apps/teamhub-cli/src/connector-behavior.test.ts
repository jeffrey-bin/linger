import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import inputs from "./test-support/connector-tool-inputs.json" with { type: "json" };
import { runCli } from "./cli.js";
import { commandDefinitions } from "./domain-commands.js";
import { appKeys, connectorVersions, type Json } from "./connector-runtime.js";
import { displayText } from "./display-text.js";
import { requestBodyText, requestUrlText } from "./test-support/fetch-text.js";

// These cases cover each write's direct execution path (arguments, provider
// response wrappers, read-back checks), so every write is classified allow
// here. The confirmation path is covered in connector-confirmation.test.ts.
vi.mock("./connector-approval.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./connector-approval.js")>();
  return {
    ...actual,
    connectorWriteApproval: Object.fromEntries(
      Object.keys(actual.connectorWriteApproval).map((command) => [
        command,
        "allow",
      ]),
    ),
  };
});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(
  app: string,
  handler: (slug: string, args: Json, body: Json) => unknown,
  downloads: Record<string, Uint8Array> = {},
  // Answers an endpoint before the defaults below when it returns a body.
  routes: (endpoint: string, body: Json) => unknown = () => undefined,
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "connector-behavior-"));
  roots.push(cwd);
  const output: string[] = [],
    errors: string[] = [],
    calls: { url: string; body: Json }[] = [],
    uploads: Uint8Array[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const endpoint = requestUrlText(url);
    if (downloads[endpoint])
      return new Response(new Uint8Array(downloads[endpoint]));
    if (init?.method === "PUT") {
      uploads.push(new Uint8Array(init.body as Uint8Array));
      return new Response(null, { status: 200 });
    }
    let body: Json = {};
    if (init?.body) body = JSON.parse(requestBodyText(init.body));
    calls.push({ url: endpoint, body });
    const routed = routes(endpoint, body);
    if (routed !== undefined) return Response.json(routed);
    if (endpoint.endsWith("/apps/account"))
      return Response.json({
        status: "ready",
        account: {
          connection_id: `connection_${app}`,
          app_key: appKeys[app],
          display_name: app,
          identity_label: "owner@example.test",
        },
      });
    if (endpoint.endsWith("/apps/tools/bind")) {
      expect(body.tool_version).toBe(connectorVersions[app]);
      return Response.json({
        tools: (body.tool_slugs as string[]).map((slug) => {
          const schema = (inputs as Record<string, unknown>)[slug];
          if (!schema) throw new Error(`Missing captured schema for ${slug}`);
          return {
            tool_slug: slug,
            tool_version: body.tool_version,
            app_key: appKeys[app],
            input_schema: schema,
          };
        }),
      });
    }
    if (endpoint.endsWith("/apps/files/upload-request"))
      return Response.json({
        key: `files/${displayText(body.md5)}`,
        new_presigned_url: "https://fixture.s3.amazonaws.com/file",
      });
    if (endpoint.endsWith("/apps/mail-body"))
      return Response.json({ html: "<h1>Converted</h1>\n" });
    if (endpoint.endsWith("/apps/tools/execute"))
      return Response.json({
        data: await handler(
          String(body.tool_slug),
          body.arguments as Json,
          body,
        ),
      });
    throw new Error(`Unexpected endpoint ${endpoint}`);
  });
  const deps = {
    cwd,
    env: {
      TEAMHUB_URL: "https://teamhub.example",
      TEAMHUB_TOKEN: "th_agent_fixture",
      TEAMHUB_STATE_ROOT: cwd,
    },
    fetch: fetcher,
    stdout: (s: string) => {
      output.push(s);
    },
    stderr: (s: string) => {
      errors.push(s);
    },
  };
  const run = async (args: string[]) => {
    output.length = 0;
    errors.length = 0;
    const code = await runCli(
      args.includes("--json") ? args : [...args, "--json"],
      deps,
    );
    return {
      code,
      result: output.length ? JSON.parse(output.join("")) : undefined,
      error: errors.length ? JSON.parse(errors.join("")) : undefined,
    };
  };
  return { cwd, run, deps, calls, uploads, fetcher, output, errors };
}
const mail = {
  messageId: "message_one",
  threadId: "thread_one",
  subject: "Mail",
  payload: {
    mimeType: "text/plain",
    headers: [{ name: "From", value: "alice@example.test" }],
    body: { data: Buffer.from("Body").toString("base64url") },
  },
};
describe("reviewed Connector command boundaries", () => {
  it("provides all 52 reviewed leaves as offline help and schemas, excluding removed apps", async () => {
    const f = await fixture("gmail", () => {
      throw new Error("offline must not call provider");
    });
    const commands = commandDefinitions.filter((x) =>
      x.toolName.startsWith("connector_"),
    );
    // Includes the two provider-independent generation commands.
    expect(commands.length).toBe(52);
    for (const command of commands) {
      expect(
        await runCli([...command.command, "--help"], { ...f.deps, env: {} }),
        command.command.join(" "),
      ).toBe(0);
      expect(
        await runCli([...command.command, "--schema", "--json"], {
          ...f.deps,
          env: {},
        }),
        command.command.join(" "),
      ).toBe(0);
    }
    for (const app of ["canva"])
      expect(commandDefinitions.some((x) => x.command[0] === app)).toBe(false);
    expect(f.calls).toEqual([]);
  }, 15000);
  it.each(["fal", "higgsfield"])(
    "removes %s help and commands without contacting TeamHub",
    async (app) => {
      const f = await fixture("gmail", () => {
        throw new Error("Removed commands must not execute");
      });
      expect(
        commandDefinitions.some((command) => command.command[0] === app),
      ).toBe(false);
      const removed = await f.run([app, "--help"]);
      expect(removed.code).toBe(2);
      expect(removed.error.error.code).toBe("usage");
      expect(f.calls).toEqual([]);
    },
  );
  it.each([
    [
      "slack",
      "send",
      "--channel-id",
      "C123",
      "--user",
      "a@example.test",
      "--content",
      "hi",
    ],
    [
      "gcal",
      "create",
      "Meeting",
      "--start",
      "2026-10-19T10:00:00+08:00",
      "--end",
      "2026-10-19T09:00:00+08:00",
    ],
    ["notion", "read", "https://evil.example/0123456789abcdef0123456789abcdef"],
    [
      "figma",
      "export",
      "https://www.figma.com/board/abc/Board",
      "--format",
      "png",
      "--output",
      "x.png",
    ],
  ])("rejects invalid %s targets before authorization", async (...args) => {
    const f = await fixture(String(args[0]), () => ({}));
    expect((await f.run(args)).code).toBe(2);
    expect(f.calls).toEqual([]);
  });
  it("stages exact Gmail attachment bytes and keeps no local copy", async () => {
    const f = await fixture("gmail", (slug, args) => {
      expect(slug).toBe("GMAIL_CREATE_EMAIL_DRAFT");
      expect(args.attachment).toMatchObject([
        { name: "sample.txt", s3key: expect.stringMatching(/^files\//) },
      ]);
      return { id: "draft_one", message: { id: "message_one" } };
    });
    await writeFile(path.join(f.cwd, "sample.txt"), "exact UTF-8 bytes €✓");
    const command = [
      "gmail",
      "draft",
      "--to",
      "a@example.test",
      "--subject",
      "Draft",
      "--content",
      "Text",
      "--attach",
      "sample.txt",
      "--operation-id",
      "draft-with-file",
      "--json",
    ];
    expect((await f.run(command)).code).toBe(0);
    expect(Buffer.from(f.uploads[0]!).toString()).toBe("exact UTF-8 bytes €✓");
    expect(f.calls.filter((x) => x.url.endsWith("/execute"))).toHaveLength(1);
    expect(await readdir(f.cwd)).toEqual(["sample.txt"]);
  });
  it.each([undefined, "outlook-partial-draft"])(
    "reports a completed Outlook draft after attachment rejection with operation ID %s",
    async (operationId) => {
      const f = await fixture("outlook", (slug) => {
        expect(slug).toBe("OUTLOOK_CREATE_DRAFT");
        return { id: "draft_one" };
      });
      const originalFetch = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementation((url, init) =>
        init?.method === "PUT"
          ? Promise.resolve(new Response(null, { status: 503 }))
          : originalFetch(url, init),
      );
      await writeFile(path.join(f.cwd, "sample.txt"), "exact UTF-8 bytes €✓");
      const command = [
        "outlook",
        "draft",
        "--to",
        "a@example.test",
        "--subject",
        "Draft",
        "--content",
        "Text",
        "--attach",
        "sample.txt",
        ...(operationId ? ["--operation-id", operationId] : []),
      ];
      const first = await f.run(command);
      const writes = f.fetcher.mock.calls.filter(([url]) =>
        requestUrlText(url).endsWith("/apps/tools/execute"),
      );
      expect(writes).toHaveLength(1);
      const originalOperationId = new Headers(writes[0]![1]?.headers).get(
        "x-teamhub-operation-id",
      );
      expect(originalOperationId).toBeTruthy();
      const partialReceipts = [
        { tool: "OUTLOOK_CREATE_DRAFT", id: "draft_one" },
      ];
      expect(first).toMatchObject({
        code: 1,
        error: {
          error: {
            code: "outcome_unknown",
            details: {
              operation_id: originalOperationId,
              retryable: false,
              partial_receipts: partialReceipts,
            },
          },
        },
      });
      expect(await readdir(f.cwd)).toEqual(["sample.txt"]);
    },
  );
  it("allows corrected attachment staging before any Gmail write", async () => {
    const f = await fixture("gmail", (slug) => {
      expect(slug).toBe("GMAIL_CREATE_EMAIL_DRAFT");
      return { id: "draft_one", message: { id: "message_one" } };
    });
    const originalFetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation((url, init) =>
      init?.method === "PUT"
        ? Promise.resolve(new Response(null, { status: 503 }))
        : originalFetch(url, init),
    );
    await writeFile(path.join(f.cwd, "sample.txt"), "exact UTF-8 bytes €✓");
    const command = [
      "gmail",
      "draft",
      "--to",
      "a@example.test",
      "--subject",
      "Draft",
      "--content",
      "Text",
      "--attach",
      "sample.txt",
    ];
    expect((await f.run(command)).error.error.code).toBe(
      "file_transfer_failed",
    );
    expect(f.calls.filter((x) => x.url.endsWith("/execute"))).toHaveLength(0);
    f.fetcher.mockImplementation(originalFetch);
    expect((await f.run(command)).code).toBe(0);
    expect(f.calls.filter((x) => x.url.endsWith("/execute"))).toHaveLength(1);
  });
  it("retains unconsumed Gmail thread messages and binds the next page to its account", async () => {
    const f = await fixture("gmail", (slug) =>
      slug === "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"
        ? mail
        : {
            messages: [
              mail,
              { ...mail, messageId: "message_two" },
              { ...mail, messageId: "message_three" },
            ],
          },
    );
    const first = await f.run([
      "gmail",
      "read",
      "message_one",
      "--thread",
      "--limit",
      "2",
      "--json",
    ]);
    expect(first).toMatchObject({
      code: 0,
      result: {
        thread: {
          messages: [
            { messageId: "message_one" },
            { messageId: "message_two" },
          ],
          hasMore: true,
        },
      },
    });
    const second = await f.run([
      "gmail",
      "read",
      "message_one",
      "--thread",
      "--limit",
      "2",
      "--cursor",
      first.result.thread.nextCursor,
      "--json",
    ]);
    expect(second).toMatchObject({
      code: 0,
      result: {
        thread: { messages: [{ messageId: "message_three" }], hasMore: false },
      },
    });
    expect(
      f.calls.filter(
        (x) => x.body.tool_slug === "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      ),
    ).toHaveLength(1);
    expect(
      f.calls.filter((x) => x.url.endsWith("/account")).at(-1)!.body.account,
    ).toBe("connection_gmail");
  });
  it("sends Slack Markdown with a channel ID without discovery", async () => {
    const f = await fixture("slack", (slug, args) => {
      expect(slug).toBe("SLACK_SEND_MESSAGE");
      expect(args).toEqual({
        channel: "C123",
        markdown_text: "**bold** [link](https://example.com)",
        reply_broadcast: false,
      });
      return { ok: true, channel: "C123", ts: "1792039200.000100" };
    });
    expect(
      (
        await f.run([
          "slack",
          "send",
          "--channel-id",
          "C123",
          "--content",
          "**bold** [link](https://example.com)",
          "--json",
        ])
      ).code,
    ).toBe(0);
  });
  it("preserves existing attendee state with one Google Calendar PATCH batch", async () => {
    const existing = {
      id: "event_one",
      organizer: { self: true, email: "owner@example.test" },
      attendees: [
        {
          email: "alice@example.test",
          responseStatus: "accepted",
          optional: true,
        },
        { email: "bob@example.test", responseStatus: "tentative" },
      ],
    };
    const f = await fixture("gcal", (slug, args) => {
      if (slug === "GOOGLECALENDAR_EVENTS_GET") return existing;
      expect(slug).toBe("GOOGLECALENDAR_BATCH_EVENTS");
      expect(args.operations).toMatchObject([
        {
          method: "PATCH",
          query_params: { sendUpdates: "all" },
          body: {
            attendees: [
              existing.attendees[0],
              { email: "charlie@example.test" },
            ],
          },
        },
      ]);
      return {
        results: [
          { op_id: "update", http_status: 200, event: { id: "event_one" } },
        ],
        succeeded: 1,
        failed: 0,
      };
    });
    expect(
      (
        await f.run([
          "gcal",
          "update",
          "event_one",
          "--add-attendee",
          "charlie@example.test",
          "--remove-attendee",
          "bob@example.test",
          "--json",
        ])
      ).code,
    ).toBe(0);
  });
  it("finds common free time only from complete busy data of every calendar", async () => {
    const busy = (a: string, b: string) => ({
      start: `2026-10-19T${a}:00Z`,
      end: `2026-10-19T${b}:00Z`,
    });
    let response: Json = {
      calendars: {
        primary: {
          busy: [
            busy("08:00", "10:00"),
            busy("12:00", "13:00"),
            busy("16:30", "18:00"),
          ],
        },
        "alice@example.test": {
          busy: [
            busy("09:30", "11:00"),
            busy("13:00", "14:00"),
            busy("15:00", "15:20"),
          ],
        },
      },
    };
    const f = await fixture("gcal", (slug, args) => {
      expect(slug).toBe("GOOGLECALENDAR_FREE_BUSY_QUERY");
      expect(args).toEqual({
        timeMin: "2026-10-19T09:00:00Z",
        timeMax: "2026-10-19T17:00:00Z",
        items: [{ id: "primary" }, { id: "alice@example.test" }],
        calendarExpansionMax: 2,
      });
      return { successful: true, data: response };
    });
    const command = [
      "gcal",
      "free",
      "--from",
      "2026-10-19T09:00:00Z",
      "--to",
      "2026-10-19T17:00:00Z",
      "--with",
      "alice@example.test",
      "--duration",
      "40",
    ];
    const free = await f.run(command);
    expect(free.code).toBe(0);
    expect(free.result.slots).toEqual([
      {
        start: "2026-10-19T11:00:00Z",
        end: "2026-10-19T12:00:00Z",
        durationMinutes: 60,
      },
      {
        start: "2026-10-19T14:00:00Z",
        end: "2026-10-19T15:00:00Z",
        durationMinutes: 60,
      },
      {
        start: "2026-10-19T15:20:00Z",
        end: "2026-10-19T16:30:00Z",
        durationMinutes: 70,
      },
    ]);
    // A missing, failed, or malformed calendar is unknown, never free.
    for (const alice of [
      undefined,
      {},
      { errors: [{ reason: "notFound" }], busy: [] },
      { busy: [{ start: "invalid", end: "invalid" }] },
    ]) {
      response = {
        calendars: {
          primary: { busy: [] },
          ...(alice ? { "alice@example.test": alice } : {}),
        },
      };
      expect((await f.run(command)).error.error.code).toBe(
        "incomplete_response",
      );
    }
    expect(f.calls.some((call) => call.url.includes("/calendar/"))).toBe(false);
  });
  it("escapes Drive name searches and never substitutes a missing parent", async () => {
    const f = await fixture("gdrive", (slug, args) => {
      if (slug === "GOOGLEDRIVE_GET_FILE_METADATA")
        return {
          id: "folder_one",
          name: "Folder",
          mimeType: "application/vnd.google-apps.folder",
          trashed: false,
        };
      expect(slug).toBe("GOOGLEDRIVE_FIND_FILE");
      expect(args).toMatchObject({
        folder_id: "folder_one",
        q: "trashed = false",
      });
      return {
        files: [
          {
            id: "file_one",
            name: "Name",
            mimeType: "text/plain",
            parents: ["wrong_parent"],
          },
        ],
      };
    });
    expect(
      (await f.run(["gdrive", "list", "--folder", "folder_one", "--json"]))
        .error.error.code,
    ).toBe("incomplete_response");
  });
});

describe("mail attachment downloads", () => {
  const part = (id: string, name: string, inline = false) => ({
    mimeType: "application/pdf",
    filename: name,
    headers: inline ? [{ name: "Content-ID", value: "<image>" }] : [],
    body: { attachmentId: id, size: 3 },
  });
  const message = (parts: Json[]) => ({
    ...mail,
    payload: { ...mail.payload, parts },
  });
  it("downloads every ordinary Gmail attachment, preserves bytes, and reports inline skips", async () => {
    const f = await fixture(
      "gmail",
      (slug, args) => {
        if (slug === "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID")
          return message([
            part("a", "Propuesta ñ.pdf"),
            part("b", "Budget é.pdf"),
            part("image", "inline.png", true),
          ]);
        if (slug === "GMAIL_GET_ATTACHMENT")
          return {
            file: {
              s3url: `https://fixture.s3.amazonaws.com/${displayText(args.attachment_id)}`,
            },
          };
        throw new Error(slug);
      },
      {
        "https://fixture.s3.amazonaws.com/a": Buffer.from("one"),
        "https://fixture.s3.amazonaws.com/b": Buffer.from("two"),
      },
    );
    await mkdir(path.join(f.cwd, "attachments"));
    const result = await f.run([
      "gmail",
      "download",
      "message_one",
      "--all",
      "--output",
      "attachments",
    ]);
    expect(result.code, JSON.stringify(result.error)).toBe(0);
    expect(result.result.files).toHaveLength(2);
    expect(result.result.skipped).toEqual([
      { attachmentId: "image", name: "inline.png", reason: "inline" },
    ]);
    expect(
      await readFile(
        path.join(f.cwd, "attachments", "Propuesta ñ.pdf"),
        "utf8",
      ),
    ).toBe("one");
    expect(result.result.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects unsafe batch filenames before downloading any attachment", async () => {
    const f = await fixture("gmail", (slug) => {
      if (slug === "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID")
        return message([part("a", "safe.pdf"), part("b", "../escape.pdf")]);
      throw new Error(`Must not download: ${slug}`);
    });
    const result = await f.run([
      "gmail",
      "download",
      "message_one",
      "--all",
      "--output",
      ".",
    ]);
    expect(result.error.error.code).toBe("invalid_path");
    expect(
      f.calls.filter((x) => x.body.tool_slug === "GMAIL_GET_ATTACHMENT"),
    ).toHaveLength(0);
  });
  it("requires an attachment ID for duplicate Outlook names", async () => {
    const f = await fixture("outlook", (slug) => {
      if (slug === "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS")
        return {
          value: ["a", "b"].map((id) => ({
            id,
            name: "Propuesta ñ.pdf",
            "@odata.type": "#microsoft.graph.fileAttachment",
            isInline: false,
            size: 3,
          })),
        };
      throw new Error(`Must not download: ${slug}`);
    });
    const result = await f.run([
      "outlook",
      "download",
      "message_one",
      "--attachment",
      "Propuesta ñ.pdf",
      "--output",
      "file.pdf",
    ]);
    expect(result.error.error.code).toBe("target_ambiguous");
    expect(result.error.error.details.issues).toHaveLength(2);
  });
  it("reports saved paths on a partial batch failure without publishing corrupt bytes", async () => {
    const f = await fixture(
      "outlook",
      (slug, args) => {
        if (slug === "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS")
          return {
            value: ["a", "b"].map((id) => ({
              id,
              name: `${id}.pdf`,
              "@odata.type": "#microsoft.graph.fileAttachment",
              isInline: false,
              size: 3,
            })),
          };
        if (slug === "OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT")
          return {
            file: {
              s3url: `https://fixture.s3.amazonaws.com/${displayText(args.attachment_id)}`,
            },
          };
        throw new Error(slug);
      },
      {
        "https://fixture.s3.amazonaws.com/a": Buffer.from("one"),
        "https://fixture.s3.amazonaws.com/b": Buffer.from("corrupt"),
      },
    );
    const result = await f.run([
      "outlook",
      "download",
      "message_one",
      "--all",
      "--output",
      ".",
    ]);
    expect(result.error.error.code).toBe("file_transfer_failed");
    expect(result.error.error.details.partial_receipts[0].path).toBe(
      path.join(f.cwd, "a.pdf"),
    );
    expect(await readFile(path.join(f.cwd, "a.pdf"), "utf8")).toBe("one");
    await expect(readFile(path.join(f.cwd, "b.pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("generative media connectors", () => {
  const png = (width: number, height: number) => {
    const bytes = Buffer.alloc(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
  };
  const openapi = {
    paths: {
      "/fal-ai/flux/dev": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Input" },
              },
            },
          },
        },
      },
      "/fal-ai/flux/dev/requests/{request_id}": {
        get: {
          responses: {
            200: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Output" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Input: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string", description: "What to draw." },
            num_images: { type: "integer", default: 1, maximum: 4 },
            image_url: { type: "string" },
            image_size: {
              anyOf: [
                { $ref: "#/components/schemas/ImageSize" },
                { type: "string", enum: ["square", "landscape_16_9"] },
              ],
              description: "\n  Output size.\n  ",
            },
          },
        },
        ImageSize: {
          type: "object",
          properties: {
            width: { type: "integer" },
            height: { type: "integer" },
          },
        },
        Output: {
          type: "object",
          properties: { images: { type: "array", items: { type: "object" } } },
        },
      },
    },
  };
  const falModel = {
    endpoint_id: "fal-ai/flux/dev",
    metadata: { display_name: "FLUX.1 [dev]", category: "text-to-image" },
    openapi,
  };
  const jobId = "3f0c6d0e-1111-4222-8333-444455556666";
  // fal's public model catalog, which the CLI reads without Composio.
  const falCatalog =
    (...models: Json[]) =>
    (endpoint: string): unknown =>
      endpoint.startsWith("https://api.fal.ai/v1/models?")
        ? { models }
        : undefined;

  it("checks a fal input against the model schema before uploading or billing", async () => {
    const f = await fixture(
      "fal",
      (slug) => {
        throw new Error(`Must not call ${slug}`);
      },
      {},
      falCatalog(falModel),
    );
    await writeFile(path.join(f.cwd, "still.png"), png(4, 4));
    const unknown = await f.run([
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/dev",
      "--prompt",
      "fox",
      "--set",
      "seed_value=3",
      "--file",
      "image_url=still.png",
    ]);
    expect(unknown.error.error.code).toBe("invalid_input");
    const invalid = await f.run([
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/dev",
      "--prompt",
      "fox",
      "--set",
      "num_images=9",
    ]);
    expect(invalid.error.error).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("num_images does not accept"),
    });
    const missing = await f.run([
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/dev",
    ]);
    expect(missing.error.error.message).toContain("--prompt requires");
    expect(f.uploads).toEqual([]);
  });

  it("uploads fal inputs, submits without waiting, and saves the output when the job is checked", async () => {
    const f = await fixture(
      "fal",
      (slug, args) => {
        if (slug === "FAL_AI_UPLOAD_FILE")
          return { access_url: "https://v3.fal.media/files/still.png" };
        if (slug === "FAL_AI_SUBMIT_ASYNC_JOB") {
          expect(args).toEqual({
            model_id: "fal-ai/flux/dev",
            input: {
              prompt: "fox",
              num_images: 1,
              image_url: "https://v3.fal.media/files/still.png",
            },
          });
          return { request_id: "req_1" };
        }
        // The queue knows the request by its app ID only.
        if (slug.startsWith("FAL_AI_QUEUE") || slug.includes("QUEUE_REQUEST"))
          expect(args).toEqual({
            model_id: "fal-ai/flux",
            request_id: "req_1",
          });
        if (slug === "FAL_AI_QUEUE_GET_STATUS") return { status: "COMPLETED" };
        if (slug === "FAL_AI_GET_QUEUE_REQUEST_RESULT")
          return {
            images: [
              {
                url: "https://v3.fal.media/files/out.png",
                content_type: "image/png",
                width: 4,
              },
            ],
            seed: 7,
          };
        throw new Error(slug);
      },
      { "https://v3.fal.media/files/out.png": png(4, 4) },
      falCatalog(falModel),
    );
    await writeFile(path.join(f.cwd, "still.png"), png(4, 4));
    const result = await f.run([
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/dev",
      "--prompt",
      "fox",
      "--set",
      "num_images=1",
      "--file",
      "image_url=still.png",
      "--output",
      "fox.png",
    ]);
    expect(result.code, JSON.stringify(result.error)).toBe(0);
    expect(result.result).toMatchObject({
      requestId: "req_1",
      model: "fal-ai/flux/dev",
      status: "queued",
      nextCommand: `teamhub image-gen --provider fal --model fal-ai/flux/dev --job 'req_1' --output '${path.join(f.cwd, "fox.png")}' --account 'connection_fal'`,
    });
    expect(f.uploads).toHaveLength(1);
    expect(f.calls.map((call) => call.body.tool_slug)).not.toContain(
      "FAL_AI_QUEUE_GET_STATUS",
    );
    await expect(readFile(path.join(f.cwd, "fox.png"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const checked = await f.run([
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/dev",
      "--job",
      "req_1",
      "--output",
      "fox.png",
    ]);
    expect(checked.code, JSON.stringify(checked.error)).toBe(0);
    expect(checked.result).toMatchObject({
      requestId: "req_1",
      status: "completed",
      outputs: [{ url: "https://v3.fal.media/files/out.png" }],
      files: [{ path: path.join(f.cwd, "fox.png") }],
    });
    expect(checked.result.files[0]).not.toHaveProperty("warning");
    expect(await readFile(path.join(f.cwd, "fox.png"))).toEqual(png(4, 4));
  });

  it("keeps the files already downloaded when a later download of a checked job fails", async () => {
    const urls = [
      "https://v3.fal.media/files/one.png",
      "https://v3.fal.media/files/two.png",
    ];
    const f = await fixture(
      "fal",
      (slug) => {
        if (slug === "FAL_AI_QUEUE_GET_STATUS") return { status: "COMPLETED" };
        if (slug === "FAL_AI_GET_QUEUE_REQUEST_RESULT")
          return {
            images: urls.map((url) => ({ url, content_type: "image/png" })),
          };
        throw new Error(slug);
      },
      { [urls[0]!]: png(4, 4) },
      falCatalog(falModel),
    );
    const fetcher = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation((url, init) => {
      if (requestUrlText(url) === urls[1])
        throw new Error("Download interrupted");
      return fetcher(url, init);
    });
    const result = await f.run([
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/dev",
      "--job",
      "req_1",
      "--output",
      "outputs",
    ]);
    const savedPath = path.join(f.cwd, "outputs", "output-1.png");
    expect(result.error.error).toMatchObject({
      code: "file_transfer_failed",
      details: {
        partial_receipts: [
          {
            url: urls[0],
            path: savedPath,
            sizeBytes: 24,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
          { url: urls[1], status: "failed" },
        ],
      },
    });
    expect(await readFile(savedPath)).toEqual(png(4, 4));
    await expect(
      readFile(path.join(f.cwd, "outputs", "output-2.png")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      f.calls.filter(
        (call) => call.body.tool_slug === "FAL_AI_SUBMIT_ASYNC_JOB",
      ),
    ).toHaveLength(0);
  });

  it("stops before any upload or payment when fal's model catalog is unreadable", async () => {
    const f = await fixture(
      "fal",
      (slug) => {
        throw new Error(`Must not call ${slug}`);
      },
      {},
      (endpoint) =>
        endpoint.startsWith("https://api.fal.ai/")
          ? "not a catalog"
          : undefined,
    );
    const result = await f.run([
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/dev",
      "--prompt",
      "fox",
    ]);
    expect(result.error.error).toMatchObject({
      code: "provider_unavailable",
      details: { retryable: true },
    });
    expect(f.uploads).toEqual([]);
  });

  it("runs a model Composio pins to its free profile with any input and no schema", async () => {
    const f = await fixture(
      "fal",
      (slug, args) => {
        if (slug === "FAL_AI_SUBMIT_ASYNC_JOB") {
          expect(args.input).toEqual({
            prompt: "fox",
            image_size: "landscape_16_9",
          });
          return { request_id: "req_3" };
        }
        throw new Error(slug);
      },
      {},
      // A catalog entry without a schema: fal checks the input itself.
      falCatalog({
        endpoint_id: "fal-ai/flux/schnell",
        metadata: { category: "text-to-image" },
      }),
    );
    const result = await f.run([
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/schnell",
      "--prompt",
      "fox",
      "--set",
      "image_size=landscape_16_9",
    ]);
    expect(result.code, JSON.stringify(result.error)).toBe(0);
    expect(result.result).toMatchObject({
      requestId: "req_3",
      status: "queued",
    });
    expect(result.result.warning).toContain("no schema");
  });

  it("returns a fal request at once and checks it once with the command to continue", async () => {
    const f = await fixture(
      "fal",
      (slug) => {
        if (slug === "FAL_AI_SUBMIT_ASYNC_JOB") return { request_id: "req_2" };
        if (slug === "FAL_AI_QUEUE_GET_STATUS")
          return { status: "IN_QUEUE", queue_position: 3 };
        throw new Error(slug);
      },
      {},
      falCatalog(falModel),
    );
    const result = await f.run([
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/dev",
      "--prompt",
      "fox",
    ]);
    const nextCommand =
      "teamhub image-gen --provider fal --model fal-ai/flux/dev --job 'req_2' --account 'connection_fal'";
    expect(result.code, JSON.stringify(result.error)).toBe(0);
    expect(result.result).toMatchObject({
      requestId: "req_2",
      model: "fal-ai/flux/dev",
      status: "queued",
      nextCommand,
    });
    const checked = await f.run([
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/dev",
      "--job",
      "req_2",
    ]);
    expect(checked.result).toMatchObject({
      requestId: "req_2",
      model: "fal-ai/flux/dev",
      status: "queued",
      queuePosition: 3,
      nextCommand,
    });
    expect(
      f.calls.filter(
        (call) => call.body.tool_slug === "FAL_AI_QUEUE_GET_STATUS",
      ),
    ).toHaveLength(1);
  });

  it("reads a fal model's price and parameter schema without generation", async () => {
    const f = await fixture(
      "fal",
      (slug) => {
        if (slug === "FAL_AI_GET_PRICING")
          return {
            prices: [
              {
                endpoint_id: "fal-ai/flux/dev",
                unit_price: 0.003,
                unit: "megapixels",
                currency: "USD",
              },
            ],
          };
        if (slug === "FAL_AI_QUEUE_GET_STATUS") return { status: "COMPLETED" };
        throw new Error(`Must not call ${slug}`);
      },
      {},
      falCatalog(falModel),
    );
    const described = await f.run([
      "image-gen",
      "--provider",
      "fal",
      "--price",
      "--model",
      "fal-ai/flux/dev",
    ]);
    expect(described.code, JSON.stringify(described.error)).toBe(0);
    expect(described.result.models[0].inputs).toContainEqual({
      name: "prompt",
      type: "string",
      required: true,
      description: "What to draw.",
    });
    expect(described.result.models[0].inputs).toContainEqual({
      name: "image_size",
      type: "object (width, height) | string",
      required: false,
      enum: ["square", "landscape_16_9"],
      description: "Output size.",
    });
    expect(described.result.models[0].outputs[0]).toMatchObject({
      name: "images",
      type: "array<object>",
    });
    expect(described.result.models[0].price).toEqual({
      unitPrice: 0.003,
      unit: "megapixels",
      currency: "USD",
    });
    expect(
      f.calls.filter(
        (call) => call.body.tool_slug === "FAL_AI_SUBMIT_ASYNC_JOB",
      ),
    ).toEqual([]);
  });

  it("uploads a Higgsfield reference image, starts the job, and saves the result when the job is checked", async () => {
    const f = await fixture(
      "higgsfield",
      (slug, args) => {
        if (slug === "HIGGSFIELD_MCP_MODELS_EXPLORE")
          return { id: "gpt_image_2_6", output_type: "image" };
        if (slug === "HIGGSFIELD_MCP_MEDIA_UPLOAD")
          return {
            uploads: [
              {
                media_id: "5a1e0c2b-1111-4aaa-8bbb-000000000001",
                method: "PUT",
                upload_url:
                  "https://upload.higgsfield.ai/user_1/5a1e0c2b-1111-4aaa-8bbb-000000000001",
                content_type: "image/png",
                instructions: "PUT the bytes",
                expires_in_seconds: 600,
              },
            ],
          };
        if (slug === "HIGGSFIELD_MCP_MEDIA_CONFIRM") {
          expect(args).toEqual({
            type: "image",
            media_ids: ["5a1e0c2b-1111-4aaa-8bbb-000000000001"],
          });
          return {
            results: [
              {
                media_id: "5a1e0c2b-1111-4aaa-8bbb-000000000001",
                status: "ready",
              },
            ],
          };
        }
        if (slug === "HIGGSFIELD_MCP_GENERATE_IMAGE") {
          expect(args).toEqual({
            params: {
              model: "gpt_image_2_6",
              prompt: "same outfit",
              aspect_ratio: "1:1",
              medias: [
                {
                  role: "image",
                  value: "5a1e0c2b-1111-4aaa-8bbb-000000000001",
                },
              ],
            },
          });
          return {
            results: [
              { id: jobId, type: "image", model: "soul", status: "queued" },
            ],
          };
        }
        if (slug === "HIGGSFIELD_MCP_JOB_STATUS")
          return {
            generation: {
              id: jobId,
              type: "image",
              model: "soul",
              status: "completed",
              results: { rawUrl: "https://d1.cloudfront.net/out.jpg" },
            },
          };
        throw new Error(slug);
      },
      { "https://d1.cloudfront.net/out.jpg": png(8, 8) },
    );
    const fetcher = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation((url, init) =>
      requestUrlText(url) === "https://d1.cloudfront.net/out.jpg"
        ? Promise.resolve(
            new Response(new Uint8Array(png(8, 8)), {
              headers: { "content-type": "image/png" },
            }),
          )
        : fetcher(url, init),
    );
    await writeFile(path.join(f.cwd, "model.png"), png(4, 4));
    const result = await f.run([
      "image-gen",
      "--provider",
      "higgsfield",
      "--model",
      "gpt_image_2_6",
      "--prompt",
      "same outfit",
      "--file",
      "image=model.png",
      "--set",
      "aspect_ratio=1:1",
      "--output",
      "look.jpg",
    ]);
    expect(result.code, JSON.stringify(result.error)).toBe(0);
    expect(result.result).toMatchObject({
      jobs: [{ jobId, status: "queued" }],
      inputs: [
        {
          source: await realpath(path.join(f.cwd, "model.png")),
          mediaId: "5a1e0c2b-1111-4aaa-8bbb-000000000001",
        },
      ],
      nextCommand: `teamhub image-gen --provider higgsfield --model gpt_image_2_6 --job '${jobId}' --output '${path.join(f.cwd, "look.jpg")}' --account 'connection_higgsfield'`,
    });
    expect(result.result).not.toHaveProperty("files");
    expect(f.calls.map((call) => call.body.tool_slug)).not.toContain(
      "HIGGSFIELD_MCP_JOB_STATUS",
    );
    const checked = await f.run([
      "image-gen",
      "--provider",
      "higgsfield",
      "--model",
      "gpt_image_2_6",
      "--job",
      jobId,
      "--output",
      "look.jpg",
    ]);
    expect(checked.code, JSON.stringify(checked.error)).toBe(0);
    expect(checked.result).toMatchObject({
      jobs: [{ jobId, status: "completed" }],
      files: [
        {
          path: path.join(f.cwd, "look.jpg"),
          warning:
            "The file holds png data but is named .jpg; rename it to end in .png before opening or sharing it.",
        },
      ],
    });
    expect(f.uploads).toEqual([new Uint8Array(png(4, 4))]);
    expect(await readFile(path.join(f.cwd, "look.jpg"))).toEqual(png(8, 8));
  });

  it("reports a Higgsfield refusal without waiting for a job", async () => {
    let answer: Json = {
      error: "Not enough credits",
      recovery_tool: "show_plans_and_credits",
    };
    const f = await fixture("higgsfield", (slug) => {
      if (slug === "HIGGSFIELD_MCP_MODELS_EXPLORE")
        return { id: "kling3_0", output_type: "video" };
      if (slug === "HIGGSFIELD_MCP_GENERATE_VIDEO") return answer;
      throw new Error(`Must not call ${slug}`);
    });
    const video = [
      "video-gen",
      "--provider",
      "higgsfield",
      "--prompt",
      "orbit",
    ];
    // Video models differ too much for a default.
    expect((await f.run(video)).error.error.code).toBe("usage");
    const result = await f.run([...video, "--model", "kling3_0"]);
    expect(result.code, JSON.stringify(result.error)).toBe(0);
    expect(result.result).toMatchObject({
      jobs: [],
      rejected: {
        error: "Not enough credits",
        recoveryTool: "show_plans_and_credits",
      },
    });
    answer = { unlim_choice: { question: "Use a free generation?" } };
    const choice = await f.run([...video, "--model", "kling3_0"]);
    expect(choice.result).toMatchObject({
      jobs: [],
      unlimitedChoice: { question: "Use a free generation?" },
      warning: expect.stringContaining("--set use_unlim=false"),
    });
  });

  it("reports a malformed Higgsfield submission as unknown instead of claiming no job started", async () => {
    const f = await fixture("higgsfield", (slug) => {
      if (slug === "HIGGSFIELD_MCP_MODELS_EXPLORE")
        return { id: "gpt_image_2_6", output_type: "image" };
      if (slug === "HIGGSFIELD_MCP_GENERATE_IMAGE") return {};
      throw new Error(slug);
    });
    const result = await f.run([
      "image-gen",
      "--provider",
      "higgsfield",
      "--model",
      "gpt_image_2_6",
      "--prompt",
      "poster",
    ]);
    expect(result.error.error).toMatchObject({
      code: "outcome_unknown",
      details: {
        partial_receipts: [{ tool: "HIGGSFIELD_MCP_GENERATE_IMAGE" }],
      },
    });
    expect(
      f.calls.filter(
        (call) => call.body.tool_slug === "HIGGSFIELD_MCP_GENERATE_IMAGE",
      ),
    ).toHaveLength(1);
  });

  it.each([
    { rows: [{ id: jobId }] },
    { rows: [{ status: "queued" }, { id: jobId, status: "queued" }] },
  ])(
    "preserves Higgsfield job IDs before validating incomplete rows: %j",
    async ({ rows }) => {
      const f = await fixture("higgsfield", (slug) => {
        if (slug === "HIGGSFIELD_MCP_MODELS_EXPLORE")
          return { id: "gpt_image_2_6", output_type: "image" };
        if (slug === "HIGGSFIELD_MCP_GENERATE_IMAGE") return { results: rows };
        throw new Error(slug);
      });
      const result = await f.run([
        "image-gen",
        "--provider",
        "higgsfield",
        "--model",
        "gpt_image_2_6",
        "--prompt",
        "poster",
      ]);
      expect(result.error.error).toMatchObject({
        code: "outcome_unknown",
        details: {
          partial_receipts: [
            {
              tool: "HIGGSFIELD_MCP_GENERATE_IMAGE",
              jobIds: [jobId],
              nextCommand: expect.stringContaining(`--job '${jobId}'`),
            },
          ],
        },
      });
      expect(
        f.calls.filter(
          (call) => call.body.tool_slug === "HIGGSFIELD_MCP_GENERATE_IMAGE",
        ),
      ).toHaveLength(1);
    },
  );

  it("returns Higgsfield jobs without checking them and reports a job the check cannot find", async () => {
    const f = await fixture("higgsfield", (slug) => {
      if (slug === "HIGGSFIELD_MCP_MODELS_EXPLORE")
        return { id: "gpt_image_2_6", output_type: "image" };
      if (slug === "HIGGSFIELD_MCP_GENERATE_IMAGE")
        return {
          results: [
            { id: jobId, type: "image", model: "soul", status: "queued" },
          ],
        };
      if (slug === "HIGGSFIELD_MCP_JOB_STATUS")
        return { error: "Job not found" };
      throw new Error(slug);
    });
    const pending = await f.run([
      "image-gen",
      "--provider",
      "higgsfield",
      "--model",
      "gpt_image_2_6",
      "--prompt",
      "poster",
    ]);
    expect(pending.code, JSON.stringify(pending.error)).toBe(0);
    expect(pending.result.nextCommand).toBe(
      `teamhub image-gen --provider higgsfield --model gpt_image_2_6 --job '${jobId}' --account 'connection_higgsfield'`,
    );
    expect(
      f.calls.filter(
        (call) => call.body.tool_slug === "HIGGSFIELD_MCP_JOB_STATUS",
      ),
    ).toEqual([]);
    const checked = await f.run([
      "image-gen",
      "--provider",
      "higgsfield",
      "--model",
      "gpt_image_2_6",
      "--job",
      jobId,
    ]);
    expect(checked.error.error.code).toBe("not_found");
  });

  it("saves Higgsfield results only once every checked job has ended", async () => {
    const otherJob = "7c3d1e4f-2222-4bbb-8ccc-000000000002";
    let done = false;
    const f = await fixture(
      "higgsfield",
      (slug, args) => {
        if (slug !== "HIGGSFIELD_MCP_JOB_STATUS") throw new Error(slug);
        const finished = done || args.jobId === jobId;
        return {
          generation: {
            id: args.jobId,
            type: "image",
            status: finished ? "completed" : "in_progress",
            ...(finished
              ? {
                  results: {
                    rawUrl: `https://d1.cloudfront.net/${String(args.jobId)}.png`,
                  },
                }
              : {}),
          },
        };
      },
      {
        [`https://d1.cloudfront.net/${jobId}.png`]: png(4, 4),
        [`https://d1.cloudfront.net/${otherJob}.png`]: png(4, 4),
      },
    );
    const flags = [
      "image-gen",
      "--provider",
      "higgsfield",
      "--model",
      "gpt_image_2_6",
      "--job",
      jobId,
      "--job",
      otherJob,
      "--output",
      "posters",
    ];
    const partial = await f.run(flags);
    expect(partial.code, JSON.stringify(partial.error)).toBe(0);
    expect(partial.result).not.toHaveProperty("files");
    expect(partial.result.nextCommand).toBe(
      `teamhub image-gen --provider higgsfield --model gpt_image_2_6 --job '${otherJob}' --output '${path.join(f.cwd, "posters")}' --account 'connection_higgsfield'`,
    );
    await expect(
      readFile(path.join(f.cwd, "posters", `${jobId}.png`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    done = true;
    const finished = await f.run(flags);
    expect(finished.code, JSON.stringify(finished.error)).toBe(0);
    expect(finished.result.files).toHaveLength(2);
    expect(finished.result).not.toHaveProperty("nextCommand");
  });

  it.each([
    ["image-gen", "--prompt", "fox"],
    ["image-gen", "--provider", "fal", "--prompt", "fox"],
    ["image-gen", "--provider", "fal", "--price", "--prompt", "fox"],
    ["image-gen", "--provider", "fal", "--price", "--job", "req_1"],
    ["image-gen", "--provider", "fal", "--price", "--output", "fox.png"],
    [
      "video-gen",
      "--provider",
      "higgsfield",
      "--model",
      "kling3_0",
      "--prompt",
      "orbit",
      "--set",
      "get_cost=true",
    ],
    [
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/dev",
      "--prompt",
      "fox",
      "--set",
      "prompt=other",
    ],
    [
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/dev",
      "--prompt",
      "fox",
      "--set",
      "__proto__={}",
    ],
    [
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/dev",
      "--job",
      "req_1",
      "--job",
      "req_2",
    ],
    [
      "image-gen",
      "--provider",
      "fal",
      "--model",
      "fal-ai/flux/dev",
      "--prompt",
      "fox",
      "--wait",
      "300",
    ],
  ])(
    "rejects conflicting generation modes before account resolution: %j",
    async (...args) => {
      const f = await fixture("fal", () => {
        throw new Error("Must not execute");
      });
      const result = await f.run(args);
      expect(result.error.error.code).toBe("usage");
      expect(f.calls).toEqual([]);
    },
  );

  it("lists fal prices by output type and resumes the catalog without dropping other pages", async () => {
    const f = await fixture("fal", (slug, args) => {
      if (slug === "FAL_AI_GET_MODELS") {
        expect(args).toMatchObject({ limit: 2, status: "active" });
        if (args.category === "image-to-image")
          return {
            models: [
              {
                endpoint_id: "fal-ai/image/edit",
                metadata: { category: "image-to-image" },
              },
            ],
            has_more: false,
          };
        return args.cursor
          ? {
              models: [
                {
                  endpoint_id: "fal-ai/image/edit",
                  metadata: { category: "image-to-image" },
                },
              ],
              has_more: false,
            }
          : {
              models: [
                falModel,
                {
                  endpoint_id: "fal-ai/music",
                  metadata: { category: "text-to-audio" },
                },
              ],
              has_more: true,
              next_cursor: "page_2",
            };
      }
      if (slug === "FAL_AI_GET_PRICING") {
        return {
          prices: (args.endpoint_id as string[]).map((endpoint_id) => ({
            endpoint_id,
            unit_price: 0.003,
            currency: "USD",
            unit: "megapixels",
          })),
        };
      }
      throw new Error(`Must not call ${slug}`);
    });
    const flags = ["image-gen", "--provider", "fal", "--price", "--limit", "2"];
    const first = await f.run(flags);
    expect(first.code, JSON.stringify(first.error)).toBe(0);
    expect(first.result.models).toEqual([
      expect.objectContaining({
        modelId: "fal-ai/flux/dev",
        outputType: "image",
        price: { unitPrice: 0.003, currency: "USD", unit: "megapixels" },
      }),
    ]);
    expect(first.result.hasMore).toBe(true);
    const cursor = first.result.nextCursor;
    const next = await f.run([...flags, "--cursor", cursor]);
    expect(next.result).toMatchObject({
      models: [{ modelId: "fal-ai/image/edit" }],
      hasMore: true,
    });
    const final = await f.run([...flags, "--cursor", next.result.nextCursor]);
    expect(final.result.hasMore).toBe(false);
    expect(
      f.calls.find(
        (call) =>
          call.body.tool_slug === "FAL_AI_GET_MODELS" &&
          (call.body.arguments as Json).cursor === "page_2",
      ),
    ).toBeDefined();
    const otherType = await f.run([
      "video-gen",
      "--provider",
      "fal",
      "--price",
      "--limit",
      "2",
      "--cursor",
      cursor,
    ]);
    expect(otherType.error.error.code).toBe("cursor_mismatch");
    expect(f.uploads).toEqual([]);
  });

  it("keeps a fal continuation when a catalog page contains no matching models", async () => {
    const f = await fixture("fal", (slug) => {
      if (slug === "FAL_AI_GET_MODELS")
        return {
          models: [
            {
              endpoint_id: "fal-ai/music",
              metadata: { category: "text-to-audio" },
            },
          ],
          has_more: true,
          next_cursor: "page_2",
        };
      throw new Error(`Must not call ${slug}`);
    });
    const result = await f.run(["video-gen", "--provider", "fal", "--price"]);
    expect(result.result).toMatchObject({
      models: [],
      hasMore: true,
      nextCursor: expect.any(String),
    });
  });

  it("reports unavailable Higgsfield prices while exposing model parameters without estimates", async () => {
    const model = {
      id: "kling3_0",
      name: "Kling",
      output_type: "video",
      parameters: [{ name: "duration", type: "integer" }],
      medias: [{ role: "start_image" }],
      supports_unlim: true,
    };
    const f = await fixture("higgsfield", (slug, args) => {
      expect(slug).toBe("HIGGSFIELD_MCP_MODELS_EXPLORE");
      if (args.action === "get") {
        expect(args.model_id).toBe("kling3_0");
        return model;
      }
      expect(args).toMatchObject({ action: "list", type: "video", limit: 20 });
      return { items: [model], next_page_token: args.after ? null : "page_2" };
    });
    const flags = ["video-gen", "--provider", "higgsfield", "--price"];
    const first = await f.run(flags);
    expect(first.code, JSON.stringify(first.error)).toBe(0);
    expect(first.result).toMatchObject({
      models: [{ modelId: "kling3_0" }],
      hasMore: true,
      pricingStatus: "unavailable",
    });
    expect(first.result.models[0]).not.toHaveProperty("price");
    expect(first.result.warning).toContain("does not expose a price table");
    const next = await f.run([...flags, "--cursor", first.result.nextCursor]);
    expect(next.result.hasMore).toBe(false);
    const one = await f.run([...flags, "--model", "kling3_0"]);
    expect(one.result).toMatchObject({
      models: [
        {
          modelId: "kling3_0",
          parameters: model.parameters,
          medias: model.medias,
          supportsUnlimited: true,
        },
      ],
      hasMore: false,
    });
    expect(f.uploads).toEqual([]);
  });

  it.each(["fal", "higgsfield"])(
    "reports unpublished %s prices without inventing a zero",
    async (provider) => {
      const f = await fixture(provider, (slug) => {
        if (slug === "FAL_AI_GET_MODELS")
          return { models: [falModel], has_more: false };
        if (slug === "FAL_AI_GET_PRICING") return { prices: [] };
        if (slug === "HIGGSFIELD_MCP_MODELS_EXPLORE")
          return { items: [{ id: "gpt_image_2_6", output_type: "image" }] };
        throw new Error(slug);
      });
      const result = await f.run([
        "image-gen",
        "--provider",
        provider,
        "--price",
      ]);
      expect(result.code, JSON.stringify(result.error)).toBe(0);
      expect(result.result.models[0]).not.toHaveProperty("price");
      expect(result.result.warning).toBeDefined();
      expect(result.result.pricingStatus).toBe(
        provider === "higgsfield" ? "unavailable" : "partial",
      );
    },
  );

  it.each(["fal", "higgsfield"])(
    "rejects a non-image %s model before upload or billing",
    async (provider) => {
      const f = await fixture(
        provider,
        (slug) => {
          if (slug === "HIGGSFIELD_MCP_MODELS_EXPLORE")
            return { id: "audio_model", output_type: "audio" };
          throw new Error(`Must not call ${slug}`);
        },
        {},
        falCatalog({
          endpoint_id: "fal-ai/audio/model",
          metadata: { category: "text-to-audio" },
        }),
      );
      await writeFile(path.join(f.cwd, "still.png"), png(4, 4));
      const result = await f.run([
        "image-gen",
        "--provider",
        provider,
        "--model",
        provider === "fal" ? "fal-ai/audio/model" : "audio_model",
        "--prompt",
        "fox",
        "--file",
        "image=still.png",
      ]);
      expect(result.error.error.code).toBe("invalid_input");
      expect(f.uploads).toEqual([]);
      expect(
        f.calls.filter(
          (call) =>
            String(call.body.tool_slug).includes("GENERATE") ||
            call.body.tool_slug === "FAL_AI_SUBMIT_ASYNC_JOB",
        ),
      ).toEqual([]);
    },
  );

  it("submits a fal video once and retrieves it through the same command", async () => {
    const model = "fal-ai/video/text-to-video";
    let done = false;
    const f = await fixture(
      "fal",
      (slug, args) => {
        if (slug === "FAL_AI_SUBMIT_ASYNC_JOB") {
          expect(args).toEqual({
            model_id: model,
            input: { prompt: "slow orbit" },
          });
          return { request_id: "req_video" };
        }
        if (slug === "FAL_AI_QUEUE_GET_STATUS") {
          expect(args.model_id).toBe("fal-ai/video");
          return { status: done ? "COMPLETED" : "IN_PROGRESS" };
        }
        if (slug === "FAL_AI_GET_QUEUE_REQUEST_RESULT")
          return {
            video: {
              url: "https://v3.fal.media/clip.mp4",
              content_type: "video/mp4",
            },
          };
        throw new Error(slug);
      },
      { "https://v3.fal.media/clip.mp4": new Uint8Array([1, 2, 3]) },
      falCatalog({
        endpoint_id: model,
        metadata: { category: "text-to-video" },
      }),
    );
    const flags = ["video-gen", "--provider", "fal", "--model", model];
    const pending = await f.run([...flags, "--prompt", "slow orbit"]);
    expect(pending.result).toMatchObject({
      requestId: "req_video",
      status: "queued",
      nextCommand: expect.stringContaining("--job 'req_video'"),
    });
    done = true;
    const completed = await f.run([
      ...flags,
      "--job",
      "req_video",
      "--output",
      "clip.mp4",
    ]);
    expect(completed.result).toMatchObject({
      status: "completed",
      files: [{ path: path.join(f.cwd, "clip.mp4") }],
    });
    expect(
      f.calls.filter(
        (call) => call.body.tool_slug === "FAL_AI_SUBMIT_ASYNC_JOB",
      ),
    ).toHaveLength(1);
  });

  it("submits Higgsfield video parameters and follows its original job without another charge", async () => {
    let done = false;
    const f = await fixture(
      "higgsfield",
      (slug, args) => {
        if (slug === "HIGGSFIELD_MCP_MODELS_EXPLORE")
          return { id: "kling3_0", output_type: "video" };
        if (slug === "HIGGSFIELD_MCP_GENERATE_VIDEO") {
          expect(args).toEqual({
            params: {
              model: "kling3_0",
              prompt: "slow orbit",
              duration: 5,
              use_unlim: false,
            },
          });
          return { results: [{ id: jobId, type: "video", status: "queued" }] };
        }
        if (slug === "HIGGSFIELD_MCP_JOB_STATUS")
          return {
            generation: {
              id: jobId,
              type: "video",
              status: done ? "completed" : "in_progress",
              ...(done
                ? { results: { rawUrl: "https://d1.cloudfront.net/clip.mp4" } }
                : {}),
            },
          };
        throw new Error(slug);
      },
      { "https://d1.cloudfront.net/clip.mp4": new Uint8Array([1, 2, 3]) },
    );
    const flags = [
      "video-gen",
      "--provider",
      "higgsfield",
      "--model",
      "kling3_0",
    ];
    const pending = await f.run([
      ...flags,
      "--prompt",
      "slow orbit",
      "--set",
      "duration=5",
      "--set",
      "use_unlim=false",
    ]);
    expect(pending.code, JSON.stringify(pending.error)).toBe(0);
    expect(pending.result.nextCommand).toContain(`--job '${jobId}'`);
    done = true;
    const completed = await f.run([
      ...flags,
      "--job",
      jobId,
      "--output",
      "clip.mp4",
    ]);
    expect(completed.result).toMatchObject({
      jobs: [{ jobId, status: "completed" }],
      files: [{ path: path.join(f.cwd, "clip.mp4") }],
    });
    expect(
      f.calls.filter(
        (call) => call.body.tool_slug === "HIGGSFIELD_MCP_GENERATE_VIDEO",
      ),
    ).toHaveLength(1);
  });

  it("reports Higgsfield jobs in fal's states and says why a job ended without a result", async () => {
    const blocked = "3f0c6d0e-1111-4222-8333-444455556667";
    const f = await fixture("higgsfield", (slug, args) => {
      if (slug === "HIGGSFIELD_MCP_JOB_STATUS")
        return {
          generation: {
            id: args.jobId,
            type: "video",
            status: args.jobId === jobId ? "in_progress" : "nsfw",
          },
        };
      throw new Error(slug);
    });
    const checked = await f.run([
      "video-gen",
      "--provider",
      "higgsfield",
      "--model",
      "kling3_0",
      "--job",
      jobId,
      "--job",
      blocked,
    ]);
    expect(checked.code, JSON.stringify(checked.error)).toBe(0);
    expect(checked.result).toMatchObject({
      jobs: [
        { jobId, status: "running" },
        {
          jobId: blocked,
          status: "failed",
          error: "Higgsfield blocked the result as unsafe content.",
        },
      ],
      nextCommand: expect.stringContaining(`--job '${jobId}'`),
    });
    expect(checked.result.nextCommand).not.toContain(blocked);
  });

  async function finishedJob() {
    const f = await fixture(
      "higgsfield",
      (slug) => {
        if (slug === "HIGGSFIELD_MCP_JOB_STATUS")
          return {
            generation: {
              id: jobId,
              type: "video",
              status: "completed",
              results: { rawUrl: "https://d1.cloudfront.net/clip.mp4" },
            },
          };
        throw new Error(slug);
      },
      { "https://d1.cloudfront.net/clip.mp4": new Uint8Array([1, 2, 3]) },
    );
    const flags = [
      "video-gen",
      "--provider",
      "higgsfield",
      "--model",
      "kling3_0",
      "--job",
      jobId,
      "--output",
    ];
    return { f, flags };
  }

  it("saves a finished job into a folder that does not exist yet", async () => {
    const { f, flags } = await finishedJob();
    const output = path.join("playground", "room_1", "clip.mp4");
    const saved = await f.run([...flags, output]);
    expect(saved.code, JSON.stringify(saved.error)).toBe(0);
    expect(await readFile(path.join(f.cwd, output))).toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  // Root ignores directory permission bits, so the write cannot be made to fail that way.
  it.skipIf(process.getuid?.() === 0)(
    "rejects a finished job it cannot save as a local failure",
    async () => {
      const { f, flags } = await finishedJob();
      // A check submits nothing, so a local failure is not an unknown outcome.
      await mkdir(path.join(f.cwd, "locked"), { mode: 0o500 });
      const failed = await f.run([
        ...flags,
        path.join("locked", "a", "clip.mp4"),
      ]);
      expect(failed.code).toBe(1);
      expect(failed.error.error.code).toBe("local_failure");
    },
  );
});
describe("GitHub commands", () => {
  const issue = {
    number: 42,
    title: "Login fails",
    state: "open",
    body: "Steps",
    user: { login: "alice" },
    labels: [{ name: "bug" }],
    assignees: [],
    comments: 1,
    html_url: "https://github.com/octo/api/pull/42",
    repository_url: "https://api.github.com/repos/octo/api",
    pull_request: { url: "https://api.github.com/repos/octo/api/pulls/42" },
  };
  it("reads a pull request with its comments and changed files", async () => {
    const f = await fixture("github", (slug, args) => {
      expect(args).toMatchObject({ owner: "octo", repo: "api" });
      if (slug === "GITHUB_GET_AN_ISSUE") return issue;
      if (slug === "GITHUB_LIST_ISSUE_COMMENTS") {
        expect(args).toMatchObject({ issue_number: 42, per_page: 100 });
        return { comments: [{ id: 7, user: { login: "bob" }, body: "LGTM" }] };
      }
      if (slug === "GITHUB_GET_A_PULL_REQUEST")
        return {
          merged: false,
          draft: false,
          head: { ref: "fix" },
          base: { ref: "main" },
        };
      expect(slug).toBe("GITHUB_LIST_PULL_REQUESTS_FILES");
      return {
        details: [
          {
            filename: "src/login.ts",
            status: "modified",
            additions: 3,
            deletions: 1,
          },
        ],
      };
    });
    const read = await f.run([
      "github",
      "read",
      "https://github.com/octo/api/pull/42/files",
    ]);
    expect(read.code).toBe(0);
    expect(read.result.item).toMatchObject({
      repository: "octo/api",
      number: 42,
      kind: "pull_request",
      labels: ["bug"],
      body: "Steps",
      comments: [{ commentId: "7", author: "bob", body: "LGTM" }],
      commentsComplete: true,
      head: "fix",
      base: "main",
      files: [{ path: "src/login.ts", status: "modified" }],
      filesComplete: true,
    });
  });
  it("pages repositories with a cursor bound to the same filters", async () => {
    const pages: number[] = [];
    const f = await fixture("github", (slug, args) => {
      expect(slug).toBe("GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER");
      expect(args).toMatchObject({ sort: "pushed", per_page: 1 });
      pages.push(Number(args.page));
      return {
        repositories: [
          { full_name: `octo/repo-${String(args.page)}`, private: false },
        ],
      };
    });
    const first = await f.run([
      "github",
      "repos",
      "--sort",
      "pushed",
      "--limit",
      "1",
    ]);
    expect(first.result).toMatchObject({
      repositories: [{ fullName: "octo/repo-1" }],
      hasMore: true,
    });
    const second = await f.run([
      "github",
      "repos",
      "--sort",
      "pushed",
      "--limit",
      "1",
      "--cursor",
      first.result.nextCursor,
    ]);
    expect(second.result.repositories).toEqual([
      { fullName: "octo/repo-2", private: false },
    ]);
    expect(pages).toEqual([1, 2]);
    const mismatched = await f.run([
      "github",
      "repos",
      "--limit",
      "1",
      "--cursor",
      first.result.nextCursor,
    ]);
    expect(mismatched.error.error.code).toBe("cursor_mismatch");
  });
  it("reads a repository whose README GitHub does not find", async () => {
    const f = await fixture("github", (slug) => {
      expect(slug).toBe("GITHUB_GET_A_REPOSITORY");
      return { full_name: "octo/api", default_branch: "main" };
    });
    const originalFetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation((url, init) =>
      requestUrlText(url).endsWith("/apps/tools/execute") &&
      requestBodyText(init!.body).includes("GITHUB_GET_A_REPOSITORY_README")
        ? Promise.resolve(
            Response.json(
              {
                error: {
                  code: "tool_execution_failed",
                  message: "Not Found",
                  request_id: "r",
                },
              },
              { status: 502 },
            ),
          )
        : originalFetch(url, init),
    );
    const repo = await f.run(["github", "repo", "octo/api"]);
    expect(repo.code).toBe(0);
    expect(repo.result.repository).toEqual({
      fullName: "octo/api",
      defaultBranch: "main",
      readme: { available: false },
    });
  });
  it("comments only after reading the target issue", async () => {
    const f = await fixture("github", (slug, args) => {
      if (slug === "GITHUB_GET_AN_ISSUE") return issue;
      expect(slug).toBe("GITHUB_CREATE_AN_ISSUE_COMMENT");
      expect(args).toEqual({
        owner: "octo",
        repo: "api",
        issue_number: 42,
        body: "Verified",
      });
      return {
        id: 9,
        html_url: "https://github.com/octo/api/pull/42#issuecomment-9",
      };
    });
    const posted = await f.run([
      "github",
      "comment",
      "octo/api#42",
      "--content",
      "Verified",
    ]);
    expect(posted.result.result).toMatchObject({
      action: "commented",
      commentId: "9",
    });
  });
  it.each([
    [["github", "read", "octo/api"], "issue or pull request"],
    [["github", "repo", "octo/api#3"], "repository"],
    [["github", "read", "https://gitlab.com/octo/api/issues/1"], "github.com"],
    [["github", "comment", "octo/api#1", "--content", "  "], "nonblank"],
  ])("rejects %j before contacting TeamHub", async (args, hint) => {
    const f = await fixture("github", () => {
      throw new Error("invalid input must not execute");
    });
    const rejected = await f.run(args);
    expect(rejected.error.error.code).toBe("usage");
    expect(rejected.error.error.message).toContain(hint);
    expect(f.calls).toEqual([]);
  });
});
