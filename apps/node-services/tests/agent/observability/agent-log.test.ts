import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAgentLogger,
  flushAgentLogs,
  closeAgentLogs,
  logAgentEvent,
  agentLogText,
  setAgentLogDirectory,
  setAgentLogOptions,
} from "../../../src/agent/observability/agent-log.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalLogLevel = process.env.AGENT_LOG_LEVEL;
const temporaryDirectories: string[] = [];

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_LOG_LEVEL;
  setAgentLogOptions({ format: "json" });
  setAgentLogDirectory();
  process.env.NODE_ENV = "test";
});

afterEach(async () => {
  await closeAgentLogs(2000);
  setAgentLogOptions();
  vi.restoreAllMocks();
  restoreEnvironment("NODE_ENV", originalNodeEnv);
  restoreEnvironment("AGENT_LOG_LEVEL", originalLogLevel);
  setAgentLogDirectory();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("logAgentEvent", () => {
  it("defaults to off in tests", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logAgentEvent("error", "runtime.failed");

    expect(output).not.toHaveBeenCalled();
  });

  it("defaults to info outside tests", () => {
    delete process.env.NODE_ENV;
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logAgentEvent("debug", "runtime.debug");
    logAgentEvent("info", "runtime.started", { roomId: "room-1" });

    expect(output).toHaveBeenCalledOnce();
    const entry = parseOutput(output);
    expect(entry).toMatchObject({
      level: "info",
      event: "runtime.started",
      roomId: "room-1",
    });
    expect(new Date(entry.time as string).toISOString()).toBe(entry.time);
  });

  it("prints JSON lines on the terminal in production", () => {
    process.env.NODE_ENV = "production";
    setAgentLogOptions();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logAgentEvent("info", "runtime.started", { roomId: "room-1" });

    expect(output).toHaveBeenCalledOnce();
    expect(parseOutput(output)).toMatchObject({
      level: "info",
      event: "runtime.started",
      roomId: "room-1",
    });
  });

  it("prints readable pretty lines outside production", () => {
    process.env.NODE_ENV = "development";
    setAgentLogOptions({ content: "full" });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    createAgentLogger({
      component: "agent-manager",
      roomId: "room-1",
      agentId: "agent-1",
      agentName: "Anotherme @ Lu",
    }).log("info", "message.received", {
      messageId: "message-1",
      messageFrom: "alice",
      messageFromType: "user",
      ...agentLogText("messageText", "Please confirm delivery."),
    });

    expect(output).toHaveBeenCalledOnce();
    const line = output.mock.calls[0]?.[0] as string;
    expect(line).toMatch(
      /^\d{2}:\d{2}:\d{2}\.\d{3} INFO {2}\[Anotherme @ Lu\] message\.received/,
    );
    expect(line).toContain("room=room-1 agent=agent-1 message=message-1");
    expect(line).toContain("user alice: Please confirm delivery.");
  });

  it("honors an explicit level and routes each severity to its console method", () => {
    process.env.AGENT_LOG_LEVEL = "debug";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    logAgentEvent("debug", "debug.event");
    logAgentEvent("info", "info.event");
    logAgentEvent("warn", "warn.event");
    logAgentEvent("error", "error.event");

    expect(log).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(warn.mock.calls[0]?.[0] as string)).toMatchObject({
      level: "warn",
      event: "warn.event",
    });
    expect(JSON.parse(error.mock.calls[0]?.[0] as string)).toMatchObject({
      level: "error",
      event: "error.event",
    });
  });

  it("filters entries below the configured level and supports off", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    process.env.AGENT_LOG_LEVEL = "warn";

    logAgentEvent("debug", "debug.event");
    logAgentEvent("info", "info.event");
    logAgentEvent("warn", "warn.event");
    process.env.AGENT_LOG_LEVEL = "off";
    logAgentEvent("error", "error.event");

    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it("safely serializes errors, bigint values, and circular references", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogOptions({ format: "json", content: "full" });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const cause = new Error("database unavailable");
    const failure = Object.assign(new Error("activation failed", { cause }), {
      retryCount: 2n,
    });
    const context: Record<string, unknown> = { attempt: 3n };
    context.self = context;

    logAgentEvent("info", "runtime.activation.failed", {
      error: failure,
      context,
    });

    const entry = parseOutput(output);
    expect(entry.error).toMatchObject({
      name: "Error",
      message: "activation failed",
      retryCount: "2",
      cause: {
        name: "Error",
        message: "database unavailable",
      },
    });
    expect(entry.context).toEqual({ attempt: "3", self: "[Circular]" });
  });

  it("preserves canonical fields when caller fields use reserved names", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logAgentEvent("info", "runtime.started", {
      time: "not-a-time",
      level: "error",
      event: "not-the-event",
    });

    const entry = parseOutput(output);
    expect(entry.level).toBe("info");
    expect(entry.event).toBe("runtime.started");
    expect(entry.time).not.toBe("not-a-time");
  });

  it("lets bound context override caller fields", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createAgentLogger({
      component: "shell",
      roomId: "room-real",
    }).child({ agentId: "agent-real", agentName: "Lu" });

    logger.log("info", "execution.started", {
      component: "forged",
      roomId: "room-forged",
      agentId: "agent-forged",
      agentName: "Forged",
    });

    expect(parseOutput(output)).toMatchObject({
      component: "shell",
      roomId: "room-real",
      agentId: "agent-real",
      agentName: "Lu",
    });
  });

  it("omits message content by default", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logAgentEvent("info", "message.received", {
      ...agentLogText("messageText", "hello"),
    });

    const entry = parseOutput(output);
    expect(entry).toMatchObject({
      contentLength: 5,
      contentTruncated: false,
    });
    expect(entry).not.toHaveProperty("messageText");
  });

  it("includes full message content when explicitly configured", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogOptions({ format: "json", content: "full" });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logAgentEvent("info", "message.received", {
      ...agentLogText("messageText", "hello"),
    });

    expect(parseOutput(output)).toMatchObject({
      messageText: "hello",
      contentLength: 5,
      contentTruncated: false,
    });
  });

  it("omits content in metadata mode", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logAgentEvent("info", "reply.generated", {
      ...agentLogText("replyText", "secret reply"),
    });

    const entry = parseOutput(output);
    expect(entry).toMatchObject({
      contentLength: 12,
      contentTruncated: false,
    });
    expect(entry).not.toHaveProperty("replyText");
  });

  it.each([
    ["runner.operation.failed", "codex process exited", true],
    ["runner.operation.failed", "Runtime execution failed", true],
    [
      "runner.operation.failed",
      "Provider cancellation cleanup is unconfirmed",
      true,
    ],
    ["runner.operation.failed", "private provider stderr", false],
    ["other.failure", "codex process exited", false],
  ])(
    "only retains controlled Runner failure text: %s %s",
    (event, errorMessage, retained) => {
      process.env.AGENT_LOG_LEVEL = "info";
      const output = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      logAgentEvent("info", event, { errorMessage, stderr: "private stderr" });
      const entry = parseOutput(output);
      expect(entry.errorMessage).toBe(retained ? errorMessage : undefined);
      expect(entry).not.toHaveProperty("stderr");
    },
  );

  it("retains numeric request usage in metadata mode while filtering text", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logAgentEvent("info", "agent_runtime_measurement", {
      last_usage: { input: 10, output: 5, cache_read: 2 },
      body: "secret body",
      messages: ["secret message"],
      input: "secret input",
      output: "secret output",
    });
    const entry = parseOutput(output);
    expect(entry.last_usage).toEqual({ input: 10, output: 5, cache_read: 2 });
    expect(JSON.stringify(entry)).not.toContain("secret");
  });

  it("truncates full content at 8 KiB without splitting UTF-8", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogOptions({ format: "json", content: "full" });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const content = "\u4f60".repeat(3_000);

    logAgentEvent("info", "message.received", {
      ...agentLogText("messageText", content),
    });

    const entry = parseOutput(output);
    expect(entry.contentLength).toBe(9_000);
    expect(entry.contentTruncated).toBe(true);
    expect(
      Buffer.byteLength(entry.messageText as string, "utf8"),
    ).toBeLessThanOrEqual(8 * 1024);
    expect(entry.messageText as string).not.toContain("\ufffd");
  });

  it("never throws when fields cannot be serialized", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fields = Object.defineProperty({}, "broken", {
      enumerable: true,
      get: () => {
        throw new Error("getter failed");
      },
    });

    expect(() =>
      logAgentEvent("info", "runtime.started", fields),
    ).not.toThrow();
    expect(parseOutput(output)).toMatchObject({
      level: "info",
      event: "runtime.started",
      logError: "fields_serialization_failed",
    });
  });

  it("never throws when the console method fails", () => {
    process.env.AGENT_LOG_LEVEL = "error";
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("stderr unavailable");
    });

    expect(() => logAgentEvent("error", "runtime.failed")).not.toThrow();
  });

  it("writes agent events to private per-agent NDJSON while retaining terminal output", async () => {
    const root = temporaryDirectory();
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogOptions();
    setAgentLogDirectory(root);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    createAgentLogger({
      component: "shell",
      agentId: "agent-1",
      contextKey: "meta:agent-1",
      contextKind: "meta",
    }).log("info", "local_run.started", {
      changeToken: 7,
      runId: "local-run-1",
    });

    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0]?.[0]).toContain("local_run.started");
    await flushAgentLogs(2000);
    const agentDirectory = path.join(root, "agents", "agent-1");
    const filePath = path.join(agentDirectory, "events.ndjson");
    expect(readNdjson(filePath)).toEqual([
      expect.objectContaining({
        agentId: "agent-1",
        contextKey: "meta:agent-1",
        contextKind: "meta",
        changeToken: 7,
        runId: "local-run-1",
        event: "local_run.started",
      }),
    ]);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(agentDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("routes events without an agent identity to the system log", async () => {
    const root = temporaryDirectory();
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogDirectory(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    logAgentEvent("info", "agent_manager.started", { port: 4319 });

    await flushAgentLogs(2000);
    expect(readNdjson(path.join(root, "system", "events.ndjson"))).toEqual([
      expect.objectContaining({
        event: "agent_manager.started",
        port: 4319,
      }),
    ]);
  });

  it("does not change permissions on an existing configured root", async () => {
    const root = temporaryDirectory();
    chmodSync(root, 0o755);
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogDirectory(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    logAgentEvent("info", "agent_manager.started");

    await flushAgentLogs(2000);
    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(root, "system")).mode & 0o777).toBe(0o700);
  });

  it("hashes unsafe agent IDs before using them as directory names", async () => {
    const root = temporaryDirectory();
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogDirectory(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    createAgentLogger({ agentId: "../../outside" }).log(
      "info",
      "shell.created",
    );

    await flushAgentLogs(2000);
    const agentDirectories = readdirSync(path.join(root, "agents"));
    expect(agentDirectories).toHaveLength(1);
    expect(agentDirectories[0]).toMatch(/^agent-[a-f0-9]{16}$/);
    expect(
      readNdjson(
        path.join(root, "agents", agentDirectories[0]!, "events.ndjson"),
      )[0],
    ).toMatchObject({ agentId: "../../outside", event: "shell.created" });
    expect(existsSync(path.join(root, "outside"))).toBe(false);
  });

  it("keeps terminal logging and business execution safe when the file sink fails", async () => {
    const root = temporaryDirectory();
    const unusableRoot = path.join(root, "not-a-directory");
    writeFileSync(unusableRoot, "occupied", { mode: 0o600 });
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogDirectory(unusableRoot);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(() => logAgentEvent("info", "runtime.started")).not.toThrow();
    expect(output).toHaveBeenCalledOnce();
    expect(await flushAgentLogs(2_000)).toBe(false);
  });

  it("redacts recursive credentials and RPC error data from every sink", async () => {
    const root = temporaryDirectory();
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogOptions({ format: "json", content: "full" });
    setAgentLogDirectory(root);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = Object.assign(
      new Error("request used Bearer secret-bearer-value"),
      {
        data: { responseToken: "rpc-secret" },
        request: {
          headers: { authorization: "Bearer nested-secret" },
        },
      },
    );

    logAgentEvent("info", "codex.rpc.error", {
      apiKey: "top-level-secret",
      authorizationMs: 12,
      nested: {
        authorizationMs: "Bearer timing-secret",
        service_token: "nested-token",
        password: "nested-password",
        runnerCredentials: ["credential-one", "credential-two"],
        safe: "visible",
      },
      error,
    });

    const entry = parseOutput(output);
    expect(entry.apiKey).toBe("[Redacted]");
    expect(entry.authorizationMs).toBe(12);
    expect(entry.nested).toEqual({
      authorizationMs: "[Redacted]",
      service_token: "[Redacted]",
      password: "[Redacted]",
      runnerCredentials: "[Redacted]",
      safe: "visible",
    });
    expect(entry.error).toMatchObject({
      name: "Error",
      message: "request used Bearer [Redacted]",
      data: "[Redacted]",
      request: {
        headers: { authorization: "[Redacted]" },
      },
    });
    const serialized = JSON.stringify(entry);
    for (const secret of [
      "secret-bearer-value",
      "rpc-secret",
      "nested-secret",
      "top-level-secret",
      "timing-secret",
      "nested-token",
      "nested-password",
      "credential-one",
      "credential-two",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    await flushAgentLogs(2000);
    expect(readNdjson(path.join(root, "system", "events.ndjson"))[0]).toEqual(
      entry,
    );
  });

  it("redacts JSON and key-value credentials embedded in full error text", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogOptions({ format: "json", content: "full" });
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    logAgentEvent("error", "teamhub.request.failed", {
      error: new Error(
        'TeamHub returned {"token":"json-secret","nested":{"service_token":"nested-secret"}} password=plain-secret',
      ),
    });

    const serialized = JSON.stringify(parseOutput(output));
    expect(serialized).not.toContain("json-secret");
    expect(serialized).not.toContain("nested-secret");
    expect(serialized).not.toContain("plain-secret");
    expect(serialized).toContain("[Redacted]");
  });

  it("keeps model usage token counts while redacting token credentials", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogOptions({ format: "json" });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logAgentEvent("info", "model_queue.finished", {
      usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 9 },
      refresh_tokens: "secret-refresh",
    });

    expect(parseOutput(output)).toMatchObject({
      usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 9 },
      refresh_tokens: "[Redacted]",
    });
  });

  it("redacts bare Context credentials from free-form text", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogOptions({ format: "json", content: "full" });
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const token = `mcp_ctx_${"A".repeat(43)}`;

    logAgentEvent("error", "context.activation.failed", {
      error: new Error(`Provider returned ${token}`),
      diagnostic: `unexpected credentials ${token}`,
    });

    const serialized = JSON.stringify(parseOutput(output));
    expect(serialized).not.toContain(token);
    expect(serialized).toContain("[Redacted]");
  });

  it("redacts Playwright Extension tokens in fields and free-form text", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogOptions({ format: "json", content: "full" });
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fieldToken = "F".repeat(43);
    const jsonToken = "J".repeat(43);
    const lineToken = "L".repeat(43);

    logAgentEvent("error", "browser.connection.failed", {
      command: { action: "configure", extension_token: fieldToken },
      error: new Error(`daemon rejected {"extension_token":"${jsonToken}"}`),
      diagnostic: `pasted PLAYWRIGHT_MCP_EXTENSION_TOKEN=${lineToken}`,
    });

    const serialized = JSON.stringify(parseOutput(output));
    expect(serialized).not.toContain(fieldToken);
    expect(serialized).not.toContain(jsonToken);
    expect(serialized).not.toContain(lineToken);
    expect(serialized).toContain("[Redacted]");
  });

  it("keeps error diagnostics while omitting business payloads in metadata mode", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const failure = Object.assign(
      new Error("TeamHub unavailable token=private-token"),
      {
        code: "TEAMHUB_CALLBACK_FAILED",
        status: 502,
        data: "private error payload",
        diagnostics: "private stderr",
      },
    );

    logAgentEvent("info", "codex.rpc.response", {
      messageText: "private message",
      nested: {
        arguments: { messages: ["private Tool input"] },
        payload: { value: "private payload" },
        prompt: "private prompt",
        params: { text: "private RPC input" },
        result: { content: "private RPC output" },
        stack: "private stack",
        safeCount: 3,
      },
      error: failure,
    });

    const entry = parseOutput(output);
    expect(entry).not.toHaveProperty("messageText");
    expect(entry.nested).toEqual({ safeCount: 3 });
    expect(entry.error).toEqual({
      name: "Error",
      reason: "TeamHub unavailable token=[Redacted]",
      frames: expect.any(String),
      code: "TEAMHUB_CALLBACK_FAILED",
      status: 502,
    });
    expect(JSON.stringify(entry)).not.toContain("private");
  });

  it("retains bounded non-Error reasons without expanding response bodies", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    const output = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    logAgentEvent("warn", "runtime.first_failure", {
      error: "upstream connection closed token=private-token",
    });
    logAgentEvent("warn", "runtime.second_failure", {
      error: {
        name: "RemoteFailure",
        code: "REMOTE_FAILED",
        statusCode: 503,
        message: "upstream unavailable",
        responseBody: "private response body",
      },
    });

    expect(parseOutputAt(output, 0).error).toEqual({
      name: "NonErrorThrown",
      reason: "upstream connection closed token=[Redacted]",
    });
    expect(parseOutputAt(output, 1).error).toEqual({
      name: "RemoteFailure",
      code: "REMOTE_FAILED",
      statusCode: 503,
      reason: "upstream unavailable",
    });
    expect(JSON.stringify(output.mock.calls)).not.toContain("private");
  });

  it("preserves bounded cause and aggregate diagnostics with correlation in both sinks", async () => {
    process.env.AGENT_LOG_LEVEL = "info";
    const root = temporaryDirectory();
    setAgentLogDirectory(root);
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const cause = Object.assign(
      new Error(
        "429 Rate limit exceeded for api_key: private-key. Current limit: 2000000",
      ),
      { statusCode: 429 },
    );
    const failure = new AggregateError(
      [
        cause,
        new Error("ECONNRESET"),
        new Error("timeout"),
        new Error("omitted"),
      ],
      "provider attempts failed",
      { cause },
    );
    cause.cause = failure;
    cause.stack =
      "Error: private-stack-message\n" +
      "    at request (/app/provider.js:10:2)\n".repeat(20);
    const logger = createAgentLogger({
      agentId: "agent-1",
      contextKey: "context-1",
    });
    logger.log("error", "local_run.failed", { runId: "run-1", error: failure });
    const entry = parseOutput(output);
    expect(entry).toMatchObject({
      agentId: "agent-1",
      contextKey: "context-1",
      runId: "run-1",
      error: {
        reason: "provider attempts failed",
        errorCount: 4,
        cause: {
          reason: expect.stringContaining("Current limit: 2000000"),
          statusCode: 429,
        },
        errors: expect.arrayContaining([
          expect.objectContaining({ reason: "ECONNRESET" }),
        ]),
      },
    });
    const diagnostic = entry.error as {
      errors: unknown[];
      cause: { frames: string };
    };
    expect(diagnostic.errors).toHaveLength(4);
    expect(diagnostic.cause.frames.split("\n")).toHaveLength(8);
    expect(JSON.stringify(entry)).not.toContain("private-");
    await flushAgentLogs(2000);
    expect(
      readFileSync(
        path.join(root, "agents", "agent-1", "events.ndjson"),
        "utf8",
      ).trim(),
    ).toBe(JSON.stringify(entry));
  });

  it("bounds long error reasons and deep causes without dropping the event", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let error = new Error("deepest");
    for (let i = 0; i < 10; i++)
      error = new Error("x".repeat(2000), { cause: error });
    logAgentEvent("error", "runtime.failed", { error });
    const entry = parseOutput(output);
    const diagnostic = entry.error as {
      reason: string;
      cause: { cause: { reason: string; cause: string } };
    };
    expect(diagnostic.reason.length).toBeLessThanOrEqual(1024);
    expect(diagnostic.cause.cause.reason).toBeDefined();
    expect(diagnostic.cause.cause.cause).toBe("[Truncated]");
    expect(entry.logError).toBeUndefined();
  });

  it("redacts inline image data and bare provider credentials before truncation", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    logAgentEvent("error", "provider.failed", {
      error: new Error(
        `invalid image data:image/png;base64,${"A".repeat(10000)} credential sk-private-sentinel; status 400`,
      ),
    });
    expect(parseOutput(output).error).toMatchObject({
      reason:
        "invalid image [Redacted binary data] credential [Redacted]; status 400",
    });
  });

  it("bounds aggregate child metadata without exposing content or recursing through cycles", () => {
    process.env.AGENT_LOG_LEVEL = "info";
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const child = Object.assign(
      new Error("upstream unavailable token=private-token"),
      {
        status: 500,
        code: "INTERNAL_ERROR",
        retryable: true,
      },
    );
    const aggregate = new AggregateError(
      Array.from({ length: 12 }, () => child),
      "restore failed",
    );
    aggregate.errors[0] = aggregate;
    aggregate.errors[1] = {
      name: "RemoteFailure",
      code: "REMOTE_FAILED",
      response: "private content",
    };
    logAgentEvent("error", "manager.restore_failed_after_listen", {
      error: aggregate,
    });
    const entry = parseOutput(output);
    expect(entry.error).toMatchObject({
      name: "AggregateError",
      errorCount: 12,
      errorsTruncated: true,
    });
    const errors = (entry.error as { errors: unknown[] }).errors;
    expect(errors).toHaveLength(8);
    expect(errors[0]).toBe("[Circular]");
    expect(errors[1]).toEqual({ name: "RemoteFailure", code: "REMOTE_FAILED" });
    expect(errors[2]).toMatchObject({
      reason: "upstream unavailable token=[Redacted]",
      frames: expect.any(String),
      name: "Error",
      status: 500,
      code: "INTERNAL_ERROR",
      retryable: true,
    });
    expect(JSON.stringify(entry)).not.toContain("private");
  });

  it.each([
    "/private/customer-secret/history",
    "/Users/customer-secret/history",
    "/home/customer-secret/history",
    "C:\\Users\\customer-secret\\history",
  ])("keeps filesystem failures actionable without exposing %s", (filePath) => {
    process.env.AGENT_LOG_LEVEL = "info";
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    logAgentEvent("error", "runtime.failed", {
      error: Object.assign(new Error(`ENOENT: missing '${filePath}'`), {
        code: "ENOENT",
      }),
    });
    expect(parseOutput(output).error).toMatchObject({
      reason: "ENOENT: missing '[Redacted path]'",
      code: "ENOENT",
    });
    expect(JSON.stringify(output.mock.calls)).not.toContain("customer-secret");
  });

  it("rotates bounded per-agent log files by size", async () => {
    const root = temporaryDirectory();
    process.env.AGENT_LOG_LEVEL = "info";
    setAgentLogDirectory(root);
    setAgentLogOptions({
      format: "json",
      content: "full",
      maxFileBytes: 200,
      maxFiles: 2,
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createAgentLogger({ agentId: "agent-rotation" });

    for (let sequence = 0; sequence < 5; sequence += 1) {
      logger.log("info", "rotation.event", {
        sequence,
        payload: "x".repeat(100),
      });
    }

    await flushAgentLogs(2000);
    const directory = path.join(root, "agents", "agent-rotation");
    expect(readdirSync(directory).sort()).toEqual([
      "events.ndjson",
      "events.ndjson.1",
    ]);
    for (const file of readdirSync(directory)) {
      expect(readNdjson(path.join(directory, file))).toHaveLength(1);
    }
  });
});

const parseOutput = (output: {
  mock: { calls: unknown[][] };
}): Record<string, unknown> =>
  JSON.parse(output.mock.calls[0]?.[0] as string) as Record<string, unknown>;

const parseOutputAt = (
  output: { mock: { calls: unknown[][] } },
  index: number,
): Record<string, unknown> =>
  JSON.parse(output.mock.calls[index]?.[0] as string) as Record<
    string,
    unknown
  >;

const restoreEnvironment = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agent-log-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

const readNdjson = (filePath: string): Record<string, unknown>[] =>
  readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
