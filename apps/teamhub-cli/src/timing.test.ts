import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createTiming } from "./timing.js";
import { loadConfig } from "./config.js";
import { createTeamHubClient, operationHeaders } from "./http-client.js";

it("measures profile and credential reads without retaining their values", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "teamhub-timing-"));
  try {
    const filename = path.join(directory, "timing.json");
    const timing = createTiming({ TEAMHUB_TIMING_FILE: filename });
    expect(timing).toBeDefined();
    await writeFile(path.join(directory, "credential"), "private-token");
    await writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({
        version: 1,
        default_profile: "private-profile",
        profiles: {
          "private-profile": {
            url: "http://localhost:1234",
            token_file: "credential",
          },
        },
      }),
    );
    await loadConfig(
      { TEAMHUB_CONFIG: path.join(directory, "config.json") },
      timing,
    );
    expect(await timing!.flush()).toBe(true);
    const content = await readFile(filename, "utf8");
    const report = JSON.parse(content);
    expect(
      report.events.map((event: { stage: string }) => event.stage),
    ).toEqual(["config_file", "credential_file"]);
    expect(content).not.toContain("private-token");
    expect(content).not.toContain("private-profile");
    expect(content).not.toContain(directory);
    expect(content).not.toContain("localhost");
    expect(createTiming({})).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("HTTP timing waits for the complete body and correlates the backend request", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "teamhub-timing-http-"));
  try {
    const filename = path.join(directory, "timing.json");
    let clock = 0;
    const timing = createTiming(
      { TEAMHUB_TIMING_FILE: filename },
      () => clock,
    )!;
    let bodyController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    const client = createTeamHubClient(
      {
        url: "http://localhost:1234",
        token: "private-token",
        identityKey: "fixture",
      },
      {
        timing,
        fetch: async (_url, options) => {
          expect(new Headers(options?.headers).get("x-request-id")).toMatch(
            /^[a-z0-9-]+$/u,
          );
          clock = 7;
          return new Response(body, {
            headers: { "X-Request-ID": "request-fixture" },
          });
        },
      },
    );
    const response = await client.request("/api/agent/v1/files");
    const reading = response.text();
    clock = 19;
    bodyController!.enqueue(new TextEncoder().encode("private payload"));
    bodyController!.close();
    expect(await reading).toBe("private payload");
    expect(await timing.flush()).toBe(true);
    const content = await readFile(filename, "utf8");
    const report = JSON.parse(content);
    expect(report.events).toEqual([
      expect.objectContaining({
        stage: "http_headers",
        duration_ms: 7,
        request_id: "request-fixture",
      }),
      expect.objectContaining({
        stage: "http",
        duration_ms: 19,
        request_id: "request-fixture",
        outcome: "success",
        http_status: 200,
      }),
    ]);
    expect(content).not.toContain("private-token");
    expect(content).not.toContain("private payload");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("timing output cannot replace an existing file and never changes a known HTTP failure", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "teamhub-timing-failed-"),
  );
  try {
    const filename = path.join(directory, "occupied");
    await writeFile(filename, "preserve");
    const timing = createTiming({ TEAMHUB_TIMING_FILE: filename })!;
    const client = createTeamHubClient(
      { url: "http://localhost", token: "private", identityKey: "fixture" },
      {
        timing,
        fetch: async () =>
          Response.json(
            { error: { code: "forbidden", message: "No" } },
            { status: 403 },
          ),
      },
    );
    await expect(
      client.api.POST("/api/agent/v1/direct-messages", { body: {} as never }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await timing.flush()).toBe(false);
    expect(await readFile(filename, "utf8")).toBe("preserve");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("records transport failure and canceled body without exposing the upstream exception", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "teamhub-timing-transfer-"),
  );
  try {
    const filename = path.join(directory, "timing.json");
    const timing = createTiming({ TEAMHUB_TIMING_FILE: filename })!;
    const config = {
      url: "http://localhost",
      token: "private-token",
      identityKey: "fixture",
    };
    const failed = createTeamHubClient(config, {
      timing,
      fetch: async () => {
        throw new Error("private upstream credentials");
      },
    });
    await expect(
      failed.api.POST("/api/agent/v1/direct-messages", {
        body: {} as never,
        headers: operationHeaders("fixture-operation"),
      }),
    ).rejects.toMatchObject({
      code: "outcome_unknown",
      details: { operation_id: "fixture-operation" },
    });
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const client = createTeamHubClient(config, {
      timing,
      fetch: async () => new Response(body),
    });
    const response = await client.request("/api/agent/v1/files");
    await response.body!.cancel();
    expect(canceled).toBe(true);
    expect(await timing.flush()).toBe(true);
    const content = await readFile(filename, "utf8");
    expect(
      JSON.parse(content)
        .events.filter((event: { stage: string }) => event.stage === "http")
        .map((event: { outcome: string }) => event.outcome),
    ).toEqual(["failure", "canceled"]);
    expect(content).not.toContain("private-token");
    expect(content).not.toContain("private upstream credentials");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
