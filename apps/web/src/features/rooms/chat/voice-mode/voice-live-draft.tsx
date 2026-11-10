import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";
import { ActorAvatar } from "../../members/actor-avatar";

export interface VoiceLiveDraft {
  actor: TeamHubActorRef;
  error?: string;
  statusLabel: string;
  text: string;
}

export function VoiceLiveDraftRow({
  draft,
  startsGroup = true,
}: {
  draft: VoiceLiveDraft;
  startsGroup?: boolean;
}) {
  if (!draft.text && !draft.error) return null;
  return (
    <article
      aria-label="Live voice draft"
      className="room-message-card message-row"
      data-author-kind="human"
      data-current-actor="true"
      data-group-start={startsGroup}
      data-voice-live-draft="true"
    >
      <div className="room-message-avatar">
        {startsGroup ? (
          <ActorAvatar
            actorId={draft.actor.id}
            kind={draft.actor.kind}
            name={draft.actor.display_name}
            size="sm"
          />
        ) : null}
      </div>
      <div className="room-message-content min-w-0">
        {draft.text ? (
          <div className="room-message-bubble text-sm leading-5 text-app-body">
            <p className="whitespace-pre-wrap break-words">{draft.text}</p>
          </div>
        ) : null}
        {draft.error ? (
          <p className="mt-1 text-xs text-app-danger" role="alert">
            {draft.error}
          </p>
        ) : null}
      </div>
    </article>
  );
}
