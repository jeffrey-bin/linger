import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";
import type { CliTiming } from "./timing.js";

export interface TeamHubConfig {
  readonly url: string;
  readonly token: string;
  readonly identity?: { readonly tenantId: string; readonly agentId: string };
  /** The caller Context written by the Computer; the only Room or Task source. */
  readonly scope?: {
    readonly kind: "room" | "task" | "document" | "thread";
    readonly id: string;
  };
  /** Optional execution provenance; never an authorization requirement. */
  readonly runId?: string;
  /** Local namespace of working copies and saved pages for this Agent and
   * Context. Never sent as identity or authorization. */
  readonly identityKey: string;
  /** The same namespace without the Context. */
  readonly agentIdentityKey?: string;
}

function invalid(message: string): never {
  throw new CliError("configuration_error", message);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function privateText(filename: string, limit: number): Promise<string> {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      invalid("The configuration or credential file is invalid.");
    const content = await handle.readFile("utf8");
    if (Buffer.byteLength(content) > limit)
      invalid("The configuration or credential file is too large.");
    return content;
  } catch (error) {
    if (error instanceof CliError) throw error;
    return invalid(
      "Could not read TeamHub configuration or its credential file. Configure TEAMHUB_CONFIG or TEAMHUB_URL and TEAMHUB_TOKEN_FILE.",
    );
  } finally {
    await handle?.close();
  }
}

/** Reads a private file that may legitimately be absent. */
async function optionalPrivateText(
  filename: string,
  limit: number,
): Promise<string | undefined> {
  try {
    await lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  }
  return privateText(filename, limit);
}

const directConfiguration = (env: NodeJS.ProcessEnv): boolean =>
  [env.TEAMHUB_URL, env.TEAMHUB_TOKEN, env.TEAMHUB_TOKEN_FILE].some(
    (value) => value !== undefined,
  );

const defaultConfigurationDirectory = (env: NodeJS.ProcessEnv): string =>
  path.resolve(
    env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), ".config"),
    "teamhub",
  );

/**
 * The directory of the configuration file in use, or of the default one when
 * the service is configured directly through the environment. Local CLI state
 * such as saved connector pages lives here unless TEAMHUB_STATE_ROOT names
 * another directory, so it does not depend on the working directory.
 */
export const configurationDirectory = (env: NodeJS.ProcessEnv): string =>
  directConfiguration(env) || env.TEAMHUB_CONFIG === undefined
    ? defaultConfigurationDirectory(env)
    : path.dirname(path.resolve(env.TEAMHUB_CONFIG));

export async function loadConfig(
  env: NodeJS.ProcessEnv,
  timing?: CliTiming,
): Promise<TeamHubConfig> {
  const read = (stage: string, filename: string, limit: number) =>
    timing
      ? timing.measure(stage, () => privateText(filename, limit))
      : privateText(filename, limit);
  let urlValue: unknown;
  let tokenValue: unknown;
  let scopeValue: unknown;
  let identityValue: unknown;
  let runId: string | undefined;
  let identitySlot: string | undefined;
  if (directConfiguration(env)) {
    if (
      !env.TEAMHUB_URL ||
      (!env.TEAMHUB_TOKEN && !env.TEAMHUB_TOKEN_FILE) ||
      (env.TEAMHUB_TOKEN && env.TEAMHUB_TOKEN_FILE)
    )
      invalid(
        "Provide TEAMHUB_URL and exactly one of TEAMHUB_TOKEN_FILE or TEAMHUB_TOKEN together.",
      );
    urlValue = env.TEAMHUB_URL;
    tokenValue = env.TEAMHUB_TOKEN_FILE
      ? await read(
          "credential_file",
          path.resolve(env.TEAMHUB_TOKEN_FILE),
          8192,
        )
      : env.TEAMHUB_TOKEN;
    if (
      env.TEAMHUB_TENANT_ID !== undefined ||
      env.TEAMHUB_AGENT_ID !== undefined
    ) {
      identityValue = {
        tenant_id: env.TEAMHUB_TENANT_ID,
        agent_id: env.TEAMHUB_AGENT_ID,
      };
      identitySlot = env.TEAMHUB_TOKEN_FILE
        ? await realpath(env.TEAMHUB_TOKEN_FILE)
        : "environment";
    }
  } else {
    const configPath =
      env.TEAMHUB_CONFIG ??
      path.join(defaultConfigurationDirectory(env), "config.json");
    let config: unknown;
    try {
      config = JSON.parse(
        await read("config_file", path.resolve(configPath), 1024 * 1024),
      );
    } catch (error) {
      if (error instanceof CliError) throw error;
      invalid("TeamHub configuration must be valid JSON.");
    }
    if (!object(config) || config.version !== 1 || !object(config.profiles))
      invalid(
        "Unsupported TeamHub configuration. Expected version 1 and profiles.",
      );
    const selected = env.TEAMHUB_PROFILE ?? config.default_profile;
    if (
      typeof selected !== "string" ||
      !Object.hasOwn(config.profiles, selected) ||
      !object(config.profiles[selected])
    )
      invalid("The selected TeamHub profile does not exist.");
    const profile = config.profiles[selected];
    if (typeof profile.token_file !== "string" || !profile.token_file)
      invalid("The TeamHub profile requires token_file.");
    urlValue = profile.url;
    tokenValue = await read(
      "credential_file",
      path.resolve(path.dirname(configPath), profile.token_file),
      8192,
    );
    scopeValue = profile.scope;
    // Per-run fields live beside the config in run.json, written by the Computer.
    const runText = await optionalPrivateText(
      path.join(path.dirname(path.resolve(configPath)), "run.json"),
      64 * 1024,
    );
    if (runText !== undefined) {
      let run: unknown;
      try {
        run = JSON.parse(runText);
      } catch {
        invalid("run.json must be valid JSON.");
      }
      if (!object(run)) invalid("run.json must be a JSON object.");
      if (run.run_id !== undefined) {
        if (
          typeof run.run_id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(run.run_id)
        )
          invalid("run_id must be a valid execution reference.");
        runId = run.run_id;
      }
    }
    if (profile.tenant_id !== undefined || profile.agent_id !== undefined) {
      identityValue = profile;
      identitySlot = `${await realpath(configPath)}\0${selected}`;
    }
  }
  let url: URL;
  try {
    if (typeof urlValue !== "string") throw new Error();
    url = new URL(urlValue);
  } catch {
    invalid("The TeamHub service URL is invalid.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === "https:" || url.protocol === "http:")
  )
    invalid("Use an HTTP or HTTPS TeamHub URL without credentials.");
  const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
  if (!token || /\s/u.test(token) || token.length > 8192)
    invalid("The TeamHub credential is invalid.");
  let scope: TeamHubConfig["scope"];
  if (scopeValue !== undefined) {
    if (
      !object(scopeValue) ||
      typeof scopeValue.kind !== "string" ||
      !["room", "task", "document", "thread"].includes(scopeValue.kind) ||
      typeof scopeValue.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(scopeValue.id)
    )
      invalid("Default scope requires a supported kind and resource ID.");
    scope = {
      kind: scopeValue.kind as NonNullable<TeamHubConfig["scope"]>["kind"],
      id: scopeValue.id,
    };
  }
  const baseUrl = url.toString().replace(/\/$/u, "");
  let identity: TeamHubConfig["identity"];
  if (identityValue !== undefined) {
    if (
      !object(identityValue) ||
      typeof identityValue.tenant_id !== "string" ||
      typeof identityValue.agent_id !== "string" ||
      ![identityValue.tenant_id, identityValue.agent_id].every((value) =>
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value),
      )
    )
      invalid("A stable identity slot requires both tenant_id and agent_id.");
    identity = {
      tenantId: identityValue.tenant_id,
      agentId: identityValue.agent_id,
    };
  }
  const identitySource = identity
    ? `${identitySlot}\0${identity.tenantId}\0${identity.agentId}`
    : token;
  const agentIdentityKey = createHash("sha256")
    .update(`${baseUrl}\0${identitySource}`)
    .digest("hex");
  return {
    url: baseUrl,
    token,
    ...(scope ? { scope } : {}),
    ...(runId ? { runId } : {}),
    ...(identity ? { identity } : {}),
    agentIdentityKey,
    identityKey: scopedIdentityKey(agentIdentityKey, scope),
  };
}

/**
 * A command that addresses a Document or Thread resource sends that resource as
 * its Context. Local state stays separate per sent Context.
 */
export function withScope(
  config: TeamHubConfig,
  scope: TeamHubConfig["scope"],
): TeamHubConfig {
  return {
    ...config,
    scope,
    identityKey: scopedIdentityKey(
      config.agentIdentityKey ?? config.identityKey,
      scope,
    ),
  };
}

const scopedIdentityKey = (
  agentIdentityKey: string,
  scope: TeamHubConfig["scope"],
): string =>
  createHash("sha256")
    .update(`${agentIdentityKey}\0${scope?.kind ?? ""}\0${scope?.id ?? ""}`)
    .digest("hex");
