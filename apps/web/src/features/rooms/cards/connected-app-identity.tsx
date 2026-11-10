import {
  AiImageIcon,
  Calendar03Icon,
  CalendarCheckIn01Icon,
  Folder01Icon,
  GameController03Icon,
  GitForkIcon,
  Mail01Icon,
  Megaphone01Icon,
  Message01Icon,
  Note01Icon,
  Notebook01Icon,
  PaintBrush01Icon,
  Plug01Icon,
  SparklesIcon,
  Task01Icon,
  Video01Icon,
} from "@hugeicons/core-free-icons";

import { Icon, type IconSvgElement } from "@/components/ui/icon";
import type { TeamHubExternalAppKey } from "@/features/teamhub/teamhub-types";

import { isConnectedAppKey } from "./connected-app-names";

const APP_ICONS: Record<TeamHubExternalAppKey, IconSvgElement> = {
  calendly: CalendarCheckIn01Icon,
  canva: PaintBrush01Icon,
  discord: GameController03Icon,
  facebook: Megaphone01Icon,
  fal_ai: SparklesIcon,
  figma: PaintBrush01Icon,
  github: GitForkIcon,
  gmail: Mail01Icon,
  google_calendar: Calendar03Icon,
  google_meet: Video01Icon,
  googledrive: Folder01Icon,
  granola: Note01Icon,
  higgsfield: AiImageIcon,
  linear: Task01Icon,
  notion: Notebook01Icon,
  outlook: Mail01Icon,
  outlook_calendar: Calendar03Icon,
  slack: Message01Icon,
};

export function ConnectedAppIcon({
  appKey,
  className,
  size = 14,
}: {
  appKey?: string | null;
  className?: string;
  size?: number;
}) {
  const icon =
    appKey && isConnectedAppKey(appKey)
      ? (APP_ICONS[appKey] ?? Plug01Icon)
      : Plug01Icon;
  return <Icon className={className} icon={icon} size={size} />;
}
