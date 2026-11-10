import { expect, test, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobManager } from "./jobs.js";
import { privateWrite } from "./storage.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup(run: ConstructorParameters<typeof JobManager>[1]) {
  const dir = await mkdtemp(path.join(tmpdir(), "installer-jobs-"));
  cleanup.push(() => rm(dir, { force: true, recursive: true }));
  const jobs = new JobManager(dir, run);
  await jobs.load();
  return { jobs, dir };
}
const input = {
  instance: "default",
  password: "private-password-not-logged",
  model: {
    baseUrl: "https://example.test/v1",
    model: "test",
    apiKey: "secret-api-key",
  },
};
test("dependency preparation can run while product installation awaits runtime and deduplicates independently", async () => {
  const { jobs } = await setup(async (value) =>
    value.preparation
      ? { code: 0, state: "ready", message: "Codex installed" }
      : { code: 4, state: "action_required", message: "Configure a runtime" },
  );
  const install = await jobs.start(input);
  await jobs.wait(install.id);
  const prepared = await jobs.start({
    instance: "default",
    preparation: "codex",
  });
  expect(prepared.id).not.toBe(install.id);
  expect(prepared.preparation).toBe("codex");
  await jobs.wait(prepared.id);
  expect(jobs.get(prepared.id)?.state).toBe("succeeded");
  expect(jobs.get(install.id)?.state).toBe("waiting_user");
});
test("runtime model keys are removed from persisted events and job snapshots", async () => {
  const { jobs, dir } = await setup(async (_value, _signal, emit) => {
    emit({ kind: "log", message: "provider said runtime-private-key" });
    return { code: 5, state: "failed", message: "runtime-private-key" };
  });
  const job = await jobs.start({
    instance: "default",
    runtimeModel: {
      baseUrl: "https://example.test/v1",
      model: "x",
      apiKey: "runtime-private-key",
    },
  });
  await jobs.wait(job.id);
  expect(
    await readFile(path.join(dir, job.id + ".json"), "utf8"),
  ).not.toContain("runtime-private-key");
});
test("duplicate starts return current job and task survives subscriber disconnect", async () => {
  let release!: () => void;
  let count = 0;
  const { jobs } = await setup(async (_input, _signal, emit) => {
    count++;
    emit({
      kind: "stage",
      stage: "images",
      state: "running",
      message: "working",
    });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { state: "ready", code: 0, message: "Complete" };
  });
  const first = await jobs.start(input);
  const second = await jobs.start(input);
  expect(second.id).toBe(first.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(count).toBe(1);
  release();
  await jobs.wait(first.id);
  expect(jobs.get(first.id)?.state).toBe("succeeded");
});
test("public snapshots/events remove secrets and restart marks pending job interrupted", async () => {
  const { jobs, dir } = await setup(async (_input, _signal, emit) => {
    emit({ kind: "log", message: `${input.password} ${input.model.apiKey}` });
    await new Promise(() => {});
  });
  const job = await jobs.start(input);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const raw =
    JSON.stringify(jobs.get(job.id)) + JSON.stringify(jobs.replay(job.id, 0));
  expect(raw).not.toContain(input.password);
  expect(raw).not.toContain(input.model.apiKey);
  const saved = await readFile(path.join(dir, `${job.id}.json`), "utf8");
  expect(saved).not.toContain(input.password);
  expect((await stat(path.join(dir, `${job.id}.json`))).mode & 0o777).toBe(
    0o600,
  );
  const restarted = new JobManager(dir, async () => {});
  await restarted.load();
  expect(restarted.get(job.id)?.state).toBe("interrupted");
});
test("bounded replay returns snapshot when cursor predates retained events", async () => {
  const { jobs } = await setup(async (_input, _signal, emit) => {
    for (let i = 0; i < 550; i++) emit({ kind: "log", message: `event ${i}` });
    return { state: "ready", code: 0, message: "Done" };
  });
  const job = await jobs.start(input);
  await jobs.wait(job.id);
  const events = jobs.replay(job.id, 1);
  expect(events[0]?.kind).toBe("snapshot");
  expect(events[0]?.job?.state).toBe("succeeded");
  expect(jobs.replay(job.id, job.lastSequence).length).toBeLessThanOrEqual(501);
});

test("cancel waits through account mutation and stops at the next safe stage", async () => {
  let next!: () => void;
  let signal!: AbortSignal;
  const { jobs } = await setup(async (_input, current, emit) => {
    signal = current;
    emit({
      kind: "stage",
      stage: "account",
      state: "running",
      message: "Creating account",
    });
    await new Promise<void>((resolve) => {
      next = resolve;
    });
    emit({
      kind: "stage",
      stage: "runtime",
      state: "running",
      message: "Checking tools",
    });
    current.throwIfAborted();
  });
  const job = await jobs.start({ instance: "default" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const canceled = await jobs.cancel(job.id);
  expect(canceled?.state).toBe("waiting_user");
  expect(signal.aborted).toBe(false);
  next();
  await jobs.wait(job.id);
  expect(jobs.get(job.id)?.state).toBe("canceled");
});
test("waiting-user jobs retry by rechecking and can be canceled after their operation settles", async () => {
  let runs = 0;
  const { jobs } = await setup(async () => {
    runs++;
    return {
      state: "action_required",
      code: 4,
      message: "Sign in to the model tool",
    };
  });
  const first = await jobs.start({ instance: "default" });
  await jobs.wait(first.id);
  expect(jobs.get(first.id)?.state).toBe("waiting_user");
  const retried = await jobs.retry(first.id);
  await jobs.wait(retried!.id);
  expect(runs).toBe(2);
  expect((await jobs.cancel(retried!.id))?.state).toBe("canceled");
});

test("shutdown cancels owned work and flushes final state before releasing ownership", async () => {
  const { jobs, dir } = await setup(async (_input, signal) => {
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("stopped")), {
        once: true,
      }),
    );
  });
  const job = await jobs.start({ instance: "default" });
  await jobs.shutdown();
  expect(jobs.get(job.id)?.state).toBe("canceled");
  expect(
    JSON.parse(await readFile(path.join(dir, `${job.id}.json`), "utf8")).job
      .state,
  ).toBe("canceled");
});

test.each([
  undefined,
  { state: "unexpected", code: 0 },
  { state: "ready", code: 5 },
])(
  "does not claim success for malformed installation outcome %#",
  async (outcome) => {
    const { jobs } = await setup(async () => outcome);
    const job = await jobs.start({ instance: "default" });
    await jobs.wait(job.id);
    expect(jobs.get(job.id)?.state).toBe("failed");
    expect(jobs.get(job.id)?.errorCode).toBe("INSTALL_RESULT_INVALID");
  },
);

const localPlan = {
  planId: "a".repeat(64),
  gpuIndex: 1,
  gpuName: "NVIDIA Test",
  llm: "Qwen",
  contextWindow: 32768,
  downloadBytes: 123,
  diskBytes: 456,
  memoryBytes: 789,
  components: ["Qwen", "Pi"],
  warnings: ["Review resources"],
};
test("local model approval survives snapshots and exposes only public plan fields", async () => {
  const { jobs, dir } = await setup(async () => ({
    state: "action_required",
    code: 4,
    message: "Review plan",
    details: {
      code: "LOCAL_MODELS_APPROVAL_REQUIRED",
      localModelsPlan: {
        ...localPlan,
        secret: "hidden",
        deploy_dir: "/private/models",
      },
    },
  }));
  const job = await jobs.start({ instance: "default" });
  await jobs.wait(job.id);
  expect(jobs.get(job.id)).toMatchObject({
    state: "waiting_user",
    errorCode: "LOCAL_MODELS_APPROVAL_REQUIRED",
    localModelsPlan: localPlan,
  });
  expect(JSON.stringify(jobs.get(job.id))).not.toContain("/private/models");
  const restarted = new JobManager(dir, async () => {});
  await restarted.load();
  expect(restarted.get(job.id)).toMatchObject({
    state: "waiting_user",
    localModelsPlan: localPlan,
  });
});
test("malformed or secret-bearing local plan is never published", async () => {
  const { jobs } = await setup(async () => ({
    state: "action_required",
    code: 4,
    message: "Review",
    details: {
      code: "LOCAL_MODELS_APPROVAL_REQUIRED",
      localModelsPlan: { ...localPlan, gpuName: "token=private-key" },
    },
  }));
  const job = await jobs.start(input);
  await jobs.wait(job.id);
  expect(jobs.get(job.id)).not.toHaveProperty("localModelsPlan");
  expect(JSON.stringify(jobs.get(job.id))).not.toContain("private-key");
});
test("local plan keeps its approval id when a review line carries a URL or path", async () => {
  const { jobs } = await setup(async () => ({
    state: "action_required",
    code: 4,
    message: "Review",
    details: {
      code: "LOCAL_MODELS_APPROVAL_REQUIRED",
      localModelsPlan: {
        ...localPlan,
        components: [...localPlan.components, "/home/user/models"],
        warnings: [
          "qwen3.8-27b: Apache-2.0 https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/LICENSE",
          ...localPlan.warnings,
        ],
      },
    },
  }));
  const job = await jobs.start(input);
  await jobs.wait(job.id);
  expect(jobs.get(job.id)?.localModelsPlan).toEqual(localPlan);
  expect(JSON.stringify(jobs.get(job.id))).not.toContain("huggingface");
});
test("local model recovery uses an explicit safe code and retries discard spent approval", async () => {
  const values: unknown[] = [];
  const { jobs } = await setup(async (value) => {
    values.push(value);
    return {
      state: "action_required",
      code: 4,
      message: "Review updated plan",
      details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
    };
  });
  const job = await jobs.start({
    instance: "default",
    localModelsApproval: localPlan.planId,
  });
  await jobs.wait(job.id);
  expect(jobs.get(job.id)).toMatchObject({
    state: "waiting_user",
    errorCode: "LOCAL_MODELS_RECOVERY_REQUIRED",
  });
  const retry = await jobs.retry(job.id);
  await jobs.wait(retry!.id);
  expect(values[1]).not.toHaveProperty("localModelsApproval");
});
test("local model runtime byte and component progress replays after manager reload", async () => {
  const { jobs, dir } = await setup(async (_input, _signal, emit) => {
    emit({
      kind: "stage",
      stage: "runtime",
      state: "running",
      message: "Downloading local models",
      progress: { completed: 50, total: 100, unit: "bytes" },
    });
    emit({
      kind: "stage",
      stage: "runtime",
      state: "running",
      message: "Verifying local models",
      progress: { completed: 2, total: 7, unit: "components" },
    });
    return {
      code: 4,
      state: "action_required",
      message: "Review",
      details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
    };
  });
  const job = await jobs.start({ instance: "default" });
  await jobs.wait(job.id);
  const restarted = new JobManager(dir, async () => {});
  await restarted.load();
  expect(
    restarted
      .replay(job.id, 0)
      .filter((event) => event.progress)
      .map((event) => event.progress),
  ).toEqual([
    { completed: 50, total: 100, unit: "bytes" },
    { completed: 2, total: 7, unit: "components" },
  ]);
});

test("model continuation after manager reload preserves private advanced settings and replaces only authority", async () => {
  const original = {
    ...input,
    email: "private-owner@example.test",
    computerName: "Owner computer",
    shareGpu: false,
    port: 8099,
    runtimeModel: {
      baseUrl: "https://runtime.example.test/v1",
      model: "runtime-model",
      apiKey: "private-runtime-key",
    },
    localModelsApproval: "b".repeat(64),
  };
  const { jobs, dir } = await setup(async () => ({
    state: "action_required",
    code: 4,
    message: "Review",
    details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
  }));
  const first = await jobs.start(original);
  await jobs.wait(first.id);
  expect(first).toMatchObject({ shareGpu: false });
  const received: unknown[] = [];
  const restarted = new JobManager(dir, async (value) => {
    received.push(value);
    return {
      state: "action_required",
      code: 4,
      message: "Review",
      details: {
        code: "LOCAL_MODELS_APPROVAL_REQUIRED",
        localModelsPlan: localPlan,
      },
    };
  });
  await restarted.load();
  const reviewed = await restarted.retry(first.id, { localModelsReplan: true });
  await restarted.wait(reviewed!.id);
  const settings = { ...original };
  delete (settings as Partial<typeof original>).localModelsApproval;
  expect(received[0]).toEqual({ ...settings, localModelsReplan: true });
  expect(restarted.get(first.id)?.state).toBe("canceled");
  const approved = await restarted.retry(reviewed!.id, {
    localModelsApproval: localPlan.planId,
  });
  await restarted.wait(approved!.id);
  expect(received[1]).toEqual({
    ...settings,
    localModelsApproval: localPlan.planId,
  });
  expect(restarted.get(reviewed!.id)?.state).toBe("canceled");
  const publicState =
    JSON.stringify(restarted.list()) +
    JSON.stringify(restarted.replay(approved!.id, 0));
  for (const secret of [
    original.password,
    original.model.apiKey,
    original.runtimeModel.apiKey,
  ])
    expect(publicState).not.toContain(secret);
});

test("lists the latest successor before its canceled plan across manager reload", async () => {
  const { jobs, dir } = await setup(async () => ({
    state: "action_required",
    code: 4,
    message: "Review",
    details: {
      code: "LOCAL_MODELS_APPROVAL_REQUIRED",
      localModelsPlan: localPlan,
    },
  }));
  const first = await jobs.start({ instance: "default" });
  await jobs.wait(first.id);
  const successor = await jobs.retry(first.id, {
    localModelsApproval: localPlan.planId,
  });
  await jobs.wait(successor!.id);
  // Equal wall-clock timestamps can occur during immediate continuations. UUID/file order is not chronological.
  for (const [id, state, createdAt] of [
    [first.id, "canceled", "2026-01-01T00:00:00.000Z"],
    [successor!.id, "succeeded", "2026-01-01T00:00:00.001Z"],
  ] as const) {
    const filename = path.join(dir, `${id}.json`);
    const saved = JSON.parse(await readFile(filename, "utf8"));
    saved.job.state = state;
    saved.job.createdAt = createdAt;
    saved.job.updatedAt = "2026-01-01T00:00:00.002Z";
    await privateWrite(filename, saved);
  }
  const restarted = new JobManager(dir, async () => {});
  await restarted.load();
  expect(restarted.list().map((job) => job.id)).toEqual([
    successor!.id,
    first.id,
  ]);
  const restartedAgain = new JobManager(dir, async () => {});
  await restartedAgain.load();
  expect(restartedAgain.list().map((job) => job.id)).toEqual([
    successor!.id,
    first.id,
  ]);
});

test("lists a running successor before its canceled model plan immediately", async () => {
  let calls = 0;
  const { jobs } = await setup(async (_input, signal) => {
    if (++calls === 1)
      return {
        state: "action_required",
        code: 4,
        message: "Review",
        details: {
          code: "LOCAL_MODELS_APPROVAL_REQUIRED",
          localModelsPlan: localPlan,
        },
      };
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("Stopped")), {
        once: true,
      }),
    );
  });
  const first = await jobs.start({ instance: "default" });
  await jobs.wait(first.id);
  const successor = await jobs.retry(first.id, {
    localModelsApproval: localPlan.planId,
  });
  expect(jobs.list()[0]).toMatchObject({ id: successor!.id, state: "running" });
  await jobs.shutdown();
});
test("auth wait and stage byte progress survive reload and retry preserves private selected configuration", async () => {
  const { jobs, dir } = await setup(async (_value, _signal, emit) => {
    emit({
      kind: "stage",
      stage: "runtime",
      state: "running",
      message: "Installing runtime",
      progress: { completed: 128, total: 1024, unit: "bytes" },
    });
    emit({
      kind: "stage",
      stage: "images",
      state: "running",
      message: "Pulling images",
      progress: { completed: 256, unit: "bytes" },
    });
    return {
      code: 4,
      state: "action_required",
      message: "Sign in",
      details: {
        code: "RUNTIME_AUTH_REQUIRED",
        runtime: "claude",
        executable: "/private/secret",
        loginCommand: "claude auth login",
        loginInstructions: "Complete sign-in in your browser.",
      },
    };
  });
  const job = await jobs.start({ ...input, setupChoice: "claude" });
  await jobs.wait(job.id);
  const calls: unknown[] = [];
  const loaded = new JobManager(dir, async (value) => {
    calls.push(value);
    return { code: 0, state: "ready", message: "Ready" };
  });
  await loaded.load();
  expect(loaded.get(job.id)).toMatchObject({
    state: "waiting_user",
    setupChoice: "claude",
    runtimeAuth: { runtime: "claude", loginCommand: "claude auth login" },
  });
  expect(
    loaded.get(job.id)?.stages.find((stage) => stage.id === "runtime")
      ?.progress,
  ).toEqual({ completed: 128, total: 1024, unit: "bytes" });
  expect(
    loaded.get(job.id)?.stages.find((stage) => stage.id === "images")?.progress,
  ).toEqual({ completed: 256, unit: "bytes" });
  expect(JSON.stringify(loaded.get(job.id))).not.toContain("/private/secret");
  const retry = await loaded.retry(job.id);
  await loaded.wait(retry!.id);
  expect(calls).toEqual([{ ...input, setupChoice: "claude" }]);
});
test("a long failure keeps its first line and the cause at its end", async () => {
  const noise = Array.from(
    { length: 80 },
    (_, i) => ` Volume linger_source-modules-${i} Created`,
  ).join("\n");
  const { jobs } = await setup(async () => ({
    code: 1,
    state: "failed",
    message: `Source Docker up failed.${noise}\npostgres log:\nls: cannot open directory '/docker-entrypoint-initdb.d/': Permission denied`,
  }));
  const job = await jobs.start({ instance: "default" });
  await jobs.wait(job.id);
  const message = jobs.get(job.id)!.message ?? "";
  expect(message.length).toBeLessThanOrEqual(2000);
  expect(message.startsWith("Source Docker up failed.")).toBe(true);
  expect(message.endsWith("Permission denied")).toBe(true);
});
test("chunk progress replaces the previous update and keeps the log lines", async () => {
  const { jobs, dir } = await setup(async (_input, _signal, emit) => {
    for (const step of ["Copying bundled PostgreSQL", "Copying bundled Go"])
      for (let chunk = 1; chunk <= 400; chunk++) {
        emit({
          kind: "stage",
          stage: "release",
          state: "running",
          message: step,
          progress: { completed: chunk, total: 400, unit: "bytes" },
        });
        if (chunk % 100 === 0)
          emit({ kind: "log", message: `${step}: ${chunk} chunks` });
      }
    return { code: 0, state: "ready", message: "Ready" };
  });
  const job = await jobs.start({ instance: "default" });
  await jobs.wait(job.id);
  const events = jobs.replay(job.id, 0);
  expect(events.filter((event) => event.kind === "log")).toHaveLength(8);
  // One update per run of chunks between two log lines.
  const updates = events.filter((event) => event.progress);
  expect(updates).toHaveLength(8);
  expect(updates.at(-1)?.progress).toEqual({
    completed: 400,
    total: 400,
    unit: "bytes",
  });
  const sequences = events.map((event) => event.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  const loaded = new JobManager(dir, async () => {});
  await loaded.load();
  expect(loaded.replay(job.id, 0)).toHaveLength(events.length);
});
