import type { TeamHubLocalRuntimeType } from "@/features/teamhub/teamhub-types";

import type { ComputerPlatform } from "./computer-platform";

/** The command that signs in to each AI app; Pi signs in with /login inside it. */
export const loginCommands = {
  codex: "codex login",
  claude: "claude auth login",
  pi: "pi",
} satisfies Record<TeamHubLocalRuntimeType, string>;

// Local Computer finds these installs in its default search folders
// (%APPDATA%\npm and ~/.local/bin) without a restart.
export function installCommand(
  runtimeType: TeamHubLocalRuntimeType,
  platform: ComputerPlatform | undefined,
): string {
  if (runtimeType === "claude")
    return platform === "win32"
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash";
  return runtimeType === "codex"
    ? "npm install -g @openai/codex"
    : "npm install -g @earendil-works/pi-coding-agent";
}
