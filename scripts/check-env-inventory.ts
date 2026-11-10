import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const INVENTORY_PATH = "scripts/env-inventory.json";
const EXAMPLE_PATH = ".env.example";

// Runtime code only: tests, fixtures and repository tooling under scripts/
// read their own variables and are not deployment configuration.
const SOURCE_PATHSPECS = [
  ":(glob)apps/*/src/**/*.ts",
  ":(glob)apps/*/src/**/*.tsx",
  ":(glob)apps/*/src/**/*.mts",
  ":(glob)apps/*/src/**/*.mjs",
  ":(glob)apps/web/vite.config.ts",
  ":(glob)apps/web/static-host.mjs",
  ":(glob)packages/*/src/**/*.ts",
  ":(glob)apps/teamhub/**/*.go",
  ":(glob)apps/computer/local-daemon/**/*.go",
  ":(exclude,glob)**/*.test.*",
  ":(exclude,glob)**/*_test.go",
  ":(exclude,glob)**/tests/**",
  ":(exclude,glob)**/testdata/**",
  ":(exclude,glob)**/e2e/**",
  ":(exclude,glob)**/*.d.ts",
];

// Process and toolchain variables that are never product configuration.
const SYSTEM_VARIABLES = new Set([
  "APPDATA",
  "CI",
  "COLUMNS",
  "COMSPEC",
  "DEV",
  "MODE",
  "PROD",
  "SSR",
  "FORCE_COLOR",
  "HOME",
  "HOSTNAME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NO_COLOR",
  "NO_PROXY",
  "OS",
  "PATH",
  "PATHEXT",
  "PROGRAMFILES",
  "PWD",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
]);

const NAME = "[A-Z][A-Z0-9_]{2,}";
const TS_PATTERNS = [
  new RegExp(`\\b(?:process\\.env|environment|env)\\.(${NAME})\\b`, "g"),
  new RegExp(
    `\\b(?:process\\.env|environment|env)\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`,
    "g",
  ),
  // Named lookup helpers: requiredEnvironment(env, "X"), Voice Runtime's
  // required("X") and Node Services' readListenAddress(env, "X", ...).
  new RegExp(
    `\\b(?:required|requiredEnvironment(?:Variable)?|readListenAddress)\\(\\s*(?:[A-Za-z_.]+\\s*,\\s*)?["'\`](${NAME})["'\`]`,
    "g",
  ),
  // Names kept as data and read later: { environmentKey: "LINGER_CODEX_PATH" }.
  new RegExp(
    `\\b\\w*[Ee]nv(?:ironment)?(?:Key|Name|Variable)\\s*:\\s*["'\`](${NAME})["'\`]`,
    "g",
  ),
];
// os.Getenv, os.LookupEnv and local helpers such as envOr or setIntEnvironment.
const GO_ENV_CALL = /\b(?:os\.Getenv|os\.LookupEnv|\w*[Ee]nv\w*)\(([^)]*)\)/g;
const GO_STRING = new RegExp(`"(${NAME})"`, "g");
// A snapshot of the process environment indexed by name: environment["HOME"].
const GO_ENVIRONMENT_INDEX = new RegExp(
  `\\b(?:environment|env)\\[\\s*"(${NAME})"\\s*\\]`,
  "g",
);
// A name kept in a constant and passed to an env call: const ConfigPathEnv = "X".
const GO_STRING_CONSTANT = new RegExp(`\\b(\\w+)\\s*=\\s*"(${NAME})"`, "g");
const GO_IDENTIFIER = /\b[A-Za-z_]\w*\b/g;

/** Variable names a Go source reads. */
export function goVariableNames(text: string): string[] {
  const constants = new Map(
    [...text.matchAll(GO_STRING_CONSTANT)].map((match) => [match[1], match[2]]),
  );
  const names = [...text.matchAll(GO_ENVIRONMENT_INDEX)].map(
    (match) => match[1],
  );
  for (const call of text.matchAll(GO_ENV_CALL)) {
    for (const match of call[1].matchAll(GO_STRING)) names.push(match[1]);
    for (const [identifier] of call[1].matchAll(GO_IDENTIFIER)) {
      const name = constants.get(identifier);
      if (name !== undefined) names.push(name);
    }
  }
  return names;
}

/** Variable names a TypeScript or JavaScript source reads. */
export function typeScriptVariableNames(text: string): string[] {
  return TS_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => match[1]),
  );
}

export interface EnvInventory {
  /**
   * Variables in .env.example that the scanner cannot see being read: external
   * programs (Compose, OpenWiki, SDKs), forwarding allowlists, dynamic names.
   * The value records who reads it.
   */
  indirect: Record<string, string>;
  /** Variables code reads that are documented elsewhere or still being cut. */
  unlisted: Record<
    string,
    { owner: string; description: string; names: string[] }
  >;
}

export async function collectCodeVariables(
  root: string,
): Promise<Map<string, Set<string>>> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--", ...SOURCE_PATHSPECS],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  const files = stdout.split("\0").filter(Boolean);
  const readers = new Map<string, Set<string>>();
  const record = (name: string, file: string) => {
    if (SYSTEM_VARIABLES.has(name)) return;
    if (!readers.has(name)) readers.set(name, new Set());
    readers.get(name)!.add(file);
  };
  await Promise.all(
    files.map(async (file) => {
      const text = await readFile(path.join(root, file), "utf8");
      if (file.endsWith(".go")) {
        for (const name of goVariableNames(text)) record(name, file);
        return;
      }
      for (const name of typeScriptVariableNames(text)) record(name, file);
    }),
  );
  return readers;
}

/** Active and commented-out assignments in .env.example. */
export function parseExampleNames(example: string): Set<string> {
  const names = new Set<string>();
  for (const line of example.split("\n")) {
    const match = /^(?:#\s*)?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

export function validateInventory(
  readers: Map<string, Set<string>>,
  exampleNames: Set<string>,
  inventory: EnvInventory,
): string[] {
  const errors: string[] = [];
  const unlistedOwner = new Map<string, string>();
  for (const [group, entry] of Object.entries(inventory.unlisted)) {
    for (const name of entry.names) {
      if (unlistedOwner.has(name))
        errors.push(
          `${name} is listed in both ${unlistedOwner.get(name)} and ${group}`,
        );
      unlistedOwner.set(name, group);
      if (exampleNames.has(name))
        errors.push(
          `${name} is in ${EXAMPLE_PATH}; remove it from ${INVENTORY_PATH} group ${group}`,
        );
      if (!readers.has(name))
        errors.push(
          `${name} in ${INVENTORY_PATH} group ${group} is no longer read by code; remove it`,
        );
    }
  }
  for (const [name, files] of [...readers].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (exampleNames.has(name) || unlistedOwner.has(name)) continue;
    errors.push(
      `${name} is read by ${[...files].sort().join(", ")} but is neither in ${EXAMPLE_PATH} nor in ${INVENTORY_PATH}`,
    );
  }
  for (const name of [...exampleNames].sort()) {
    if (readers.has(name) || SYSTEM_VARIABLES.has(name)) continue;
    if (inventory.indirect[name] !== undefined) continue;
    errors.push(
      `${name} is in ${EXAMPLE_PATH} but no code reads it; delete it, or list it under "indirect" with what reads it`,
    );
  }
  for (const name of Object.keys(inventory.indirect)) {
    if (!exampleNames.has(name))
      errors.push(
        `${name} is listed as indirect but is not in ${EXAMPLE_PATH}`,
      );
    else if (readers.has(name))
      errors.push(`${name} is read by our code; remove it from "indirect"`);
  }
  return errors;
}

export async function runEnvInventoryCheck(
  options: { root?: string; stderr?: (message: string) => void } = {},
): Promise<number> {
  const root = options.root ?? process.cwd();
  const stderr = options.stderr ?? ((message) => process.stderr.write(message));
  const [readers, example, inventory] = await Promise.all([
    collectCodeVariables(root),
    readFile(path.join(root, EXAMPLE_PATH), "utf8"),
    readFile(path.join(root, INVENTORY_PATH), "utf8").then(
      (text) => JSON.parse(text) as EnvInventory,
    ),
  ]);
  const errors = validateInventory(
    readers,
    parseExampleNames(example),
    inventory,
  );
  for (const error of errors) stderr(`env-inventory: ${error}\n`);
  return errors.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await runEnvInventoryCheck();
}
