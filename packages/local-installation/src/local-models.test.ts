import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { prepareLocalModels, localModelsEnvironment } from "./local-models.js";
import { runProcess } from "./process.js";
import { runLocalmodels } from "./localmodels-tool.js";
import type { Instance } from "./instance.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "model-delegation-"));
  roots.push(home);
  const root = path.join(home, "instances/test");
  await mkdir(root, { recursive: true });
  const id = "a".repeat(64);
  const summary = {
    planId: id,
    gpuIndex: 2,
    gpuName: "upstream GPU",
    llm: "upstream-selected",
    contextWindow: 131072,
    downloadBytes: 100,
    diskBytes: 200,
    memoryBytes: 300,
    components: ["upstream-selected", "Pi"],
    warnings: ["upstream license warning"],
  };
  const binding = {
    schema: "localmodels.stack-binding/v1",
    ready: true,
    planId: id,
    pi: {
      executable: "/upstream/pi",
      environment: { PI_CODING_AGENT_DIR: "/upstream/profile" },
      configFingerprint: "b".repeat(64),
    },
    reasons: [],
  };
  const call = vi.fn<typeof runLocalmodels>(async (_home, args) => {
    if (args[0] === "stack" && args[1] === "plan") {
      await writeFile(
        args[args.indexOf("--out") + 1]!,
        JSON.stringify({ schema: "localmodels.stack-plan/v1", plan_id: id }),
        { mode: 0o600 },
      );
      return { code: 0, stdout: "{}", stderr: "" };
    }
    if (args[0] === "setup" && args[1] === "review")
      return {
        code: 0,
        stdout: JSON.stringify({
          schema: "localmodels.stack-review/v1",
          ...summary,
        }),
        stderr: "",
      };
    if (args[0] === "setup" && args[1] === "binding")
      return { code: 0, stdout: JSON.stringify(binding), stderr: "" };
    return { code: 0, stdout: "private token=never-public", stderr: "" };
  });
  return {
    home,
    instance: { root } as Instance,
    id,
    summary,
    binding,
    call,
    options: { signal: new AbortController().signal, onEvent: vi.fn() },
  };
}
test("delegates planning and review without pinning a model, decision or GPU", async () => {
  const f = await fixture();
  const result = await prepareLocalModels(f.instance, f.options, {
    localmodels: f.call,
  });
  expect(result).toMatchObject({
    code: 4,
    details: {
      code: "LOCAL_MODELS_APPROVAL_REQUIRED",
      localModelsPlan: f.summary,
    },
  });
  const plan = f.call.mock.calls.find((c) => c[1][1] === "plan")![1];
  expect(plan[plan.indexOf("--base-dir") + 1]).toBe(
    path.join(f.home, "runtime/localmodels/models"),
  );
  expect(plan).not.toContain("--llm");
  expect(
    plan.slice(plan.indexOf("--decision"), plan.indexOf("--decision") + 2),
  ).toEqual(["--decision", "none"]);
  expect(plan).not.toContain("--gpu");
  expect(f.call.mock.calls.some((c) => c[1][1] === "apply")).toBe(false);
  expect(
    (await stat(path.join(f.home, "runtime/localmodels/plan.json"))).mode &
      0o077,
  ).toBe(0);
});
test("a wrong confirmation never applies or replans a saved plan", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  f.call.mockClear();
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: "c".repeat(64) },
    { localmodels: f.call },
  );
  expect(
    f.call.mock.calls.some((c) => ["plan", "apply"].includes(c[1][1]!)),
  ).toBe(false);
});
test("applies exactly the approved saved plan and binds only the upstream verified descriptor", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  f.call.mockClear();
  expect(
    await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsApproval: f.id },
      { localmodels: f.call },
    ),
  ).toBeUndefined();
  expect(f.call.mock.calls.find((c) => c[1][1] === "apply")![1]).toEqual([
    "stack",
    "apply",
    path.join(f.home, "runtime/localmodels/plan.json"),
    "--approve",
    f.id,
    "--jsonl",
  ]);
  expect(
    JSON.parse(
      await readFile(
        path.join(f.home, "runtime/localmodels/binding.json"),
        "utf8",
      ),
    ),
  ).toEqual(f.binding);
});
test("never records a successful binding when apply fails", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) =>
    a[1][1] === "apply"
      ? { code: 2, stdout: "private", stderr: "" }
      : original(...a),
  );
  expect(
    await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsApproval: f.id },
      { localmodels: f.call },
    ),
  ).toMatchObject({ code: 4, state: "action_required" });
  await expect(
    stat(path.join(f.home, "runtime/localmodels/binding.json")),
  ).rejects.toThrow();
});
test("forwards actual split JSONL byte counters but never raw output", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) => {
    if (a[1][1] === "apply") {
      a[2]?.onOutput?.(
        'private token=hidden\n{"event":"progress","component":"llm","phase":"download","done":4,',
      );
      a[2]?.onOutput?.('"total":10}\n');
    }
    return original(...a);
  });
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  expect(f.options.onEvent.mock.calls.flat()).toContainEqual(
    expect.objectContaining({
      progress: { completed: 4, total: 10, unit: "bytes" },
    }),
  );
  expect(JSON.stringify(f.options.onEvent.mock.calls)).not.toContain("hidden");
});
test("replanning requires a separate review and never silently approves", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  f.call.mockClear();
  expect(
    await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsReplan: true, localModelsApproval: f.id },
      { localmodels: f.call },
    ),
  ).toMatchObject({ code: 4 });
  expect(f.call).not.toHaveBeenCalled();
  expect(
    await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsReplan: true },
      { localmodels: f.call },
    ),
  ).toMatchObject({ details: { code: "LOCAL_MODELS_APPROVAL_REQUIRED" } });
  expect(f.call.mock.calls.some((c) => c[1][1] === "apply")).toBe(false);
});
test("saved binding needs fresh upstream health before reuse", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  f.binding.ready = false;
  f.binding.pi = null as never;
  expect(
    await prepareLocalModels(f.instance, f.options, { localmodels: f.call }),
  ).toMatchObject({ details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" } });
});
test("cancellation propagates without pretending to finish", async () => {
  const f = await fixture();
  const c = new AbortController();
  c.abort();
  await expect(
    prepareLocalModels(
      f.instance,
      { ...f.options, signal: c.signal },
      { localmodels: f.call },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(f.call).not.toHaveBeenCalled();
});
test("Computer environment consumes the authoritative binding without parsing Pi formats", async () => {
  const f = await fixture();
  const { writeSetupChoice } = await import("./setup-selection.js");
  await writeSetupChoice(f.instance, "local-models");
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  expect(await localModelsEnvironment(f.instance)).toEqual({
    LINGER_PI_PATH: "/upstream/pi",
    PI_CODING_AGENT_DIR: "/upstream/profile",
    LINGER_LOCAL_MODELS_REVISION: "b".repeat(64),
  });
});

test("streams more than the process capture limit during an approved stack apply", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...args) => {
    if (args[1][1] !== "apply") return original(...args);
    const record =
      JSON.stringify({
        event: "progress",
        component: "llm",
        phase: "download",
        done: 1,
        total: 2,
      }) + "\n";
    const final =
      JSON.stringify({
        event: "progress",
        component: "llm",
        phase: "download",
        done: 2,
        total: 2,
      }) + "\n";
    return runProcess(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(record)}.repeat(30000));process.stdout.write(${JSON.stringify(final)});`,
      ],
      args[2],
    );
  });
  expect(
    await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsApproval: f.id },
      { localmodels: f.call },
    ),
  ).toBeUndefined();
  expect(f.options.onEvent.mock.calls.flat()).toContainEqual(
    expect.objectContaining({
      progress: { completed: 2, total: 2, unit: "bytes" },
    }),
  );
  expect(
    f.call.mock.calls.find((call) => call[1][1] === "apply")?.[2]?.capture,
  ).toBe(false);
});

test("creates the shared private model root before the main model executor can populate it", async () => {
  const f = await fixture();
  const invoke = vi.fn<typeof runLocalmodels>(async (home, args, options) => {
    const root = path.join(f.home, "runtime/localmodels/models");
    expect((await stat(root)).mode & 0o077).toBe(0);
    return f.call(home, args, options);
  });
  await prepareLocalModels(f.instance, f.options, { localmodels: invoke });
  expect(invoke).toHaveBeenCalled();
});

test("a new main-model plan reserves no decision model", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  const args = f.call.mock.calls.find((call) => call[1][1] === "plan")![1];
  expect(
    args.slice(args.indexOf("--decision"), args.indexOf("--decision") + 2),
  ).toEqual(["--decision", "none"]);
});

test("explicit shared-GPU consent is persisted and bound into the saved main plan command", async () => {
  const f = await fixture();
  await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: true },
    { localmodels: f.call },
  );
  const args = f.call.mock.calls.find((call) => call[1][1] === "plan")![1];
  expect(args).toContain("--share-gpu");
  expect(
    JSON.parse(
      await readFile(path.join(f.instance.root, "gpu-sharing.json"), "utf8"),
    ),
  ).toBe(true);
});

test("changed resource consent cannot approve an earlier saved plan", async () => {
  const f = await fixture();
  await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: true },
    { localmodels: f.call },
  );
  f.call.mockClear();
  const result = await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: false, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  expect(result).toMatchObject({
    state: "action_required",
    details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
  });
  expect(
    f.call.mock.calls.some(
      ([, args]) => args[0] === "stack" && ["plan", "apply"].includes(args[1]!),
    ),
  ).toBe(false);
});

test.each(["missing", "damaged", "different-plan"])(
  "%s plan input binding cannot authorize apply",
  async (state) => {
    const f = await fixture();
    await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
    const file = path.join(f.home, "runtime/localmodels/plan-inputs.json");
    if (state === "missing") await rm(file);
    else
      await writeFile(
        file,
        state === "damaged"
          ? "not-json"
          : JSON.stringify({
              planId: "c".repeat(64),
              shareGpu: false,
              decision: false,
            }),
      );
    f.call.mockClear();
    const result = await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsApproval: f.id },
      { localmodels: f.call },
    );
    expect(result).toMatchObject({
      details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
    });
    expect(f.call.mock.calls.some(([, args]) => args[1] === "apply")).toBe(
      false,
    );
  },
);

test("revocation requires a separate reviewed plan before any later apply", async () => {
  const f = await fixture();
  await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: true },
    { localmodels: f.call },
  );
  f.call.mockClear();
  const result = await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: false, localModelsReplan: true },
    { localmodels: f.call },
  );
  expect(result).toMatchObject({
    details: { code: "LOCAL_MODELS_APPROVAL_REQUIRED" },
  });
  const plan = f.call.mock.calls.find(([, args]) => args[1] === "plan")![1];
  expect(plan).not.toContain("--share-gpu");
  expect(f.call.mock.calls.some(([, args]) => args[1] === "apply")).toBe(false);
  f.call.mockClear();
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  expect(f.call.mock.calls.some(([, args]) => args[1] === "apply")).toBe(true);
});

test.each([false, true])(
  "revokes an existing queued controller before old-plan early return (failure=%s)",
  async (failure) => {
    const f = await fixture();
    await prepareLocalModels(
      f.instance,
      { ...f.options, shareGpu: true },
      { localmodels: f.call },
    );
    const control = path.join(f.home, "runtime/model-services");
    const descriptor = {
      schema: "localmodels.service-controller-binding/v1",
      baseUrl: "http://127.0.0.1:18300",
      keyFile: path.join(control, "control.key"),
      bridgeRoot: path.join(control, "bridge"),
    };
    await writeFile(
      path.join(f.instance.root, "model-services.json"),
      JSON.stringify(descriptor),
      { mode: 0o600 },
    );
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...args) =>
      args[1][0] === "foundations"
        ? {
            code: failure ? 1 : 0,
            stdout: JSON.stringify(descriptor),
            stderr: "private-provider-secret",
          }
        : original(...args),
    );
    f.call.mockClear();
    const result = await prepareLocalModels(
      f.instance,
      {
        ...f.options,
        shareGpu: false,
        localModelsApproval: f.id,
      },
      { localmodels: f.call },
    );
    expect(f.call.mock.calls[0]![1].slice(0, 2)).toEqual([
      "foundations",
      "ensure",
    ]);
    const args = f.call.mock.calls[0]![1];
    expect(args).not.toContain("--share-gpu");
    expect(args).not.toContain("--component");
    expect(args[args.indexOf("--main-plan") + 1]).toBe(
      path.join(f.home, "runtime/localmodels/plan.json"),
    );
    expect(f.call.mock.calls[0]![2]).toMatchObject({ timeoutMs: 30_000 });
    expect(result).toMatchObject({
      details: {
        code: failure
          ? "GPU_SHARING_REVOCATION_FAILED"
          : "LOCAL_MODELS_RECOVERY_REQUIRED",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-provider-secret");
    expect(f.call.mock.calls.some(([, args]) => args[1] === "apply")).toBe(
      false,
    );
  },
);

test("first installation with sharing declined never starts a revocation controller", async () => {
  const f = await fixture();
  const result = await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: false },
    { localmodels: f.call },
  );
  expect(result).toMatchObject({
    details: { code: "LOCAL_MODELS_APPROVAL_REQUIRED" },
  });
  expect(f.call.mock.calls[0]![1].slice(0, 2)).toEqual(["stack", "plan"]);
  expect(f.call.mock.calls.some(([, args]) => args[0] === "foundations")).toBe(
    false,
  );
});

test.each([false, true])(
  "reuses only a live verified binding without approving a saved plan (revoke=%s)",
  async (revoke) => {
    const f = await fixture();
    await prepareLocalModels(
      f.instance,
      { ...f.options, shareGpu: true },
      { localmodels: f.call },
    );
    await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsApproval: f.id },
      { localmodels: f.call },
    );
    if (!revoke)
      await rm(path.join(f.home, "runtime/localmodels/plan-inputs.json"));
    if (revoke) {
      const control = path.join(f.home, "runtime/model-services");
      const descriptor = {
        schema: "localmodels.service-controller-binding/v1",
        baseUrl: "http://127.0.0.1:18300",
        keyFile: path.join(control, "control.key"),
        bridgeRoot: path.join(control, "bridge"),
      };
      await writeFile(
        path.join(f.instance.root, "model-services.json"),
        JSON.stringify(descriptor),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(f.instance.root, "foundation-selection.json"),
        JSON.stringify(["embedding"]),
        { mode: 0o600 },
      );
      const original = f.call.getMockImplementation()!;
      f.call.mockImplementation(async (...args) =>
        args[1][0] === "foundations"
          ? { code: 0, stdout: JSON.stringify(descriptor), stderr: "" }
          : original(...args),
      );
    }
    f.call.mockClear();
    expect(
      await prepareLocalModels(
        f.instance,
        { ...f.options, ...(revoke ? { shareGpu: false } : {}) },
        { localmodels: f.call },
      ),
    ).toBeUndefined();
    expect(f.call.mock.calls.some(([, args]) => args[0] === "stack")).toBe(
      false,
    );
    expect(
      f.call.mock.calls.some(
        ([, args]) => args[0] === "setup" && args[1] === "binding",
      ),
    ).toBe(true);
    if (revoke)
      expect(f.call.mock.calls[0]![1].slice(0, 2)).toEqual([
        "foundations",
        "ensure",
      ]);
    if (revoke)
      expect(
        JSON.parse(
          await readFile(
            path.join(f.home, "runtime/localmodels/plan-inputs.json"),
            "utf8",
          ),
        ).shareGpu,
      ).toBe(true);
    else
      await expect(
        stat(path.join(f.home, "runtime/localmodels/plan-inputs.json")),
      ).rejects.toThrow();
  },
);

test("a stale stored binding with missing approval inputs cannot authorize deployment", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  await rm(path.join(f.home, "runtime/localmodels/plan-inputs.json"));
  f.binding.ready = false;
  f.call.mockClear();
  const result = await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  expect(result).toMatchObject({
    details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
  });
  expect(f.call.mock.calls.some(([, args]) => args[0] === "stack")).toBe(false);
});
