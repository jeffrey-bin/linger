import type { TeamHubExternalAppKey } from "@/features/teamhub/teamhub-types";

type ProfileSourceSelection = "fixed" | "optional" | "required" | "unsupported";

const PROFILE_SOURCE_SELECTION: Record<
  TeamHubExternalAppKey,
  ProfileSourceSelection
> = {
  discord: "required",
  facebook: "unsupported",
  github: "optional",
  gmail: "fixed",
  outlook: "fixed",
  google_calendar: "required",
  google_meet: "unsupported",
  notion: "required",
  slack: "required",
};

export function profileSourcePolicy(provider: string): {
  selection: ProfileSourceSelection;
} {
  return {
    selection: PROFILE_SOURCE_SELECTION[provider] ?? "unsupported",
  };
}

export function profileSourceSubmitLabel(provider: string, count: number) {
  switch (provider) {
    case "github":
      return count === 0
        ? "Add GitHub profile"
        : `Add GitHub profile + ${count} ${pluralize("repository", count, "repositories")}`;
    case "google_calendar":
      return `Add ${count} ${pluralize("calendar", count)}`;
    case "notion":
      return `Add ${count} Notion ${pluralize("item", count)}`;
    case "slack":
      return `Add ${count} Slack ${pluralize("channel", count)}`;
    case "discord":
      return `Add ${count} Discord ${pluralize("channel", count)}`;
    default:
      return "Add";
  }
}

function pluralize(singular: string, count: number, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

export function providerDisplayName(provider: string) {
  if (provider === "google_calendar") return "Google Calendar";
  if (provider === "github") return "GitHub";
  return `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}
