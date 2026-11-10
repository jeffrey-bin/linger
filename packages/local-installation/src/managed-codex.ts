import path from "node:path";
import { runLocalmodels } from "./localmodels-tool.js";
import {
  inspectRuntimeDescriptors,
  inspectSelectedRuntimeDescriptors,
  runtimeEnvironmentFromDescriptors,
} from "./managed-runtimes.js";
import { validateModelConfig } from "./instance.js";
export interface RuntimeModel {
  baseUrl: string;
  model: string;
  apiKey: string;
}
export async function configureManagedCodex(
  root: string,
  model: RuntimeModel,
  signal: AbortSignal,
  dependencies: { localmodels?: typeof runLocalmodels } = {},
) {
  return codexConfiguration(
    path.resolve(root, "../.."),
    model,
    signal,
    dependencies,
    false,
  );
}
export async function checkRuntimeModel(
  model: RuntimeModel,
  signal: AbortSignal,
  dependencies: { home: string; localmodels?: typeof runLocalmodels },
) {
  return codexConfiguration(
    dependencies.home,
    model,
    signal,
    dependencies,
    true,
  );
}
/** Thin adapter for upstream-owned Responses verification and native configuration. */
async function codexConfiguration(
  home: string,
  model: RuntimeModel,
  signal: AbortSignal,
  dependencies: { localmodels?: typeof runLocalmodels },
  check: boolean,
) {
  validateModelConfig(model);
  signal.throwIfAborted();
  try {
    const result = await (dependencies.localmodels ?? runLocalmodels)(
      home,
      [
        "harness",
        "auth",
        "--root",
        path.join(home, "runtime", "harness"),
        "--runtime",
        "codex",
        "--config-stdin",
        ...(check ? ["--check"] : []),
        "--json",
      ],
      {
        signal,
        timeoutMs: 120000,
        input: JSON.stringify({
          provider: "openai-compatible",
          apiKey: model.apiKey,
          baseUrl: model.baseUrl,
          modelId: model.model,
          wireApi: "responses",
        }),
      },
    );
    if (
      result.code !== 0 ||
      (!check && JSON.parse(result.stdout).saved !== true)
    )
      throw new Error("Upstream rejected model configuration");
  } catch {
    signal.throwIfAborted();
    throw new Error(
      "Runtime model configuration failed. Check the provider settings and network, then retry.",
    );
  }
}
export async function readManagedModel(root: string) {
  const rows = await inspectRuntimeDescriptors(path.resolve(root, "../.."), {
    runtime: "codex",
  });
  return rows.find((row) => row.runtime === "codex")?.modelConfig ?? undefined;
}
export async function managedRuntimeEnvironment(
  home: string,
  root = home,
): Promise<NodeJS.ProcessEnv> {
  return runtimeEnvironmentFromDescriptors(
    await inspectSelectedRuntimeDescriptors(home, root),
  );
}
