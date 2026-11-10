// Contract between the local title bar page (app://shell) and the main
// process. The title bar is desktop-owned UI; the SPA never sees this API.

export type ShellPlatform = "darwin" | "win32" | "linux";

export interface TitlebarState {
  readonly platform: ShellPlatform;
  readonly title: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
  readonly maximized: boolean;
  readonly focused: boolean;
}

export type ShellCommand =
  | "back"
  | "forward"
  | "reload"
  | "minimize"
  | "maximize"
  | "close";

export interface LingerShellApi {
  getState(): Promise<TitlebarState>;
  onState(callback: (state: TitlebarState) => void): () => void;
  command(name: ShellCommand): void;
}

export const SHELL_IPC = {
  state: "shell.state",
  stateEvent: "shell.state.event",
  command: "shell.command",
} as const;
