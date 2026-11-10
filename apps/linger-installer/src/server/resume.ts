import { realpath } from "node:fs/promises";
import path from "node:path";

import { loadInstance } from "@linger/local-installation/instance";
import { userEnvironmentPending } from "@linger/local-installation/user-environment";
import type { InstallOutcome } from "@linger/local-installation/events";
import {
  installNativeSource,
  probeNativeSourceServices,
} from "@linger/local-installation/native-source";

export interface ResumeOptions {
  home: string;
  sourceRepo: string;
  instanceName: string;
  externalComputer?: boolean;
  signal: AbortSignal;
  log: (message: string) => void;
}

type Instance = NonNullable<Awaited<ReturnType<typeof loadInstance>>>;

export interface ResumeEngine {
  run: (
    options: Parameters<typeof installNativeSource>[0],
  ) => Promise<InstallOutcome>;
  probe: (
    instance: Instance,
    signal: AbortSignal,
  ) => Promise<{ ready: boolean }[]>;
}

// How an installed instance starts again: its native processes.
const ENGINES: Partial<Record<Instance["mode"], ResumeEngine>> = {
  "source-native": {
    run: installNativeSource,
    probe: probeNativeSourceServices,
  },
};

/**
 * Starts the services of an installed source instance again, for example
 * after a reboot. It reuses the Harness and accounts saved by the first
 * install and asks for nothing; the services outlive this process.
 */
export async function resumeSourceInstance(
  options: ResumeOptions,
  {
    load = loadInstance,
    engines = ENGINES,
    pending = userEnvironmentPending,
  } = {},
): Promise<InstallOutcome> {
  const instance = await load({
    name: options.instanceName,
    home: options.home,
  });
  const engine = instance && engines[instance.mode];
  if (!instance?.source || !engine)
    return {
      code: 4,
      state: "action_required",
      message: `No source instance named ${options.instanceName}.`,
    };
  // A desktop update ships a new source tree, and a changed user.env new
  // keys; running services keep the old ones until they restart.
  const repo = await realpath(options.sourceRepo).catch(() =>
    path.resolve(options.sourceRepo),
  );
  if (
    (!instance.source || instance.source.repo === repo) &&
    (await engine.probe(instance, options.signal)).every(
      (check) => check.ready,
    ) &&
    !(await pending(instance))
  )
    return {
      code: 0,
      state: "ready",
      message: "Services are already running.",
      details: { origin: instance.origin },
    };
  const outcome = await engine.run({
    name: instance.name,
    home: options.home,
    repo: options.sourceRepo,
    externalComputer: options.externalComputer,
    signal: options.signal,
    onEvent: (event) => {
      if (event.message) options.log(event.message);
    },
  });
  return outcome.code === 0
    ? {
        ...outcome,
        details: {
          ...(outcome.details as object | undefined),
          origin: instance.origin,
        },
      }
    : outcome;
}
