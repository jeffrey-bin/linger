import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import type { Instance } from "./instance.js";
import {
  atomicPrivate,
  privateDirectory,
  readPrivate,
} from "./private-files.js";

// The only names a person sets for an instance. Everything else the
// installer generates (ports, seeds, database addresses) or does not read.
export const USER_ENVIRONMENT_KEYS = [
  "COMPOSIO_API_KEY",
  "SONIOX_API_KEY",
  "XAI_API_KEY",
  "TZ",
] as const;
export type UserEnvironmentKey = (typeof USER_ENVIRONMENT_KEYS)[number];
export type UserEnvironment = Partial<Record<UserEnvironmentKey, string>>;

const TEMPLATE = `# Your own keys for this Linger instance. Linger reads only the names below
# and keeps this file through upgrades and reinstalls. After a change, quit
# and reopen the Linger app. Keep it private (chmod 600).

# Connected apps such as Gmail, GitHub and Slack (Composio).
COMPOSIO_API_KEY=
# Recording, dictation and meeting transcripts (Soniox).
SONIOX_API_KEY=
# Grok Live voice mode (xAI); it does not need Soniox.
XAI_API_KEY=
# Time zone of the services, for example America/New_York.
TZ=
`;

export function userEnvironmentFile(root: string): string {
  return path.join(root, "user.env");
}

// install.ts shows the message of an error with this code as it is: it says
// which file to fix and how.
export const USER_ENVIRONMENT_INVALID = "USER_ENVIRONMENT_INVALID";
function invalid(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), {
    code: USER_ENVIRONMENT_INVALID,
  });
}

function isUserKey(name: string): name is UserEnvironmentKey {
  return (USER_ENVIRONMENT_KEYS as readonly string[]).includes(name);
}

async function readUserFile(root: string): Promise<string | undefined> {
  const file = userEnvironmentFile(root);
  try {
    return await readPrivate(file);
  } catch (cause) {
    throw invalid(
      `${file} must be a regular file you own that only you can read (chmod 600 ${file}).`,
      cause,
    );
  }
}

/**
 * The keys set in the instance's user.env, empty ones left out. A missing
 * file is created from a commented template so people find where keys go.
 * Starting the services does not change an existing one; only the desktop
 * setup page (updateUserKeys) and adoptUserEnvironment edit it. Names outside
 * USER_ENVIRONMENT_KEYS, installer-managed ones included, are ignored with a
 * warning.
 */
export async function readUserEnvironment(
  root: string,
  onWarning: (message: string) => void = () => {},
): Promise<UserEnvironment> {
  const contents = await readUserFile(root);
  if (contents === undefined) {
    await atomicPrivate(userEnvironmentFile(root), TEMPLATE);
    return {};
  }
  const values: UserEnvironment = {};
  for (const [name, raw] of Object.entries(parseEnv(contents))) {
    if (!isUserKey(name)) {
      onWarning(
        `user.env sets ${name}, which Linger does not take from there; it is ignored. Only ${USER_ENVIRONMENT_KEYS.join(", ")} are read.`,
      );
      continue;
    }
    const value = (raw ?? "").trim();
    if (!value) continue;
    if (/[\r\n\0']/.test(value))
      throw invalid(
        `${name} in ${userEnvironmentFile(root)} contains a newline or a single quote.`,
      );
    values[name] = value;
  }
  return values;
}

export function voiceEnabled(values: UserEnvironment): boolean {
  return Boolean(values.SONIOX_API_KEY || values.XAI_API_KEY);
}

/**
 * Whether user.env holds other keys than the generated configuration the
 * services last started with, so they need a restart to take them.
 */
export async function userEnvironmentPending(
  instance: Instance,
): Promise<boolean> {
  const generated = await readPrivate(path.join(instance.root, "native.env"));
  if (generated === undefined) return true;
  const applied = parseEnv(generated);
  const wanted = await readUserEnvironment(instance.root);
  return USER_ENVIRONMENT_KEYS.some(
    (key) => (wanted[key] ?? "") !== (applied[key]?.trim() ?? ""),
  );
}

/**
 * Moves the keys an older configuration file carried into the instance's
 * user.env, keeping any key user.env already sets, then deletes that file.
 * Returns the names it moved; onIgnored gets the names of the other values
 * the file set, which are not kept anywhere.
 */
export async function adoptUserEnvironment(
  root: string,
  legacyFile: string,
  onIgnored: (names: string[]) => void = () => {},
): Promise<UserEnvironmentKey[]> {
  let contents: string;
  try {
    contents = await readFile(legacyFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ignored: string[] = [];
  const found = Object.entries(parseEnv(contents)).flatMap(([name, raw]) => {
    const value = (raw ?? "").trim();
    if (!value) return [];
    if (isUserKey(name) && !/[\r\n\0']/.test(value))
      return [[name, value] as const];
    ignored.push(name);
    return [];
  });
  if (ignored.length) onIgnored(ignored);
  const moved: UserEnvironmentKey[] = [];
  if (found.length) {
    await privateDirectory(root);
    let text = (await readUserFile(root)) ?? TEMPLATE;
    const existing = parseEnv(text);
    for (const [name, value] of found) {
      if (existing[name]?.trim()) continue;
      const line = `${name}='${value}'`;
      const pattern = new RegExp(`^${name}=.*$`, "m");
      text = pattern.test(text)
        ? text.replace(pattern, () => line)
        : `${text.endsWith("\n") ? text : `${text}\n`}${line}\n`;
      moved.push(name);
    }
    await atomicPrivate(userEnvironmentFile(root), text);
  }
  await rm(legacyFile, { force: true });
  return moved;
}

// The keys a person can type into the desktop app's setup page. TZ stays a
// file-only setting.
export const USER_KEY_NAMES = [
  "COMPOSIO_API_KEY",
  "SONIOX_API_KEY",
  "XAI_API_KEY",
] as const;
export type UserKeyName = (typeof USER_KEY_NAMES)[number];
export type UserKeys = Partial<Record<UserKeyName, string>>;
// Provider keys are short ASCII tokens; anything else is a paste mistake,
// and the env files the services read cannot quote it.
const KEY_VALUE = /^[A-Za-z0-9._~+/=:-]{1,512}$/;

/** Throws unless every entry names a user key and holds a key or "". */
export function validateUserKeyChanges(
  value: unknown,
): asserts value is UserKeys {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid keys");
  for (const [name, key] of Object.entries(value)) {
    if (!(USER_KEY_NAMES as readonly string[]).includes(name))
      throw new Error("Invalid keys");
    if (typeof key !== "string" || (key !== "" && !KEY_VALUE.test(key)))
      throw new Error(`${name} is not a valid key`);
  }
}

/**
 * Saves keys in the user.env of the instance at `root`, before or after it
 * is installed: a key replaces the set one, "" clears it and a missing name
 * keeps it. Every other line, TZ and comments included, stays as it is.
 * Returns the names now set. The file is replaced atomically and owner-only,
 * so this works while services run; they take it when they restart.
 */
export async function updateUserKeys(
  root: string,
  changes: UserKeys,
): Promise<UserKeyName[]> {
  validateUserKeyChanges(changes);
  await privateDirectory(path.dirname(root));
  await privateDirectory(root);
  let text = (await readUserFile(root)) ?? TEMPLATE;
  for (const [name, value] of Object.entries(changes)) {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^${name}=.*$`, "gm");
    text = pattern.test(text)
      ? text.replace(pattern, () => line)
      : `${text.endsWith("\n") || !text ? text : `${text}\n`}${line}\n`;
  }
  await atomicPrivate(userEnvironmentFile(root), text);
  const set = parseEnv(text);
  return USER_KEY_NAMES.filter((name) => set[name]?.trim());
}
