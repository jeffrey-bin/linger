import type {
  TeamHubLocalComputerPage,
  TeamHubLocalRuntimeType,
} from "@/features/teamhub/teamhub-types";

import type { ComputerDisplayStatus } from "./computer-connection-status";

type LocalComputer = TeamHubLocalComputerPage["items"][number];
type RuntimeStatus = LocalComputer["runtimes"][number]["status"];

/** Order the page suggests AI apps in when several need the same step. */
export const appOrder: readonly TeamHubLocalRuntimeType[] = [
  "claude",
  "codex",
  "pi",
];

export const appNames = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
} satisfies Record<TeamHubLocalRuntimeType, string>;

export const appDescriptions = {
  claude: "Anthropic's coding agent",
  codex: "OpenAI's coding agent",
  pi: "Open-source coding agent",
} satisfies Record<TeamHubLocalRuntimeType, string>;

export type ComputerReadiness =
  | { kind: "reconnecting" }
  | { kind: "offline" }
  | { kind: "update" }
  | { kind: "signIn"; app: TeamHubLocalRuntimeType }
  | { kind: "updateApp"; app: TeamHubLocalRuntimeType }
  | { kind: "check"; app: TeamHubLocalRuntimeType }
  | { kind: "setUp"; app: TeamHubLocalRuntimeType }
  | { kind: "ready"; app: TeamHubLocalRuntimeType };

export function appStatus(
  computer: LocalComputer,
  app: TeamHubLocalRuntimeType,
): RuntimeStatus {
  return (
    computer.runtimes.find((runtime) => runtime.type === app)?.status ??
    "not_installed"
  );
}

function firstApp(computer: LocalComputer, status: RuntimeStatus) {
  return appOrder.find((app) => appStatus(computer, app) === status);
}

/**
 * One conclusion for the whole Computer: an Agent can run as soon as one AI
 * app is ready, so the other apps never make a ready Computer look broken.
 */
export function computerReadiness(
  computer: LocalComputer,
  displayStatus: ComputerDisplayStatus,
): ComputerReadiness {
  if (displayStatus === "reconnecting") return { kind: "reconnecting" };
  // The Runner Gateway turns away a Computer below the version floor, so it
  // reads offline until the update, which is the step that brings it back.
  if (computer.upgrade_required) return { kind: "update" };
  if (displayStatus === "offline") return { kind: "offline" };
  const ready = firstApp(computer, "ready");
  if (ready) return { kind: "ready", app: ready };
  const signIn = firstApp(computer, "authentication_required");
  if (signIn) return { kind: "signIn", app: signIn };
  // An installed app that is too old or could not be checked is closer to
  // ready than an app the user has not installed yet.
  const outdated = firstApp(computer, "incompatible");
  if (outdated) return { kind: "updateApp", app: outdated };
  const unchecked =
    firstApp(computer, "error") ?? firstApp(computer, "unknown");
  if (unchecked) return { kind: "check", app: unchecked };
  return { kind: "setUp", app: "claude" };
}
