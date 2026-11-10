import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { writeCliConfig } from "./test-support/cli-config.js";
import { requestBodyText, requestUrlText } from "./test-support/fetch-text.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  scope: { kind: "room" | "task"; id: string } = {
    kind: "room",
    id: "room_meta",
  },
  response: () => Response = () =>
    Response.json({
      accepted: true,
      task_id: "task_1",
      status: "running",
      duplicate_request: false,
    }),
) {
  const cwd = await mkdtemp(path.join(tmpdir(), "task-create-"));
  const configDirectory = await mkdtemp(
    path.join(tmpdir(), "task-create-config-"),
  );
  directories.push(cwd, configDirectory);
  const calls: {
    url: string;
    body: Record<string, unknown>;
    headers: Headers;
  }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    calls.push({
      url: requestUrlText(url),
      body: JSON.parse(requestBodyText(options?.body)),
      headers: new Headers(options?.headers),
    });
    return response();
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies = {
    cwd,
    env: writeCliConfig(configDirectory, { scope }),
    fetch: fetcher,
    stdout: (value: string) => {
      stdout.push(value);
    },
    stderr: (value: string) => {
      stderr.push(value);
    },
  };
  const run = (args: string[]) =>
    runCli(["task", "create", ...args], dependencies);
  return { cwd, calls, fetcher, stdout, stderr, run };
}

describe("delegated Task creation CLI", () => {
  it("creates and starts the Task in the configured Room without approval", async () => {
    const f = await fixture();
    const code = await f.run([
      "--name",
      "Write report",
      "--requirement",
      "Collect the Q3 evidence and summarize it.",
      "--operation-id",
      "create-1",
      "--json",
    ]);
    expect(code).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toMatch(/\/api\/agent\/v1\/tasks$/u);
    expect(f.calls[0]!.headers.get("x-teamhub-context-kind")).toBe("room");
    expect(f.calls[0]!.headers.get("x-teamhub-context-id")).toBe("room_meta");
    expect(f.calls[0]!.body).toEqual({
      name: "Write report",
      requirement: "Collect the Q3 evidence and summarize it.",
      invocation_id: expect.stringMatching(
        /^agent-invocation-sha256:[a-f0-9]{64}$/u,
      ),
    });
    expect(JSON.parse(f.stdout.join(""))).toMatchObject({
      task_id: "task_1",
      status: "running",
    });
  });

  it("reads a long requirement from a file and renders a text result", async () => {
    const f = await fixture();
    const brief = path.join(f.cwd, "brief.txt");
    await writeFile(brief, "Line one.\nLine two.");
    const code = await f.run([
      "--name",
      "Long brief",
      "--requirement-file",
      brief,
    ]);
    expect(code).toBe(0);
    expect(f.calls[0]!.body.requirement).toBe("Line one.\nLine two.");
    expect(f.stdout.join("")).toContain("Task created and running");
    expect(f.stdout.join("")).toContain("task_1");
  });

  it("requires exactly one requirement source before any request", async () => {
    const f = await fixture();
    expect(await f.run(["--name", "No brief"])).not.toBe(0);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("needs a Room Context and does not run in a Task Context", async () => {
    const f = await fixture({ kind: "task", id: "task_parent" });
    const code = await f.run([
      "--name",
      "Nested",
      "--requirement",
      "Should not start.",
    ]);
    expect(code).toBe(4);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.stderr.join("")).toContain("In a Task you don't");
  });

  it("reports the running Task limit from TeamHub", async () => {
    const f = await fixture(undefined, () =>
      Response.json(
        {
          error: {
            code: "task_limit_reached",
            message:
              "This Agent already has 10 running Tasks; check them, send to an idle one, or stop one first",
          },
        },
        { status: 409 },
      ),
    );
    const code = await f.run([
      "--name",
      "Eleventh",
      "--requirement",
      "One too many.",
    ]);
    expect(code).not.toBe(0);
    expect(f.stderr.join("")).toContain("10 running Tasks");
  });
});
