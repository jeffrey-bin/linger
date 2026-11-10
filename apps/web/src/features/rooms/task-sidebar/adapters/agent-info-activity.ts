import type {
  TeamHubMessage,
  TeamHubRunStatus,
} from "@/features/teamhub/teamhub-types";

export interface AgentInfoActivityEntry {
  createdAt: string;
  runStatusId?: string;
  id: string;
  promptText: string;
}

export function agentInfoActivityEntries(
  messages: readonly TeamHubMessage[],
  options: {
    actorId: string;
    runStatuses: readonly TeamHubRunStatus[];
  },
): AgentInfoActivityEntry[] {
  const messagesById = new Map(
    messages.map((message) => [message.id, message]),
  );
  const entries = new Map<string, AgentInfoActivityEntry>();

  for (const runStatus of options.runStatuses) {
    if (runStatus.agent.id !== options.actorId) continue;
    const prompt = previousHumanMessage(messages, runStatus.created_at);
    const promptText = messageText(prompt);
    if (!prompt || !promptText) continue;
    const current = entries.get(prompt.id);
    if (
      current &&
      compareRecency(current.createdAt, current.id, runStatus) >= 0
    ) {
      continue;
    }
    entries.set(prompt.id, {
      createdAt: runStatus.created_at,
      runStatusId: runStatus.id,
      id: runStatus.id,
      promptText,
    });
  }

  for (const message of chronological(messages)) {
    if (message.author.kind !== "agent") continue;
    if (message.author.id !== options.actorId) continue;
    // Runtime handoffs and Room notices are not replies to anyone.
    if (message.message_kind !== "conversation") continue;
    const prompt = promptForMessage(messages, messagesById, message);
    const promptText = messageText(prompt);
    if (!prompt || !promptText) continue;
    if (entries.has(prompt.id)) continue;
    entries.set(prompt.id, {
      createdAt: message.created_at,
      id: message.id,
      promptText,
    });
  }

  return [...entries.values()].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
  );
}

function promptForMessage(
  messages: readonly TeamHubMessage[],
  messagesById: Map<string, TeamHubMessage>,
  message: TeamHubMessage,
) {
  if (message.reply_to_message_id) {
    const replied = messagesById.get(message.reply_to_message_id);
    if (replied?.author.kind === "human") return replied;
  }
  return previousHumanMessage(messages, message.created_at);
}

function previousHumanMessage(
  messages: readonly TeamHubMessage[],
  before: string,
) {
  return chronological(messages)
    .filter(
      (message) =>
        message.author.kind === "human" &&
        message.message_kind === "conversation" &&
        message.created_at.localeCompare(before) <= 0,
    )
    .at(-1);
}

function chronological(messages: readonly TeamHubMessage[]) {
  return [...messages].sort(
    (left, right) =>
      left.created_at.localeCompare(right.created_at) ||
      left.id.localeCompare(right.id),
  );
}

function messageText(message?: TeamHubMessage) {
  if (!message) return "";
  return message.raw_message.trim();
}

function compareRecency(
  createdAt: string,
  id: string,
  runStatus: TeamHubRunStatus,
) {
  const created = createdAt.localeCompare(runStatus.created_at);
  if (created !== 0) return created;
  return id.localeCompare(runStatus.id);
}
