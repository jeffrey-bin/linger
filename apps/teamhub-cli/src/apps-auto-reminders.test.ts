import { describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";

function fixture(response: Record<string, unknown>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const output: string[] = [],
    errors: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    calls.push({
      url: url as string,
      body: JSON.parse((init?.body as string | undefined) ?? "{}"),
    });
    return Response.json(response);
  });
  const deps = {
    cwd: process.cwd(),
    env: {
      TEAMHUB_URL: "https://teamhub.example",
      TEAMHUB_TOKEN: "th_agent_fixture",
      TEAMHUB_CONTEXT_KIND: "room",
      TEAMHUB_CONTEXT_ID: "room_one",
    },
    fetch: fetcher,
    stdout: (s: string) => void output.push(s),
    stderr: (s: string) => void errors.push(s),
  };
  return { calls, output, errors, deps };
}
const gmail = {
  connection_id: "connection_gmail",
  app_key: "gmail",
  identity_label: "bob@example.com",
  status: "active",
  enabled: true,
};

describe("apps auto-reminders", () => {
  it("lists the Sponsor's switchable connections", async () => {
    const f = fixture({ connections: [gmail] });
    expect(await runCli(["apps", "auto-reminders", "list"], f.deps)).toBe(0);
    expect(f.calls).toEqual([
      {
        url: "https://teamhub.example/api/agent/v1/apps/auto-reminders/list",
        body: {},
      },
    ]);
    expect(f.output.join("")).toContain(
      "connection_gmail  gmail  bob@example.com  auto reminders on",
    );
  });

  it("turns one connection off", async () => {
    const f = fixture({ ...gmail, enabled: false });
    expect(
      await runCli(
        [
          "apps",
          "auto-reminders",
          "set",
          "connection_gmail",
          "--off",
          "--json",
        ],
        f.deps,
      ),
    ).toBe(0);
    expect(f.calls).toEqual([
      {
        url: "https://teamhub.example/api/agent/v1/apps/auto-reminders/set",
        body: { connection_id: "connection_gmail", enabled: false },
      },
    ]);
    expect(JSON.parse(f.output.join(""))).toMatchObject({ enabled: false });
  });

  it("requires exactly one of --on or --off", async () => {
    for (const flags of [[], ["--on", "--off"]]) {
      const f = fixture(gmail);
      expect(
        await runCli(
          ["apps", "auto-reminders", "set", "connection_gmail", ...flags],
          f.deps,
        ),
      ).not.toBe(0);
      expect(f.calls).toEqual([]);
    }
  });
});
