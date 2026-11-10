import type { TeamHubMessageCard } from "@/features/teamhub/teamhub-types";

import { connectedAppDisplayName } from "./connected-app-names";

/**
 * A settled card no longer asks anything, so the chat shows what happened as
 * one centered system line, the way Room notices do: who did what to what.
 * The object links to where the result lives. A card still waiting or still
 * running returns null and stays a card.
 */
export interface CardNotice {
  text: string;
  /** The object in the line, linked to where the result lives. */
  link?: { label: string; to: NoticeTarget };
  /** Further lines, one per answer after the first on a question card. */
  more?: string[];
}

export type NoticeTarget = { room: string } | "apps";

type Question = NonNullable<
  TeamHubMessageCard["question"]
>["questions"][number];

const runningStatuses = new Set([
  "pending",
  "approved",
  "executing",
  "authorizing",
]);

export function settledCardNotice(
  card: TeamHubMessageCard,
  viewerId: string | undefined,
): CardNotice | null {
  const finishedApproval =
    card.kind === "runtime_permission" && card.status === "approved";
  if (runningStatuses.has(card.status) && !finishedApproval) return null;

  const who =
    card.decided_by && card.decided_by.id === viewerId
      ? "You"
      : (card.decided_by?.display_name ?? "Someone");
  const title = `“${card.title}”`;
  const reason = card.answer?.comment?.trim();
  const outcome = card.outcome?.trim();
  const withOutcome = outcome ? `: ${outcome}` : "";

  if (card.kind === "question") {
    if (card.status !== "answered") {
      return { text: `No one answered ${title} in time` };
    }
    const given = card.answer?.answers ?? {};
    const lines = (card.question?.questions ?? []).map(
      (question) =>
        `${who} answered “${question.prompt}” with “${answerLabels(question, given[question.id]) || "No answer"}”`,
    );
    if (reason) lines.push(`${who} added “${reason}”`);
    return { text: lines[0] ?? "", more: lines.slice(1) };
  }

  if (card.status === "expired") {
    return { text: `${title} expired` };
  }
  if (card.status === "denied") {
    return {
      text: `${who} declined ${title}${reason ? `: “${reason}”` : ""}`,
    };
  }

  switch (card.kind) {
    case "runtime_permission":
      return {
        text:
          card.status === "consumed"
            ? `${who} allowed ${title} once, and it ran`
            : `${who} allowed ${title} once`,
      };
    case "browser_connection":
      return { text: `${who} connected Chrome` };
    case "provider_key":
      return { text: `${who} added the Composio API key` };
    case "connection_auth": {
      const app = connectedAppDisplayName(card.connection_auth?.app_key);
      return card.status === "succeeded"
        ? {
            text: `${who} connected `,
            link: { label: app, to: "apps" },
          }
        : { text: `${title} did not finish${withOutcome}` };
    }
    case "computer_permission":
      return { text: `${who} granted ${title}` };
    case "profile_setup_apps":
    case "profile_setup_sources":
      return {
        text:
          card.answer?.decision === "skipped"
            ? `${who} skipped ${title}`
            : `${who} completed ${title}`,
      };
    case "room_creation": {
      const room = card.room_creation;
      if (card.status === "succeeded" && room?.created_room_id) {
        return {
          text: `${who} created Room `,
          link: { label: room.name, to: { room: room.created_room_id } },
        };
      }
      break;
    }
    default:
      break;
  }

  // Connector writes, Agent changes and Room creations TeamHub ran.
  if (card.status === "succeeded") {
    return { text: `${who} approved ${title}` };
  }
  if (card.status === "failed") {
    return {
      text: `${who} approved ${title}, but it failed${withOutcome}`,
    };
  }
  if (card.status === "unknown") {
    return {
      text: `${who} approved ${title}; the result is unknown${withOutcome}`,
    };
  }
  return { text: `${title} ended` };
}

function answerLabels(
  question: Question,
  value: string | string[] | undefined,
): string {
  const chosen = Array.isArray(value) ? value : value ? [value] : [];
  return chosen
    .map(
      (id) => question.options?.find((option) => option.id === id)?.label ?? id,
    )
    .join(", ");
}
