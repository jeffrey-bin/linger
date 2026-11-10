export interface ManagedToolsRelease {
  releaseId: string;
  platform: string;
  versions: { teamhub: string; lev8: string };
  directory: string;
}

export interface ManagedToolsStatus {
  current: ManagedToolsRelease | null;
  previous: ManagedToolsRelease | null;
  /** Managed pointers with missing or invalid release data. */
  corrupt?: Partial<Record<"current" | "previous", string>>;
}

export interface ManagedToolsInstallerOptions {
  root?: string;
  baseUrl?: string;
  requiredLev8Version?: string;
  detectPlatform?: () => Promise<string>;
  lockTimeoutMs?: number;
  /** Smoke deadline, followed by a 250ms SIGTERM grace before SIGKILL. */
  smokeTimeoutMs?: number;
  /** Fault-injection seam; called while holding the installation lock. */
  onSwitch?: (
    phase: "prepared" | "current" | "previous",
  ) => void | Promise<void>;
}

export function createManagedToolsInstaller(
  options?: ManagedToolsInstallerOptions,
): {
  /** Validate the current immutable release without locks or filesystem writes. */
  readCurrent(): Promise<ManagedToolsRelease | null>;
  ensure(releaseId: string): Promise<ManagedToolsStatus>;
  /** Select and repair current under the same lock; fallback only if absent. */
  ensureCurrent(fallbackReleaseId: string): Promise<ManagedToolsStatus>;
  update(releaseId: string): Promise<ManagedToolsStatus>;
  rollback(): Promise<ManagedToolsStatus>;
  status(): Promise<ManagedToolsStatus>;
};

export function detectManagedToolsPlatform(
  probe?: (command: string, args: string[]) => Promise<string>,
): Promise<string>;
