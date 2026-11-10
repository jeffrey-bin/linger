import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { prepareFoundationServices } from "./foundation-services.js";
import type { Instance } from "./instance.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "foundation-install-"));
  roots.push(home);
  const root = path.join(home, "instances/default");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return { home, instance: { root } as Instance };
}

test("installation schedules only the controller and returns before downloads", async () => {
  const { home, instance } = await fixture();
  const control = path.join(home, "runtime/model-services");
  await mkdir(control, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(control, "control.key"),
    JSON.stringify("private-control-key"),
    { mode: 0o600 },
  );
  const run = vi.fn(async (_home: string, args: string[]) => {
    expect(args.slice(0, 2)).toEqual(["foundations", "ensure"]);
    expect(args).not.toContain("apply");
    return {
      code: 0,
      stdout: JSON.stringify({
        schema: "localmodels.service-controller-binding/v1",
        baseUrl: "http://127.0.0.1:18300",
        keyFile: path.join(control, "control.key"),
        bridgeRoot: path.join(control, "bridge"),
      }),
      stderr: "",
    };
  });
  await prepareFoundationServices(
    instance,
    "codex",
    {
      home,
      signal: new AbortController().signal,
    },
    { run },
  );
  expect(run).toHaveBeenCalledTimes(1);
  expect(
    await readFile(path.join(instance.root, "model-services.json"), "utf8"),
  ).not.toContain("private-control-key");
});

test("controller bootstrap failure does not fail application initialization or expose native errors", async () => {
  const { home, instance } = await fixture();
  const onEvent = vi.fn();
  await expect(
    prepareFoundationServices(
      instance,
      "claude",
      { home, signal: new AbortController().signal, onEvent },
      {
        run: vi.fn(async () => {
          throw new Error("secret-token private native diagnostics");
        }),
      },
    ),
  ).resolves.toBeUndefined();
  expect(JSON.stringify(onEvent.mock.calls)).not.toContain("secret-token");
});

test("local main model readiness is distinct from the background controller", async () => {
  const { home, instance } = await fixture();
  const run = vi.fn(async (_home: string, args: string[]) => {
    expect(args).toContain("--main-plan");
    expect(args).toContain(path.join(home, "runtime/localmodels/plan.json"));
    return { code: 2, stdout: "", stderr: "private" };
  });
  await prepareFoundationServices(
    instance,
    "local-models",
    { home, signal: new AbortController().signal },
    { run },
  );
  expect(run).toHaveBeenCalledTimes(1);
});

test("the background controller shares GPUs unless sharing was declined", async () => {
  const { home, instance } = await fixture();
  const run = vi.fn<
    (
      home: string,
      args: string[],
    ) => Promise<{ code: number; stdout: string; stderr: string }>
  >(async () => ({
    code: 1,
    stdout: "",
    stderr: "",
  }));
  await prepareFoundationServices(
    instance,
    "pi",
    { home, signal: new AbortController().signal },
    { run },
  );
  expect(run.mock.calls[0]?.[1]).toContain("--share-gpu");
  await prepareFoundationServices(
    instance,
    "pi",
    {
      home,
      shareGpu: false,
      signal: new AbortController().signal,
    },
    { run },
  );
  expect(run.mock.calls[1]?.[1]).not.toContain("--share-gpu");
  await prepareFoundationServices(
    instance,
    "pi",
    { home, signal: new AbortController().signal },
    { run },
  );
  expect(run.mock.calls[2]?.[1]).not.toContain("--share-gpu");
});
