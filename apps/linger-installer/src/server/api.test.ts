vi.mock("@linger/local-installation/managed-codex", async () => ({
  ...(await vi.importActual("@linger/local-installation/managed-codex")),
  readManagedModel: async () => undefined,
}));
vi.mock("@linger/local-installation/setup-plan", () => ({
  inspectSetup: async () => ({
    hardware: {
      platform: "linux",
      arch: "x64",
      totalMemoryBytes: 1024,
      diskFreeBytes: null,
      gpus: [],
    },
    choices: ["local-models", "codex", "claude", "pi"],
    localModels: {
      eligible: false,
      reasons: ["upstream-unavailable"],
      selectedGpuIndex: null,
      estimate: {
        model: "",
        downloadBytes: null,
        diskBytes: null,
        memoryBytes: null,
        durationSeconds: null,
        assumption: "Unknown",
      },
    },
    runtimes: [],
    recommendation: "codex",
  }),
}));
import { initializeInstance } from "@linger/local-installation/instance";
import { atomicPrivate as privateWrite } from "@linger/local-installation/instance";
import { expect, test, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunInstallation } from "./jobs.js";
import { startInstallerServer } from "./server.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup(run?: RunInstallation) {
  const home = await mkdtemp(path.join(tmpdir(), "installer-api-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "web"));
  await writeFile(path.join(home, "web/index.html"), "offline");
  let calls = 0;
  const server = await startInstallerServer({
    home,
    sourceRepo: home,
    webDir: path.join(home, "web"),
    dependencies: {
      run: async (_input, _signal, emit) => {
        calls++;
        if (run) return run(_input, _signal, emit);
        emit({
          kind: "stage",
          stage: "preflight",
          state: "running",
          message: "Checking",
        });
        return {
          state: "action_required",
          code: 2,
          message: "Sign in to the runtime.",
        };
      },
    },
  });
  cleanup.push(server.close);
  const session = await fetch(server.origin + "/api/session", {
    method: "POST",
    headers: { Origin: server.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: server.bootstrapToken }),
  });
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  const api = (route: string, method = "GET", body?: unknown) =>
    fetch(server.origin + route, {
      method,
      headers: {
        Cookie: cookie,
        Origin: server.origin,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { api, home, server, calls: () => calls };
}
test("config exposes defaults and validates input before starting work", async () => {
  const { api, calls } = await setup();
  const config = await (await api("/api/config")).json();
  expect(config.instance).toBe("default");
  expect(config.email).toBe("owner@linger.local");
  expect(config).not.toHaveProperty("password");
  expect(
    (await api("/api/jobs", "POST", { instance: "../../escape" })).status,
  ).toBe(400);
  expect(
    (await api("/api/jobs", "POST", { instance: "default", password: "short" }))
      .status,
  ).toBe(400);
  expect(calls()).toBe(0);
});
test("action-required install does not claim ready and SSE replays sequenced default events", async () => {
  const { api } = await setup();
  const response = await api("/api/jobs", "POST", { instance: "default" });
  expect(response.status).toBe(202);
  const job = await response.json();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const current = await (await api("/api/jobs/" + job.id)).json();
  expect(current.state).toBe("waiting_user");
  const stream = await api("/api/jobs/" + job.id + "/events?after=0");
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  const reader = stream.body!.getReader();
  const event = new TextDecoder().decode((await reader.read()).value);
  expect(event).toContain("id:");
  expect(event).toContain("data:");
  expect(event).not.toContain("event:");
  await reader.cancel();
});
test("unknown actions and shutdown during active work are rejected", async () => {
  const { api } = await setup();
  expect(
    (await api("/api/actions/exec", "POST", { command: "touch arbitrary" }))
      .status,
  ).toBe(404);
  expect((await api("/api/instances/default/login")).status).toBe(404);
});

test("only authenticated dedicated login response exposes private account and uses no-store", async () => {
  const { api, home } = await setup();
  const instance = await initializeInstance({
    name: "default",
    computerName: "My work computer",
    home,
  });
  await privateWrite(
    path.join(instance.root, "local-account.json"),
    JSON.stringify({
      email: "owner@linger.local",
      password: "visible-on-completion-only",
      provisioned: true,
    }),
  );
  const config = await (await api("/api/config")).json();
  expect(config.accountExists).toBe(true);
  expect(config.computerName).toBe("My work computer");
  expect(config).not.toHaveProperty("password");
  const response = await api("/api/instances/default/login");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const login = await response.json();
  expect(login.email).toBe("owner@linger.local");
  expect(login.password === "visible-on-completion-only").toBe(true);
  expect(login.origin).toBe(instance.origin);
});

test("HTTP disconnect keeps job alive, duplicate clicks share the same job, shutdown is refused while running", async () => {
  let release!: () => void;
  let aborted = false;
  const { api, calls } = await setup(async (_input, signal, emit) => {
    signal.addEventListener(
      "abort",
      () => {
        aborted = true;
        release();
      },
      { once: true },
    );
    emit({
      kind: "stage",
      stage: "images",
      state: "running",
      message: "Importing images",
    });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { state: "ready", code: 0, message: "Complete" };
  });
  const first = await (
    await api("/api/jobs", "POST", { instance: "default" })
  ).json();
  const stream = await api(`/api/jobs/${first.id}/events`);
  const reader = stream.body!.getReader();
  await reader.read();
  await reader.cancel();
  const second = await (
    await api("/api/jobs", "POST", { instance: "default" })
  ).json();
  expect(second.id).toBe(first.id);
  expect(calls()).toBe(1);
  expect(aborted).toBe(false);
  expect((await api("/api/shutdown", "POST")).status).toBe(409);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await (await api(`/api/jobs/${first.id}`)).json()).state).toBe(
    "succeeded",
  );
});

test("retry accepts model authority only and retains original private job configuration", async () => {
  const received: unknown[] = [];
  const { api } = await setup(async (value) => {
    received.push(value);
    return {
      code: 4,
      state: "action_required",
      message: "Review",
      details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
    };
  });
  const original = {
    instance: "default",
    email: "owner@example.test",
    password: "private-password",
    model: {
      baseUrl: "https://model.example.test/v1",
      model: "model",
      apiKey: "private-model-key",
    },
  };
  const first = await (await api("/api/jobs", "POST", original)).json();
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (const authority of [
    { password: "replacement-secret" },
    { instance: "other" },
    { localModelsApproval: "bad" },
    { localModelsReplan: true, localModelsApproval: "a".repeat(64) },
  ])
    expect(
      (await api(`/api/jobs/${first.id}/retry`, "POST", authority)).status,
    ).toBe(400);
  const response = await api(`/api/jobs/${first.id}/retry`, "POST", {
    localModelsReplan: true,
  });
  expect(response.status).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(received[1]).toEqual({ ...original, localModelsReplan: true });
  expect(JSON.stringify(await response.json())).not.toContain(
    original.password,
  );
});

test("setup inspection is authorized, no-store, and never starts an installation", async () => {
  const { api, server, calls } = await setup();
  expect((await fetch(server.origin + "/api/setup")).status).toBe(401);
  const response = await api("/api/setup");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const report = await response.json();
  expect(report.choices).toEqual(["local-models", "codex", "claude", "pi"]);
  expect(report.hardware.totalMemoryBytes).toBeGreaterThan(0);
  expect(calls()).toBe(0);
});

test("runtime login is owner-only, no-store and rejects shell inputs", async () => {
  const { api, server } = await setup();
  const unauthorized = await fetch(
    server.origin + "/api/runtime-login?instance=default",
  );
  expect(unauthorized.status).toBe(401);
  expect(
    (
      await api("/api/runtime-login", "POST", {
        instance: "default",
        executable: "sh",
      })
    ).status,
  ).toBe(400);
  expect((await api("/api/runtime-login?instance=../bad")).status).toBe(400);
  const missing = await api("/api/runtime-login?instance=default");
  expect(missing.headers.get("cache-control")).toContain("no-store");
  expect(missing.status).toBe(200);
  expect(await missing.json()).toEqual({ state: "idle" });
  expect(
    (
      await fetch(server.origin + "/api/runtime-login?instance=default", {
        method: "DELETE",
      })
    ).status,
  ).not.toBe(200);
  expect(
    (await api("/api/runtime-login?instance=../bad", "DELETE")).status,
  ).toBe(400);
  const cancelled = await api("/api/runtime-login?instance=default", "DELETE");
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toEqual({ state: "idle" });
});
test("instance runtime is owner-only and not found without an instance", async () => {
  const { api, server } = await setup();
  expect(
    (await fetch(server.origin + "/api/instances/default/runtime")).status,
  ).toBe(401);
  const missing = await api("/api/instances/default/runtime");
  expect(missing.status).toBe(404);
  expect((await api("/api/instances/..%2Fbad/runtime")).status).toBe(400);
});
test("runtime API key input rejects mixed authorization, control characters and unknown providers", async () => {
  const { api } = await setup();
  for (const credential of [
    { apiKey: "key", provider: "unknown" },
    { apiKey: "key\nextra", provider: "openai" },
    { apiKey: "key", provider: "openai", code: "ABCD" },
    { apiKey: "key" },
  ]) {
    const response = await api("/api/runtime-login", "POST", {
      instance: "default",
      ...credential,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("key\\nextra");
  }
});

test("accepts complete compatible-model input and rejects partial or mixed fields", async () => {
  const { api } = await setup();
  const input = {
    instance: "default",
    provider: "openai-compatible",
    apiKey: "local",
    baseUrl: "http://127.0.0.1:18100/v1",
    model: "local-qwen",
  };
  const response = await api("/api/runtime-login", "POST", input);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("local-qwen");
  for (const change of [
    { model: undefined },
    { baseUrl: undefined },
    { provider: "openai" },
    { code: "ABCD" },
    { baseUrl: "http://169.254.169.254/latest" },
  ])
    expect(
      (await api("/api/runtime-login", "POST", { ...input, ...change })).status,
    ).toBe(400);
});
