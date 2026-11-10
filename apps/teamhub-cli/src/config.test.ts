import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, withScope } from "./config.js";

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "teamhub-config-"));
  directories.push(directory);
  await mkdir(path.join(directory, "private"));
  await writeFile(
    path.join(directory, "private", "token"),
    "th_agent_fixture\n",
    { mode: 0o600 },
  );
  const config = path.join(directory, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      default_profile: "work",
      profiles: {
        work: {
          url: "https://teamhub.example",
          token_file: "private/token",
          scope: { kind: "room", id: "room_one" },
        },
        personal: {
          url: "https://personal.example",
          token_file: "private/token",
          scope: { kind: "task", id: "task_two" },
        },
      },
    }),
  );
  return { directory, config };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("persistent TeamHub CLI configuration", () => {
  it("loads optional Run provenance without changing the identity namespace", async () => {
    const f = await fixture();
    const original = await loadConfig({ TEAMHUB_CONFIG: f.config });
    await writeFile(
      path.join(f.directory, "run.json"),
      JSON.stringify({ run_id: "run_one" }),
    );
    const configured = await loadConfig({ TEAMHUB_CONFIG: f.config });
    expect(configured.runId).toBe("run_one");
    expect(configured.identityKey).toBe(original.identityKey);
  });
  it("loads an explicit profile with relative token file and no internal runtime", async () => {
    const f = await fixture();
    const config = await loadConfig({ TEAMHUB_CONFIG: f.config });
    expect(config).toMatchObject({
      url: "https://teamhub.example",
      token: "th_agent_fixture",
      scope: { kind: "room", id: "room_one" },
    });
    expect(
      (
        await loadConfig({
          TEAMHUB_CONFIG: f.config,
          TEAMHUB_PROFILE: "personal",
        })
      ).scope,
    ).toEqual({ kind: "task", id: "task_two" });
  });
  it("rereads a rotated credential on each CLI invocation", async () => {
    const f = await fixture();
    const first = await loadConfig({ TEAMHUB_CONFIG: f.config });
    await writeFile(
      path.join(f.directory, "private", "token"),
      "th_agent_rotated",
    );
    const second = await loadConfig({ TEAMHUB_CONFIG: f.config });
    expect(second.token).toBe("th_agent_rotated");
    expect(second.identityKey).not.toBe(first.identityKey);
  });
  it("supports direct environment configuration without an on-disk profile or caller Context", async () => {
    const config = await loadConfig({
      TEAMHUB_URL: "http://127.0.0.1:8123",
      TEAMHUB_TOKEN: "th_agent_test",
    });
    expect(config).toMatchObject({
      url: "http://127.0.0.1:8123",
      token: "th_agent_test",
    });
    expect(config).not.toHaveProperty("scope");
  });
  it.each(["agent", "agent_build"])(
    "rejects the retired %s profile scope",
    async (kind) => {
      const f = await fixture();
      const data = JSON.parse(await readFile(f.config, "utf8"));
      data.profiles.work.scope = { kind, id: "agent_one" };
      await writeFile(f.config, JSON.stringify(data));
      await expect(
        loadConfig({ TEAMHUB_CONFIG: f.config }),
      ).rejects.toMatchObject({ code: "configuration_error" });
    },
  );
  it("does not combine a URL override with another profile's credential", async () => {
    const f = await fixture();
    await expect(
      loadConfig({
        TEAMHUB_CONFIG: f.config,
        TEAMHUB_URL: "https://another.example",
      }),
    ).rejects.toMatchObject({ code: "configuration_error" });
  });
  it.each([
    "https://user:pass@example.test",
    "https://example.test/?redirect=x",
    "file:///tmp/token",
  ])("rejects unsafe service URL %s", async (url) => {
    await expect(
      loadConfig({ TEAMHUB_URL: url, TEAMHUB_TOKEN: "th_agent_test" }),
    ).rejects.toMatchObject({ code: "configuration_error" });
  });
  it("rejects incomplete scope, missing profile, invalid token and legacy host-only config", async () => {
    const f = await fixture();
    const data = JSON.parse(await readFile(f.config, "utf8"));
    data.profiles.incomplete = {
      ...data.profiles.work,
      scope: { kind: "room" },
    };
    await writeFile(f.config, JSON.stringify(data));
    for (const env of [
      { TEAMHUB_CONFIG: f.config, TEAMHUB_PROFILE: "missing" },
      { TEAMHUB_CONFIG: f.config, TEAMHUB_PROFILE: "incomplete" },
      {
        TEAMHUB_URL: "https://example.test",
        TEAMHUB_TOKEN: "secret\ninjected",
      },
      {
        TEAMHUB_HOST_URL: "http://127.0.0.1:1234",
        TEAMHUB_SESSION_TOKEN: "legacy",
      },
    ])
      await expect(loadConfig(env)).rejects.toMatchObject({
        code: "configuration_error",
      });
  });
});

it("keeps the local namespace across token rotation only for an explicit Agent identity slot", async () => {
  const f = await fixture();
  const profile = {
    url: "https://teamhub.example",
    token_file: "private/token",
    tenant_id: "tenant_one",
    agent_id: "agent_one",
    scope: { kind: "room", id: "room_one" },
  };
  const save = (value: object) =>
    writeFile(
      f.config,
      JSON.stringify({
        version: 1,
        default_profile: "work",
        profiles: { work: value },
      }),
    );
  await save(profile);
  const first = await loadConfig({ TEAMHUB_CONFIG: f.config });
  await writeFile(
    path.join(f.directory, "private", "token"),
    "th_agent_rotated",
  );
  const rotated = await loadConfig({ TEAMHUB_CONFIG: f.config });
  expect(rotated.identityKey).toBe(first.identityKey);
  expect(rotated.identity).toEqual({
    tenantId: "tenant_one",
    agentId: "agent_one",
  });
  await save({ ...profile, agent_id: "agent_two" });
  const different = await loadConfig({ TEAMHUB_CONFIG: f.config });
  expect(different.identityKey).not.toBe(first.identityKey);
  await save({ ...profile, tenant_id: undefined });
  await expect(loadConfig({ TEAMHUB_CONFIG: f.config })).rejects.toMatchObject({
    code: "configuration_error",
  });
});

it("accepts plain HTTP TeamHub URLs from the environment and profiles", async () => {
  expect(
    (
      await loadConfig({
        TEAMHUB_URL: "http://teamhub:8080",
        TEAMHUB_TOKEN: "th_agent_fixture",
      })
    ).url,
  ).toBe("http://teamhub:8080");
  const f = await fixture();
  await writeFile(
    f.config,
    JSON.stringify({
      version: 1,
      default_profile: "internal",
      profiles: {
        internal: {
          url: "http://teamhub:8080",
          token_file: "private/token",
        },
      },
    }),
  );
  expect((await loadConfig({ TEAMHUB_CONFIG: f.config })).url).toBe(
    "http://teamhub:8080",
  );
});

it("ignores TEAMHUB_CONTEXT_KIND and TEAMHUB_CONTEXT_ID in every configuration mode", async () => {
  const f = await fixture();
  const initial = await loadConfig({ TEAMHUB_CONFIG: f.config });
  for (const context of [
    { TEAMHUB_CONTEXT_KIND: "document", TEAMHUB_CONTEXT_ID: "document_one" },
    { TEAMHUB_CONTEXT_ID: "document_one" },
    { TEAMHUB_CONTEXT_KIND: "agent_build", TEAMHUB_CONTEXT_ID: "build_one" },
  ]) {
    expect(await loadConfig({ TEAMHUB_CONFIG: f.config, ...context })).toEqual(
      initial,
    );
    expect(
      await loadConfig({
        TEAMHUB_URL: "https://teamhub.example",
        TEAMHUB_TOKEN: "th_agent_test",
        ...context,
      }),
    ).not.toHaveProperty("scope");
  }
});

it("separates local recovery state per caller Context while keeping the scope-independent recovery identity", async () => {
  const f = await fixture();
  const room = await loadConfig({ TEAMHUB_CONFIG: f.config });
  const data = JSON.parse(await readFile(f.config, "utf8"));
  data.profiles.work.scope = { kind: "task", id: "task_two" };
  await writeFile(f.config, JSON.stringify(data));
  const task = await loadConfig({ TEAMHUB_CONFIG: f.config });
  expect(task.agentIdentityKey).toBe(room.agentIdentityKey);
  expect(task.identityKey).not.toBe(room.identityKey);
  expect(task.identityKey).not.toBe(task.agentIdentityKey);
  delete data.profiles.work.scope;
  await writeFile(f.config, JSON.stringify(data));
  const unscoped = await loadConfig({ TEAMHUB_CONFIG: f.config });
  expect(unscoped.agentIdentityKey).toBe(room.agentIdentityKey);
  expect(
    new Set([unscoped, room, task].map((item) => item.identityKey)).size,
  ).toBe(3);
});

it("recomputes only the scoped recovery namespace when a command sends another Context", async () => {
  const f = await fixture();
  const room = await loadConfig({ TEAMHUB_CONFIG: f.config });
  const document = withScope(room, { kind: "document", id: "document_one" });
  expect(document).toEqual({
    ...room,
    scope: { kind: "document", id: "document_one" },
    identityKey: expect.any(String),
  });
  expect(document.identityKey).not.toBe(room.identityKey);
  expect(document.agentIdentityKey).toBe(room.agentIdentityKey);
  expect(withScope(room, room.scope)).toEqual(room);
  expect(withScope(document, room.scope)).toEqual(room);
  const unscoped = withScope(room, undefined);
  expect(unscoped.scope).toBeUndefined();
  expect(unscoped.identityKey).not.toBe(room.identityKey);
  expect(
    withScope(room, { kind: "document", id: "document_two" }).identityKey,
  ).not.toBe(document.identityKey);
});

describe("run.json", () => {
  const writeRun = (directory: string, value: string) =>
    writeFile(path.join(directory, "run.json"), value);
  it("reads per-run fields only from run.json", async () => {
    const f = await fixture();
    const data = JSON.parse(await readFile(f.config, "utf8"));
    Object.assign(data.profiles[data.default_profile], {
      run_id: "profile_run",
    });
    await writeFile(f.config, JSON.stringify(data));
    expect(await loadConfig({ TEAMHUB_CONFIG: f.config })).not.toMatchObject({
      runId: expect.anything(),
    });
    await writeRun(
      f.directory,
      JSON.stringify({
        run_id: "run_one",
      }),
    );
    expect(await loadConfig({ TEAMHUB_CONFIG: f.config })).toMatchObject({
      runId: "run_one",
    });
  });
  it("leaves values undefined when run.json is absent", async () => {
    const f = await fixture();
    const config = await loadConfig({ TEAMHUB_CONFIG: f.config });
    expect(config.runId).toBeUndefined();
  });
  it.each([
    ["non-object", "[]"],
    ["malformed", "{"],
    ["invalid run_id", JSON.stringify({ run_id: "bad id" })],
    ["oversized", JSON.stringify({ pad: "x".repeat(65 * 1024) })],
  ])("rejects %s run.json", async (_name, content) => {
    const f = await fixture();
    await writeRun(f.directory, content);
    await expect(
      loadConfig({ TEAMHUB_CONFIG: f.config }),
    ).rejects.toMatchObject({ code: "configuration_error" });
  });
});
