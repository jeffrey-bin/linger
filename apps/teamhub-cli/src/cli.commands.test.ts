import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import type { TeamHubConfig } from "./config.js";
import { displayText } from "./display-text.js";
import { commandDefinitions, commandOptions } from "./domain-commands.js";
import { writeCliConfig } from "./test-support/cli-config.js";
import { requestUrlText } from "./test-support/fetch-text.js";
const roots: string[] = [];
afterEach(() => {
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});
/** A config.json profile whose scope is the caller Context; room_one by default. */
function fixture(
  scope: TeamHubConfig["scope"] | null = { kind: "room", id: "room_one" },
) {
  const cwd = mkdtempSync(path.join(tmpdir(), "teamhub-cli-"));
  const configDirectory = mkdtempSync(
    path.join(tmpdir(), "teamhub-cli-config-"),
  );
  roots.push(cwd, configDirectory);
  const stdout: string[] = [],
    stderr: string[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      accepted: true,
      target: { type: "room", id: "room_one" },
      inbox_id: "room_one",
      message_id: "message_one",
      resources: [],
      duplicate_request: false,
    }),
  );
  const readInput = vi.fn(async () => "Hello");
  const dependencies = {
    cwd,
    env: writeCliConfig(configDirectory, { scope: scope ?? undefined }),
    fetch: fetcher,
    readInput,
    stdout: (value: string) => {
      stdout.push(value);
    },
    stderr: (value: string) => {
      stderr.push(value);
    },
  };
  return {
    cwd,
    configDirectory,
    stdout,
    stderr,
    fetcher,
    readInput,
    dependencies,
  };
}
const send = ["message", "send", "--content", "Hello", "--json"];
/** A presentation-sequence acceptance. */
function sequenceAccepted() {
  return Response.json({
    accepted: true,
    inbox_id: "room:room_one",
    sequence_id: "sequence_one",
    duplicate_request: false,
  });
}
/** The Room profile with a run.json that carries run context only. */
function runFixture() {
  const f = fixture();
  writeFileSync(
    path.join(f.configDirectory, "run.json"),
    JSON.stringify({
      run_id: "run_one",
    }),
  );
  return f;
}
function contextHeaders(call: Parameters<typeof fetch>) {
  const headers = new Headers(call[1]!.headers);
  return {
    kind: headers.get("x-teamhub-context-kind"),
    id: headers.get("x-teamhub-context-id"),
  };
}
const app = [
  "apps",
  "execute",
  "--connectionId",
  "connection_one",
  "--toolSlug",
  "NOTION_FETCH_PAGE",
  "--toolVersion",
  "20261009_00",
  "--arguments",
  '{"page_id":"one"}',
  "--operation-id",
  "external-write",
  "--json",
];
function body(call: Parameters<typeof fetch>): Record<string, unknown> {
  const value = call[1]!.body;
  return value instanceof FormData
    ? JSON.parse(displayText(value.get("metadata")))
    : JSON.parse(displayText(value));
}
function operation(call: Parameters<typeof fetch>): string | null {
  return new Headers(call[1]!.headers).get("x-teamhub-operation-id");
}
describe("integrated CLI business requests and outcomes", () => {
  it.each([false, true])(
    "keeps same-name Document candidates in errors (JSON=%s)",
    async (json) => {
      const f = fixture();
      f.fetcher.mockResolvedValue(
        Response.json({
          files: [
            { document_id: "document_first", name: "Same name café" },
            { document_id: "document_second", name: "Same name café" },
          ],
        }),
      );
      expect(
        await runCli(
          [
            "docs",
            "get",
            "Same name café",
            "-o",
            "copy.md",
            ...(json ? ["--json"] : []),
          ],
          f.dependencies,
        ),
      ).toBe(2);
      const output = f.stderr.join("");
      if (json)
        expect(JSON.parse(output).error).toMatchObject({
          code: "ambiguous_name",
          details: { candidates: ["document_first", "document_second"] },
        });
      else
        expect(output).toContain("Candidates: document_first, document_second");
      expect(f.stdout).toEqual([]);
      expect(existsSync(path.join(f.cwd, "copy.md"))).toBe(false);
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([1, 2, 100])(
    "searches all %i explicit Inboxes in one request",
    async (count) => {
      const f = fixture();
      const inboxes = Array.from(
        { length: count },
        (_, index) => `room:room_${index}`,
      );
      f.fetcher.mockResolvedValue(
        Response.json({ messages: [], has_more: false }),
      );
      expect(
        await runCli(
          [
            "message",
            "search",
            "literal café query",
            ...inboxes.flatMap((inbox) => ["--inbox", inbox]),
            "--json",
          ],
          f.dependencies,
        ),
        f.stderr.join(""),
      ).toBe(0);
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(body(f.fetcher.mock.calls[0]!)).toMatchObject({
        query: "literal café query",
        inbox_ids: inboxes,
      });
      expect(JSON.parse(f.stdout.join(""))).toEqual({
        messages: [],
        has_more: false,
      });
    },
  );
  it("rejects more than 100 search Inbox filters before dispatch", async () => {
    const f = fixture();
    expect(
      await runCli(
        [
          "message",
          "search",
          "query",
          ...Array.from({ length: 101 }, (_, index) => [
            "--inbox",
            `room:room_${index}`,
          ]).flat(),
          "--json",
        ],
        f.dependencies,
      ),
    ).toBe(2);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("writes no local state for a write command", async () => {
    const f = fixture();
    const stateRoot = path.join(f.cwd, "state");
    mkdirSync(stateRoot);
    writeFileSync(path.join(f.cwd, ".teamhub"), "protected");
    f.dependencies.env.TEAMHUB_STATE_ROOT = stateRoot;
    expect(await runCli(send, f.dependencies), f.stderr.join("")).toBe(0);
    expect(readFileSync(path.join(f.cwd, ".teamhub"), "utf8")).toBe(
      "protected",
    );
    expect(readdirSync(stateRoot)).toEqual([]);
    expect(existsSync(path.join(f.configDirectory, ".teamhub"))).toBe(false);
  });
  it.each(["", "relative/path", "/state\ninvalid"])(
    "rejects invalid state root %j before dispatch",
    async (root) => {
      const f = fixture();
      f.dependencies.env.TEAMHUB_STATE_ROOT = root;
      expect(await runCli(send, f.dependencies)).toBe(2);
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.stderr.join("")).toContain("configuration_error");
    },
  );
  it("reports an unknown outcome with its operation ID and retries it under that ID from anywhere", async () => {
    const f = fixture();
    const other = path.join(f.cwd, "other");
    mkdirSync(other);
    f.fetcher.mockRejectedValueOnce(new Error("response lost"));
    expect(await runCli(send, f.dependencies)).toBeGreaterThan(0);
    const reported = JSON.parse(f.stderr.join("")).error;
    expect(reported.code).toBe("outcome_unknown");
    const operationId = reported.details.operation_id;
    expect(operationId).toBe(operation(f.fetcher.mock.calls[0]!));
    // No local state picks the operation up again: a plain rerun is new.
    expect(await runCli(send, f.dependencies), f.stderr.join("")).toBe(0);
    expect(operation(f.fetcher.mock.calls[1]!)).not.toBe(operationId);
    expect(
      await runCli([...send, "--operation-id", operationId], {
        ...f.dependencies,
        cwd: other,
      }),
      f.stderr.join(""),
    ).toBe(0);
    expect(operation(f.fetcher.mock.calls[2]!)).toBe(operationId);
    expect(body(f.fetcher.mock.calls[2]!).invocation_id).toBe(
      body(f.fetcher.mock.calls[0]!).invocation_id,
    );
    expect(existsSync(path.join(other, ".teamhub"))).toBe(false);
  });
  it("sends a Room message without a source when --reply-to is absent", async () => {
    const f = runFixture();
    expect(await runCli(send, f.dependencies), f.stderr.join("")).toBe(0);
    expect(body(f.fetcher.mock.calls[0]!)).not.toHaveProperty(
      "source_message_id",
    );
  });
  it("sends a Room sequence without a source when --reply-to is absent", async () => {
    const f = runFixture();
    f.fetcher.mockImplementation(async () => sequenceAccepted());
    expect(
      await runCli(
        [
          "message",
          "sequence",
          "--content",
          "One",
          "--pause",
          "brief",
          "--content",
          "Two",
          "--json",
        ],
        f.dependencies,
      ),
      f.stderr.join(""),
    ).toBe(0);
    expect(body(f.fetcher.mock.calls[0]!)).not.toHaveProperty(
      "source_message_id",
    );
  });
  it("names the run.json Run in a header, not in a Room sequence body", async () => {
    const f = runFixture();
    f.fetcher.mockImplementation(async () => sequenceAccepted());
    expect(
      await runCli(
        [
          "message",
          "sequence",
          "--content",
          "One",
          "--pause",
          "brief",
          "--content",
          "Two",
          "--json",
        ],
        f.dependencies,
      ),
      f.stderr.join(""),
    ).toBe(0);
    // TeamHub keeps the Run only when it is this Agent's running Run there.
    const sent = body(f.fetcher.mock.calls[0]!);
    expect(sent).toMatchObject({ inbox_id: "room:room_one" });
    expect(sent).not.toHaveProperty("execution_run_ref");
    expect(
      new Headers(f.fetcher.mock.calls[0]![1]!.headers).get("x-teamhub-run-id"),
    ).toBe("run_one");
  });
  it("sends inline \\n in a sequence bubble as a real line break", async () => {
    const f = runFixture();
    f.fetcher.mockImplementation(async () => sequenceAccepted());
    expect(
      await runCli(
        [
          "message",
          "sequence",
          "--content",
          "First\\n\\nSecond",
          "--pause",
          "brief",
          "--content",
          "Third",
          "--json",
        ],
        f.dependencies,
      ),
      f.stderr.join(""),
    ).toBe(0);
    expect(body(f.fetcher.mock.calls[0]!)).toMatchObject({
      messages: [{ content: "First\n\nSecond" }, { content: "Third" }],
    });
  });
  it("passes an explicit --reply-to through unchanged for a Room send and sequence", async () => {
    const f = runFixture();
    expect(
      await runCli([...send, "--reply-to", "explicit"], f.dependencies),
      f.stderr.join(""),
    ).toBe(0);
    expect(body(f.fetcher.mock.calls[0]!)).toMatchObject({
      inbox_id: "room:room_one",
      source_message_id: "explicit",
    });
    const sequence = runFixture();
    sequence.fetcher.mockImplementation(async () => sequenceAccepted());
    expect(
      await runCli(
        [
          "message",
          "sequence",
          "--content",
          "One",
          "--pause",
          "brief",
          "--content",
          "Two",
          "--reply-to",
          "explicit",
          "--json",
        ],
        sequence.dependencies,
      ),
      sequence.stderr.join(""),
    ).toBe(0);
    expect(body(sequence.fetcher.mock.calls[0]!)).toMatchObject({
      source_message_id: "explicit",
    });
  });
  it.each([
    send,
    ["docs", "create", "--title", "T", "--content", "x", "--json"],
    ["message", "card", "--title", "Done", "--content", "x", "--json"],
    ["task", "check", "--json"],
  ])(
    "refuses %j in a Task Context before upload or dispatch",
    async (...argv) => {
      const f = fixture({ kind: "task", id: "task_one" });
      expect(await runCli(argv, f.dependencies)).toBe(4);
      const failure = JSON.parse(f.stderr.join("")).error;
      expect(failure.code).toBe("forbidden");
      expect(failure.message).toContain("final reply");
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it("permits intentional repeated successful sends using fresh identities", async () => {
    const f = fixture();
    expect(await runCli(send, f.dependencies)).toBe(0);
    expect(await runCli(send, f.dependencies)).toBe(0);
    expect(operation(f.fetcher.mock.calls[0]!)).not.toBe(
      operation(f.fetcher.mock.calls[1]!),
    );
  });
  it.each(["network", "malformed", "missing", "provider"])(
    "reports an unknown external app %s outcome without retrying it",
    async (failure) => {
      const f = fixture();
      if (failure === "network") f.fetcher.mockRejectedValue(new Error("lost"));
      else if (failure === "malformed")
        f.fetcher.mockResolvedValue(new Response("broken"));
      else if (failure === "missing")
        f.fetcher.mockResolvedValue(Response.json({}));
      else
        f.fetcher.mockResolvedValue(
          Response.json(
            { error: { code: "tool_execution_failed", message: "uncertain" } },
            { status: 409 },
          ),
        );
      expect(await runCli(app, f.dependencies)).toBeGreaterThan(0);
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      const reported = JSON.parse(f.stderr.join("")).error;
      expect(reported.code).toBe("outcome_unknown");
      expect(reported.message).toContain("Check the connected application");
      expect(reported.details).toMatchObject({
        operation_id: "external-write",
        retryable: false,
      });
    },
  );
  it("keeps the application's reason with an unknown external app outcome", async () => {
    const f = fixture();
    const issue = {
      path: "provider",
      code: "provider_error",
      message: "Balance exhausted.",
    };
    f.fetcher.mockResolvedValue(
      Response.json(
        {
          error: {
            code: "tool_execution_failed",
            message: "uncertain",
            issues: [issue],
          },
        },
        { status: 409 },
      ),
    );
    expect(await runCli(app, f.dependencies)).toBeGreaterThan(0);
    const reported = JSON.parse(f.stderr.join("")).error;
    expect(reported.code).toBe("outcome_unknown");
    expect(reported.details.issues).toEqual([issue]);
  });
  it.each(["inline", "file", "stdin"])(
    "preserves app arguments and arbitrary JSON data using %s input",
    async (mode) => {
      const f = fixture();
      const args = app.slice();
      const argumentsValue = {
        query: "Rapport\n✅",
        nested: { nullValue: null, list: [1, false, "x"] },
      };
      const data = [null, false, 7, { label: "Café ✅" }];
      const index = args.indexOf("--arguments");
      if (mode === "inline") args[index + 1] = JSON.stringify(argumentsValue);
      else {
        args[index] = "--arguments-file";
        args[index + 1] = mode === "stdin" ? "-" : "app-arguments.json";
        if (mode === "stdin")
          f.readInput.mockResolvedValue(JSON.stringify(argumentsValue));
        else
          writeFileSync(
            path.join(f.cwd, "app-arguments.json"),
            JSON.stringify(argumentsValue),
          );
      }
      f.fetcher.mockResolvedValue(Response.json({ data }));
      const dependencies = {
        ...f.dependencies,
        ...(mode === "file" ? { readInput: undefined } : {}),
      };
      expect(await runCli(args, dependencies), f.stderr.join("")).toBe(0);
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(body(f.fetcher.mock.calls[0]!).arguments).toEqual(argumentsValue);
      expect(JSON.parse(f.stdout.join(""))).toEqual({ data });
    },
  );
  it("does not fence malformed app input before any dispatch", async () => {
    const f = fixture();
    const args = app.map((value) =>
      value === '{"page_id":"one"}' ? "[]" : value,
    );
    expect(await runCli(args, f.dependencies)).toBe(2);
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValue(Response.json({ data: { ok: true } }));
    expect(await runCli(app, f.dependencies), f.stderr.join("")).toBe(0);
  });
  it("allows a known pre-dispatch app rejection to be corrected", async () => {
    const f = fixture();
    f.fetcher
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "invalid_tool_arguments", message: "bad" } },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ data: { ok: true } }));
    expect(await runCli(app, f.dependencies)).toBeGreaterThan(0);
    expect(await runCli(app, f.dependencies), f.stderr.join("")).toBe(0);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("sends an identical message twice as two operations and keeps no state after delivery", async () => {
    const f = fixture();
    const ack = ["message", "send", "--content", "Received", "--json"];
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await runCli(ack, f.dependencies), f.stderr.join("")).toBe(0);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    const [first, second] = f.fetcher.mock.calls.map(operation);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    expect(existsSync(path.join(f.configDirectory, ".teamhub"))).toBe(false);
  });
  it("lets a message write name its operation explicitly", async () => {
    // TeamHub deduplicates by the named operation, whatever the local state.
    const first = fixture();
    const second = fixture();
    for (const f of [first, second])
      expect(
        await runCli([...send, "--operation-id", "send-once"], f.dependencies),
        f.stderr.join(""),
      ).toBe(0);
    expect(body(second.fetcher.mock.calls[0]!).invocation_id).toBe(
      body(first.fetcher.mock.calls[0]!).invocation_id,
    );
  });
  it("sends a Thread target inside the configured Room without changing the Context or credential identity", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      Response.json({
        accepted: true,
        target: { type: "thread", id: "thread_one" },
        inbox_id: "thread:thread_one",
        message_id: "message_one",
        resources: [],
        duplicate_request: false,
      }),
    );
    expect(
      await runCli(
        [...send, "--thread", "thread_one", "--reply-to", "explicit"],
        f.dependencies,
      ),
      f.stderr.join(""),
    ).toBe(0);
    expect(body(f.fetcher.mock.calls[0]!)).toMatchObject({
      inbox_id: "thread:thread_one",
      source_message_id: "explicit",
    });
    expect(contextHeaders(f.fetcher.mock.calls[0]!)).toEqual({
      kind: "room",
      id: "room_one",
    });
    expect(
      new Headers(f.fetcher.mock.calls[0]![1]!.headers).get("authorization"),
    ).toBe("Bearer th_agent_fixture");
  });
  it("manages a delegated Task from the configured Room Context", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        accepted: true,
        task_id: "task_one",
        status: "running",
        delivery: "steered",
        duplicate_request: false,
      }),
    );
    expect(
      await runCli(
        [
          "task",
          "send",
          "--task-id",
          "task_one",
          "--message",
          "Use the Q3 data.",
          "--steer",
          "--json",
        ],
        f.dependencies,
      ),
      f.stderr.join(""),
    ).toBe(0);
    const [request] = f.fetcher.mock.calls;
    expect(requestUrlText(request![0])).toContain("/api/agent/v1/tasks/send");
    expect(body(request!)).toMatchObject({
      task_id: "task_one",
      message: "Use the Q3 data.",
      steer: true,
      invocation_id: expect.stringMatching(/^agent-invocation-sha256:/u),
    });
    expect(contextHeaders(request!)).toEqual({ kind: "room", id: "room_one" });
  });
  it("reads global discovery without inheriting a collection filter or creating a receipt", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      Response.json({ mode: "inboxes", inboxes: [] }),
    );
    expect(
      await runCli(
        ["message", "read", "--list-inboxes", "--json"],
        f.dependencies,
      ),
    ).toBe(0);
    expect(body(f.fetcher.mock.calls[0]!)).toEqual({ list_inboxes: true });
    expect(operation(f.fetcher.mock.calls[0]!)).toBeNull();
    expect(existsSync(path.join(f.cwd, ".teamhub"))).toBe(false);
  });
  it("reports English failures with command and the configured bare Task target while hiding backend routing prose", async () => {
    const f = fixture({ kind: "task", id: "task_one" });
    f.fetcher.mockResolvedValue(
      Response.json(
        {
          error: {
            code: "permission_denied",
            message: "Not allowed to read task:task_one",
            details: { inbox_id: "task:task_one", request_id: "request_one" },
          },
        },
        { status: 403 },
      ),
    );
    expect(await runCli(["message", "read", "--json"], f.dependencies)).toBe(4);
    expect(body(f.fetcher.mock.calls[0]!)).toMatchObject({
      inbox_id: "task:task_one",
    });
    expect(contextHeaders(f.fetcher.mock.calls[0]!)).toEqual({
      kind: "task",
      id: "task_one",
    });
    const failure = JSON.parse(f.stderr.join("")).error;
    expect(failure).toMatchObject({
      code: "permission_denied",
      command: "message read",
      target: { type: "task", id: "task_one" },
    });
    expect(f.stderr.join("")).not.toMatch(/task:task_one|Not allowed/);
  });
  it.each(["[]", "null", '"text"', "{bad", "{} {}"])(
    "rejects malformed complete message %s before network",
    async (value) => {
      const f = fixture();
      expect(
        await runCli(["message", "send", "--message", value], f.dependencies),
      ).toBe(2);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it("rejects oversized JSON before network", async () => {
    const f = fixture();
    f.readInput.mockResolvedValue(" ".repeat(5 * 1024 * 1024 + 1));
    expect(
      await runCli(["message", "send", "--message-file", "-"], f.dependencies),
    ).toBe(2);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

it("reads a real message Thread inside the configured Room Context without document-comment scope", async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(
    Response.json({ mode: "history", messages: [], has_more: false }),
  );
  await runCli(
    ["message", "read", "--thread", "thread_one", "--json"],
    f.dependencies,
  );
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(body(f.fetcher.mock.calls[0]!)).toEqual({
    thread_id: "thread_one",
  });
  expect(contextHeaders(f.fetcher.mock.calls[0]!)).toEqual({
    kind: "room",
    id: "room_one",
  });
});

describe("caller Context comes only from config.json", () => {
  it.each([
    ["message", "send", "--room", "room_one", "--content", "Hello"],
    ["message", "read", "--room", "room_one"],
    ["message", "send", "--task", "task_one", "--content", "Hello"],
    ["docs", "create", "--task", "task_one", "--title", "T", "--content", "x"],
    ["room", "protocol", "--room", "room_one"],
    ["routine", "list", "--room", "room_one"],
    ["task", "check", "--room", "room_one"],
  ])(
    "rejects the removed target option in %j before configuration or I/O",
    async (...argv) => {
      const f = fixture();
      f.dependencies.env = {};
      expect(await runCli([...argv, "--json"], f.dependencies)).toBe(2);
      const flag = argv.find((value) => ["--room", "--task"].includes(value));
      expect(JSON.parse(f.stderr.join("")).error).toMatchObject({
        code: "usage",
        message: `Unknown option: ${flag}. Run this command with --help.`,
      });
      expect(f.readInput).not.toHaveBeenCalled();
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it("offers no Room or Task target option on any command", () => {
    for (const definition of commandDefinitions) {
      expect(commandOptions(definition)).not.toHaveProperty("--room");
      expect(commandOptions(definition)).not.toHaveProperty("--task");
    }
  });
  it.each([
    [
      "an unscoped profile",
      null,
      ["message", "send", "--content", "Hello"],
      "Room or Task",
    ],
    [
      "a Thread profile",
      { kind: "thread", id: "thread_one" },
      ["docs", "create", "--title", "T", "--content", "x"],
      "Room or Task",
    ],
    [
      "a Task profile",
      { kind: "task", id: "task_one" },
      ["room", "protocol"],
      "Room",
    ],
  ] as const)(
    "fails a Room-type command with %s as a configuration error",
    async (_name, scope, argv, needed) => {
      const f = fixture(scope);
      expect(await runCli([...argv, "--json"], f.dependencies)).toBe(2);
      expect(JSON.parse(f.stderr.join("")).error).toMatchObject({
        code: "configuration_error",
        message: `This command needs a ${needed} Context in the TeamHub CLI configuration.`,
      });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    [null, { kind: null, id: null }],
    [
      { kind: "room", id: "room_one" },
      { kind: "room", id: "room_one" },
    ],
  ] as const)(
    "reads an explicit Task Inbox with profile scope %j",
    async (scope, headers) => {
      const f = fixture(scope);
      f.fetcher.mockResolvedValue(
        Response.json({
          mode: "inbox",
          inbox_id: "task:task_one",
          messages: [],
          has_more: false,
        }),
      );
      expect(
        await runCli(
          ["message", "read", "--inbox", "task:task_one", "--json"],
          f.dependencies,
        ),
        f.stderr.join(""),
      ).toBe(0);
      expect(body(f.fetcher.mock.calls[0]!)).toEqual({
        inbox_id: "task:task_one",
      });
      expect(contextHeaders(f.fetcher.mock.calls[0]!)).toEqual(headers);
    },
  );
  it("has no caller Context in direct environment mode, even with the retired override", async () => {
    const f = fixture();
    f.dependencies.env = {
      TEAMHUB_URL: "https://teamhub.example",
      TEAMHUB_TOKEN: "th_agent_fixture",
      TEAMHUB_CONTEXT_KIND: "room",
      TEAMHUB_CONTEXT_ID: "room_one",
    };
    expect(await runCli(send, f.dependencies)).toBe(2);
    expect(JSON.parse(f.stderr.join("")).error).toMatchObject({
      code: "configuration_error",
      message:
        "This command needs a Room or Task Context in the TeamHub CLI configuration.",
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValue(Response.json({ data: { ok: true } }));
    expect(await runCli(app, f.dependencies), f.stderr.join("")).toBe(0);
    expect(contextHeaders(f.fetcher.mock.calls[0]!)).toEqual({
      kind: null,
      id: null,
    });
  });
});
