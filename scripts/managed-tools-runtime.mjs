import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createManagedToolsInstaller } from "./managed-tools-install.mjs";
import { writeManagedToolsLaunchers } from "./managed-tools-launchers.mjs";

export async function prepareManagedToolsRuntime(
  environment = process.env,
  { ensureInstalled = false } = {},
) {
  const releaseId = environment.LINGER_CLI_RELEASE_ID?.trim();
  if (!releaseId) return undefined;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(releaseId) ||
    releaseId === "stable"
  )
    throw new Error("A fixed release-id is required");
  const baseUrl = environment.LINGER_CLI_RELEASES_BASE_URL?.trim();
  if (!baseUrl) throw new Error("Configure LINGER_CLI_RELEASES_BASE_URL");
  const root = path.resolve(
    environment.LINGER_TOOLS_ROOT ??
      path.join(
        environment.HOME || os.homedir(),
        ".local/share/simplexai/tools",
      ),
  );
  const requiredLev8Version =
    environment.LINGER_LEV8_VERSION?.trim() || "0.6.0";
  if (!/^\d+\.\d+\.\d+$/u.test(requiredLev8Version))
    throw new Error("Invalid LINGER_LEV8_VERSION");
  const configuration = { root, baseUrl, releaseId, requiredLev8Version };
  // Read-only Providers cannot bootstrap or repair their own tool mount. The
  // trusted Context activation completes that work before applying the policy.
  if (ensureInstalled)
    await createManagedToolsInstaller(configuration).ensureCurrent(releaseId);
  const bootstrapBin = path.join(root, "bootstrap/bin");
  await writeManagedToolsLaunchers(bootstrapBin, configuration);
  const binDirectory = path.join(root, "current/bin");
  return {
    root,
    binDirectory,
    bootstrapBin,
    readOnlyRoots: [
      path.dirname(process.execPath),
      fileURLToPath(new URL("./", import.meta.url)),
    ],
    path: [
      binDirectory,
      bootstrapBin,
      environment.PATH || "/usr/bin:/bin",
    ].join(path.delimiter),
  };
}

async function invoke(configuration, tool, args) {
  if (!["teamhub", "lev8"].includes(tool))
    throw new Error("Unknown managed tool");
  const installer = createManagedToolsInstaller(configuration);
  // Healthy immutable releases need no writes, including in read-only Contexts.
  // On repair, reselect current under the lock so a live update still wins over
  // the bootstrap release-id.
  const installed =
    (await installer.readCurrent()) ??
    (await installer.ensureCurrent(configuration.releaseId)).current;
  const packageRoot = path.join(installed.directory, tool);
  let command = path.join(packageRoot, tool);
  try {
    await access(command);
  } catch (error) {
    if (error.code !== "ENOENT" || tool !== "teamhub") throw error;
    command = process.execPath;
    args = [path.join(packageRoot, "teamhub.js"), ...args];
  }
  // Use the validated release directory, not a shell lookup or mutable pointer.
  const child = spawn(command, args, { stdio: "inherit" });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    process.exitCode = result.code ?? (result.signal === "SIGINT" ? 130 : 143);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [action, encoded, tool, ...args] = process.argv.slice(2);
    if (action === "prepare")
      writeSync(
        1,
        JSON.stringify((await prepareManagedToolsRuntime()) ?? null) + "\n",
      );
    else if (action === "invoke") await invoke(JSON.parse(encoded), tool, args);
    else if (["ensure", "update", "rollback", "status"].includes(action)) {
      const runtime = await prepareManagedToolsRuntime();
      if (!runtime) throw new Error("Configure LINGER_CLI_RELEASE_ID");
      const installer = createManagedToolsInstaller({
        root: runtime.root,
        requiredLev8Version: process.env.LINGER_LEV8_VERSION || "0.6.0",
      });
      writeSync(
        1,
        JSON.stringify(
          await installer[action](encoded ?? process.env.LINGER_CLI_RELEASE_ID),
        ) + "\n",
      );
    } else
      throw new Error(
        "Use prepare, ensure, update <release-id>, rollback or status",
      );
  } catch (error) {
    // Do not expose source URLs or arbitrary underlying download exceptions.
    console.error(
      "Managed CLI operation failed:",
      error.message.replace(/https?:\/\/\S+/gu, "[release source]"),
    );
    process.exitCode = 1;
  }
}
