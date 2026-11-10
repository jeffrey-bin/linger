import type { TeamHubExternalApp } from "@/features/teamhub/teamhub-types";

export interface AppGroup {
  apps: readonly string[];
  id: string;
  title: string;
}

/**
 * The Connectors page sections, ordered by how central each kind of app is to
 * daily work. TeamHub apps listed in no group (Google Drive, Facebook) stay
 * connectable elsewhere but are not offered on this page, so an app TeamHub
 * adds later appears here only once it is added to a group. Group names avoid
 * product nouns such as Profile, Chats, Docs, Projects and Sources.
 */
export const APP_GROUPS: readonly AppGroup[] = [
  {
    id: "mail-calendar",
    title: "Mail & Calendar",
    apps: [
      "gmail",
      "outlook",
      "google_calendar",
      "outlook_calendar",
      "calendly",
    ],
  },
  { id: "meetings", title: "Meetings", apps: ["granola", "google_meet"] },
  {
    id: "productivity",
    title: "Productivity",
    apps: ["github", "notion", "linear"],
  },
  { id: "messaging", title: "Messaging", apps: ["slack", "discord"] },
  {
    id: "design-creative",
    title: "Design & Creative",
    apps: ["figma", "canva"],
  },
  { id: "multimodal", title: "Multimodal", apps: ["higgsfield", "fal_ai"] },
];

/**
 * One-line card labels. TeamHub's longer descriptions stay in the manage
 * dialog, where their import limits and scope matter.
 */
const APP_SUMMARIES: Record<string, string> = {
  calendly: "Scheduling links and events",
  canva: "Designs and presentations",
  discord: "Servers and channels",
  fal_ai: "Generative media models",
  figma: "Design files",
  github: "Repositories and activity",
  gmail: "Email",
  google_calendar: "Calendars and events",
  google_meet: "Video call records",
  granola: "Meeting notes",
  higgsfield: "AI images and video",
  linear: "Issues and projects",
  notion: "Pages and databases",
  outlook: "Email",
  outlook_calendar: "Calendars and events",
  slack: "Workspaces and channels",
};

export function appSummary(app: TeamHubExternalApp) {
  return APP_SUMMARIES[app.key] ?? app.description;
}

/** Each group with the catalog apps it holds, in group order; empty groups drop. */
export function groupCatalogApps(apps: readonly TeamHubExternalApp[]) {
  const byKey = new Map(apps.map((app) => [app.key, app]));
  return APP_GROUPS.map((group) => ({
    group,
    apps: group.apps.flatMap((key) => byKey.get(key) ?? []),
  })).filter((entry) => entry.apps.length > 0);
}
