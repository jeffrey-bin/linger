import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

const workspaceGrant = z.object({
  grantId: z.string().min(1),
  path: z.string().min(1),
  label: z.string(),
  access: z.enum(["read_write", "read_only"]),
  createdAt: z.string(),
});
export type WorkspaceGrant = z.infer<typeof workspaceGrant>;

// Non-secret desktop settings. The Gateway credential is kept apart
// (computer-credential.ts). Keys of older versions, such as sandboxMode,
// are dropped on read.
const desktopConfig = z.object({
  serverUrl: z.string().url().optional(),
  displayName: z.string().optional(),
  computerId: z.string().optional(),
  tenantId: z.string().optional(),
  ownerActorId: z.string().optional(),
  workspaceGrants: z.array(workspaceGrant).default([]),
  // Always-on mode: keep the system awake even when idle.
  preventSleep: z.boolean().default(false),
  // macOS permissions whose system prompt was shown once.
  permissionsAsked: z.array(z.enum(["folders", "automation"])).default([]),
  // The AI runtime the local server's installer set up: its executables
  // (LINGER_<RUNTIME>_PATH) and profiles (CODEX_HOME, CLAUDE_CONFIG_DIR,
  // PI_CODING_AGENT_DIR). The Computer daemon runs with them.
  runtimeEnvironment: z.record(z.string(), z.string()).optional(),
  window: z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
});
export type DesktopConfig = z.infer<typeof desktopConfig>;

export class ConfigStore {
  readonly #file: string;
  #value: DesktopConfig;

  constructor(file: string, defaults: Partial<DesktopConfig> = {}) {
    this.#file = file;
    // A damaged file falls back to defaults; the user enrolls again.
    const stored = desktopConfig.safeParse({ ...defaults, ...readJson(file) });
    this.#value = stored.success
      ? stored.data
      : desktopConfig.parse({ ...defaults });
  }

  get(): DesktopConfig {
    return this.#value;
  }

  update(patch: Partial<DesktopConfig>): DesktopConfig {
    this.#value = desktopConfig.parse({ ...this.#value, ...patch });
    mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const staged = `${this.#file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(staged, `${JSON.stringify(this.#value, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(staged, this.#file);
    return this.#value;
  }
}

const readJson = (file: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) return {};
    throw error;
  }
};
