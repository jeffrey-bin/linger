import { contextHostRoot } from "../paths.js";
import { localTimeZone } from "./date.js";
import { serviceCredential } from "@linger/service-kit/node";

export interface MemoryScheduleConfig {
  readonly concurrency: number;
  /** The process time zone; days and the hourly calendar turn over in it. */
  readonly timeZone: string;
  readonly weeklyDay: number;
}

export interface MemoryConfig {
  readonly dataRoot: string;
  readonly schedule: MemoryScheduleConfig;
  readonly serviceToken: string;
}

export function readMemoryConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MemoryConfig {
  return Object.freeze({
    dataRoot: contextHostRoot(environment),
    schedule: Object.freeze({
      concurrency: 4,
      timeZone: localTimeZone(),
      weeklyDay: 1,
    }),
    serviceToken: requiredServiceCredential(environment),
  });
}

function requiredServiceCredential(environment: NodeJS.ProcessEnv): string {
  const credential = serviceCredential("node-services-internal", environment);
  if (!credential) throw new TypeError("LINGER_SECRET_SEED is required");
  return credential;
}
