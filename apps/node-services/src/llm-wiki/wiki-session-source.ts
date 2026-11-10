import { stringify } from "yaml";

import type { WikiSessionRouting } from "./backend.js";
import { rawSourceReference, roomMessageUrl } from "./personal-wiki-policy.js";

/** A Session of the Memory index as TeamHub sends it with its indexed text. */
export interface WikiSessionDescriptor {
  kind: "room" | "recording";
  date: string;
  sessionId: string;
  roomId: string;
  transcriptDocumentId?: string;
  transcriptDocumentVersionId?: string;
  representedHumanActorId: string;
  representedHumanDisplayName: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
/** The line Memory writes under each Room message heading of Session Raw:
 * `## <time> · <author>`, a blank line, then this line. */
const MESSAGE_METADATA = /^Message metadata: (\{.*\})$/u;

/**
 * The generator input of one Session: the application-owned routing to its
 * dated Session page and the Human's identity, then the indexed text with a
 * citation token after each Room message, or one for a recording's
 * transcript. A citation opens the original conversation at that message.
 */
export function renderSessionSource(
  title: string,
  raw: string,
  session: WikiSessionDescriptor,
): { markdown: string; routing: WikiSessionRouting } {
  const citations: string[] = [];
  const cite = (url: string) => {
    if (!citations.includes(url)) citations.push(url);
    return `Citation: [[source:${rawSourceReference(url)}]]`;
  };
  let body: string;
  if (session.kind === "room") {
    // Only the metadata line right under a message heading names a message,
    // so a message body quoting that format names nothing.
    const lines = raw.split("\n");
    body = lines
      .map((line, index) => {
        const messageId =
          index >= 2 &&
          lines[index - 2]!.startsWith("## ") &&
          lines[index - 1] === ""
            ? messageIdOf(line)
            : undefined;
        return messageId
          ? `${line}\n${cite(roomMessageUrl(session.roomId, messageId))}`
          : line;
      })
      .join("\n");
  } else {
    const transcript = `teamhub://documents/${session.transcriptDocumentId}/versions/${session.transcriptDocumentVersionId}`;
    body = `${cite(transcript)}\n\n${raw}`;
  }
  if (citations.length === 0)
    throw new Error("A Session source has nothing to cite");
  const targetPath = `sessions/${session.date}/${session.sessionId}.md`;
  const header = {
    type: "Session Source",
    title,
    wiki_projection: {
      node_type: "session",
      target_path: targetPath,
      date: session.date,
      session_id: session.sessionId,
      source_kind: session.kind === "room" ? "room" : "meeting",
    },
    session_identity: {
      represented_human_actor_id: session.representedHumanActorId,
      represented_human_display_name: session.representedHumanDisplayName,
      // A recording is not speech by its uploader.
      attribution_basis:
        session.kind === "room"
          ? "message_author_actor_id"
          : "unknown_transcript_speakers",
      attachment_attribution_basis: "unknown_transcript_speakers",
    },
  };
  return {
    markdown: `---\n${stringify(header, { lineWidth: 0 }).trimEnd()}\n---\n\n# ${title.replace(/[\r\n]/gu, " ")}\n\n${body.trimEnd()}\n`,
    routing: { targetPath, date: session.date, citations },
  };
}

function messageIdOf(line: string): string | undefined {
  const metadata = MESSAGE_METADATA.exec(line)?.[1];
  if (!metadata) return undefined;
  try {
    const value = JSON.parse(metadata) as { message_id?: unknown };
    return typeof value.message_id === "string" &&
      ID_PATTERN.test(value.message_id)
      ? value.message_id
      : undefined;
  } catch {
    return undefined;
  }
}
