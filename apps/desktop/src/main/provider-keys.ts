import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

// The personal provider keys the setup page takes, by the names the services
// read. The installer keeps them in the instance's user.env, which a person
// can also edit by hand.
export const PROVIDER_KEYS = {
  composio: "COMPOSIO_API_KEY",
  soniox: "SONIOX_API_KEY",
  xai: "XAI_API_KEY",
} as const;
export type KeyProvider = keyof typeof PROVIDER_KEYS;

// Edits from the setup page: a key replaces the saved one, "" removes it
// and an absent provider keeps it.
export type ProviderKeyChanges = Partial<Record<KeyProvider, string>>;

export const userEnvironmentFile = (home: string, instance: string): string =>
  path.join(home, "instances", instance, "user.env");

// The keys saved in `home`, by provider; unreadable counts as none.
export function savedProviderKeys(
  home: string,
  instance: string,
): Partial<Record<KeyProvider, string>> {
  let saved: Record<string, string | undefined>;
  try {
    saved = parseEnv(readFileSync(userEnvironmentFile(home, instance), "utf8"));
  } catch {
    return {};
  }
  const keys: Partial<Record<KeyProvider, string>> = {};
  for (const [provider, name] of Object.entries(PROVIDER_KEYS))
    if (saved[name]?.trim()) keys[provider as KeyProvider] = saved[name].trim();
  return keys;
}

// The installer's own input for the same edits.
export const installerKeyChanges = (
  changes: ProviderKeyChanges,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(changes).map(([provider, key]) => [
      PROVIDER_KEYS[provider as KeyProvider],
      key,
    ]),
  );
