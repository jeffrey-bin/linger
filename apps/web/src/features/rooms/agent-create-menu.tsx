import {
  BotIcon,
  Copy01Icon,
  PlusSignIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";

import { ActionMenu } from "@/components/ui/action-menu";

/** The 26px plus beside a navigation group title (AGENTS and ROOMS). */
export const navPlusButtonClass =
  "flex size-[26px] shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-accent hover:text-accent-foreground active:scale-[0.85] active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus max-md:size-11";

export function AgentCreateMenu({
  onCreateFromTemplate,
  onCreateAgent,
  onCreateRoom,
}: {
  onCreateFromTemplate: () => void;
  onCreateAgent: () => void;
  onCreateRoom: () => void;
}) {
  return (
    <ActionMenu
      label="Create chat"
      placement="right-start"
      buttonClassName={navPlusButtonClass}
      trigger={<Icon icon={PlusSignIcon} size={16} />}
      items={[
        {
          label: "Create Agent",
          icon: <Icon icon={BotIcon} size={14} />,
          onSelect: onCreateAgent,
        },
        {
          label: "Create Room",
          icon: <Icon icon={UserGroupIcon} size={14} />,
          onSelect: onCreateRoom,
        },
        {
          label: "Agent templates",
          icon: <Icon icon={Copy01Icon} size={14} />,
          onSelect: onCreateFromTemplate,
        },
      ]}
    />
  );
}
