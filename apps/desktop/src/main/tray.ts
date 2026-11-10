import {
  Menu,
  Tray,
  app,
  dialog,
  nativeImage,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";

import mark16 from "../../resources/tray/mark-16.png";
import mark32 from "../../resources/tray/mark-32.png";
import tile16 from "../../resources/tray/tile-16.png";
import tile32 from "../../resources/tray/tile-32.png";
import type { DiagnosticsModule } from "./diagnostics.js";
import { EnrollmentError, type EnrollmentModule } from "./enrollment.js";
import type { Module, ModuleContext } from "./modules.js";
import type { PowerGuardModule } from "./power-guard.js";
import type { SetupWindowModule } from "./setup-window.js";
import type { StatusModule, StatusTone } from "./status.js";
import { renderTrayIcon, type TrayArtwork } from "./tray-icon.js";
import { trayMenu, type TrayAction, type TrayMenuItem } from "./tray-menu.js";
import type { UpdaterModule } from "./updater.js";
import type { WindowManagerModule } from "./window-manager.js";

export interface TrayOptions {
  // Owned by the app lifecycle.
  readonly quit: () => void;
}

const BUSY_FRAME_MS = 400;

const ARTWORK: Record<number, TrayArtwork> = {
  1: { mark: Buffer.from(mark16), tile: Buffer.from(tile16) },
  2: { mark: Buffer.from(mark32), tile: Buffer.from(tile32) },
};

const icon = (tone: StatusTone, frame: number): NativeImage => {
  const template = process.platform === "darwin";
  const image = nativeImage.createEmpty();
  for (const scale of [1, 2]) {
    image.addRepresentation({
      scaleFactor: scale,
      buffer: renderTrayIcon({
        tone,
        frame,
        size: 16 * scale,
        template,
        artwork: ARTWORK[scale]!,
      }),
    });
  }
  if (template) image.setTemplateImage(true);
  return image;
};

// GTK aborts the process when a tray or menu is created without a display.
const headless = (): boolean =>
  app.commandLine.getSwitchValue("ozone-platform") === "headless";

// The system tray. The same menu opens from the title bar status.
export class TrayModule implements Module {
  readonly name = "Tray";
  readonly dependsOn = [
    "Status",
    "PowerGuard",
    "WindowManager",
    "Enrollment",
    "SetupWindow",
    "Updater",
    "Diagnostics",
  ];
  readonly #options: TrayOptions;
  #ctx: ModuleContext | undefined;
  #tray: Tray | undefined;
  #frame = 0;
  #animation: NodeJS.Timeout | undefined;
  readonly #icons = new Map<string, NativeImage>();
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: TrayOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    const windows = ctx.get<WindowManagerModule>("WindowManager");
    try {
      if (headless()) throw new Error("No display");
      this.#tray = new Tray(this.#icon());
      this.#tray.setToolTip("Linger");
      // Windows and Linux open the window on click; macOS shows the menu.
      if (process.platform !== "darwin")
        this.#tray.on("click", () => windows.show());
    } catch (error) {
      ctx.log.warn("tray.unavailable", { error: String(error) });
    }
    this.#unsubscribe.push(
      ctx.bus.on("status.changed", () => this.#refresh()),
      ctx.bus.on("power.changed", () => this.#refresh()),
      ctx.bus.on("update.changed", () => this.#refresh()),
    );
    this.#refresh();
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) off();
    clearInterval(this.#animation);
    this.#tray?.destroy();
    this.#tray = undefined;
  }

  #status() {
    return this.#ctx!.get<StatusModule>("Status").current();
  }

  #refresh(): void {
    const tone = this.#status().tone;
    if (tone === "busy" && !this.#animation) {
      this.#animation = setInterval(() => {
        this.#frame = (this.#frame + 1) % 3;
        this.#tray?.setImage(this.#icon());
      }, BUSY_FRAME_MS);
    } else if (tone !== "busy" && this.#animation) {
      clearInterval(this.#animation);
      this.#animation = undefined;
      this.#frame = 0;
    }
    if (!this.#tray) return;
    this.#tray.setImage(this.#icon());
    this.#tray.setToolTip(`Linger · ${this.#status().label}`);
    this.#tray.setContextMenu(this.#menu());
  }

  #icon(): NativeImage {
    const tone = this.#status().tone;
    const key = `${tone}:${tone === "busy" ? this.#frame : 0}`;
    let image = this.#icons.get(key);
    if (!image) {
      image = icon(tone, this.#frame);
      this.#icons.set(key, image);
    }
    return image;
  }

  #menu(): Menu {
    const power = this.#ctx!.get<PowerGuardModule>("PowerGuard");
    const status = this.#status();
    const update = this.#ctx!.get<UpdaterModule>("Updater").state();
    const items = trayMenu({
      status,
      preventSleep: power.alwaysOn(),
      enrolled: !!this.#ctx!.config.get().computerId,
      update,
    });
    return Menu.buildFromTemplate(items.map((item) => this.#item(item)));
  }

  #item(item: TrayMenuItem): MenuItemConstructorOptions {
    if (item.kind === "separator") return { type: "separator" };
    if (item.kind === "label") return { label: item.label, enabled: false };
    return {
      label: item.label,
      ...(item.checked === undefined
        ? {}
        : { type: "checkbox" as const, checked: item.checked }),
      click: () => this.#run(item.action),
    };
  }

  #run(action: TrayAction): void {
    const ctx = this.#ctx!;
    switch (action) {
      case "enroll":
        // A new computer goes through setup; a connected one re-enrolls.
        if (ctx.config.get().computerId) void this.#enroll();
        else ctx.get<SetupWindowModule>("SetupWindow").show();
        break;
      case "open":
        ctx.get<WindowManagerModule>("WindowManager").show();
        break;
      case "toggle-prevent-sleep": {
        const power = ctx.get<PowerGuardModule>("PowerGuard");
        power.setAlwaysOn(!power.alwaysOn());
        break;
      }
      case "install-update":
        void ctx.get<UpdaterModule>("Updater").install();
        break;
      case "check-update":
        void ctx.get<UpdaterModule>("Updater").check();
        break;
      case "show-logs":
      case "save-diagnostics": {
        const diagnostics = ctx.get<DiagnosticsModule>("Diagnostics");
        void (
          action === "show-logs" ? diagnostics.openLogs() : diagnostics.save()
        ).catch((error: unknown) =>
          ctx.log.warn("tray.diagnostics_failed", { error: String(error) }),
        );
        break;
      }
      case "quit":
        this.#options.quit();
        break;
    }
  }

  async #enroll(): Promise<void> {
    const ctx = this.#ctx!;
    const windows = ctx.get<WindowManagerModule>("WindowManager");
    windows.show();
    try {
      await ctx.get<EnrollmentModule>("Enrollment").enroll();
    } catch (error) {
      ctx.log.warn("tray.enroll_failed", { error: String(error) });
      const signedOut =
        error instanceof EnrollmentError && error.code === "NOT_SIGNED_IN";
      const window = windows.window();
      const options = {
        type: "warning" as const,
        message: signedOut ? "Sign in first" : "Couldn't connect this computer",
        detail: signedOut
          ? "Sign in to Linger in the window, then choose Connect This Computer again."
          : error instanceof Error
            ? error.message
            : String(error),
      };
      await (window
        ? dialog.showMessageBox(window, options)
        : dialog.showMessageBox(options));
    }
  }
}
