import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  initializeInstance,
  privateDirectory,
  atomicPrivate,
} from "./instance.js";
import { prepareModelGateway, stopModelGateway } from "./model-gateway.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "linger-gateway-"));
  roots.push(home);
  const instance = await initializeInstance({
    home,
    name: "default",
    releaseDir: "/release",
  });
  const root = path.join(instance.root, "model-gateway");
  await privateDirectory(root);
  await atomicPrivate(
    path.join(root, "caller.key"),
    "private-gateway-key-0123456789",
  );
  const binding = {
    schema: "localmodels.gateway/v1",
    baseUrl: "http://127.0.0.1:43210/v1",
    containerBaseUrl: "http://host.docker.internal:43210/v1",
    apiKeyFile: path.join(root, "caller.key"),
    runtime: "codex",
    ready: true,
    authenticated: false,
    models: [],
  };
  const run = vi.fn<typeof import("./localmodels-tool.js").runLocalmodels>(
    async () => ({
      code: 0,
      stdout: JSON.stringify(binding),
      stderr: "",
    }),
  );
  return {
    home,
    instance,
    root,
    binding,
    run,
    signal: new AbortController().signal,
  };
}
async function localController(f: Awaited<ReturnType<typeof fixture>>) {
  const root = path.join(f.home, "runtime/model-services");
  await privateDirectory(root);
  const binding = {
    schema: "localmodels.service-controller-binding/v1",
    baseUrl: "http://127.0.0.1:43211",
    keyFile: path.join(root, "control.key"),
    bridgeRoot: path.join(root, "bridge"),
  };
  await atomicPrivate(
    binding.keyFile,
    JSON.stringify("private-control-key-0123456789"),
  );
  await atomicPrivate(
    path.join(f.instance.root, "model-services.json"),
    JSON.stringify(binding),
  );
  return binding;
}
/** What an earlier release left: an owned gateway and its descriptor. */
async function earlierGateway(f: Awaited<ReturnType<typeof fixture>>) {
  await atomicPrivate(
    path.join(f.root, "gateway.json"),
    JSON.stringify({ desiredState: "running" }),
  );
  await atomicPrivate(
    path.join(f.instance.root, "model-gateway.json"),
    JSON.stringify(f.binding),
  );
}
const exists = (file: string) =>
  readFile(file).then(
    () => true,
    () => false,
  );

it.each(["codex", "claude", "pi"] as const)(
  "prepares no gateway for %s on its own sign-in",
  async (runtime) => {
    const f = await fixture();
    await prepareModelGateway(
      f.instance,
      runtime,
      { home: f.home, signal: f.signal },
      { run: f.run },
    );
    await prepareModelGateway(
      f.instance,
      { runtime, modelSource: "runtime" },
      { home: f.home, signal: f.signal },
      { run: f.run },
    );
    expect(f.run).not.toHaveBeenCalled();
    expect(await exists(path.join(f.instance.root, "model-gateway.json"))).toBe(
      false,
    );
  },
);

it.each(["pi", "codex", "claude"] as const)(
  "binds the local stack gateway for local models served by %s",
  async (runtime) => {
    const f = await fixture();
    const controller = await localController(f);
    await prepareModelGateway(
      f.instance,
      { runtime, modelSource: "local" },
      { home: f.home, signal: f.signal },
      { run: f.run },
    );
    expect(f.run).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        await readFile(
          path.join(f.instance.root, "model-gateway.json"),
          "utf8",
        ),
      ),
    ).toEqual(controller);
  },
);

it("reads the stored local-models choice as the local source served by Pi", async () => {
  const { setupSelection } = await import("./setup-plan.js");
  expect(setupSelection("local-models")).toEqual({
    runtime: "pi",
    modelSource: "local",
  });
  expect(setupSelection("codex")).toEqual({
    runtime: "codex",
    modelSource: "runtime",
  });
});

it.each(["codex", "claude", "pi"] as const)(
  "stops the gateway an earlier release started for %s and keeps its data",
  async (runtime) => {
    const f = await fixture();
    await earlierGateway(f);
    const events: string[] = [];
    await prepareModelGateway(
      f.instance,
      runtime,
      {
        home: f.home,
        signal: f.signal,
        onEvent: (event) => events.push(event.message),
      },
      { run: f.run },
    );
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledWith(
      f.home,
      ["gateway", "stop", "--root", f.root, "--json"],
      expect.objectContaining({ signal: f.signal }),
    );
    expect(f.run.mock.calls[0]![1]).not.toContain("ensure");
    expect(events.join("\n")).toContain("earlier installation");
    expect(await exists(path.join(f.instance.root, "model-gateway.json"))).toBe(
      false,
    );
    expect(await exists(path.join(f.root, "caller.key"))).toBe(true);
    expect(await exists(path.join(f.root, "gateway.json"))).toBe(true);
  },
);

it("continues setup when the earlier gateway cannot be stopped and logs why", async () => {
  const f = await fixture();
  await earlierGateway(f);
  f.run.mockResolvedValueOnce({
    code: 1,
    stdout: JSON.stringify({
      schema: "localmodels.gateway-error/v1",
      code: "GATEWAY_ACTION_FAILED",
      message: "Gateway process is owned by another user.",
    }),
    stderr: "Authorization: Bearer private-header-value",
  });
  const events: string[] = [];
  await prepareModelGateway(
    f.instance,
    "claude",
    {
      home: f.home,
      signal: f.signal,
      onEvent: (event) => events.push(event.message),
    },
    { run: f.run },
  );
  const log = events.join("\n");
  expect(log).toContain(
    "could not be stopped: The owned model gateway could not be stopped: Gateway process is owned by another user.",
  );
  expect(log).not.toContain("private-header-value");
  expect(await exists(path.join(f.instance.root, "model-gateway.json"))).toBe(
    false,
  );
});

it("moves an upgraded instance from an earlier gateway to local models", async () => {
  const f = await fixture();
  await earlierGateway(f);
  const controller = await localController(f);
  await prepareModelGateway(
    f.instance,
    "local-models",
    { home: f.home, signal: f.signal },
    { run: f.run },
  );
  expect(f.run).not.toHaveBeenCalled();
  expect(
    JSON.parse(
      await readFile(path.join(f.instance.root, "model-gateway.json"), "utf8"),
    ),
  ).toEqual(controller);
  // The local stack owns its controller; stop only touches the old gateway.
  await stopModelGateway(f.instance, f.signal, { run: f.run });
  expect(f.run.mock.calls.at(-1)?.[1]).toEqual([
    "gateway",
    "stop",
    "--root",
    f.root,
    "--json",
  ]);
});

it("stops nothing when no owned gateway was recorded", async () => {
  const f = await fixture();
  await localController(f);
  await prepareModelGateway(
    f.instance,
    "local-models",
    { home: f.home, signal: f.signal },
    { run: f.run },
  );
  await stopModelGateway(f.instance, f.signal, { run: f.run });
  expect(f.run).not.toHaveBeenCalled();
});

it("refuses local application binding without a verified controller descriptor", async () => {
  const f = await fixture();
  await expect(
    prepareModelGateway(
      f.instance,
      "local-models",
      { home: f.home, signal: f.signal },
      { run: f.run },
    ),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});

it("rejects changed local bridge endpoints and control credentials before application startup", async () => {
  const f = await fixture();
  const original = await localController(f);
  for (const value of [
    { ...original, keyFile: "/outside/control.key" },
    { ...original, bridgeRoot: "/outside/bridge" },
    { ...original, baseUrl: "http://foreign.example:43211" },
  ]) {
    await atomicPrivate(
      path.join(f.instance.root, "model-services.json"),
      JSON.stringify(value),
    );
    await expect(
      prepareModelGateway(
        f.instance,
        "local-models",
        { home: f.home, signal: f.signal },
        { run: f.run },
      ),
    ).rejects.toThrow();
  }
  await atomicPrivate(
    path.join(f.instance.root, "model-services.json"),
    JSON.stringify(original),
  );
  await atomicPrivate(
    original.keyFile,
    JSON.stringify("invalid secret with spaces"),
  );
  await expect(
    prepareModelGateway(
      f.instance,
      "local-models",
      { home: f.home, signal: f.signal },
      { run: f.run },
    ),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
