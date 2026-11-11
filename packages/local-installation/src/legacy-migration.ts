import { readdir } from "node:fs/promises";
import path from "node:path";
import { stopComputer } from "./computer.js";
import { INSTANCE_NAME, lingerHome } from "./home.js";
import { composeProject, withInstanceLock, type Instance } from "./instance.js";
import { stopModelGateway } from "./model-gateway.js";
import { stopNativeProcess } from "./native-process.js";
import { nativeServices } from "./native-source.js";
import { atomicPrivate, readPrivate } from "./private-files.js";

// Names that installs made while the product was named Simplex still carry.
// They identify what this one-time migration converts; nothing reads them
// after it.
const LEGACY_PROJECT_PREFIX = "simplex-";
const LEGACY_ENVIRONMENT_PREFIX = /^SIMPLEX_/gm;
// Generated instance files whose keys carried the legacy prefix. user.env is
// the person's own file and never held them.
const ENVIRONMENT_FILES = ["services.env", "livekit.env", "native.env"];

export interface LegacyMigrationOptions {
  /** The home to migrate; LINGER_HOME or ~/.simplexai by default. */
  readonly home?: string;
  /** Stops an instance's processes before its names change. */
  readonly stopInstance?: (instance: Instance) => Promise<void>;
}

/**
 * Converts an installation made while the product was named Simplex, once:
 * each instance gets its Linger project name and LINGER_* environment keys.
 * An instance that fails does not hold back the others; one error at the end
 * names every instance that is still legacy and why.
 */
export async function migrateLegacyInstallation(
  options: LegacyMigrationOptions = {},
): Promise<void> {
  const home = path.resolve(options.home ?? lingerHome());
  const stop = options.stopInstance ?? stopLegacyInstance;
  const directory = path.join(home, "instances");
  const failures: string[] = [];
  for (const name of await children(directory)) {
    if (!INSTANCE_NAME.test(name)) continue;
    const root = path.join(directory, name);
    try {
      // Converted instances are left unlocked: an installer job may hold
      // their lock while this runs at the next start.
      if (!isLegacy(await readInstance(root))) continue;
      await withInstanceLock({ root } as Instance, () =>
        migrateInstance(root, name, stop),
      );
    } catch (error) {
      failures.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length > 0)
    throw new Error(
      `Could not convert these instances to Linger names. Stop any task running in them and start Linger again.\n${failures.join("\n")}`,
    );
}

async function children(directory: string): Promise<string[]> {
  return readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  });
}

// A damaged record is not this migration's to judge, as in
// legacyMigrationPending; the installer reports it when it loads the instance.
async function readInstance(root: string): Promise<Instance | undefined> {
  const text = await readPrivate(path.join(root, "instance.json"));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Instance;
  } catch {
    return undefined;
  }
}

function isLegacy(instance: Instance | undefined): instance is Instance {
  return instance?.project?.startsWith(LEGACY_PROJECT_PREFIX) ?? false;
}

/** Stops what an instance runs from its folder, using its stored settings. */
async function stopLegacyInstance(instance: Instance): Promise<void> {
  await stopComputer(instance);
  for (const name of nativeServices)
    await stopNativeProcess(instance.root, name);
  await stopModelGateway(instance, undefined);
}

async function migrateInstance(
  root: string,
  name: string,
  stop: (instance: Instance) => Promise<void>,
): Promise<void> {
  const instance = await readInstance(root);
  if (!isLegacy(instance)) return;
  await stop(instance);
  for (const file of ENVIRONMENT_FILES) {
    const location = path.join(root, file);
    const text = await readPrivate(location);
    const renamed = text?.replace(LEGACY_ENVIRONMENT_PREFIX, "LINGER_");
    if (renamed !== text) await atomicPrivate(location, renamed!);
  }
  // Written last: the legacy project name is what marks the instance as
  // not yet migrated.
  await atomicPrivate(
    path.join(root, "instance.json"),
    JSON.stringify(
      { ...instance, project: composeProject(root, name) },
      null,
      2,
    ) + "\n",
  );
}
