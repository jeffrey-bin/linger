import path from "node:path";
import { validateModelConfig } from "./instance.js";
import { runLocalmodels } from "./localmodels-tool.js";
import { type NativeRuntime } from "./managed-runtimes.js";
export type ApiKeyProvider = "openai" | "anthropic" | "openai-compatible";
export interface CompatibleModel {
  baseUrl: string;
  model: string;
}
/** User input is validated here; upstream verifies providers and owns native credentials. */
export async function saveRuntimeApiKey(
  root: string,
  runtime: NativeRuntime,
  provider: ApiKeyProvider,
  apiKey: string,
  model?: CompatibleModel,
  dependencies: { localmodels?: typeof runLocalmodels } = {},
) {
  if (
    !apiKey ||
    apiKey.length > 4096 ||
    [...apiKey].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    !["openai", "anthropic", "openai-compatible"].includes(provider) ||
    (runtime === "codex" && provider !== "openai") ||
    (runtime === "claude" && provider !== "anthropic")
  )
    throw new Error("Invalid runtime credentials");
  if (provider === "openai-compatible") {
    if (runtime !== "pi" || !model)
      throw new Error("Invalid runtime credentials");
    validateModelConfig({ ...model, apiKey });
  } else if (model) throw new Error("Invalid runtime credentials");
  const home = path.resolve(root, "../..");
  try {
    const result = await (dependencies.localmodels ?? runLocalmodels)(
      home,
      [
        "harness",
        "auth",
        "--root",
        path.join(home, "runtime", "harness"),
        "--runtime",
        runtime,
        "--config-stdin",
        "--json",
      ],
      {
        input: JSON.stringify({
          provider,
          apiKey,
          ...(model ? { baseUrl: model.baseUrl, modelId: model.model } : {}),
        }),
        timeoutMs: 120000,
      },
    );
    if (result.code !== 0 || JSON.parse(result.stdout).saved !== true)
      throw new Error("Upstream rejected credentials");
  } catch {
    throw new Error(
      "Runtime credential configuration failed. Check the provider settings and network, then retry.",
    );
  }
}
