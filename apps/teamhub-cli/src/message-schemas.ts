// Offline discovery schemas describe normalized business inputs. Command
// definitions separately expose the explicit CLI text/file/JSON sources.
type Schema = Record<string, unknown>;
const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = Object.keys(properties),
): Schema => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const text = { type: "string", minLength: 1, maxLength: 50000, pattern: "\\S" };
const identity = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
};
const teamhubID = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
};
const sourcePath = {
  type: "string",
  minLength: 1,
  description:
    "Local resource path relative to cwd; stdin, URLs, symlinks and private paths are rejected.",
};
const caption = { type: "string", minLength: 1, maxLength: 50000 };
const paging = {
  cursor: { type: "string", maxLength: 1024 },
  limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
};
const textSegment = object({ type: { const: "text" }, content: text });
const reference = object({
  type: { const: "reference" },
  content: {
    type: "string",
    minLength: 1,
    maxLength: 120,
    pattern: "^[^\\r\\n]+$",
  },
  target: teamhubID,
  target_type: { enum: ["user", "agent"] },
});
const existingDocument = object(
  {
    type: { const: "document" },
    document_id: teamhubID,
    content: caption,
    presentation: { enum: ["inline", "card", "canvas"], default: "inline" },
  },
  ["type", "document_id", "content"],
);
const localDocument = object(
  {
    type: { const: "document" },
    "content-path": sourcePath,
    content: caption,
    mode: { enum: ["document", "file", "tree"] },
  },
  ["type", "content-path"],
);
// What previews and quotes show in place of the fragment.
const fragmentTitle = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  description: "One plain line naming the fragment, e.g. Launch tracker.",
};
export const publicMessageSegmentSchema = {
  oneOf: [
    textSegment,
    reference,
    existingDocument,
    localDocument,
    object({
      type: { const: "fragment" },
      title: fragmentTitle,
      content: { type: "string", minLength: 1, maxLength: 2097152 },
    }),
    object({
      type: { const: "fragment" },
      title: fragmentTitle,
      "content-path": sourcePath,
    }),
  ],
};
const segmentArray = (items: unknown) => ({
  type: "array",
  minItems: 1,
  maxItems: 1000,
  items,
});
export const messageSendInputSchema = {
  ...object(
    {
      inbox_id: identity,
      message_segments: segmentArray(publicMessageSegmentSchema),
      source_message_id: teamhubID,
      continues: { const: true },
    },
    ["inbox_id", "message_segments"],
  ),
  description:
    "--content/--file parse ordered text and explicit Actor references; --attach appends local document segments. --message/--message-file accept only {segments:[...]}. The message goes to the configured Room, or --thread. Resource preparation and message submission share one atomic operation.",
};
export const messageCardInputSchema = {
  ...object(
    {
      inbox_id: identity,
      card_title: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        description: "One line shown as the card's title.",
      },
      card_kind: {
        enum: ["profile"],
        description:
          "What the card is; profile delivers the Human's Personal Profile.",
      },
      message_segments: segmentArray(publicMessageSegmentSchema),
    },
    ["inbox_id", "card_title", "message_segments"],
  ),
  description:
    "--title is the card's one-line title; --kind profile marks a Personal Profile delivery; --content/--file is its one-line result; --attach publishes local files and --document shows existing Documents, both repeatable. Resource preparation and message submission share one atomic operation.",
};
export const messageReadInputSchema = {
  oneOf: [
    object({ inbox_id: identity, ...paging }, ["inbox_id"]),
    object({ thread_id: identity, ...paging }, ["thread_id"]),
    object({
      message_ids: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        uniqueItems: true,
        items: identity,
      },
    }),
    object({ list_inboxes: { const: true } }),
  ],
};
export const messageSearchInputSchema = object(
  {
    query: { type: "string", minLength: 1, maxLength: 1000, pattern: "\\S" },
    inbox_ids: {
      type: "array",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 512 },
    },
    ...paging,
  },
  ["query"],
);
export const messageDirectInputSchema = object({
  messages: { type: "array", minItems: 1, maxItems: 100, items: text },
});
export const messageSequenceInputSchema = object(
  {
    inbox_id: {
      type: "string",
      pattern: "^room[_-][A-Za-z0-9_-]*$",
      minLength: 6,
      maxLength: 64,
    },
    messages: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: [object({ content: text, pause_before: { const: "none" } })],
      additionalItems: object({
        content: text,
        pause_before: { enum: ["none", "brief", "natural"] },
      }),
    },
    source_message_id: teamhubID,
  },
  ["inbox_id", "messages"],
);
const emoji = { type: "string", pattern: "^[a-z0-9_+-]{1,64}$" };
export const messageEmojiInputSchema = object({
  message_id: teamhubID,
  emoji,
});
export const messageEmojiOutputSchema = object({
  accepted: { const: true },
  message_id: teamhubID,
  emoji,
});
const questionText = (max: number) => ({
  type: "string",
  minLength: 1,
  maxLength: max,
  pattern: "\\S",
});
const question = object(
  {
    question: questionText(2000),
    options: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: questionText(200),
    },
    multiple: { type: "boolean" },
  },
  ["question", "options"],
);
export const messageAskUserInputSchema = object(
  {
    thread_id: identity,
    title: questionText(120),
    questions: { type: "array", minItems: 1, maxItems: 20, items: question },
  },
  ["title", "questions"],
);
export const messageAskUserOutputSchema = object({
  interaction_id: teamhubID,
  message_id: teamhubID,
  status: { const: "pending" },
});
export const historyInboxSchema = object({
  inbox_id: { type: "string" },
  kind: { enum: ["room", "thread", "task", "meta", "taskmeta"] },
});
export const historyMessageSchema = object({
  message_id: identity,
  inbox_id: { type: "string" },
  author_actor_id: identity,
  author: { type: "string" },
  author_kind: { enum: ["human", "agent"] },
  body: { type: "string" },
  segments: { type: "array", items: { type: "object" } },
  message_kind: {
    enum: ["conversation", "agent_runtime", "task_terminal_notice"],
  },
  created_at: { type: "string", format: "date-time" },
  context_message_ids: { type: "array", items: identity },
  resource_references: {
    type: "array",
    items: object({ document_id: identity }),
  },
});
export const readMessageSchema = {
  ...historyMessageSchema,
  required: [
    ...(historyMessageSchema.required as string[]),
    "context_messages",
  ],
  properties: {
    ...(historyMessageSchema.properties as Schema),
    context_messages: { type: "array", items: historyMessageSchema },
    thread_id: identity,
  },
};
export const messageReadOutputSchema = {
  oneOf: [
    object(
      {
        mode: { const: "inbox" },
        inbox_id: { type: "string" },
        messages: { type: "array", items: readMessageSchema },
        root: readMessageSchema,
        has_more: { type: "boolean" },
        next_cursor: { type: "string", minLength: 1 },
      },
      ["mode", "inbox_id", "messages", "has_more"],
    ),
    object({
      mode: { const: "messages" },
      messages: { type: "array", items: readMessageSchema },
      requested_message_ids: { type: "array", items: identity },
      unavailable_message_ids: { type: "array", items: identity },
      has_more: { const: false },
    }),
    object({
      mode: { const: "inboxes" },
      inboxes: { type: "array", items: historyInboxSchema },
      has_more: { const: false },
    }),
  ],
};
export const messageSearchOutputSchema = object(
  {
    messages: { type: "array", items: historyMessageSchema },
    has_more: { type: "boolean" },
    next_cursor: { type: "string", minLength: 1 },
  },
  ["messages", "has_more"],
);
const duplicate = {
  duplicate_request: { type: "boolean" },
  reason: { type: "string", minLength: 1 },
};
export const messageDirectOutputSchema = object(
  {
    accepted: { const: true },
    inbox_id: { type: "string" },
    message_ids: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: teamhubID,
    },
    room_created: { type: "boolean" },
    ...duplicate,
  },
  ["accepted", "inbox_id", "message_ids", "room_created", "duplicate_request"],
);
export const messageSequenceOutputSchema = object(
  {
    accepted: { const: true },
    inbox_id: { type: "string" },
    sequence_id: teamhubID,
    ...duplicate,
  },
  ["accepted", "inbox_id", "sequence_id", "duplicate_request"],
);
export const messageDocumentResourceSchema = {
  ...object(
    {
      kind: { const: "document" },
      segment_index: { type: "integer", minimum: 0 },
      status: { enum: ["published", "reused"] },
      document_id: teamhubID,
      version_id: teamhubID,
      revision_id: teamhubID,
      name: { type: "string", minLength: 1 },
    },
    ["kind", "segment_index", "status", "document_id", "name"],
  ),
  anyOf: [{ required: ["version_id"] }, { required: ["revision_id"] }],
};
export const messageTreeResourceSchema = {
  ...object(
    {
      kind: { const: "tree" },
      segment_index: { type: "integer", minimum: 0 },
      status: { enum: ["published", "reused"] },
      publication_group_id: teamhubID,
      root_placement_path: { type: "string", minLength: 1 },
      file_count: { type: "integer", minimum: 0 },
      directory_count: { type: "integer", minimum: 0 },
      total_bytes: { type: "integer", minimum: 0 },
      documents: {
        type: "array",
        items: object({
          relative_path: { type: "string", minLength: 1 },
          document_id: teamhubID,
          document_version_id: teamhubID,
        }),
      },
      entry_document_id: teamhubID,
      entry_document_version_id: teamhubID,
    },
    [
      "kind",
      "segment_index",
      "status",
      "publication_group_id",
      "root_placement_path",
      "file_count",
      "directory_count",
      "total_bytes",
      "documents",
    ],
  ),
  dependencies: {
    entry_document_id: ["entry_document_version_id"],
    entry_document_version_id: ["entry_document_id"],
  },
};
export const messageSendOutputSchema = object(
  {
    accepted: { const: true },
    target: object({
      type: { enum: ["room", "thread", "task"] },
      id: identity,
    }),
    inbox_id: { type: "string" },
    task_id: { type: "string" },
    message_id: teamhubID,
    resources: {
      type: "array",
      items: {
        oneOf: [messageDocumentResourceSchema, messageTreeResourceSchema],
      },
    },
    ...duplicate,
  },
  ["accepted", "target", "message_id", "resources", "duplicate_request"],
);
