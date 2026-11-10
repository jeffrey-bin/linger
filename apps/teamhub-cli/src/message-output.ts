import { CliError } from "./errors.js";
import { displayText } from "./display-text.js";
type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const yes = (value: unknown) => (value === true ? "yes" : "no");
const text = (value: unknown) =>
  typeof value === "string" ? value : displayText(value ?? "");
// Render the flag that reads this Inbox again; the configured Room has none.
function target(inbox: unknown): string {
  const address = text(inbox);
  if (address.startsWith("thread:"))
    return `--thread ${address.slice("thread:".length)}`;
  if (/^(?:task|meta|taskmeta):/u.test(address)) return `--inbox ${address}`;
  return address.startsWith("room:") ? address : `room:${address}`;
}
function message(value: unknown): string {
  const item = object(value);
  const lines = [
    `Target: ${target(item.inbox_id)}`,
    `Created: ${text(item.created_at)}`,
  ];
  if (item.thread_id) lines.push(`Thread: ${text(item.thread_id)}`);
  lines.push(
    `message_id=${JSON.stringify(item.message_id)} ${text(item.author)} (${text(item.author_kind)}; ${text(item.author_actor_id)}): ${JSON.stringify(item.body)}`,
  );
  const contexts = new Map(
    list(item.context_messages).map((value) => {
      const context = object(value);
      return [context.message_id, context];
    }),
  );
  for (const id of list(item.context_message_ids)) {
    const context = contexts.get(id);
    lines.push(
      context
        ? `  reply to message_id=${JSON.stringify(id)} ${text(context.author)}: ${JSON.stringify(context.body)}`
        : `  reply to message_id=${JSON.stringify(id)} [unavailable]`,
    );
  }
  const segments = list(item.segments);
  if (segments.length) {
    lines.push("Segments:");
    segments.forEach((value, index) =>
      lines.push(`${index + 1}. ${JSON.stringify(value)}`),
    );
  }
  const references = list(item.resource_references);
  if (references.length)
    lines.push(`Resource references: ${JSON.stringify(references)}`);
  return lines.join("\n");
}
export function renderMessageRead(result: Json): string {
  const messages = list(result.messages);
  if (result.mode === "inboxes") {
    const inboxes = list(result.inboxes);
    return inboxes.length
      ? `${inboxes.length} inboxes\n\nINBOX  KIND\n${inboxes
          .map((value) => {
            const item = object(value);
            return `${text(item.inbox_id)}  ${text(item.kind)}`;
          })
          .join("\n")}`
      : "No inboxes found.";
  }
  if (result.mode === "messages")
    return [
      `${messages.length} of ${list(result.requested_message_ids).length} messages`,
      ...messages.map(message),
      ...(list(result.unavailable_message_ids).length
        ? [
            `Unavailable message IDs: ${JSON.stringify(result.unavailable_message_ids)}`,
          ]
        : []),
    ].join("\n\n");
  const lines = [];
  if (result.root) lines.push("Root", message(result.root));
  lines.push(
    messages.length
      ? `${messages.length} ${result.root ? "replies" : "messages"} on this page`
      : result.root
        ? "No replies found."
        : "No messages found.",
  );
  lines.push(...messages.map(message), `Has more: ${yes(result.has_more)}`);
  if (result.has_more && result.next_cursor)
    lines.push(`Next cursor: ${text(result.next_cursor)}`);
  return lines.join("\n\n");
}
export function renderMessageSearch(result: Json, input?: Json): string {
  const messages = list(result.messages);
  const lines = [
    ...(input
      ? [
          `Query: ${text(input.query)}`,
          `Inboxes: ${list(input.inbox_ids).length ? list(input.inbox_ids).map(text).join(", ") : "all authorized"}`,
        ]
      : []),
    messages.length
      ? `${messages.length} ${messages.length === 1 ? "message" : "messages"} found`
      : "No messages found.",
    ...messages.map(message),
    `Has more: ${yes(result.has_more)}`,
  ];
  if (result.has_more && result.next_cursor)
    lines.push(`Next cursor: ${text(result.next_cursor)}`);
  return lines.join("\n\n");
}
function duplicate(result: Json): string[] {
  if (typeof result.duplicate_request !== "boolean")
    throw new CliError(
      "invalid_response",
      "TeamHub did not provide duplicate-request status.",
    );
  if (!result.duplicate_request) return [];
  if (typeof result.reason !== "string" || !result.reason.trim())
    throw new CliError(
      "invalid_response",
      "TeamHub did not explain the duplicate request.",
    );
  return ["Duplicate request: yes", `Reason: ${result.reason}`];
}
export function renderMessageSend(result: Json): string {
  const actual = object(result.target);
  const lines = [
    result.duplicate_request ? "Already accepted" : "Message accepted",
    `Target   --${text(actual.type)} ${text(actual.id)}`,
    `Message  ${text(result.message_id)}`,
    ...duplicate(result),
  ];
  const resources = list(result.resources);
  if (resources.length) {
    lines.push(
      "",
      `${resources.length} resources`,
      "SEGMENT  STATE  RESOURCE  VERSION  NAME",
    );
    for (const value of resources) {
      const resource = object(value);
      if (resource.kind === "tree") {
        lines.push(
          `${text(resource.segment_index)}  ${text(resource.status)}  ${text(resource.publication_group_id)}  ${text(resource.root_placement_path)}  ${text(resource.file_count)} files, ${text(resource.directory_count)} directories, ${text(resource.total_bytes)} bytes`,
        );
        for (const document of list(resource.documents)) {
          const item = object(document);
          lines.push(
            `  ${text(item.relative_path)}  ${text(item.document_id)}  ${text(item.document_version_id)}`,
          );
        }
      } else
        lines.push(
          `${text(resource.segment_index)}  ${text(resource.status)}  ${text(resource.document_id)}  ${text(resource.version_id ?? resource.revision_id)}  ${text(resource.name)}`,
        );
    }
  }
  return lines.join("\n");
}
export function renderMessageDirect(result: Json): string {
  const ids = list(result.message_ids);
  return [
    result.duplicate_request ? "Already accepted" : "Direct messages accepted",
    `Target        ${target(result.inbox_id)}`,
    `Room created  ${text(result.room_created)}`,
    `Messages      ${ids.length}`,
    ...ids.map((id) => `  ${text(id)}`),
    ...duplicate(result),
  ].join("\n");
}
export function renderMessageEmoji(result: Json): string {
  return `Reacted :${text(result.emoji)}: to ${text(result.message_id)}`;
}
export function renderMessageAskUser(result: Json): string {
  return [
    "Question posted",
    `Interaction  ${text(result.interaction_id)}`,
    `Message      ${text(result.message_id)}`,
    `Status       ${text(result.status)}`,
    "The answer arrives later as a new message. Don't wait for it here, and don't ask again.",
  ].join("\n");
}
export function renderMessageSequence(result: Json): string {
  return [
    result.duplicate_request ? "Already accepted" : "Sequence accepted",
    `Room      ${text(result.inbox_id).replace(/^room:/u, "")}`,
    `Sequence  ${text(result.sequence_id)}`,
    "Presentation is queued.",
    ...duplicate(result),
  ].join("\n");
}
