import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TeamHubConfig } from "../config.js";

/**
 * Writes a private config.json profile and its token file, as the Computer
 * does. The profile scope is the only source of the caller Context, so tests
 * that need a Room or Task Context use this instead of direct environment
 * configuration. Rewriting the same directory replaces the profile.
 */
export function writeCliConfig(
  directory: string,
  options: {
    readonly scope?: TeamHubConfig["scope"];
    readonly url?: string;
    readonly token?: string;
    readonly profile?: Record<string, unknown>;
  } = {},
): NodeJS.ProcessEnv {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "token"),
    `${options.token ?? "th_agent_fixture"}\n`,
    { mode: 0o600 },
  );
  const config = path.join(directory, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      version: 1,
      default_profile: "work",
      profiles: {
        work: {
          url: options.url ?? "https://teamhub.example",
          token_file: "token",
          ...(options.scope ? { scope: options.scope } : {}),
          ...options.profile,
        },
      },
    }),
  );
  return { TEAMHUB_CONFIG: config };
}
