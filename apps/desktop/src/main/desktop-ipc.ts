import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";

import {
  IPC,
  type ComputerStatus,
  type DesktopSettings,
  type LocalAccountSignIn,
  type WorkspaceGrantView,
} from "../shared/api.js";
import type { ComputerDaemonModule } from "./computer-daemon.js";
import type { WorkspaceGrant } from "./config.js";
import type { EnrollmentModule } from "./enrollment.js";
import type { LocalServerModule } from "./local-server.js";
import type { Module, ModuleContext } from "./modules.js";
import { sameOrigin } from "./navigation.js";
import type { PowerGuardModule } from "./power-guard.js";
import {
  runDesktopPermissionStep,
  type DesktopPermissionHost,
} from "./system-permissions.js";
import type { WindowManagerModule } from "./window-manager.js";
import type { WorkspaceGrantsModule } from "./workspace-grants.js";

const grantIdInput = z.string().min(1).max(128);
// The server address is not settable from the SPA: a page served by one
// server must not be able to repoint the app. It changes on app://offline.
const settingsPatchInput = z
  .object({ displayName: z.string().min(1).max(120).optional() })
  .strict();

const permissionId = z.enum(["screen_recording", "accessibility"]);
const permissionStepInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("prompt"),
      subject: z.literal("linger"),
      permission: permissionId,
    })
    .strict(),
  z
    .object({
      action: z.literal("open_settings"),
      subject: z.enum(["linger", "computer_use"]),
      permission: permissionId,
    })
    .strict(),
  z
    .object({ action: z.literal("relaunch"), subject: z.literal("linger") })
    .strict(),
]);

const view = (grant: WorkspaceGrant): WorkspaceGrantView => ({ ...grant });

// The preload API handlers. Every call must come from a frame on
// the configured server origin; inputs are validated with zod.
export class DesktopIpcModule implements Module {
  readonly name = "DesktopIpc";
  readonly dependsOn = [
    "Enrollment",
    "LocalServer",
    "PowerGuard",
    "ComputerDaemon",
    "WindowManager",
    "WorkspaceGrants",
  ];
  readonly #defaultDisplayName: string;
  // Set on macOS only.
  readonly #permissions: DesktopPermissionHost | undefined;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: {
    defaultDisplayName: string;
    permissions?: DesktopPermissionHost;
  }) {
    this.#defaultDisplayName = options.defaultDisplayName;
    this.#permissions = options.permissions;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const daemon = ctx.get<ComputerDaemonModule>("ComputerDaemon");
    const enrollment = ctx.get<EnrollmentModule>("Enrollment");
    const grants = ctx.get<WorkspaceGrantsModule>("WorkspaceGrants");
    const windows = ctx.get<WindowManagerModule>("WindowManager");
    const power = ctx.get<PowerGuardModule>("PowerGuard");
    const localServer = ctx.get<LocalServerModule>("LocalServer");

    const status = (): ComputerStatus => {
      const computerId = ctx.config.get().computerId;
      return {
        bridge: daemon.connection(),
        runtime: daemon.state(),
        ...(computerId ? { computerId } : {}),
        activeOperations: daemon.running(),
        preventSleep: power.active(),
      };
    };
    const settings = (): DesktopSettings => {
      const config = ctx.config.get();
      return {
        serverUrl: config.serverUrl ?? "",
        displayName: config.displayName ?? this.#defaultDisplayName,
      };
    };
    const handle = (
      channel: string,
      handler: (...args: unknown[]) => unknown,
    ): void => {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args) => {
        const serverUrl = ctx.config.get().serverUrl;
        const origin = event.senderFrame?.origin;
        if (!serverUrl || !origin || !sameOrigin(origin, serverUrl)) {
          ctx.log.warn("ipc.rejected_origin", { channel });
          throw new Error("Not allowed");
        }
        return handler(...args);
      });
      this.#unsubscribe.push(() => ipcMain.removeHandler(channel));
    };

    handle(IPC.computerStatus, () => status());
    handle(IPC.computerEnroll, () => enrollment.enroll());
    handle(IPC.computerUnenroll, () => enrollment.unenroll());
    handle(IPC.workspacePick, async () => {
      const grant = await grants.pick();
      return grant ? view(grant) : null;
    });
    handle(IPC.workspaceList, () => grants.list().map(view));
    handle(IPC.workspaceRevoke, (grantId) => {
      grants.revoke(grantIdInput.parse(grantId));
    });
    handle(IPC.settingsGet, () => settings());
    handle(IPC.settingsSet, (patch) => {
      const before = settings().displayName;
      ctx.config.update(settingsPatchInput.parse(patch));
      // The daemon announces the name; a new name restarts it when idle.
      if (settings().displayName !== before) ctx.bus.emit("computer.renamed");
      return settings();
    });

    // The handler already checked that the caller is the window's server, so
    // only the window's server needs to be the installed one.
    handle(IPC.localAccountAvailable, () => localServer.servesWindow());
    handle(IPC.localAccountSignIn, async (): Promise<LocalAccountSignIn> => {
      try {
        await localServer.signInWithAccount();
        ctx.log.info("local_server.account_signed_in", {});
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log.warn("local_server.account_sign_in_failed", { error: message });
        return { ok: false, message };
      }
    });

    const permissions = this.#permissions;
    if (permissions)
      handle(IPC.permissionAct, (step) =>
        runDesktopPermissionStep(permissions, permissionStepInput.parse(step)),
      );

    const push = (): void => {
      windows.webContents()?.send(IPC.computerStatusEvent, status());
    };
    this.#unsubscribe.push(
      ctx.bus.on("computer.connection", push),
      ctx.bus.on("runtime.state", push),
      ctx.bus.on("runtime.activity", push),
      ctx.bus.on("power.changed", push),
      ctx.bus.on("computer.changed", push),
    );
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) off();
  }
}
