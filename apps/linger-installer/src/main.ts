import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { launchInstaller } from "./server/launch.js";
export { startInstallerServer } from "./server/server.js";
export { launchInstaller } from "./server/launch.js";
export function parseInstallerArguments(args: string[]) {
  const options: {
    home: string;
    sourceRepo?: string;
    externalComputer?: boolean;
    instanceName?: string;
    port?: number;
    noOpen?: boolean;
    resume?: boolean;
    inspect?: boolean;
    userKeys?: boolean;
  } = {
    home: process.env.LINGER_HOME ?? path.join(homedir(), ".simplexai"),
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--no-open") {
      options.noOpen = true;
      continue;
    }
    if (flag === "--resume") {
      options.resume = true;
      continue;
    }
    if (flag === "--inspect") {
      options.inspect = true;
      continue;
    }
    if (flag === "--user-keys") {
      options.userKeys = true;
      continue;
    }
    if (flag === "--external-computer") {
      options.externalComputer = true;
      continue;
    }
    if (
      !["--home", "--port", "--source-repo", "--instance"].includes(flag ?? "")
    )
      throw new Error("Invalid installer option.");
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new Error("Installer option is missing a value.");
    if (flag === "--home") options.home = path.resolve(value);
    else if (flag === "--source-repo") options.sourceRepo = path.resolve(value);
    else if (flag === "--instance") {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(value))
        throw new Error("Invalid instance name.");
      options.instanceName = value;
    } else {
      const port = Number(value);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
        throw new Error("Invalid installer port.");
      options.port = port;
    }
  }
  if (!options.sourceRepo && !options.inspect && !options.userKeys)
    throw new Error("The installer needs a source checkout (--source-repo).");
  if (options.resume && !options.instanceName)
    throw new Error("Resume needs a source checkout and an instance.");
  if (options.userKeys && !options.instanceName)
    throw new Error("Keys need an instance.");
  return options;
}
// The desktop client shows this line, so it carries the real cause; only an
// access error points at permissions.
export function startFailure(error: unknown) {
  const code = (error as { code?: unknown } | undefined)?.code;
  const reason =
    error instanceof Error ? error.message.split("\n")[0]!.slice(0, 300) : "";
  if (code === "EACCES" || code === "EPERM")
    return `Installer could not start: ${reason} Check the installation package and home directory permissions.`;
  return `Installer could not start${typeof code === "string" && code ? ` (${code})` : ""}: ${reason || "unknown error."}`;
}
const failedToStart = (error: unknown) => {
  process.stderr.write(`${startFailure(error)}\n`);
  process.exitCode = 1;
};
async function resume(options: ReturnType<typeof parseInstallerArguments>) {
  // Headless restart for the desktop client: progress on stderr, the outcome
  // as one JSON line on stdout.
  const { resumeSourceInstance } = await import("./server/resume.js");
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  const outcome = await resumeSourceInstance({
    home: options.home,
    sourceRepo: options.sourceRepo!,
    instanceName: options.instanceName!,
    externalComputer: options.externalComputer,
    signal: controller.signal,
    log: (message) => process.stderr.write(message.replace(/\n?$/, "\n")),
  }).catch((error: unknown) => ({
    code: 1,
    state: "failed",
    message: error instanceof Error ? error.message : String(error),
    details: undefined,
  }));
  // Detached service processes may keep handles open; exit once flushed.
  process.stdout.write(`${JSON.stringify(outcome)}\n`, () =>
    process.exit(outcome.code),
  );
}
// Headless check of this computer for the desktop client: the setup report
// as one JSON line on stdout.
async function inspect(options: ReturnType<typeof parseInstallerArguments>) {
  const { inspectSetup } =
    await import("@linger/local-installation/setup-plan");
  const startedAt = Date.now();
  // The desktop logs stderr, so a slow check says which part was slow.
  const report = await inspectSetup({
    home: options.home,
    signal: AbortSignal.timeout(10 * 60_000),
    onEvent: (event) => {
      if (event.kind === "log")
        process.stderr.write(event.message.replace(/\n?$/, "\n"));
    },
  }).catch(() => null);
  process.stderr.write(
    `Checked this computer in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.\n`,
  );
  process.stdout.write(`${JSON.stringify(report)}\n`, () =>
    process.exit(report ? 0 : 1),
  );
}
// Headless key update for the desktop client: the changes arrive as JSON on
// stdin so keys never appear in process arguments, and the names now set in
// the instance's user.env leave as one JSON line on stdout. Values are never
// echoed.
export async function saveUserKeys(
  options: { home: string; instanceName?: string },
  input: string,
): Promise<{ saved: string[] } | { error: string }> {
  const [{ instanceRoot }, { updateUserKeys }] = await Promise.all([
    import("@linger/local-installation/instance"),
    import("@linger/local-installation/user-environment"),
  ]);
  try {
    let changes: unknown;
    try {
      changes = JSON.parse(input);
    } catch {
      throw new Error("Invalid keys");
    }
    const saved = await updateUserKeys(
      instanceRoot({ name: options.instanceName!, home: options.home }),
      changes as never,
    );
    return { saved };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Cannot save keys",
    };
  }
}
async function userKeys(options: ReturnType<typeof parseInstallerArguments>) {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const outcome = await saveUserKeys(options, input);
  process.stdout.write(`${JSON.stringify(outcome)}\n`, () =>
    process.exit("error" in outcome ? 1 : 0),
  );
}
async function serve(options: ReturnType<typeof parseInstallerArguments>) {
  const server = await launchInstaller({
    ...options,
    sourceRepo: options.sourceRepo!,
  });
  process.stdout.write(
    `Installer is running at ${server.origin}\nOpen the private launcher in your browser: ${path.join(options.home, "installer", "launch.html")}\nOn a remote Linux host, forward the installer port over SSH and open the private launcher on your computer.\n`,
  );
  const stop = () => {
    void server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await server.closed;
}
// A packaged installer (the desktop client bundles one) carries the
// publisher's pinned localmodels, native PostgreSQL and Native voice tools
// next to it, in distribution.json.
export async function loadPublishedSources(
  file: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const [
    { readPublishedTool },
    { readPublishedNativeSources, readPublishedVoiceTools },
  ] = await Promise.all([
    import("@linger/local-installation/localmodels-tool"),
    import("@linger/local-installation/native-dependencies"),
  ]);
  const tool = await readPublishedTool(file);
  if (tool && !environment.LINGER_LOCALMODELS_TOOL_JSON)
    environment.LINGER_LOCALMODELS_TOOL_JSON = JSON.stringify(tool);
  const native = await readPublishedNativeSources(file);
  if (native && !environment.LINGER_NATIVE_DEPENDENCIES_JSON)
    environment.LINGER_NATIVE_DEPENDENCIES_JSON = JSON.stringify(native);
  const voice = await readPublishedVoiceTools(file);
  if (voice && !environment.LINGER_NATIVE_VOICE_TOOLS_JSON)
    environment.LINGER_NATIVE_VOICE_TOOLS_JSON = JSON.stringify(voice);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let options: ReturnType<typeof parseInstallerArguments> | undefined;
  try {
    options = parseInstallerArguments(process.argv.slice(2));
    await loadPublishedSources(
      fileURLToPath(new URL("distribution.json", import.meta.url)),
    );
  } catch (error) {
    failedToStart(error);
  }
  if (options?.userKeys) await userKeys(options);
  else if (options?.inspect) await inspect(options);
  else if (options?.resume) await resume(options);
  else if (options) await serve(options).catch(failedToStart);
}
