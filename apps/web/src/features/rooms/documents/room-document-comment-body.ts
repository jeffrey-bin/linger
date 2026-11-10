import {
  createTeamHubMessageContent,
  formatTeamHubMentionToken,
} from "@/features/teamhub/teamhub-message-content";
import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";
import type { MessageComposition } from "../chat/message-composer";

export function commentBodyFromComposition(
  composition: MessageComposition,
): unknown[] {
  const content = createTeamHubMessageContent({
    files: [],
    mentions: composition.mentions,
    text: composition.body,
  });
  return [
    {
      content: content.segments.map((segment) =>
        segment.type === "reference"
          ? {
              props: { actorId: segment.target, label: segment.content },
              type: "mention",
            }
          : { styles: {}, text: segment.content, type: "text" },
      ),
      props: {},
      type: "paragraph",
    },
  ];
}

export function commentCompositionFromBody(
  body: unknown,
  mentionOptions: TeamHubActorRef[],
): MessageComposition {
  const actorsById = new Map(mentionOptions.map((actor) => [actor.id, actor]));
  const mentions = new Map<string, TeamHubActorRef>();
  const blocks = Array.isArray(body) ? body : [];
  let text = "";

  blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0) {
      text += "\n";
    }
    text += commentContentText(
      block && typeof block === "object"
        ? (block as { content?: unknown }).content
        : undefined,
      actorsById,
      mentions,
    );
  });

  return { body: text, files: [], mentions: [...mentions.values()] };
}

function commentContentText(
  content: unknown,
  actorsById: Map<string, TeamHubActorRef>,
  mentions: Map<string, TeamHubActorRef>,
): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((inline) => {
      if (!inline || typeof inline !== "object") {
        return "";
      }
      const value = inline as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") {
        return value.text;
      }
      if (value.type === "mention") {
        const props = value.props as
          | { actorId?: unknown; label?: unknown }
          | undefined;
        const actorId = props?.actorId;
        const actor =
          typeof actorId === "string" ? actorsById.get(actorId) : undefined;
        if (actor !== undefined) {
          mentions.set(actor.id, actor);
          return formatTeamHubMentionToken(actor);
        }
        if (typeof props?.label === "string") {
          return props.label.startsWith("@") ? props.label : `@${props.label}`;
        }
      }
      return "content" in value
        ? commentContentText(value.content, actorsById, mentions)
        : "";
    })
    .join("");
}
