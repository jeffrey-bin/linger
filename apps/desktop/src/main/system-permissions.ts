import type {
  DesktopPermissionId,
  DesktopPermissionStep,
} from "../shared/api.js";

// The macOS Screen Recording and Accessibility permissions of Linger.app
// itself. Shell commands the daemon starts (screencapture, osascript) are
// attributed to the app, so the Go daemon, which cannot call these APIs,
// asks this module over its stdio channel.

export type SystemPermissionId = DesktopPermissionId;
export type SystemPermissionState =
  | "granted"
  | "denied"
  | "not_determined"
  | "unknown";
export interface SystemPermission {
  readonly id: SystemPermissionId;
  readonly state: SystemPermissionState;
  readonly relaunch_required: boolean;
}

export const SYSTEM_PERMISSION_IDS: readonly SystemPermissionId[] = [
  "screen_recording",
  "accessibility",
];

export const SYSTEM_SETTINGS_URL: Readonly<Record<SystemPermissionId, string>> =
  {
    screen_recording:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    accessibility:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  };

// The Electron calls this needs; tests use fakes.
export interface SystemPermissionApi {
  // systemPreferences.getMediaAccessStatus("screen")
  screenAccessStatus(): string;
  // systemPreferences.isTrustedAccessibilityClient(prompt)
  isTrustedAccessibilityClient(prompt: boolean): boolean;
  // desktopCapturer.getSources for screens; the first call shows the system
  // prompt and lists Linger under Screen Recording.
  captureScreens(): Promise<unknown>;
  openExternal(url: string): Promise<void>;
}

const screenState = (status: string): SystemPermissionState => {
  switch (status) {
    case "granted":
      return "granted";
    case "denied":
    case "restricted":
      return "denied";
    case "not-determined":
      return "not_determined";
    default:
      return "unknown";
  }
};

export class SystemPermissions {
  readonly #api: SystemPermissionApi;
  // macOS applies a Screen Recording grant only to a new process, so once
  // this process asked, a grant still reads as missing until a relaunch.
  #screenAsked = false;

  constructor(api: SystemPermissionApi) {
    this.#api = api;
  }

  status(): SystemPermission[] {
    const screen = screenState(this.#api.screenAccessStatus());
    return [
      {
        id: "screen_recording",
        state: screen,
        relaunch_required: this.#screenAsked && screen !== "granted",
      },
      {
        id: "accessibility",
        state: this.#api.isTrustedAccessibilityClient(false)
          ? "granted"
          : "denied",
        relaunch_required: false,
      },
    ];
  }

  async prompt(id: SystemPermissionId): Promise<SystemPermission[]> {
    if (id === "screen_recording") {
      this.#screenAsked = true;
      await this.#api.captureScreens();
    } else {
      this.#api.isTrustedAccessibilityClient(true);
    }
    return this.status();
  }

  async openSettings(id: SystemPermissionId): Promise<SystemPermission[]> {
    if (id === "screen_recording") this.#screenAsked = true;
    await this.#api.openExternal(SYSTEM_SETTINGS_URL[id]);
    return this.status();
  }
}

// What a permission step from the page needs from the app.
export interface DesktopPermissionHost {
  readonly permissions: Pick<SystemPermissions, "prompt" | "openSettings">;
  openExternal(url: string): Promise<void>;
  // Quits and starts the app again, for a Screen Recording grant to apply.
  relaunch(): void;
}

// Runs a step the owner took on the permission card of this Mac. Opening
// CuaDriver's pane bypasses SystemPermissions, which would otherwise count it
// as this app asking for Screen Recording.
export async function runDesktopPermissionStep(
  host: DesktopPermissionHost,
  step: DesktopPermissionStep,
): Promise<void> {
  switch (step.action) {
    case "prompt":
      await host.permissions.prompt(step.permission);
      return;
    case "open_settings":
      if (step.subject === "linger")
        await host.permissions.openSettings(step.permission);
      else await host.openExternal(SYSTEM_SETTINGS_URL[step.permission]);
      return;
    case "relaunch":
      // Let the page get its answer before the app quits.
      setImmediate(() => host.relaunch());
      return;
  }
}
