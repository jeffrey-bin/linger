import { revokeFoundationGpuSharing } from "./foundation-services.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  atomicPrivate,
  privateDirectory,
  readPrivate,
  withInstanceLock,
  type Instance,
} from "./instance.js";
import type { InstallOutcome, InstallerEvent } from "./events.js";
import { runLocalmodels } from "./localmodels-tool.js";
import {
  readSetupChoice,
  DEFAULT_GPU_SHARING,
  readGpuSharing,
  writeGpuSharing,
} from "./setup-selection.js";
export interface LocalModelsPlanSummary {
  planId: string;
  gpuIndex: number;
  gpuName: string;
  llm: string;
  contextWindow: number;
  downloadBytes: number;
  diskBytes: number;
  memoryBytes: number;
  components: string[];
  warnings: string[];
}
interface Binding {
  schema: "localmodels.stack-binding/v1";
  ready: boolean;
  planId: string;
  pi: {
    executable: string;
    environment: Record<string, string>;
    configFingerprint: string;
  } | null;
}
interface Options {
  shareGpu?: boolean;
  localModelsApproval?: string;
  localModelsReplan?: boolean;
  signal: AbortSignal;
  onEvent: (e: InstallerEvent) => void;
}
interface Dependencies {
  localmodels?: typeof runLocalmodels;
}
function review(value: unknown): LocalModelsPlanSummary {
  const v = value as LocalModelsPlanSummary & { schema?: string };
  if (
    v?.schema !== "localmodels.stack-review/v1" ||
    !/^[a-f0-9]{64}$/.test(v.planId) ||
    !Number.isSafeInteger(v.gpuIndex) ||
    v.gpuIndex < 0 ||
    ![v.gpuName, v.llm].every(
      (x) => typeof x === "string" && x.length > 0 && x.length < 1024,
    ) ||
    ![v.contextWindow, v.downloadBytes, v.diskBytes, v.memoryBytes].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    ![v.components, v.warnings].every(
      (a) =>
        Array.isArray(a) &&
        a.every(
          (x) =>
            typeof x === "string" &&
            x.length < 4000 &&
            ![...x].some(
              (c) => c.charCodeAt(0) < 32 && c !== "\t" && c !== "\n",
            ),
        ),
    )
  )
    throw new Error("Invalid upstream local model review.");
  return {
    planId: v.planId,
    gpuIndex: v.gpuIndex,
    gpuName: v.gpuName,
    llm: v.llm,
    contextWindow: v.contextWindow,
    downloadBytes: v.downloadBytes,
    diskBytes: v.diskBytes,
    memoryBytes: v.memoryBytes,
    components: v.components,
    warnings: v.warnings,
  };
}
function binding(value: unknown, id?: string): Binding {
  const b = value as Binding;
  if (
    b?.schema !== "localmodels.stack-binding/v1" ||
    typeof b.ready !== "boolean" ||
    !/^[a-f0-9]{64}$/.test(b.planId) ||
    (id !== undefined && b.planId !== id)
  )
    throw new Error("Invalid upstream local model binding.");
  if (
    b.ready &&
    (!b.pi ||
      !path.isAbsolute(b.pi.executable) ||
      !/^[a-f0-9]{64}$/.test(b.pi.configFingerprint) ||
      !b.pi.environment ||
      Object.entries(b.pi.environment).some(
        ([key, v]) =>
          key !== "PI_CODING_AGENT_DIR" ||
          typeof v !== "string" ||
          !path.isAbsolute(v),
      ))
  )
    throw new Error("Invalid upstream Pi binding.");
  return b;
}
export async function localModelsEnvironment(
  instance: Instance,
): Promise<NodeJS.ProcessEnv> {
  if ((await readSetupChoice(instance)) !== "local-models") return {};
  const raw = await readPrivate(
    path.join(
      path.resolve(instance.root, "../.."),
      "runtime/localmodels/binding.json",
    ),
  );
  if (!raw) return {};
  const b = binding(JSON.parse(raw));
  if (!b.ready || !b.pi) return {};
  return {
    ...b.pi.environment,
    LINGER_PI_PATH: b.pi.executable,
    LINGER_LOCAL_MODELS_REVISION: b.pi.configFingerprint,
  };
}
export async function hasSavedLocalModelsPlan(home: string): Promise<boolean> {
  const raw = await readPrivate(
    path.join(home, "runtime/localmodels/plan.json"),
  );
  if (!raw) return false;
  const saved = JSON.parse(raw) as { schema?: string; plan_id?: string };
  if (
    saved.schema !== "localmodels.stack-plan/v1" ||
    !/^[a-f0-9]{64}$/.test(saved.plan_id ?? "")
  )
    throw new Error("Invalid saved upstream plan.");
  return true;
}
export async function reviewSavedModelPlan(
  home: string,
  file: string,
  options: { signal?: AbortSignal } = {},
  dependencies: Dependencies = {},
): Promise<LocalModelsPlanSummary> {
  const result = await (dependencies.localmodels ?? runLocalmodels)(
    home,
    ["setup", "review", "--plan", path.resolve(file), "--json"],
    { signal: options.signal, timeoutMs: 120000 },
  );
  if (result.code !== 0)
    throw new Error("The upstream model plan could not be reviewed.");
  return review(JSON.parse(result.stdout));
}
export async function prepareLocalModels(
  instance: Instance,
  options: Options,
  dependencies: Dependencies = {},
): Promise<InstallOutcome | undefined> {
  options.signal.throwIfAborted();
  const action = (
    code: string,
    message: string,
    summary?: LocalModelsPlanSummary,
  ): InstallOutcome => ({
    code: 4,
    state: "action_required",
    message,
    details: { code, ...(summary ? { localModelsPlan: summary } : {}) },
  });
  if (options.localModelsReplan && options.localModelsApproval)
    return action(
      "LOCAL_MODELS_RECOVERY_REQUIRED",
      "Reviewing a new plan and approving it must be separate requests.",
    );
  const home = path.resolve(instance.root, "../.."),
    root = path.join(home, "runtime/localmodels"),
    planFile = path.join(root, "plan.json"),
    inputsFile = path.join(root, "plan-inputs.json");
  await privateDirectory(root);
  await privateDirectory(path.join(root, "models"));
  return withInstanceLock({ root } as Instance, async () => {
    let saved = await readPrivate(planFile);
    if (options.shareGpu === false) {
      try {
        await revokeFoundationGpuSharing(
          instance,
          { home, mainPlan: saved !== undefined, signal: options.signal },
          { run: dependencies.localmodels },
        );
      } catch {
        options.signal.throwIfAborted();
        return action(
          "GPU_SHARING_REVOCATION_FAILED",
          "GPU sharing revocation could not be confirmed. Existing models were not stopped; retry before approving a plan.",
        );
      }
    }
    if (options.shareGpu !== undefined)
      await writeGpuSharing(instance, options.shareGpu);
    const shareGpu =
      options.shareGpu ??
      (await readGpuSharing(instance)) ??
      DEFAULT_GPU_SHARING;
    const invoke = dependencies.localmodels ?? runLocalmodels;
    const command = async (args: string[]) => {
      let buffer = "";
      return invoke(home, args, {
        signal: options.signal,
        timeoutMs: args[1] === "apply" ? undefined : 120000,
        capture: !(args[0] === "stack" && args[1] === "apply"),
        onEvent: options.onEvent,
        onOutput: (chunk) => {
          buffer += chunk;
          if (buffer.length > 128000) buffer = buffer.slice(-64000);
          for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (
              event?.event === "progress" &&
              typeof event.component === "string" &&
              /^[a-z][a-z0-9_-]{0,40}$/.test(event.component) &&
              ["download", "verify"].includes(event.phase) &&
              Number.isSafeInteger(event.done) &&
              event.done >= 0 &&
              Number.isSafeInteger(event.total) &&
              event.total >= event.done
            )
              options.onEvent({
                kind: "stage",
                stage: "runtime",
                state: "running",
                message: `Local model ${event.component}: ${event.phase}`,
                progress: {
                  completed: event.done,
                  total: event.total,
                  unit: "bytes",
                },
              });
          }
        },
      });
    };
    if (!saved && options.localModelsApproval)
      return action(
        "LOCAL_MODELS_APPROVAL_REQUIRED",
        "The approved upstream plan does not exist. Generate and review a plan first.",
      );
    if (!saved || options.localModelsReplan) {
      const temporary = path.join(root, `plan-${randomUUID()}.json`);
      try {
        const result = await command([
          "stack",
          "plan",
          "--defer-services",
          ...(shareGpu ? ["--share-gpu"] : []),
          "--decision",
          "none",
          "--base-dir",
          path.join(root, "models"),
          "--out",
          temporary,
          "--json",
        ]);
        if (result.code !== 0)
          return action(
            "LOCAL_MODELS_UNAVAILABLE",
            "The upstream planner could not create a local model plan. Existing resources were preserved.",
          );
        const generated = await readPrivate(temporary);
        if (!generated)
          throw new Error("The upstream planner did not save a plan.");
        const planned = await reviewSavedModelPlan(
          home,
          temporary,
          { signal: options.signal },
          { localmodels: invoke },
        );
        await atomicPrivate(planFile, generated);
        await atomicPrivate(
          inputsFile,
          JSON.stringify({ planId: planned.planId, shareGpu, decision: false }),
        );
        saved = generated;
      } finally {
        await rm(temporary, { force: true });
      }
    }
    const summary = await reviewSavedModelPlan(
      home,
      planFile,
      { signal: options.signal },
      { localmodels: invoke },
    );
    const bindFile = path.join(root, "binding.json");
    const previous = await readPrivate(bindFile);
    const observe = async () => {
      const result = await command([
        "setup",
        "binding",
        "--plan",
        planFile,
        "--json",
      ]);
      if (result.code !== 0) return null;
      return binding(JSON.parse(result.stdout), summary.planId);
    };
    if (
      previous &&
      !options.localModelsReplan &&
      binding(JSON.parse(previous)).planId === summary.planId
    ) {
      const observed = await observe();
      if (observed?.ready) {
        await atomicPrivate(bindFile, JSON.stringify(observed));
        return;
      }
      return action(
        "LOCAL_MODELS_RECOVERY_REQUIRED",
        "The upstream stack is not ready. Review an updated plan; existing resources were preserved.",
      );
    }
    let inputs:
      | { planId?: unknown; shareGpu?: unknown; decision?: unknown }
      | undefined;
    try {
      const raw = await readPrivate(inputsFile);
      inputs = raw ? JSON.parse(raw) : undefined;
    } catch {
      // A damaged or incomplete approval binding cannot authorize deployment.
    }
    if (
      inputs?.planId !== summary.planId ||
      inputs?.shareGpu !== shareGpu ||
      inputs?.decision !== false
    )
      return action(
        "LOCAL_MODELS_RECOVERY_REQUIRED",
        "Local model resource choices changed or their approval binding is unavailable. Review a new plan; existing resources were preserved.",
      );
    if (
      options.localModelsApproval !== summary.planId ||
      options.localModelsReplan
    )
      return action(
        "LOCAL_MODELS_APPROVAL_REQUIRED",
        "Review the upstream local model plan before installing.",
        summary,
      );
    const applied = await command([
      "stack",
      "apply",
      planFile,
      "--approve",
      summary.planId,
      "--jsonl",
    ]);
    if (applied.code !== 0)
      return action(
        "LOCAL_MODELS_RECOVERY_REQUIRED",
        "Local model installation or verification did not finish. Existing resources were preserved.",
      );
    const observed = await observe();
    if (!observed?.ready)
      return action(
        "LOCAL_MODELS_RECOVERY_REQUIRED",
        "The upstream tool could not verify the local stack binding. Existing resources were preserved.",
      );
    await atomicPrivate(bindFile, JSON.stringify(observed));
    options.onEvent({
      kind: "stage",
      stage: "runtime",
      state: "succeeded",
      message: "The upstream local model stack and Pi connection are ready.",
    });
  });
}
