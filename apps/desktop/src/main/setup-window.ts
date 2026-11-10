import {
  BrowserWindow,
  Notification,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
  type IpcMainInvokeEvent,
  type Session,
} from "electron";
import os from "node:os";
import path from "node:path";

import iconPng from "../../resources/icon.png";
// The Linger logo with its wordmark, for the page header.
import logoPng from "../../resources/logo-horizontal.png";
// The installer's welcome scene, so setup looks like the installer.
import scenePng from "../../../linger-installer/public/onboarding/welcome-scene.png";
// The SPA's typeface, so the setup page reads like the app it opens.
import geistWoff2 from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2";
import setupHtml from "../shell/setup.html";
import {
  SETUP_IPC,
  type SetupCommand,
  type SetupState,
} from "../shared/setup.js";
import type { DiagnosticsModule } from "./diagnostics.js";
import type { EnrollmentModule } from "./enrollment.js";
import type { LocalServerModule } from "./local-server.js";
import {
  SETTINGS_URL,
  type MacPermissions,
  type PermissionStatuses,
} from "./mac-permissions.js";
import type { Module, ModuleContext } from "./modules.js";
import type { PowerGuardModule } from "./power-guard.js";
import { parseSetupCommand } from "./setup-command.js";
import { INVALID_SERVER, type WindowManagerModule } from "./window-manager.js";
import type { WorkspaceGrantsModule } from "./workspace-grants.js";

export interface SetupWindowOptions {
  readonly preload: string;
  readonly version: string;
  readonly defaultDisplayName: string;
  // Open on start; set when this computer is not connected yet.
  readonly show: boolean;
  readonly loginItem: {
    get(): boolean;
    set(on: boolean): void;
  };
  // macOS only.
  readonly permissions?: MacPermissions;
}

const SETUP_URL = "app://setup/";
// Its own session: the setup page never sees the server's cookies.
const PARTITION = "linger-setup";

// The first-run window (setup, sign-in, connect, permissions). The main
// window stays hidden until setup finishes or the user asks for it.
export class SetupWindowModule implements Module {
  readonly name = "SetupWindow";
  readonly dependsOn = [
    "Diagnostics",
    "Enrollment",
    "LocalServer",
    "PowerGuard",
    "WindowManager",
    "WorkspaceGrants",
  ];
  readonly #options: SetupWindowOptions;
  #ctx: ModuleContext | undefined;
  #window: BrowserWindow | undefined;
  #signedIn = false;
  #permissions: PermissionStatuses | undefined;
  #diagnostics: SetupState["diagnostics"];
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: SetupWindowOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    const pages = this.#session();
    pages.protocol.handle("app", (request) => this.#serve(request));
    const fromSetup = (event: IpcMainInvokeEvent): void => {
      if (
        event.sender !== this.#window?.webContents ||
        !event.senderFrame?.url.startsWith(SETUP_URL)
      )
        throw new Error("Not allowed");
    };
    ipcMain.handle(SETUP_IPC.state, async (event) => {
      fromSetup(event);
      await Promise.all([this.#refreshSignedIn(), this.#refreshPermissions()]);
      return this.#state();
    });
    ipcMain.handle(SETUP_IPC.run, async (event, command: unknown) => {
      fromSetup(event);
      await this.#run(parseSetupCommand(command));
      return this.#state();
    });
    const push = (): void => this.#push();
    // Signing in happens in the main window; its cookies tell us when.
    const onCookie = (): void => void this.#refreshSignedIn().then(push);
    session.defaultSession.cookies.on("changed", onCookie);
    this.#unsubscribe.push(
      () => ipcMain.removeHandler(SETUP_IPC.state),
      () => ipcMain.removeHandler(SETUP_IPC.run),
      () => session.defaultSession.cookies.off("changed", onCookie),
      () => pages.protocol.unhandle("app"),
      ctx.bus.on("computer.changed", push),
      ctx.bus.on("power.changed", push),
      ctx.bus.on("grants.changed", push),
      ctx.bus.on("local-server.changed", push),
      ctx.bus.on("server.changed", onCookie),
    );
    if (this.#options.show) this.show();
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#window?.destroy();
    this.#window = undefined;
  }

  visible(): boolean {
    return !!this.#window && !this.#window.isDestroyed();
  }

  show(): void {
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.show();
      this.#window.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 760,
      height: 660,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: "Set Up Linger",
      backgroundColor: "#ffffff",
      icon: nativeImage.createFromBuffer(Buffer.from(iconPng)),
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset" as const,
            trafficLightPosition: { x: 16, y: 16 },
          }
        : { autoHideMenuBar: true }),
      webPreferences: {
        preload: this.#options.preload,
        session: this.#session(),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    const contents = window.webContents;
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    window.once("ready-to-show", () => window.show());
    // Back from System Settings: show what changed there.
    window.on(
      "focus",
      () => void this.#refreshPermissions().then(() => this.#push()),
    );
    window.on("closed", () => {
      if (this.#window === window) this.#window = undefined;
    });
    this.#window = window;
    void window.loadURL(SETUP_URL).catch(() => undefined);
    // Whether this computer can serve a local model, found out while the
    // page is read; the option appears once it can.
    this.#ctx?.get<LocalServerModule>("LocalServer").inspect();
  }

  async #run(command: SetupCommand): Promise<void> {
    const ctx = this.#ctx!;
    const windows = ctx.get<WindowManagerModule>("WindowManager");
    switch (command.op) {
      case "server.set":
        if (!windows.setServer(command.serverUrl))
          throw new Error(INVALID_SERVER);
        await this.#refreshSignedIn();
        return;
      case "local.start": {
        const local = ctx.get<LocalServerModule>("LocalServer");
        const plan = {
          runtime: command.runtime ?? "recommended",
          ...(command.keys ? { keys: command.keys } : {}),
        } as const;
        // The page follows progress through state; a failure shows there too.
        void local.begin(plan).catch(() => undefined);
        return;
      }
      case "local.location.pick": {
        const picked = await dialog.showOpenDialog(this.#window!, {
          title: "Choose Where to Install Linger",
          buttonLabel: "Choose",
          properties: ["openDirectory", "createDirectory"],
        });
        if (picked.canceled || !picked.filePaths[0]) return;
        await ctx
          .get<LocalServerModule>("LocalServer")
          .chooseLocation(picked.filePaths[0]);
        return;
      }
      case "local.location.reset":
        await ctx.get<LocalServerModule>("LocalServer").chooseLocation(null);
        return;
      case "local.signin.start":
        await ctx
          .get<LocalServerModule>("LocalServer")
          .startSignIn(command.code);
        return;
      case "local.signin.open":
        await ctx.get<LocalServerModule>("LocalServer").openSignInPage();
        return;
      case "local.signin.cancel":
        await ctx.get<LocalServerModule>("LocalServer").cancelSignIn();
        return;
      case "local.signin.switch":
        ctx
          .get<LocalServerModule>("LocalServer")
          .switchRuntime(command.runtime);
        return;
      case "signin.open":
        windows.show();
        return;
      case "computer.connect":
        await ctx.get<EnrollmentModule>("Enrollment").enroll();
        // Bring setup back over the main window used for signing in.
        this.show();
        return;
      case "notifications.test":
        if (Notification.isSupported())
          new Notification({
            title: "Notifications are on",
            body: "Linger will tell you here when a task needs you.",
          }).show();
        return;
      case "prevent-sleep.set":
        ctx.get<PowerGuardModule>("PowerGuard").setAlwaysOn(command.on);
        return;
      case "open-at-login.set":
        this.#options.loginItem.set(command.on);
        return;
      case "folder.add":
        await ctx.get<WorkspaceGrantsModule>("WorkspaceGrants").pick();
        return;
      case "permission.request":
        await this.#options.permissions?.request(command.id);
        await this.#refreshPermissions();
        return;
      case "permission.settings":
        await shell.openExternal(SETTINGS_URL[command.id]);
        return;
      case "logs.open":
        await ctx.get<DiagnosticsModule>("Diagnostics").openLogs();
        return;
      case "diagnostics.save":
        try {
          this.#diagnostics = {
            file: await ctx.get<DiagnosticsModule>("Diagnostics").save(),
          };
        } catch (error) {
          ctx.log.warn("setup.diagnostics_failed", { error: String(error) });
          this.#diagnostics = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
        return;
      case "finish":
        this.#window?.close();
        windows.show();
        return;
    }
  }

  #state(): SetupState {
    const ctx = this.#ctx!;
    const config = ctx.config.get();
    return {
      platform: process.platform as SetupState["platform"],
      version: this.#options.version,
      serverUrl: config.serverUrl ?? "",
      signedIn: this.#signedIn,
      enrolled: !!config.computerId,
      displayName: config.displayName ?? this.#options.defaultDisplayName,
      preventSleep: ctx.get<PowerGuardModule>("PowerGuard").alwaysOn(),
      openAtLogin: this.#options.loginItem.get(),
      folders: config.workspaceGrants.map(({ grantId, label, path }) => ({
        grantId,
        label,
        path,
      })),
      localServer: localServerState(ctx.get<LocalServerModule>("LocalServer")),
      ...(this.#diagnostics ? { diagnostics: this.#diagnostics } : {}),
      ...(this.#permissions ? { permissions: this.#permissions } : {}),
    };
  }

  async #refreshSignedIn(): Promise<void> {
    const enrollment = this.#ctx!.get<EnrollmentModule>("Enrollment");
    const signedIn = await enrollment.signedIn();
    // Signing in is the cue to bring setup back to the front.
    if (signedIn && !this.#signedIn && this.visible()) this.show();
    this.#signedIn = signedIn;
  }

  async #refreshPermissions(): Promise<void> {
    const permissions = this.#options.permissions;
    if (!permissions) return;
    try {
      this.#permissions = await permissions.statuses();
    } catch (error) {
      this.#ctx?.log.warn("setup.permissions_failed", { error: String(error) });
    }
  }

  #push(): void {
    const contents = this.#window?.webContents;
    if (contents && !contents.isDestroyed())
      contents.send(SETUP_IPC.stateEvent, this.#state());
  }

  #session(): Session {
    return session.fromPartition(PARTITION);
  }

  #serve(request: Request): Response {
    const url = new URL(request.url);
    if (url.host !== "setup") return new Response(null, { status: 404 });
    if (url.pathname === "/welcome-scene.png")
      return new Response(Buffer.from(scenePng), {
        headers: { "content-type": "image/png" },
      });
    if (url.pathname === "/logo.png")
      return new Response(Buffer.from(logoPng), {
        headers: { "content-type": "image/png" },
      });
    if (url.pathname === "/geist.woff2")
      return new Response(Buffer.from(geistWoff2), {
        headers: { "content-type": "font/woff2" },
      });
    return new Response(setupHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

const localServerState = (
  local: LocalServerModule,
): SetupState["localServer"] => {
  const {
    available,
    phase,
    message,
    steps,
    step,
    progress,
    attempt,
    localModels,
    location,
    keys,
    signIn,
  } = local.status();
  const home = os.homedir();
  return {
    available,
    phase,
    message,
    steps,
    step,
    progress,
    attempt,
    localModels,
    location: {
      ...location,
      path:
        location.path === home || location.path.startsWith(home + path.sep)
          ? "~" + location.path.slice(home.length)
          : location.path,
    },
    keys,
    ...(signIn ? { signIn } : {}),
  };
};
