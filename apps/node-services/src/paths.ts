import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The production bundle (apps/desktop/scripts/bundle-node-services.mjs)
// defines it as the package directory relative to each bundled entry, since
// every source file of an entry shares that entry's URL.
declare const LINGER_PACKAGE_ROOT: string | undefined;
const bundled = typeof LINGER_PACKAGE_ROOT === "string";
const fromSource = import.meta.url.endsWith(".ts");

/** The node-services package directory, from src/, the compiled dist/ or a bundle. */
export const packageRoot = path.resolve(
  fileURLToPath(new URL(bundled ? LINGER_PACKAGE_ROOT : "..", import.meta.url)),
);

/** The checkout; a bundle has none around it and runs in the checkout. */
export const repositoryRoot = bundled
  ? process.cwd()
  : path.resolve(packageRoot, "..", "..");

/** The package's prompts, which ship beside src/ and dist/. */
export const promptsRoot = path.join(packageRoot, "prompts");

/**
 * A module the services start in a worker or process, by its path under src/
 * without extension: the TypeScript source in development, else the compiled
 * or bundled JavaScript in dist/. `.mjs` files keep their name in both.
 */
export function serviceModule(name: string): URL {
  const file = name.endsWith(".mjs")
    ? name
    : `${name}.${fromSource ? "ts" : "js"}`;
  return pathToFileURL(
    path.join(packageRoot, fromSource ? "src" : "dist", file),
  );
}

/**
 * Whether the module at `url` is the file Node started. Never inside a bundle,
 * whose modules all share the URL of its entry.
 */
export function isMainModule(url: string): boolean {
  return !bundled && process.argv[1] === fileURLToPath(url);
}

/** Relative configuration paths are relative to the repository root. */
function resolveConfiguredPath(value: string): string {
  return path.resolve(repositoryRoot, value);
}

/** The Agent Service's state directory: AGENT_HOME, default ~/.mirror. */
export function mirrorHome(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.AGENT_HOME?.trim();
  return configured
    ? resolveConfiguredPath(configured)
    : path.join(os.homedir(), ".mirror");
}

/**
 * One directory per Agent. The Context Host maps parts of it into Runtimes
 * and Memory writes its projections there, so both roles resolve it here.
 */
export function contextHostRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    mirrorHome(environment),
    "agent-manager",
    "workspaces",
    "context-host",
  );
}

/** The image's Computer release: COMPUTER_RELEASE_DIR, default /app/computer-release. */
export function computerReleaseRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolveConfiguredPath(
    environment.COMPUTER_RELEASE_DIR?.trim() || "/app/computer-release",
  );
}
