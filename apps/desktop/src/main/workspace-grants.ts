import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceGrant } from "./config.js";
import type { Module, ModuleContext } from "./modules.js";

export interface WorkspaceGrantsOptions {
  // System folder picker. Paths never come from the renderer.
  readonly pickDirectory: () => Promise<string | undefined>;
  // Granted automatically once this computer is connected and nothing else
  // is, so Agents can be created without a setup step. Created if missing.
  readonly defaultDirectory?: string;
}

export class WorkspaceGrantsModule implements Module {
  readonly name = "WorkspaceGrants";
  readonly dependsOn = ["Config"];
  readonly #options: WorkspaceGrantsOptions;
  #ctx: ModuleContext | undefined;
  #offComputerChanged: (() => void) | undefined;

  constructor(options: WorkspaceGrantsOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    this.#offComputerChanged = ctx.bus.on("computer.changed", (computerId) => {
      if (computerId) void this.#ensureDefault();
    });
    if (ctx.config.get().computerId) await this.#ensureDefault();
  }

  async stop(): Promise<void> {
    this.#offComputerChanged?.();
  }

  list(): WorkspaceGrant[] {
    return [...this.#ctx!.config.get().workspaceGrants];
  }

  async pick(): Promise<WorkspaceGrant | null> {
    const picked = await this.#options.pickDirectory();
    if (!picked) return null;
    return this.add(picked);
  }

  async add(directory: string): Promise<WorkspaceGrant> {
    const ctx = this.#ctx!;
    const resolved = await realpath(directory);
    if (!(await stat(resolved)).isDirectory())
      throw new Error("Workspace must be a directory");
    const existing = this.list().find((g) => g.path === resolved);
    if (existing) return existing;
    const grant: WorkspaceGrant = {
      grantId: `grant_${randomUUID()}`,
      path: resolved,
      label: path.basename(resolved) || resolved,
      access: "read_write",
      createdAt: new Date().toISOString(),
    };
    ctx.config.update({ workspaceGrants: [...this.list(), grant] });
    ctx.bus.emit("grants.changed");
    ctx.log.info("workspace_grant.added", { grant_id: grant.grantId });
    return grant;
  }

  async #ensureDefault(): Promise<void> {
    const directory = this.#options.defaultDirectory;
    if (!directory || this.list().length > 0) return;
    try {
      await mkdir(directory, { recursive: true, mode: 0o755 });
      await this.add(directory);
    } catch (error) {
      this.#ctx!.log.warn("workspace_grant.default_failed", {
        error: String(error),
      });
    }
  }

  revoke(grantId: string): void {
    const ctx = this.#ctx!;
    const remaining = this.list().filter((g) => g.grantId !== grantId);
    if (remaining.length === this.list().length) return;
    ctx.config.update({ workspaceGrants: remaining });
    ctx.bus.emit("grants.changed");
    ctx.log.info("workspace_grant.revoked", { grant_id: grantId });
  }
}
