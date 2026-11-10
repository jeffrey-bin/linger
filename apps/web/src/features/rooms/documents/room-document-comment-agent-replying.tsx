import type { ThreadData } from "@blocknote/core/comments";
import { useEffect, useState } from "react";

import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";

import { commentCompositionFromBody } from "./room-document-comment-body";
import { visibleThreadComments } from "./room-document-comments";

/** Past this, an Agent that never answered stops showing as replying. */
export const AGENT_REPLY_WAIT_MS = 10 * 60 * 1000;

/**
 * The Agents a thread is waiting on: those @mentioned in its latest comment,
 * written by someone else, while that comment is still recent. The reply
 * itself is a later comment in the thread, so it ends the wait.
 */
export function agentsReplyingTo(
  thread: ThreadData,
  actors: ReadonlyMap<string, TeamHubActorRef>,
  now: number,
): TeamHubActorRef[] {
  if (thread.resolved) return [];
  const latest = visibleThreadComments(thread).at(-1);
  if (!latest) return [];
  if (now - new Date(latest.createdAt).getTime() > AGENT_REPLY_WAIT_MS) {
    return [];
  }
  const { mentions } = commentCompositionFromBody(latest.body, [
    ...actors.values(),
  ]);
  return mentions.filter(
    (actor) => actor.kind === "agent" && actor.id !== latest.userId,
  );
}

export function RoomDocumentCommentAgentReplying({
  actors,
  anchorText,
  thread,
}: {
  actors: ReadonlyMap<string, TeamHubActorRef>;
  /** The live text under the thread's anchor; null once it is deleted. */
  anchorText: string | null;
  thread: ThreadData;
}) {
  const [now, setNow] = useState(() => Date.now());
  const latest = visibleThreadComments(thread).at(-1);
  // An Agent asked to change the anchored text edits the Document before it
  // posts its reply, and the edit arrives first. Remember the text as it stood
  // when the request was seen, so the edit itself ends the wait.
  const [asked, setAsked] = useState({ anchorText, commentId: latest?.id });
  if (asked.commentId !== latest?.id) {
    setAsked({ anchorText, commentId: latest?.id });
  }
  const anchorEdited =
    asked.commentId === latest?.id && asked.anchorText !== anchorText;
  const agents = anchorEdited ? [] : agentsReplyingTo(thread, actors, now);
  const expiresAt = latest
    ? new Date(latest.createdAt).getTime() + AGENT_REPLY_WAIT_MS
    : 0;

  // Re-check once the wait runs out, so a silent Agent stops "replying".
  useEffect(() => {
    if (!expiresAt) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  if (agents.length === 0) return null;
  const names = agents.map((agent) => agent.display_name);
  const label =
    names.length === 1
      ? `${names[0]} is replying`
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are replying`;

  return (
    <div aria-live="polite" className="agent-replying" role="status">
      <span aria-hidden="true" className="agent-replying-dots">
        <span />
        <span />
        <span />
      </span>
      <span className="agent-replying-label">{label}</span>
    </div>
  );
}
