/** Schedule the owned model controller; its readiness never gates installation. */
import path from "node:path";
import { atomicPrivate, readPrivate, type Instance } from "./instance.js";
import { runLocalmodels } from "./localmodels-tool.js";
import type { InstallerEvent } from "./events.js";
import type { SetupChoice } from "./setup-plan.js";
import {
  DEFAULT_GPU_SHARING,
  readGpuSharing,
  writeGpuSharing,
} from "./setup-selection.js";

/** Update existing controller consent before a pending main plan can return early. */
export async function revokeFoundationGpuSharing(
  instance: Instance,
  options: { home: string; mainPlan: boolean; signal: AbortSignal },
  dependencies: { run?: typeof runLocalmodels } = {},
): Promise<void> {
  const raw = await readPrivate(
    path.join(instance.root, "model-services.json"),
  );
  if (!raw) return;
  const stored = JSON.parse(raw) as Stored;
  if (
    !("schema" in stored) ||
    stored.schema !== "localmodels.service-controller-binding/v1"
  )
    throw new Error("Existing model controller selection is unavailable.");
  await prepareFoundationServices(
    instance,
    "local-models",
    {
      ...options,
      shareGpu: false,
      requireController: true,
    },
    dependencies,
  );
}

interface Binding {
  schema: "localmodels.service-controller-binding/v1";
  baseUrl: string;
  keyFile: string;
  bridgeRoot: string;
}
type Stored = Binding | { state: "unavailable" };

export async function prepareFoundationServices(
  instance: Instance,
  choice: SetupChoice,
  options: {
    home: string;
    shareGpu?: boolean;
    mainPlan?: boolean;
    requireController?: boolean;
    signal: AbortSignal;
    onEvent?: (event: InstallerEvent) => void;
  },
  dependencies: { run?: typeof runLocalmodels } = {},
): Promise<void> {
  const shareGpu =
    options.shareGpu ?? (await readGpuSharing(instance)) ?? DEFAULT_GPU_SHARING;
  if (options.shareGpu !== undefined)
    await writeGpuSharing(instance, options.shareGpu);
  const root = path.join(path.resolve(options.home), "runtime/model-services");
  const file = path.join(instance.root, "model-services.json");
  try {
    const result = await (dependencies.run ?? runLocalmodels)(
      options.home,
      [
        "foundations",
        "ensure",
        "--root",
        root,
        "--base-dir",
        path.join(path.resolve(options.home), "runtime/localmodels/models"),
        ...(choice === "local-models" && options.mainPlan !== false
          ? [
              "--main-plan",
              path.join(
                path.resolve(options.home),
                "runtime/localmodels/plan.json",
              ),
            ]
          : []),
        ...(shareGpu ? ["--share-gpu"] : []),
        "--json",
      ],
      { signal: options.signal, timeoutMs: 30_000 },
    );
    if (result.code !== 0) throw new Error("Controller bootstrap failed");
    const binding = JSON.parse(result.stdout) as Binding;
    const url = new URL(binding.baseUrl);
    if (
      binding.schema !== "localmodels.service-controller-binding/v1" ||
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      binding.keyFile !== path.join(root, "control.key") ||
      binding.bridgeRoot !== path.join(root, "bridge")
    )
      throw new Error("Invalid model controller binding");
    await atomicPrivate(file, JSON.stringify(binding));
  } catch {
    options.signal.throwIfAborted();
    if (options.requireController)
      throw new Error("GPU sharing revocation could not be confirmed.");
    await atomicPrivate(file, JSON.stringify({ state: "unavailable" }));
    options.onEvent?.({
      kind: "log",
      stage: "services",
      message:
        "Background model services are temporarily unavailable; application setup will continue using fallback capabilities.",
    });
  }
}
