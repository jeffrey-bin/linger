import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { displayText } from "./display-text.js";
import { requestUrlText } from "./test-support/fetch-text.js";

type Json = Record<string, unknown>;

function entry(id: string, state: string, relaunch = false): Json {
  return { id, state, prompt: "available", relaunch_required: relaunch };
}
function status(screen: string, accessibility = "granted"): Json {
  return {
    platform: "darwin",
    host: "desktop",
    subjects: [
      {
        subject: "linger",
        permissions: [
          entry("screen_recording", screen),
          entry("accessibility", accessibility),
        ],
      },
      {
        subject: "computer_use",
        permissions: [
          entry("screen_recording", "denied"),
          entry("accessibility", "not_determined"),
        ],
      },
    ],
  };
}
const requested = {
  status: "permission_requested",
  computer_id: "computer_one",
  permissions: status("not_determined"),
  room_id: "room_one",
  message_id: "message_card",
  interaction_id: "interaction_one",
};

function fixture(responses: readonly Json[]) {
  const calls: { url: string; body: Json }[] = [];
  const output: string[] = [],
    errors: string[] = [];
  let index = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    calls.push({
      url: requestUrlText(url),
      body: JSON.parse(displayText(init?.body ?? "{}")),
    });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return Response.json(response);
  });
  const deps = {
    cwd: process.cwd(),
    env: {
      TEAMHUB_URL: "https://teamhub.example",
      TEAMHUB_TOKEN: "th_agent_fixture",
    },
    fetch: fetcher,
    stdout: (s: string) => void output.push(s),
    stderr: (s: string) => void errors.push(s),
  };
  return { calls, output, errors, deps };
}
const statusURL =
  "https://teamhub.example/api/agent/v1/computer/permissions/status";
const requestURL =
  "https://teamhub.example/api/agent/v1/computer/permissions/request";

afterEach(() => {
  vi.useRealTimers();
});

describe("computer permissions status", () => {
  it("renders every subject and permission state", async () => {
    const f = fixture([
      { computer_id: "computer_one", permissions: status("denied") },
    ]);
    expect(await runCli(["computer", "permissions", "status"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ url: statusURL, body: {} }]);
    const text = f.output.join("");
    expect(text).toContain("Computer computer_one (darwin, desktop):");
    expect(text).toContain(
      "Linger: screen_recording denied, accessibility granted",
    );
    expect(text).toContain(
      "Computer use (CuaDriver): screen_recording denied, accessibility not_determined",
    );
  });

  it("says a non-Mac needs no permissions", async () => {
    const f = fixture([
      {
        computer_id: "computer_one",
        permissions: { platform: "linux", host: "standalone", subjects: [] },
      },
    ]);
    expect(await runCli(["computer", "permissions", "status"], f.deps)).toBe(0);
    expect(f.output.join("")).toContain("not a Mac");
  });
});

describe("computer permissions request", () => {
  it("defaults to the Linger subject and tells the Agent to end its turn", async () => {
    const f = fixture([requested]);
    expect(
      await runCli(
        [
          "computer",
          "permissions",
          "request",
          "--permissions",
          "screen_recording",
          "--reason",
          "Take a screenshot of the report",
        ],
        f.deps,
      ),
    ).toBe(0);
    expect(f.calls).toEqual([
      {
        url: requestURL,
        body: {
          subject: "linger",
          permissions: ["screen_recording"],
          reason: "Take a screenshot of the report",
        },
      },
    ]);
    const text = f.output.join("");
    expect(text).toContain("Permission card posted (message_card)");
    expect(text).toContain("End your turn now");
  });

  it("maps --for computer-use and renders ready as continue", async () => {
    const f = fixture([
      {
        status: "ready",
        computer_id: "computer_one",
        permissions: status("granted"),
      },
    ]);
    expect(
      await runCli(
        [
          "computer",
          "permissions",
          "request",
          "--permissions",
          "accessibility,screen_recording",
          "--for",
          "computer-use",
        ],
        f.deps,
      ),
    ).toBe(0);
    expect(f.calls[0]!.body).toEqual({
      subject: "computer_use",
      permissions: ["accessibility", "screen_recording"],
    });
    expect(f.output.join("")).toContain("Continue your work.");
  });

  it.each([
    [[]],
    [["--permissions", "camera"]],
    [["--permissions", "accessibility,accessibility"]],
    [["--permissions", "accessibility", "--for", "browser"]],
    [["--permissions", "accessibility", "--wait", "0"]],
    [["--permissions", "accessibility", "--wait", "121"]],
    [["--permissions", "accessibility", "--wait", "1.5"]],
    [["--permissions", "accessibility", "--reason", " "]],
    [["--permissions", "accessibility", "--reason", "x".repeat(201)]],
  ])("rejects invalid flags %j before any request", async (flags) => {
    const f = fixture([requested]);
    expect(
      await runCli(["computer", "permissions", "request", ...flags], f.deps),
    ).not.toBe(0);
    expect(f.calls).toEqual([]);
  });

  it("with --wait polls status every 2 seconds until the subject is granted", async () => {
    vi.useFakeTimers();
    const f = fixture([
      requested,
      { computer_id: "computer_one", permissions: status("denied") },
      { computer_id: "computer_one", permissions: status("granted") },
    ]);
    const run = runCli(
      [
        "computer",
        "permissions",
        "request",
        "--permissions",
        "screen_recording",
        "--wait",
        "30",
        "--json",
      ],
      f.deps,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.calls.map((call) => call.url)).toEqual([requestURL, statusURL]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await run).toBe(0);
    expect(f.calls.map((call) => call.url)).toEqual([
      requestURL,
      statusURL,
      statusURL,
    ]);
    expect(JSON.parse(f.output.join(""))).toMatchObject({
      status: "granted",
      message_id: "message_card",
      permissions: status("granted"),
    });
  });

  it("with --wait returns the requested result when time runs out", async () => {
    vi.useFakeTimers();
    const f = fixture([
      requested,
      { computer_id: "computer_one", permissions: status("denied") },
    ]);
    const run = runCli(
      [
        "computer",
        "permissions",
        "request",
        "--permissions",
        "screen_recording",
        "--wait",
        "3",
      ],
      f.deps,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await run).toBe(0);
    expect(f.calls.map((call) => call.url)).toEqual([
      requestURL,
      statusURL,
      statusURL,
    ]);
    expect(f.output.join("")).toContain("End your turn now");
  });

  it("does not poll when the request is already ready", async () => {
    const f = fixture([
      {
        status: "ready",
        computer_id: "computer_one",
        permissions: status("granted"),
      },
    ]);
    expect(
      await runCli(
        [
          "computer",
          "permissions",
          "request",
          "--permissions",
          "screen_recording",
          "--wait",
          "10",
        ],
        f.deps,
      ),
    ).toBe(0);
    expect(f.calls).toHaveLength(1);
  });
});
