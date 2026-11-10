export type InstallStage =
  | "preflight"
  | "release"
  | "images"
  | "services"
  | "account"
  | "computer"
  | "runtime";
export interface InstallerEvent {
  kind: "stage" | "log";
  stage?: InstallStage;
  state?: "running" | "succeeded" | "failed" | "skipped" | "waiting_user";
  message: string;
  progress?: { completed: number; total?: number; unit: string };
}
export interface InstallObserver {
  interactive?: boolean;
  onEvent: (event: InstallerEvent) => void;
}
export interface InstallOutcome {
  code: number;
  state: string;
  message: string;
  details?: unknown;
}
