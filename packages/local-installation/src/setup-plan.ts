import { homedir } from "node:os";
import path from "node:path";
import type { InstallerEvent } from "./events.js";
import { runLocalmodels } from "./localmodels-tool.js";
import { DEFAULT_GPU_SHARING } from "./setup-selection.js";

export type SetupChoice = "local-models" | "codex" | "claude" | "pi";
export type RuntimeChoice = Exclude<SetupChoice, "local-models">;
/**
 * Runtime and model source are separate: local models also run behind a
 * runtime, and only they need the local stack's gateway. The stored choice
 * names one combination per runtime; "local-models" is the local source served
 * by Pi, the only runtime the local stack binds today.
 */
export type ModelSource = "local" | "runtime";
export interface SetupSelection {
  runtime: RuntimeChoice;
  modelSource: ModelSource;
}
export function setupSelection(
  choice: SetupChoice | SetupSelection,
): SetupSelection {
  if (typeof choice !== "string") return choice;
  return choice === "local-models"
    ? { runtime: "pi", modelSource: "local" }
    : { runtime: choice, modelSource: "runtime" };
}
export type SetupReason = string;
export interface SetupGpu {
  index: number;
  name: string;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  busy: boolean;
}
export interface SetupEstimate {
  downloadBytes: number | null;
  diskBytes: number | null;
  memoryBytes: number | null;
  durationSeconds: { min: number; max: number } | null;
  assumption: string;
}
export interface SetupReport {
  hardware: {
    platform: string;
    arch: string;
    totalMemoryBytes: number;
    diskFreeBytes: number | null;
    gpus: SetupGpu[];
  };
  choices: SetupChoice[];
  localModels: {
    eligible: boolean;
    reasons: SetupReason[];
    reasonMessages?: string[];
    selectedGpuIndex: number | null;
    estimate: SetupEstimate & { model: string };
  };
  runtimes: {
    choice: RuntimeChoice;
    installed: boolean;
    auth: "unknown" | "authenticated" | "unauthenticated";
    estimate: SetupEstimate;
  }[];
  recommendation: SetupChoice;
}
export interface SetupOptions {
  shareGpu?: boolean;
  home?: string;
  userHome?: string;
  signal?: AbortSignal;
  localmodels?: typeof runLocalmodels;
  onEvent?: (event: InstallerEvent) => void;
}
interface UpstreamReport {
  schema: string;
  facts: {
    platform: string;
    arch: string;
    ram: { total_bytes: number };
    disk: { free_bytes: number | null };
    gpus: {
      index: number;
      uuid?: string;
      name: string;
      total_bytes: number;
      free_bytes: number;
    }[];
    services?: { compute_processes?: { gpu_uuid: string }[] | null };
  };
  stack: {
    available: boolean;
    reasons: { code: string; message: string }[];
    plan: {
      llm: { model: { id: string }; placement: { gpus: { index: number }[] } };
      budget: {
        download_bytes: number;
        disk_needed_bytes: number;
        ram_needed_bytes: number;
      };
    } | null;
  };
  harness: {
    schema: string;
    runtimes: {
      runtime: RuntimeChoice;
      installed: boolean;
      authenticated: boolean | null;
      estimate?: SetupEstimate;
    }[];
  };
  recommendation: SetupChoice;
}
const choices: SetupChoice[] = ["local-models", "codex", "claude", "pi"];
/** Presentation adapter only. Host probes, admission, recommendation and budgets belong upstream. */
export async function inspectSetup(
  options: SetupOptions = {},
): Promise<SetupReport> {
  options.signal?.throwIfAborted();
  const home = path.resolve(
    options.home ?? path.join(options.userHome ?? homedir(), ".simplexai"),
  );
  try {
    const result = await (options.localmodels ?? runLocalmodels)(
      home,
      [
        "setup",
        "inspect",
        "--root",
        path.join(home, "runtime", "harness"),
        "--model-base-dir",
        path.join(home, "runtime", "localmodels", "models"),
        "--decision",
        "none",
        "--offline",
        "--defer-services",
        ...((options.shareGpu ?? DEFAULT_GPU_SHARING) ? ["--share-gpu"] : []),
        "--json",
      ],
      {
        signal: options.signal,
        timeoutMs: 120000,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      },
    );
    options.signal?.throwIfAborted();
    if (result.code !== 0) throw new Error("Upstream setup failed");
    const value = JSON.parse(result.stdout) as UpstreamReport;
    if (
      value.schema !== "localmodels.setup-report/v1" ||
      value.harness.schema !== "localmodels.harness-status/v1" ||
      !choices.includes(value.recommendation) ||
      typeof value.stack.available !== "boolean"
    )
      throw new Error("Invalid upstream report");
    const plan = value.stack.plan;
    if (value.stack.available && !plan)
      throw new Error("Missing upstream plan");
    const estimate = (budget?: SetupEstimate): SetupEstimate => ({
      downloadBytes: budget?.downloadBytes ?? null,
      diskBytes: budget?.diskBytes ?? null,
      memoryBytes: budget?.memoryBytes ?? null,
      durationSeconds: budget?.durationSeconds ?? null,
      assumption:
        budget?.assumption ??
        "Resource estimates are unavailable from localmodels.",
    });
    return {
      hardware: {
        platform: value.facts.platform,
        arch: value.facts.arch,
        totalMemoryBytes: value.facts.ram.total_bytes,
        diskFreeBytes: value.facts.disk.free_bytes,
        gpus: value.facts.gpus.map((g) => ({
          index: g.index,
          name: g.name,
          totalMemoryBytes: g.total_bytes,
          freeMemoryBytes: g.free_bytes,
          busy:
            value.facts.services?.compute_processes?.some(
              (process) => process.gpu_uuid === g.uuid,
            ) ?? false,
        })),
      },
      choices: [...choices],
      localModels: {
        eligible: value.stack.available,
        reasons: value.stack.reasons.map((reason) => reason.code),
        reasonMessages: value.stack.reasons.map((reason) => reason.message),
        selectedGpuIndex: plan?.llm.placement.gpus[0]?.index ?? null,
        estimate: {
          ...estimate(
            plan
              ? {
                  downloadBytes: plan.budget.download_bytes,
                  diskBytes: plan.budget.disk_needed_bytes,
                  memoryBytes: plan.budget.ram_needed_bytes,
                  durationSeconds: null,
                  assumption:
                    "Resource plan supplied by localmodels; duration is unknown.",
                }
              : undefined,
          ),
          model: plan?.llm.model.id ?? "",
        },
      },
      runtimes: value.harness.runtimes.map((row) => ({
        choice: row.runtime,
        installed: row.installed,
        auth:
          row.authenticated === null
            ? "unknown"
            : row.authenticated
              ? "authenticated"
              : "unauthenticated",
        estimate: estimate(row.estimate),
      })),
      recommendation: value.recommendation,
    };
  } catch {
    options.signal?.throwIfAborted();
    throw Object.assign(
      new Error(
        "The localmodels setup report is unavailable. Check the verified tool installation and retry.",
      ),
      { code: "LOCALMODELS_SETUP_UNAVAILABLE" },
    );
  }
}
export async function assertLocalModelsEligible(
  options: SetupOptions = {},
): Promise<SetupReport> {
  const report = await inspectSetup(options);
  if (!report.localModels.eligible)
    throw new Error(
      `Local models are unavailable: ${report.localModels.reasons.map((code, index) => (report.localModels.reasonMessages?.[index] ? `${code}: ${report.localModels.reasonMessages[index]}` : code)).join(", ")}`,
    );
  return report;
}
