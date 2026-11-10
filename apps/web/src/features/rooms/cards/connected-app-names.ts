import type { TeamHubExternalAppKey } from "@/features/teamhub/teamhub-types";

const APP_NAMES: Record<TeamHubExternalAppKey, string> = {
  calendly: "Calendly",
  canva: "Canva",
  discord: "Discord",
  facebook: "Facebook",
  fal_ai: "fal.ai",
  figma: "Figma",
  github: "GitHub",
  gmail: "Gmail",
  google_calendar: "Google Calendar",
  google_meet: "Google Meet",
  googledrive: "Google Drive",
  granola: "Granola",
  higgsfield: "Higgsfield",
  linear: "Linear",
  notion: "Notion",
  outlook: "Outlook",
  outlook_calendar: "Outlook Calendar",
  slack: "Slack",
};

export function isConnectedAppKey(
  value: string,
): value is TeamHubExternalAppKey {
  return /^[a-z0-9][a-z0-9_-]{0,119}$/.test(value);
}

export function connectedAppDisplayName(appKey?: string | null) {
  if (!appKey) {
    return "this app";
  }
  return APP_NAMES[appKey] ?? appKey;
}
