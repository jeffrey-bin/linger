import path from "node:path";
import {
  atomicPrivate,
  readPrivate,
  loadInstance,
  type Instance,
} from "./instance.js";
import type { SetupChoice } from "./setup-plan.js";
export function validateSetupChoice(
  value: unknown,
): asserts value is SetupChoice {
  if (!["local-models", "codex", "claude", "pi"].includes(value as string))
    throw new Error("Invalid setup choice");
}
export async function readSetupChoice(
  instance: Pick<Instance, "root"> | { name: string; home?: string },
): Promise<SetupChoice | undefined> {
  const loaded = "root" in instance ? instance : await loadInstance(instance);
  if (!loaded) return undefined;
  const saved = await readPrivate(path.join(loaded.root, "setup-choice.json"));
  if (!saved) return undefined;
  const value = JSON.parse(saved);
  if (!value || Object.keys(value).length !== 1)
    throw new Error("Invalid saved setup choice");
  validateSetupChoice(value.choice);
  return value.choice;
}
/** Caller owns the instance lock. */
export async function writeSetupChoice(
  instance: Instance,
  choice: SetupChoice,
): Promise<void> {
  validateSetupChoice(choice);
  await atomicPrivate(
    path.join(instance.root, "setup-choice.json"),
    JSON.stringify({ choice }),
  );
}

/** Without a saved choice, local models are planned on the current free
 * memory of GPUs that other programs also use; nothing is stopped. */
export const DEFAULT_GPU_SHARING = true;
export async function readGpuSharing(
  instance: Pick<Instance, "root"> | { name: string; home?: string },
): Promise<boolean | undefined> {
  const loaded = "root" in instance ? instance : await loadInstance(instance);
  if (!loaded) return undefined;
  const raw = await readPrivate(path.join(loaded.root, "gpu-sharing.json"));
  if (raw === undefined) return undefined;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "boolean")
    throw new Error("Invalid saved GPU sharing consent");
  return value;
}
/** Caller owns the instance lock; a saved `false` keeps busy GPUs out of plans. */
export async function writeGpuSharing(
  instance: Pick<Instance, "root">,
  consent: boolean,
): Promise<void> {
  if (typeof consent !== "boolean")
    throw new Error("Invalid GPU sharing consent");
  await atomicPrivate(
    path.join(instance.root, "gpu-sharing.json"),
    JSON.stringify(consent),
  );
}
