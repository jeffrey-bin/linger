import { ChatGptIcon, ClaudeIcon, PiIcon } from "@hugeicons/core-free-icons";

import type { IconSvgElement } from "@/components/ui/icon";
import type { TeamHubLocalRuntimeType } from "@/features/teamhub/teamhub-types";

export const appIcons = {
  claude: ClaudeIcon,
  codex: ChatGptIcon,
  pi: PiIcon,
} satisfies Record<TeamHubLocalRuntimeType, IconSvgElement>;
