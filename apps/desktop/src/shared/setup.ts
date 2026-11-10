// Contract between the local setup page (app://setup) and the main process.
// The setup window walks a new install through server, sign-in, connecting
// this computer and the system permissions it needs.

export interface SetupFolder {
  readonly grantId: string;
  readonly label: string;
  readonly path: string;
}

export type SetupPermission = "full-disk" | "folders" | "automation";
export type SetupPermissionStatus = "granted" | "denied" | "unknown";

// Linger installed and run on this computer instead of a team server.
export interface SetupLocalServer {
  // Whether this computer can run it; absent options are not offered.
  readonly available: boolean;
  readonly phase: "idle" | "preparing" | "installing" | "ready" | "failed";
  readonly message: string;
  // While installing: the steps shown, the current one and the overall share
  // done (0-1).
  readonly steps: readonly SetupLocalStep[];
  readonly step: SetupLocalStep;
  readonly progress: number;
  // Which installation this is; timers and the bar start over with each.
  readonly attempt: number;
  // Whether this computer can serve a local model; checked as the setup
  // window opens.
  readonly localModels: SetupLocalModelsCheck;
  // The folder the installation goes into, for showing (~ for the home
  // folder); custom once picked on the page.
  readonly location: {
    readonly path: string;
    readonly custom: boolean;
    readonly error?: string;
  };
  // Which provider keys are saved there; the page never sees them.
  readonly keys: {
    readonly composio: boolean;
    readonly soniox: boolean;
    readonly xai: boolean;
  };
  // While the "signin" step shows: the AI runtime's own sign-in.
  readonly signIn?: SetupRuntimeSignIn;
}

export type SetupLocalStep =
  | "prepare"
  | "download"
  | "services"
  | "workspace"
  | "signin"
  | "connect"
  | "agents";

// The runtime the installer set up has no sign-in on this computer. The
// person signs in on the vendor's page (url, entering deviceCode there) or
// in a terminal; Claude Code's page shows a code to paste back
// (acceptsCode). failed carries why the last attempt ended.
export interface SetupRuntimeSignIn {
  readonly runtime: "codex" | "claude" | "pi";
  readonly state:
    | "required"
    | "starting"
    | "waiting_user"
    | "failed"
    | "signed_in";
  readonly url?: string;
  readonly deviceCode?: string;
  readonly acceptsCode?: boolean;
  readonly message?: string;
}

export type SetupLocalModelsCheck =
  | { readonly state: "unchecked" | "checking" | "unavailable" }
  | {
      readonly state: "checked";
      readonly eligible: boolean;
      readonly memoryBytes: number;
      readonly diskFreeBytes: number | null;
      readonly gpu?: string;
      // The inference model to deploy, with what it needs; when eligible.
      readonly model?: {
        readonly name: string;
        readonly downloadBytes: number | null;
        readonly diskBytes: number | null;
        readonly memoryBytes: number | null;
      };
      // Why not, in the localmodels tool's words; when not eligible.
      readonly reasons?: readonly string[];
    };

// The AI runtime the installer sets up; "recommended" lets it pick and
// "local" deploys an inference model on this computer.
export type SetupLocalRuntime =
  | "recommended"
  | "codex"
  | "claude"
  | "pi"
  | "local";

// Provider keys typed on the page: a key replaces the saved one, ""
// removes it and an absent provider keeps it.
export interface SetupProviderKeys {
  readonly composio?: string;
  readonly soniox?: string;
  readonly xai?: string;
}

export interface SetupState {
  readonly platform: "darwin" | "win32" | "linux";
  readonly version: string;
  readonly serverUrl: string;
  readonly signedIn: boolean;
  readonly enrolled: boolean;
  readonly displayName: string;
  readonly preventSleep: boolean;
  readonly openAtLogin: boolean;
  readonly folders: readonly SetupFolder[];
  readonly localServer: SetupLocalServer;
  // The diagnostics zip last saved from this window, or why it failed.
  readonly diagnostics?: { readonly file?: string; readonly error?: string };
  // macOS privacy permissions; absent on other platforms or until checked.
  readonly permissions?: Readonly<
    Record<SetupPermission, SetupPermissionStatus>
  >;
}

export type SetupCommand =
  | { readonly op: "server.set"; readonly serverUrl: string }
  | {
      readonly op: "local.start";
      readonly runtime?: SetupLocalRuntime;
      readonly keys?: SetupProviderKeys;
    }
  // Picks the install folder with the system picker, or goes back to the
  // default.
  | { readonly op: "local.location.pick" }
  | { readonly op: "local.location.reset" }
  // The runtime sign-in step: start the runtime's login (or give it the
  // code its page showed), open its page again, check again, or install
  // another runtime instead.
  | { readonly op: "local.signin.start"; readonly code?: string }
  | { readonly op: "local.signin.open" }
  | { readonly op: "local.signin.cancel" }
  | {
      readonly op: "local.signin.switch";
      readonly runtime: "codex" | "claude" | "pi";
    }
  | { readonly op: "signin.open" }
  | { readonly op: "computer.connect" }
  | { readonly op: "notifications.test" }
  | { readonly op: "prevent-sleep.set"; readonly on: boolean }
  | { readonly op: "open-at-login.set"; readonly on: boolean }
  | { readonly op: "folder.add" }
  | {
      readonly op: "permission.request";
      readonly id: Exclude<SetupPermission, "full-disk">;
    }
  | { readonly op: "permission.settings"; readonly id: SetupPermission }
  | { readonly op: "finish" }
  // Opens the log folder, or saves a redacted diagnostics zip and shows it.
  | { readonly op: "logs.open" }
  | { readonly op: "diagnostics.save" };

export interface LingerSetupApi {
  getState(): Promise<SetupState>;
  onState(callback: (state: SetupState) => void): () => void;
  run(command: SetupCommand): Promise<SetupState>;
}

export const SETUP_IPC = {
  state: "setup.state",
  stateEvent: "setup.state.event",
  run: "setup.run",
} as const;
