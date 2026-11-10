#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";

function readEnvironment(file, allowMissing) {
  try {
    return parseEnv(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && allowMissing) return {};
    if (error.code === "ENOENT") {
      throw new Error(
        `Missing local environment file: ${file}. Copy .env.example or set LOCAL_ENV_FILE.`,
        { cause: error },
      );
    }
    throw error;
  }
}

// The environment of the checkout at `root`. Each layer overrides the one
// before: scripts/local-defaults.env with every fixed local default, the env
// file with personal values, then the shell.
export function localEnvironment(root, optional = false) {
  const envFile = resolve(root, process.env.LOCAL_ENV_FILE || ".env");
  const fixedDefaults = readEnvironment(
    resolve(root, "scripts/local-defaults.env"),
    true,
  );
  const personal = readEnvironment(envFile, optional);
  warnUnknownNames(root, envFile, fixedDefaults, Object.keys(personal));
  return {
    ...fixedDefaults,
    ...personal,
    ...process.env,
    LOCAL_ENV_FILE: envFile,
  };
}

// Renamed or deleted settings otherwise stay in .env unnoticed. Warn about
// every name that no list of known settings has, without stopping the start.
function warnUnknownNames(root, envFile, fixedDefaults, names) {
  const known = new Set(Object.keys(fixedDefaults));
  const example = readFileSync(resolve(root, ".env.example"), "utf8");
  for (const line of example.split("\n")) {
    const match = /^(?:#\s*)?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) known.add(match[1]);
  }
  const inventory = JSON.parse(
    readFileSync(resolve(root, "scripts/env-inventory.json"), "utf8"),
  );
  for (const name of Object.keys(inventory.indirect)) known.add(name);
  for (const group of Object.values(inventory.unlisted))
    for (const name of group.names) known.add(name);
  const unknown = names.filter((name) => !known.has(name)).sort();
  if (unknown.length === 0) return;
  const shown = relative(root, envFile);
  console.warn(
    `Warning: ${shown.startsWith("..") ? envFile : shown} sets names no service reads: ${unknown.join(", ")}. ` +
      "They are not in .env.example, scripts/env-inventory.json or scripts/local-defaults.env; rename or delete them.",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const root = resolve(import.meta.dirname, "..");
  const args = process.argv.slice(2);
  const optional = args[0] === "--optional";
  if (optional) args.shift();
  if (args[0] === "--") args.shift();
  if (!args.length)
    throw new Error("Expected a command after with-local-env.mjs");
  const environment = localEnvironment(root, optional);
  // Replace the launcher so the command keeps its PID, exit status and signal
  // handling without a supervisor. Windows has no execve; there the launcher
  // waits for the command and exits with its status. This file is copied on its
  // own, so it does not share scripts/replace-process.mjs.
  if (process.platform === "win32") {
    const line = args
      .map((value) => {
        if (/["%\r\n]/.test(value))
          throw new Error(
            "Unsupported character in a Windows command argument.",
          );
        return /^[\w./\\:=@+-]+$/.test(value) ? value : `"${value}"`;
      })
      .join(" ");
    spawn(line, {
      env: environment,
      shell: true,
      stdio: "inherit",
      windowsHide: true,
    })
      .once("error", (error) => {
        console.error(error.message);
        process.exit(1);
      })
      .once("exit", (code) => process.exit(code ?? 1));
  } else process.execve("/usr/bin/env", ["env", ...args], environment);
}
