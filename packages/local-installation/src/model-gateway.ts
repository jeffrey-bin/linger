/** localmodels owns gateway installation and provider credential handling. */
import path from "node:path";
import { lstat, rm } from "node:fs/promises";
import { atomicPrivate, readPrivate, type Instance } from "./instance.js";
import { runLocalmodels } from "./localmodels-tool.js";
import { localmodelsFailure } from "./localmodels-failure.js";
import {
  setupSelection,
  type SetupChoice,
  type SetupSelection,
} from "./setup-plan.js";
import type { InstallerEvent } from "./events.js";

interface LocalGateway {
  schema: "localmodels.service-controller-binding/v1";
  baseUrl: string;
  keyFile: string;
  bridgeRoot: string;
}
function validateLocal(instance: Instance, value: unknown): LocalGateway {
  const binding = value as LocalGateway;
  const control = path.join(
    path.resolve(instance.root, "../.."),
    "runtime/model-services",
  );
  if (
    !binding ||
    binding.schema !== "localmodels.service-controller-binding/v1" ||
    binding.keyFile !== path.join(control, "control.key") ||
    binding.bridgeRoot !== path.join(control, "bridge")
  )
    throw new Error("Invalid local stack gateway descriptor.");
  const url = new URL(binding.baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Invalid local stack gateway address.");
  return {
    schema: binding.schema,
    baseUrl: url.origin,
    keyFile: binding.keyFile,
    bridgeRoot: binding.bridgeRoot,
  };
}
async function validateLocalKey(
  instance: Instance,
  value: unknown,
): Promise<void> {
  const binding = validateLocal(instance, value);
  const directory = await lstat(path.dirname(binding.keyFile));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (directory.uid !== process.getuid?.() || directory.mode & 0o077))
  )
    throw new Error("Unsafe local stack gateway directory.");
  const raw = await readPrivate(binding.keyFile);
  let key: unknown;
  try {
    key = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error("Invalid local stack gateway credential.");
  }
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(key))
    throw new Error("Invalid local stack gateway credential.");
}
interface Dependencies {
  run?: typeof runLocalmodels;
}
const root = (instance: Instance) => path.join(instance.root, "model-gateway");
const descriptorFile = (instance: Instance) =>
  path.join(instance.root, "model-gateway.json");
/**
 * Only the local model source needs an application gateway, whichever runtime
 * serves it. A runtime on its own sign-in or API key needs none; a gateway an
 * earlier release started for it is stopped and its descriptor removed. Its
 * private directory is kept.
 */
export async function prepareModelGateway(
  instance: Instance,
  choice: SetupChoice | SetupSelection,
  options: {
    home: string;
    signal: AbortSignal;
    onEvent?: (event: InstallerEvent) => void;
  },
  dependencies: Dependencies = {},
): Promise<void> {
  if (setupSelection(choice).modelSource !== "local")
    return retireModelGateway(instance, options, dependencies);
  // The SDK controller fronts the approved stack's existing Magpie catalog.
  const raw = await readPrivate(
    path.join(instance.root, "model-services.json"),
  );
  if (!raw)
    throw new Error("The local stack application gateway is not prepared.");
  const binding = validateLocal(instance, JSON.parse(raw));
  await validateLocalKey(instance, binding);
  await atomicPrivate(descriptorFile(instance), JSON.stringify(binding));
}
async function retireModelGateway(
  instance: Instance,
  options: { signal: AbortSignal; onEvent?: (event: InstallerEvent) => void },
  dependencies: Dependencies,
): Promise<void> {
  const owned = await readPrivate(path.join(root(instance), "gateway.json"));
  if (owned) {
    options.onEvent?.({
      kind: "log",
      stage: "runtime",
      message:
        "Stopping the application model gateway from an earlier installation; this runtime no longer needs it.",
    });
    try {
      await stopModelGateway(instance, options.signal, dependencies);
    } catch (error) {
      options.signal.throwIfAborted();
      // A gateway that keeps running is unused; setup does not depend on it.
      options.onEvent?.({
        kind: "log",
        stage: "runtime",
        message: `The earlier application model gateway could not be stopped: ${(error as Error).message}`,
      });
    }
  }
  await rm(descriptorFile(instance), { force: true });
}
export async function stopModelGateway(
  instance: Instance,
  signal: AbortSignal | undefined,
  dependencies: Dependencies = {},
): Promise<void> {
  // Only earlier releases started an owned gateway; the local stack and its
  // model controller have their own lifecycle owners.
  if (!(await readPrivate(path.join(root(instance), "gateway.json")))) return;
  const args = ["gateway", "stop", "--root", root(instance), "--json"];
  const result = await (dependencies.run ?? runLocalmodels)(
    path.resolve(instance.root, "../.."),
    args,
    { signal, timeoutMs: 30_000 },
  );
  if (result.code !== 0) {
    const { cause } = localmodelsFailure(args, result);
    throw new Error(
      cause
        ? `The owned model gateway could not be stopped: ${cause}`
        : "The owned model gateway could not be stopped.",
    );
  }
}
