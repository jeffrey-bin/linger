import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runCli } from "./cli.js";
import type { CommandDefinition } from "./command-definition.js";
import { commandDefinitions } from "./domain-commands.js";
import { routesByToolName } from "./business-routes.js";
import type { TeamHubConfig } from "./config.js";
import { writeCliConfig } from "./test-support/cli-config.js";
import {
  commandExamples,
  personalProfileDocument,
  fileExamples,
  skillMarkdown,
  rawEvidenceId,
  taskDetail,
} from "./test-support/command-examples.js";
import {
  findOpenAPIPath,
  openAPIContract,
} from "./test-support/openapi-requests.js";
import { displayText } from "./display-text.js";

const roots: string[] = [];
const verifiedOperations = new Set<string>();
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
let validateRequest: Awaited<
  ReturnType<typeof openAPIContract>
>["validateRequest"];
let validateResponse: Awaited<
  ReturnType<typeof openAPIContract>
>["validateResponse"];
beforeAll(async () => {
  ({ validateRequest, validateResponse } = await openAPIContract());
});
afterAll(() => {
  console.info(
    `OpenAPI coverage: ${httpCommands.length} HTTP commands, ${fileExamples.length} file scenarios, ${verifiedOperations.size} unique HTTP operations`,
  );
});
/**
 * How each command's HTTP exchange is checked. Every command must have one, so
 * a new command fails here until its check is chosen.
 * route: the shared Agent route table; execute: its own requests;
 * multipart: metadata plus file parts; file: the file scenarios below;
 * connector: the connector-*.test.ts suites.
 */
function checkCategory(
  definition: CommandDefinition,
): "route" | "execute" | "multipart" | "file" | "connector" {
  if (definition.toolName.startsWith("connector_")) return "connector";
  if (definition.fileRoute) return "file";
  if (["send_message", "send_message_card"].includes(definition.toolName))
    return "multipart";
  return definition.execute || definition.toolName === "create_task"
    ? "execute"
    : "route";
}
const httpCommands = commandDefinitions.filter(
  (definition) => !["connector", "file"].includes(checkCategory(definition)),
);
const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const approval = {
  accepted: true,
  status: "pending_approval",
  creation_approval_request_id: "approval_one",
  message_id: "message_one",
};
const downloadBytes = "original report\n";
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==",
  "base64",
);

const historyMessage = {
  message_id: "message_one",
  inbox_id: "room:room_one",
  author_actor_id: "actor_agent",
  author: "Reviewer",
  author_kind: "agent",
  body: "Contract example",
  segments: [{ type: "text", content: "Contract example" }],
  message_kind: "conversation",
  created_at: "2026-10-10T00:00:00Z",
  context_message_ids: [],
  resource_references: [],
};
const autoReminders = {
  connection_id: "connection_one",
  app_key: "gmail",
  identity_label: "owner@example.test",
  status: "active",
  enabled: false,
};

const computerPermissions = {
  platform: "darwin",
  host: "desktop",
  subjects: [
    {
      subject: "linger",
      permissions: [
        {
          id: "screen_recording",
          state: "not_determined",
          prompt: "available",
          relaunch_required: false,
        },
      ],
    },
  ],
};

async function respond(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const endpoint = url.pathname;
  if (endpoint.endsWith("/messages/read"))
    return Response.json({
      mode: "inbox",
      inbox_id: "room:room_one",
      messages: [{ ...historyMessage, context_messages: [] }],
      has_more: false,
    });
  if (endpoint.endsWith("/messages/commit")) {
    const form = await request.formData();
    const metadata = JSON.parse(displayText(form.get("metadata"))) as {
      segments: { type: string }[];
    };
    return Response.json({
      accepted: true,
      target: { type: "room", id: "room_one" },
      inbox_id: "room:room_one",
      message_id: "message_one",
      resources: metadata.segments.flatMap((segment, index) =>
        segment.type === "text" || segment.type === "reference"
          ? []
          : [
              {
                kind: "document",
                segment_index: index,
                status: "published",
                document_id: `document_${index}`,
                version_id: "version_one",
                name: "report.txt",
              },
            ],
      ),
      duplicate_request: false,
    });
  }
  if (endpoint.endsWith("/tasks/check"))
    return Response.json({ task: taskDetail });
  if (endpoint.endsWith("/tasks/send"))
    return Response.json({
      accepted: true,
      task_id: "task_one",
      status: "running",
      delivery: "steered",
      duplicate_request: false,
    });
  if (endpoint.endsWith("/tasks/stop"))
    return Response.json({
      accepted: true,
      task_id: "task_one",
      status: "canceled",
      duplicate_request: false,
    });
  if (endpoint.endsWith("/messages/search"))
    return Response.json({ messages: [historyMessage], has_more: false });
  if (endpoint.endsWith("/api/agent/v1/tasks"))
    return Response.json({
      accepted: true,
      task_id: "task_one",
      status: "running",
      duplicate_request: false,
    });
  if (endpoint.endsWith("/creation-approval-requests"))
    return Response.json(approval);
  if (endpoint.endsWith("/direct-messages"))
    return Response.json({
      accepted: true,
      inbox_id: "room:room_one",
      message_ids: ["message_one", "message_two"],
      room_created: true,
      duplicate_request: false,
    });
  if (endpoint.endsWith("/emoji-reactions"))
    return Response.json({
      accepted: true,
      message_id: "message_one",
      emoji: "tada",
    });
  if (endpoint.endsWith("/user-questions"))
    return Response.json({
      interaction_id: "interaction_one",
      message_id: "message_one",
      status: "pending",
    });
  if (endpoint.endsWith("/presentation-sequences"))
    return Response.json({
      accepted: true,
      inbox_id: "room:room_one",
      sequence_id: "sequence_one",
      duplicate_request: false,
    });
  if (endpoint.endsWith("/room-members/add"))
    return Response.json({
      room_id: "room_one",
      actor_id: "actor_agent",
      added: true,
    });
  if (endpoint.endsWith("/room-members/query"))
    return Response.json({
      inbox_id: "room:room_one",
      room_id: "room_one",
      membership_revision: 2,
      members: [],
    });
  if (endpoint.endsWith("/team-md/query"))
    return Response.json({
      room_id: "room_one",
      raw_markdown: "# Protocol",
      revision: 2,
      updated_at: "2026-10-12T00:00:00Z",
    });
  if (endpoint.endsWith("/team-md"))
    return Response.json({
      created: true,
      room_id: "room_one",
      revision: 1,
      notified_actor_ids: ["actor_agent"],
      message_id: "message_one",
    });
  if (endpoint.endsWith("/available-agents"))
    return Response.json({ agents: [] });
  if (endpoint.endsWith("/agents/get"))
    return Response.json({
      actor_id: "actor_agent",
      name: "Reviewer",
      description: "Reviews evidence.",
      prompt: "Check evidence.",
    });
  if (endpoint.endsWith("/agents"))
    return Response.json({
      status: "applied",
      actor_id: "actor_agent",
      room_id: "room_one",
    });
  if (endpoint.endsWith("/agents/updates"))
    return Response.json({
      status: "confirmation_pending",
      room_id: "room_one",
      message_id: "message_one",
      interaction_id: "interaction_one",
    });
  if (endpoint.endsWith("/routines/deletion"))
    return Response.json({ deleted: true, routine_id: "routine_one" });
  if (endpoint.includes("/routines")) {
    const routine = {
      id: "routine_one",
      name: "Review",
      instruction: "Review the report",
      schedule: { kind: "daily", time: "09:00", timezone: "Asia/Shanghai" },
      enabled: !endpoint.endsWith("/pause"),
    };
    return Response.json(
      endpoint.endsWith("/query") ? { routines: [routine] } : { routine },
    );
  }
  if (endpoint.endsWith("/documents"))
    return Response.json({
      document_id: "document_one",
      revision_id: "revision_one",
      status: "created",
      replayed: false,
    });
  if (endpoint.endsWith("/document-semantic-mutations"))
    return Response.json({
      semantic_mutation_id: "mutation_one",
      status: "applied",
      revision_id: "revision_two",
      history_entry_id: "history_one",
      replayed: false,
    });
  if (endpoint.endsWith("/document-comments/thread"))
    return Response.json({
      thread_id: "thread_one",
      selection: {
        quoted_text: "Evidence",
        context_before: "",
        context_after: "",
      },
      comments: [],
    });
  if (endpoint.endsWith("/document-comments/replies"))
    return Response.json({
      thread_id: "thread_one",
      comment_id: "comment_two",
      replayed: false,
    });
  if (endpoint.endsWith("/document-comments/text-replacements"))
    return Response.json({
      thread_id: "thread_one",
      status: "applied",
      replayed: false,
      observation: "Text replaced.",
    });
  if (endpoint.endsWith("/computer/browser-connection"))
    return Response.json({
      status: "connection_requested",
      room_id: "room_one",
      message_id: "message_card",
      interaction_id: "interaction_one",
    });
  if (endpoint.endsWith("/computer/permissions/status"))
    return Response.json({
      computer_id: "computer_one",
      permissions: computerPermissions,
    });
  if (endpoint.endsWith("/computer/permissions/request"))
    return Response.json({
      status: "permission_requested",
      computer_id: "computer_one",
      permissions: computerPermissions,
      room_id: "room_one",
      message_id: "message_card",
      interaction_id: "interaction_one",
    });
  if (endpoint.endsWith("/apps/account"))
    return Response.json({
      status: "ready",
      account: {
        connection_id: "connection_one",
        app_key: "notion",
        display_name: "Notion",
        identity_label: "owner@example.test",
      },
    });
  if (endpoint.endsWith("/apps/connections"))
    return Response.json({ connections: [] });
  if (endpoint.endsWith("/apps/auto-reminders/list"))
    return Response.json({ connections: [autoReminders] });
  if (endpoint.endsWith("/apps/auto-reminders/set"))
    return Response.json(autoReminders);
  if (endpoint.endsWith("/apps/tools/search"))
    return Response.json({ tools: [] });
  if (endpoint.endsWith("/apps/tools/execute"))
    return Response.json({ data: { found: true } });
  if (endpoint.endsWith("/skills/packages"))
    return Response.json(
      {
        skill_id: "skill_one",
        name: "release-check",
        manifest_version: "1",
        binding_version: 1,
        replayed: false,
      },
      { status: 201 },
    );
  if (endpoint.endsWith("/personal-profile/query"))
    return Response.json({
      current: {
        revision_id: "personal_profile_revision_one",
        profile: personalProfileDocument,
        markdown: "# Owner",
        created_at: "2026-10-23T00:00:00Z",
      },
    });
  if (endpoint.endsWith("/personal-profile/builds"))
    return Response.json({ building_since: "2026-10-23T00:00:00Z" });
  if (endpoint.endsWith("/personal-profile/revisions"))
    return Response.json({
      revision_id: "personal_profile_revision_two",
      created_at: "2026-10-23T00:00:00Z",
    });
  if (/\/account-profile\/(query|updates)$/u.test(endpoint))
    return Response.json({ name: "Alice", bio: "", organization: "Acme" });
  if (endpoint.endsWith("/tracking-items/list"))
    return Response.json({ items: [], next_cursor: "" });
  if (/\/tracking-items\/(add|update|done)$/u.test(endpoint))
    return Response.json({
      id: "ti_00000000000000000000000000000001",
      kind: "todo",
      content: "Send pricing",
      due_at: null,
      due_text: "next week",
      source_ref: "message_one",
      source_date: "2026-10-23",
      source_timezone: "Asia/Shanghai",
      status: "open",
      created_at: "2026-10-23T00:00:00Z",
      updated_at: "2026-10-23T00:00:00Z",
      revision: 1,
      routines: [],
    });
  if (endpoint.endsWith("/knowledge/search"))
    return Response.json({
      schemaVersion: 1,
      indexedAt: null,
      status: "empty",
      items: [],
      gaps: [{ code: "no_matches" }],
    });
  if (endpoint.endsWith("/knowledge/read"))
    return Response.json({
      schemaVersion: 1,
      evidenceId: rawEvidenceId,
      title: "Report",
      source: { kind: "raw", ref: "report" },
      complete: false,
      directory: [],
      sections: [],
      missingSections: ["summary"],
    });
  if (endpoint.endsWith("/assets") && request.method === "POST")
    return Response.json({
      asset_id: "asset_one",
      media_type: "image/png",
      size_bytes: imageBytes.length,
      sha256: digest(imageBytes),
      replayed: false,
    });
  if (endpoint.endsWith("/assets/asset_one/content"))
    return new Response(imageBytes, {
      headers: {
        "content-type": "application/octet-stream",
        "x-content-sha256": digest(imageBytes),
        "x-document-filename": Buffer.from("card.png").toString("base64url"),
      },
    });
  if (url.searchParams.get("format") === "blocks")
    return new Response(
      JSON.stringify({
        blocks: [
          {
            id: "block_card",
            type: "image",
            props: { url: "document-asset:asset_one" },
          },
        ],
      }),
      {
        headers: {
          "content-type": "application/octet-stream",
          "x-content-sha256": digest("blocks"),
          "x-document-version-id": "version_one",
          "x-document-filename":
            Buffer.from("blocks.json").toString("base64url"),
          "x-document-read-only": "true",
          "x-document-id": "document_one",
        },
      },
    );
  if (endpoint.endsWith("/content"))
    return new Response(downloadBytes, {
      headers: {
        "content-type": "application/octet-stream",
        "x-content-sha256": digest(downloadBytes),
        "x-document-version-id": "version_one",
        "x-document-filename": Buffer.from(
          url.searchParams.has("format") ? "download.html" : "download.txt",
        ).toString("base64url"),
        "x-document-read-only": String(url.searchParams.has("format")),
        "x-document-id": "document_one",
      },
    });
  if (endpoint === "/api/agent/v1/files" && request.method === "GET")
    return Response.json({ files: [] });
  if (endpoint.endsWith("/body"))
    return Response.json({
      document_id: "document_one",
      revision_id: "revision_two",
      history_entry_id: "history_one",
      sha256: digest(new Uint8Array(await request.arrayBuffer())),
      replayed: false,
    });
  throw new Error(`Missing response fixture: ${request.method} ${endpoint}`);
}

const token = `th_agent_${"A".repeat(43)}`;
/** The caller Context comes from the config.json profile scope. */
async function fixture(
  scope: TeamHubConfig["scope"] = { kind: "room", id: "room_one" },
) {
  const cwd = await mkdtemp(path.join(tmpdir(), "cli-openapi-"));
  const configDirectory = await mkdtemp(
    path.join(tmpdir(), "cli-openapi-config-"),
  );
  roots.push(cwd, configDirectory);
  await mkdir(path.join(cwd, "playground/skill/release-check"), {
    recursive: true,
  });
  await mkdir(path.join(cwd, "playground/tree"), { recursive: true });
  await writeFile(path.join(cwd, "playground/report.txt"), "report\n");
  await writeFile(path.join(cwd, "playground/card.png"), imageBytes);
  await writeFile(path.join(cwd, "playground/report.md"), "# Report\n");
  await writeFile(path.join(cwd, "playground/tree/report.txt"), "report\n");
  await writeFile(
    path.join(cwd, "playground/skill/release-check/SKILL.md"),
    skillMarkdown,
  );
  const operations: string[] = [];
  const requests: Request[] = [];
  const errors: string[] = [];
  const stderr: string[] = [];
  const env = writeCliConfig(configDirectory, {
    url: "https://teamhub.test",
    token,
    scope,
  });
  const dependencies = {
    cwd,
    env,
    stdout: () => {},
    stderr: (value: string) => {
      stderr.push(value);
    },
    fetch: (async (url, options) => {
      const request = new Request(url, options);
      requests.push(request.clone());
      try {
        const operation = await validateRequest(request.clone());
        const response = await respond(request);
        await validateResponse(request, response.clone());
        operations.push(operation);
        verifiedOperations.add(operation);
        return response;
      } catch (error) {
        errors.push(String(error));
        throw error;
      }
    }) as typeof fetch,
  };
  return {
    cwd,
    env,
    operations,
    requests,
    errors,
    stderr,
    async run(args: string[]) {
      const exit = await runCli([...args, "--json"], dependencies);
      expect(errors, errors.join("\n")).toEqual([]);
      expect(exit, stderr.join("\n")).toBe(0);
    },
  };
}

describe("actual CLI HTTP exchanges against TeamHub OpenAPI", () => {
  it("uses the default Room for live reads and explicit Thread membership without changing the target", async () => {
    const f = await fixture();
    await f.run(["room", "members"]);
    expect(await f.requests.at(-1)!.json()).toEqual({ inbox_id: "room_one" });
    await f.run(["room", "protocol"]);
    expect(await f.requests.at(-1)!.json()).toEqual({ inbox_id: "room_one" });
    await f.run(["room", "members", "--thread", "thread_one"]);
    expect(await f.requests.at(-1)!.json()).toEqual({
      inbox_id: "thread:thread_one",
    });
    for (const request of f.requests) {
      expect(request.headers.get("x-teamhub-context-kind")).toBe("room");
      expect(request.headers.get("x-teamhub-context-id")).toBe("room_one");
    }
  });
  it("checks every CLI command's HTTP exchange, with no obsolete examples", () => {
    for (const definition of commandDefinitions)
      if (checkCategory(definition) === "route")
        expect(
          routesByToolName[definition.toolName],
          definition.command.join(" "),
        ).toBeDefined();
    expect(Object.keys(commandExamples).sort()).toEqual(
      commandDefinitions
        .filter((item) => checkCategory(item) !== "connector")
        .map((item) => item.toolName)
        .sort(),
    );
  });
  for (const descriptor of commandDefinitions.filter(
    (item) => checkCategory(item) !== "connector",
  )) {
    // The first exchange also loads lazy command modules and compiles schemas.
    // This suite checks HTTP contracts, not a five-second cold-start budget.
    it(
      descriptor.command.join(" "),
      async () => {
        const example = commandExamples[descriptor.toolName];
        expect(example).toBeDefined();
        const f = await fixture();
        if (descriptor.toolName === "replace_document") {
          await f.run([
            "docs",
            "get",
            "document_one",
            "-o",
            "download.html",
            "--format",
            "html",
          ]);
          await writeFile(path.join(f.cwd, "download.html"), "<p>Changed</p>");
          f.operations.length = 0;
          f.requests.length = 0;
        }
        await f.run([...descriptor.command, ...example!]);
        expect(f.operations.length).toBeGreaterThan(0);
        // Multi-request commands must reach their write stage, not just discovery.
        if (checkCategory(descriptor) === "multipart")
          expect(
            f.requests.some((request) =>
              request.headers
                .get("content-type")
                ?.startsWith("multipart/form-data"),
            ),
          ).toBe(true);
      },
      20_000,
    );
  }
  for (const example of fileExamples) {
    it(`file CLI ${example.args.join(" ")}`, async () => {
      const f = await fixture();
      if (example.downloadFirst) {
        const html = example.command.join(" ") === "docs replace";
        await f.run([
          "docs",
          "get",
          "document_one",
          "-o",
          html ? "download.html" : "download.txt",
          ...(html ? ["--format", "html"] : []),
        ]);
        await writeFile(
          path.join(f.cwd, html ? "download.html" : "download.txt"),
          html ? "<p>Changed</p>" : "Changed\n",
        );
        f.operations.length = 0;
        f.requests.length = 0;
      }
      await f.run(example.args);
      expect(f.operations.length).toBeGreaterThan(0);
    });
  }
  it.each([
    ["task", "get"],
    ["task", "list"],
    ["task", "members"],
    ["task", "finish"],
    ["room", "team-md"],
    ["room", "agents"],
    ["agents"],
    ["profile", "--name", "Reviewer", "--content", "Check evidence."],
    ["docs", "ls"],
    ["docs", "mutate"],
    ["publish"],
    ["skill", "publish"],
    ["build", "get"],
    ["human", "ask"],
    ["message", "fragment"],
  ])("rejects removed public route %j before HTTP", async (...args) => {
    const fetcher = vi.fn();
    expect(
      await runCli(args, {
        cwd: tmpdir(),
        env: {},
        fetch: fetcher,
        stdout: () => {},
        stderr: () => {},
      }),
    ).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("matches concrete routes before an earlier parameter route", () => {
    const paths = [
      { template: "/tasks/{id}", schema: "task" },
      { template: "/tasks/query", schema: "query" },
    ];
    expect(findOpenAPIPath(paths, "/tasks/query")?.schema).toBe("query");
    expect(findOpenAPIPath(paths, "/tasks/task_one")?.schema).toBe("task");
  });
  it("rejects the historical generic success fake against the real response schema", async () => {
    const f = await fixture();
    await f.run(["message", "send", ...commandExamples.send_message!]);
    await expect(
      validateResponse(f.requests[0]!, Response.json({ accepted: true })),
    ).rejects.toThrow("message_id");
  });
  it("validates nested response fields and rejects extra fields", async () => {
    const request = new Request(
      "https://teamhub.test/api/agent/v1/tasks/check",
      { method: "POST" },
    );
    await expect(
      validateResponse(
        request,
        Response.json({
          task: { ...taskDetail, queued_message_count: "none" },
        }),
      ),
    ).rejects.toThrow("data/task/queued_message_count must be integer");
    await expect(
      validateResponse(
        request,
        Response.json({ task: { ...taskDetail, unknown_field: true } }),
      ),
    ).rejects.toThrow("additional properties");
  });
  it("selects the error schema using the actual HTTP status", async () => {
    const request = new Request(
      "https://teamhub.test/api/agent/v1/presentation-sequences",
      {
        method: "POST",
      },
    );
    await expect(
      validateResponse(
        request,
        Response.json(
          {
            accepted: true,
            inbox_id: "room:room_one",
            sequence_id: "sequence_one",
          },
          { status: 400 },
        ),
      ),
    ).rejects.toThrow("required property 'error'");
    await expect(
      validateResponse(
        request,
        Response.json(
          {
            error: {
              code: "invalid_request",
              message: "Invalid message",
              request_id: "request_one",
            },
          },
          { status: 400 },
        ),
      ),
    ).resolves.toBeUndefined();
  });
  it("uses the default error response rather than another success status", async () => {
    const f = await fixture();
    await f.run([
      "profile",
      "skill",
      "publish",
      "playground/skill/release-check",
    ]);
    const request = f.requests[0]!;
    const created = await respond(request.clone());
    expect(created.status).toBe(201);
    await expect(
      validateResponse(
        request,
        Response.json(await created.json(), { status: 200 }),
      ),
    ).rejects.toThrow("required property 'error'");
  });
  it.each([undefined, "text/plain", "application/octet-stream"])(
    "rejects JSON response bodies with undeclared content type %s",
    async (contentType) => {
      const request = new Request(
        "https://teamhub.test/api/agent/v1/presentation-sequences",
        { method: "POST" },
      );
      const body = JSON.stringify({
        accepted: true,
        inbox_id: "room:room_one",
        sequence_id: "sequence_one",
        duplicate_request: false,
      });
      await expect(
        validateResponse(
          request,
          new Response(new TextEncoder().encode(body), {
            headers: contentType ? { "content-type": contentType } : {},
          }),
        ),
      ).rejects.toThrow("undeclared response content type");
      await expect(
        validateResponse(
          request,
          new Response(body, {
            headers: { "content-type": "application/json; charset=utf-8" },
          }),
        ),
      ).resolves.toBeUndefined();
    },
  );
  it("validates unchanged downloads and rejects retired pending responses", async () => {
    const request = new Request(
      "https://teamhub.test/api/agent/v1/files/document_one/content",
    );
    await expect(
      validateResponse(request, new Response(null, { status: 304 })),
    ).resolves.toBeUndefined();
    await expect(
      validateResponse(request, new Response(null, { status: 202 })),
    ).rejects.toThrow("undeclared response content type");
    await expect(
      validateResponse(request, new Response(downloadBytes, { status: 202 })),
    ).rejects.toThrow("undeclared response content type");
  });
  it("detects obsolete Connected Apps camelCase on the actual serialized request", async () => {
    const f = await fixture();
    await f.run(["apps", "execute", ...commandExamples.execute_app_tool!]);
    const actual = f.requests[0]!;
    const wrong = new Request(actual.url, {
      method: actual.method,
      headers: actual.headers,
      body: JSON.stringify({
        connectionId: "connection_one",
        toolSlug: "NOTION_FETCH_PAGE",
        toolVersion: "20261009_00",
        arguments: { page_id: "page_one" },
      }),
    });
    await expect(validateRequest(wrong)).rejects.toThrow(
      /connection_id|additional properties/,
    );
  });
  it("detects the historical missing Document semantic schema version after real encoding", async () => {
    const f = await fixture();
    await f.run([
      "docs",
      "update",
      ...commandExamples.apply_document_semantic_mutation!,
    ]);
    const actual = f.requests[0]!;
    const obsolete = (await actual.clone().json()) as Record<string, unknown>;
    delete obsolete.schema_version;
    await expect(
      validateRequest(
        new Request(actual.url, {
          method: actual.method,
          headers: actual.headers,
          body: JSON.stringify(obsolete),
        }),
      ),
    ).rejects.toThrow("schema_version");
  });
  it("rejects unsupported fields in real atomic message resource metadata", async () => {
    const f = await fixture();
    await f.run([
      "message",
      "send",
      "--content",
      "Report",
      "--attach",
      "playground/report.txt",
    ]);
    const actual = f.requests[0]!;
    const form = await actual.formData();
    const metadata = JSON.parse(displayText(form.get("metadata"))) as Record<
      string,
      unknown
    >;
    form.set(
      "metadata",
      JSON.stringify({ ...metadata, context_session_id: "internal-only" }),
    );
    const headers = new Headers(actual.headers);
    headers.delete("content-type");
    await expect(
      validateRequest(
        new Request(actual.url, { method: actual.method, headers, body: form }),
      ),
    ).rejects.toThrow("additional properties");
  });
  it("rejects undeclared methods and missing required fields rather than skipping schema checks", async () => {
    await expect(
      validateRequest(
        new Request(
          "https://teamhub.test/api/agent/v1/presentation-sequences",
          {
            method: "DELETE",
          },
        ),
      ),
    ).rejects.toThrow("Undeclared TeamHub method");
    await expect(
      validateRequest(
        new Request(
          "https://teamhub.test/api/agent/v1/presentation-sequences",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
        ),
      ),
    ).rejects.toThrow("required property");
  });
});
