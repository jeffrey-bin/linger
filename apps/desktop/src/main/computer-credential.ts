import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { z } from "zod";

// The Gateway credential of this computer. The token is secret: it is only
// passed to the daemon through its environment and never logged.
const computerCredential = z.object({
  computerId: z.string().min(1),
  gatewayUrl: z
    .string()
    .url()
    .refine((value) => /^wss?:$/.test(new URL(value).protocol)),
  token: z.string().min(32),
});
export type ComputerCredential = z.infer<typeof computerCredential>;

// An owner-only file next to the app config. Not the OS keychain: preview
// builds are signed ad hoc, so every update would ask for keychain access.
export class CredentialStore {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  // A missing or damaged file means the computer must be connected again.
  read(): ComputerCredential | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const parsed = computerCredential.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  write(credential: ComputerCredential): void {
    const value = computerCredential.parse(credential);
    mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const staged = `${this.#file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(staged, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(staged, this.#file);
  }

  clear(): void {
    rmSync(this.#file, { force: true });
  }
}
