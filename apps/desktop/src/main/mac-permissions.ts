import { execFile } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import path from "node:path";

export type PermissionId = "full-disk" | "folders" | "automation";
export type PermissionStatus = "granted" | "denied" | "unknown";
export type PermissionStatuses = Readonly<
  Record<PermissionId, PermissionStatus>
>;

// System Settings panes (Privacy & Security) for each permission.
export const SETTINGS_URL: Readonly<Record<PermissionId, string>> = {
  "full-disk":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  folders:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
  automation:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
};

export const PROTECTED_FOLDERS = ["Downloads", "Documents", "Desktop"];

// errAEEventNotPermitted: the user (or a missing usage string) said no.
const AUTOMATION_DENIED = "-1743";

export interface PermissionProbes {
  // Resolves when the file opens; rejects with the open error.
  openFile(file: string): Promise<void>;
  listDirectory(directory: string): Promise<void>;
  // Runs AppleScript; rejects with osascript's error text.
  appleScript(script: string): Promise<void>;
}

export const nodeProbes: PermissionProbes = {
  openFile: async (file) => {
    await (await open(file, "r")).close();
  },
  listDirectory: async (directory) => {
    await readdir(directory);
  },
  appleScript: (script) =>
    new Promise((resolve, reject) => {
      // Waits while the system asks; a user who walks away gets a timeout.
      execFile(
        "/usr/bin/osascript",
        ["-e", script],
        { timeout: 120_000 },
        (error, _stdout, stderr) =>
          error ? reject(new Error(`${stderr}${error.message}`)) : resolve(),
      );
    }),
};

const denied = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES";
};

// The macOS privacy (TCC) permissions tasks run into.
// Commands that agents start count as Linger's own, so one grant here
// covers them. Asking for folders or automation shows a system prompt, so
// those are only checked after the user asked once; Full Disk Access never
// prompts and is always checked.
export class MacPermissions {
  readonly #home: string;
  readonly #probes: PermissionProbes;
  readonly #asked: () => readonly PermissionId[];
  readonly #markAsked: (id: Exclude<PermissionId, "full-disk">) => void;

  constructor(options: {
    home: string;
    asked: () => readonly PermissionId[];
    markAsked: (id: Exclude<PermissionId, "full-disk">) => void;
    probes?: PermissionProbes;
  }) {
    this.#home = options.home;
    this.#asked = options.asked;
    this.#markAsked = options.markAsked;
    this.#probes = options.probes ?? nodeProbes;
  }

  async statuses(): Promise<PermissionStatuses> {
    const fullDisk = await this.#fullDisk();
    const asked = this.#asked();
    return {
      "full-disk": fullDisk,
      folders:
        fullDisk === "granted"
          ? "granted"
          : asked.includes("folders")
            ? await this.#folders()
            : "unknown",
      automation: asked.includes("automation")
        ? await this.#automation()
        : "unknown",
    };
  }

  // Shows the system prompts for folders or automation. Full Disk Access
  // can only be granted in System Settings.
  async request(id: Exclude<PermissionId, "full-disk">): Promise<void> {
    this.#markAsked(id);
    if (id === "folders") await this.#folders();
    else await this.#automation();
  }

  // The user's TCC database opens only with Full Disk Access.
  async #fullDisk(): Promise<PermissionStatus> {
    const file = path.join(
      this.#home,
      "Library/Application Support/com.apple.TCC/TCC.db",
    );
    try {
      await this.#probes.openFile(file);
      return "granted";
    } catch (error) {
      return denied(error) ? "denied" : "unknown";
    }
  }

  async #folders(): Promise<PermissionStatus> {
    let status: PermissionStatus = "granted";
    for (const name of PROTECTED_FOLDERS) {
      try {
        await this.#probes.listDirectory(path.join(this.#home, name));
      } catch (error) {
        if (denied(error)) return "denied";
        status = "unknown";
      }
    }
    return status;
  }

  // System Events stands in for the apps tasks script; each other app asks
  // once the first time a task controls it.
  async #automation(): Promise<PermissionStatus> {
    try {
      await this.#probes.appleScript(
        'tell application "System Events" to get name of first process',
      );
      return "granted";
    } catch (error) {
      return String(error).includes(AUTOMATION_DENIED) ? "denied" : "unknown";
    }
  }
}
