import { teamHubData } from "./http-client.js";
import { decodeInlineEscapes } from "./content-segments.js";
import type {
  CommandArguments,
  CommandDefinition,
  CommandInputReader,
  CommandOption,
  NormalizedCommandInput,
} from "./command-definition.js";
import { reportInFinalReply } from "./command-definition.js";
import {
  assertPositionals,
  jsonSource,
  markdownBodySource,
  option,
  parseJsonValue,
  requiredOption,
  targetFromFlags,
  values,
} from "./command-input.js";
import { parseActorReferences } from "./command-mentions.js";
import { CliError } from "./errors.js";
import {
  renderMessageRead,
  renderMessageSearch,
  renderMessageSend,
  renderMessageDirect,
  renderMessageSequence,
  renderMessageEmoji,
  renderMessageAskUser,
} from "./message-output.js";

import {
  messageCardInputSchema,
  messageSendInputSchema,
  messageSendOutputSchema,
  messageReadInputSchema,
  messageReadOutputSchema,
  messageSearchInputSchema,
  messageSearchOutputSchema,
  messageDirectInputSchema,
  messageDirectOutputSchema,
  messageSequenceInputSchema,
  messageSequenceOutputSchema,
  messageEmojiInputSchema,
  messageEmojiOutputSchema,
  messageAskUserInputSchema,
  messageAskUserOutputSchema,
} from "./message-schemas.js";
import { displayText } from "./display-text.js";

type Json = Record<string, unknown>;
const fail = (message: string): never => {
  throw new CliError("usage", message);
};
const record = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
function string(
  value: unknown,
  label: string,
  max = 50000,
  nonblank = true,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    [...value].length > max ||
    (nonblank && !value.trim())
  )
    fail(`${label} must be a nonblank string of at most ${max} characters.`);
  return value as string;
}
function id(value: unknown, label: string, max = 256): string {
  const text = string(value, label, max);
  if (!idPattern.test(text)) fail(`${label} is not a valid identifier.`);
  return text;
}
function strict(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): Json {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    fail(`${label} has invalid or unsupported fields.`);
  return value as Json;
}
function cardTitle(args: CommandArguments): string {
  const title = requiredOption(args, "--title").trim();
  if (!title || [...title].length > 120 || /[\r\n]/.test(title))
    fail("--title must be one line of 1 to 120 characters.");
  return title;
}
// TeamHub's question card rules, checked field by field so a bad call is
// corrected before anything reaches the Room.
function askUserQuestions(value: unknown): Json[] {
  if (typeof value === "string")
    fail("--questions must be a JSON array, not a string of encoded JSON.");
  if (!Array.isArray(value) || value.length < 1 || value.length > 20)
    fail("--questions must be a JSON array of 1 to 20 questions.");
  return (value as unknown[]).map((item, index) => {
    const path = `questions[${index}]`;
    const question = strict(
      item,
      ["question", "options", "multiple"],
      ["question"],
      path,
    );
    string(question.question, `${path}.question`, 2000);
    const { options, multiple } = question;
    if (multiple !== undefined && typeof multiple !== "boolean")
      fail(`${path}.multiple must be true or false.`);
    if (!Array.isArray(options) || options.length < 1 || options.length > 20)
      fail(
        `${path}.options must list 1 to 20 choices; ask an open question in an ordinary message instead.`,
      );
    const labels = new Set<string>();
    (options as unknown[]).forEach((option, optionIndex) => {
      const label = string(
        option,
        `${path}.options[${optionIndex}]`,
        200,
      ).trim();
      if (labels.has(label))
        fail(
          `${path}.options[${optionIndex}] "${label}" repeats an earlier choice.`,
        );
      labels.add(label);
    });
    return question;
  });
}
function paging(args: CommandArguments): Json {
  const result: Json = {};
  const cursor = option(args, "--cursor");
  if (cursor !== undefined)
    result.cursor = string(cursor, "--cursor", 1024, false);
  const limit = option(args, "--limit");
  if (limit !== undefined) {
    if (!/^[0-9]+$/u.test(limit) || Number(limit) < 1 || Number(limit) > 100)
      fail("--limit must be an integer from 1 to 100.");
    result.limit = Number(limit);
  }
  return result;
}
function count<T>(value: T[], min: number, max: number, label: string): T[] {
  if (value.length < min || value.length > max)
    fail(`${label} must contain ${min}-${max} items.`);
  return value;
}
function reply(args: CommandArguments, allowed: boolean): Json {
  const source = option(args, "--reply-to");
  if (source === undefined) return {};
  if (!allowed)
    fail("--reply-to is supported only for Room or Thread messages.");
  const sourceID = id(source, "--reply-to", 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(sourceID))
    fail("--reply-to is not a valid message ID.");
  return { source_message_id: sourceID };
}
const targetOptions: Record<string, CommandOption> = {
  "--thread": {
    description: "Bare Thread ID inside the configured Room.",
  },
};
const bodyOptions: Record<string, CommandOption> = {
  "--content": {
    description:
      "Inline body text; never read as a path. Outside code, \\n and \\t become a line break and a tab, and \\\\ becomes \\ (write \\\\n for a literal \\n; inside shell double quotes type \\\\\\\\n). Code and --file bodies are never decoded.",
  },
  "--file": {
    description:
      "Read a UTF-8 body file; - consumes stdin (multi-line text, e.g. a heredoc).",
  },
};
const completeOptions = {
  "--message": { description: "One complete JSON object." },
  "--message-file": {
    description: "Read one complete JSON object from a file or stdin.",
  },
};
const pageOptions = {
  "--cursor": { description: "Exact previous next_cursor." },
  "--limit": { description: "Page size from 1 to 100; default 20." },
};

export function validateMessageSegments(value: unknown): Json[] {
  if (!Array.isArray(value)) fail("message.segments must be an array.");
  return count(value as unknown[], 1, 1000, "message.segments").map(
    (raw, index) => {
      if (!record(raw)) fail(`Segment ${index} must be an object.`);
      const segment = raw as Json;
      const type = segment.type;
      if (type === "text") {
        strict(
          segment,
          ["type", "content"],
          ["type", "content"],
          "Text segment",
        );
        string(segment.content, "Text content");
      } else if (type === "reference") {
        strict(
          segment,
          ["type", "content", "target", "target_type"],
          ["type", "content", "target", "target_type"],
          "Reference segment",
        );
        const label = string(segment.content, "Reference label", 120);
        if (
          /[\r\n]/u.test(label) ||
          !["user", "agent"].includes(String(segment.target_type))
        )
          fail(
            "Reference requires a single-line label and user or agent target_type.",
          );
        id(segment.target, "Reference target", 64);
      } else if (type === "document") {
        const local = Object.hasOwn(segment, "content-path");
        strict(
          segment,
          local
            ? ["type", "content-path", "content", "mode"]
            : ["type", "document_id", "content", "presentation"],
          local ? ["type", "content-path"] : ["type", "document_id", "content"],
          "Document segment",
        );
        if (local) {
          resourcePath(segment["content-path"]);
          if (
            segment.mode !== undefined &&
            !["document", "file", "tree"].includes(displayText(segment.mode))
          )
            fail("Document mode must be document, file or tree.");
        } else {
          id(segment.document_id, "Document ID", 64);
          if (
            segment.presentation !== undefined &&
            !["inline", "card", "canvas"].includes(
              displayText(segment.presentation),
            )
          )
            fail("Document presentation must be inline, card or canvas.");
        }
        if (segment.content !== undefined)
          string(segment.content, "Document content");
      } else if (type === "fragment") {
        strict(
          segment,
          ["type", "title", "content-path", "content"],
          ["type", "title"],
          "Fragment segment",
        );
        const title = string(segment.title, "Fragment title", 120);
        if (title !== title.trim() || /[\r\n]/u.test(title))
          fail("Fragment title must be one line without surrounding spaces.");
        if (
          Object.hasOwn(segment, "content-path") ===
          Object.hasOwn(segment, "content")
        )
          fail("Fragment requires exactly one of content or content-path.");
        if (segment.content !== undefined)
          string(segment.content, "Fragment content", 2 * 1024 * 1024);
        else resourcePath(segment["content-path"]);
      } else fail(`Unsupported segment type at index ${index}.`);
      return segment;
    },
  );
}
function resourcePath(value: unknown): string {
  const text = string(value, "Resource content-path", 4096);
  if (text === "-" || /^[a-z][a-z0-9+.-]*:\/\//iu.test(text))
    fail("Resource paths cannot use stdin or URLs.");
  return text;
}
async function ordinaryBodies(
  args: CommandArguments,
  reader: CommandInputReader,
): Promise<string[]> {
  const sources = args.ordered.filter(
    (item) => item.name === "--content" || item.name === "--file",
  );
  return Promise.all(
    sources.map(async (item) =>
      string(
        item.name === "--file"
          ? await reader.text(item.value)
          : decodeInlineEscapes(item.value),
        "Message body",
      ),
    ),
  );
}
async function normalizeSend(
  args: CommandArguments,
  reader: CommandInputReader,
): Promise<NormalizedCommandInput> {
  assertPositionals(args, 0, 0);
  const destination = targetFromFlags(args, ["thread"]);
  const attachments = values(args, "--attach");
  const source = reply(
    args,
    !destination.target || destination.target.type === "thread",
  );
  const structured =
    option(args, "--message") !== undefined ||
    option(args, "--message-file") !== undefined;
  if (
    structured &&
    (option(args, "--content") !== undefined ||
      option(args, "--file") !== undefined ||
      attachments.length)
  )
    fail(
      "Complete message input cannot be combined with body input or --attach.",
    );
  let segments: unknown;
  if (structured)
    segments = strict(
      await jsonSource(args, reader, "--message", "--message-file"),
      ["segments"],
      ["segments"],
      "Message",
    ).segments;
  else {
    const body = await markdownBodySource(args, reader, false);
    segments = [
      ...(body === undefined ? [] : parseActorReferences(body)),
      ...attachments.map((value) => ({
        type: "document",
        "content-path": resourcePath(value),
      })),
    ];
  }
  const message_segments = validateMessageSegments(segments);
  const target = destination.target;
  const routing = target ? { inbox_id: `${target.type}:${target.id}` } : {};
  const continues =
    option(args, "--continuing") !== undefined ? { continues: true } : {};
  return {
    ...destination,
    input: { ...routing, message_segments, ...source, ...continues },
  };
}
// A card is one light Message in the Room: a one-line title, a one-line result
// and files. The Meta delivers a finished background Task's result with it, or
// points out something the user must notice.
async function normalizeCard(
  args: CommandArguments,
  reader: CommandInputReader,
): Promise<NormalizedCommandInput> {
  assertPositionals(args, 0, 0);
  const destination = targetFromFlags(args, ["thread"]);
  const title = cardTitle(args);
  const kind = option(args, "--kind");
  if (kind !== undefined && kind !== "profile") fail("--kind must be profile.");
  const body = (await markdownBodySource(args, reader))!;
  const message_segments = validateMessageSegments([
    ...parseActorReferences(body),
    ...values(args, "--document").map((id) => ({
      type: "document",
      document_id: id,
      content: id,
      presentation: "card",
    })),
    ...values(args, "--attach").map((value) => ({
      type: "document",
      "content-path": resourcePath(value),
    })),
  ]);
  const target = destination.target;
  const routing = target ? { inbox_id: `${target.type}:${target.id}` } : {};
  return {
    ...destination,
    input: {
      ...routing,
      card_title: title,
      ...(kind ? { card_kind: kind } : {}),
      message_segments,
    },
  };
}
async function normalizeRead(
  args: CommandArguments,
): Promise<NormalizedCommandInput> {
  assertPositionals(args, 0, 0);
  const destination = targetFromFlags(args, ["thread"]);
  const batch = option(args, "--message-ids"),
    inbox = option(args, "--inbox"),
    discover = option(args, "--list-inboxes");
  if (
    Number(Boolean(destination.target)) +
      Number(batch !== undefined) +
      Number(inbox !== undefined) +
      Number(discover !== undefined) >
    1
  )
    fail("Choose exactly one message read target or mode.");
  if (
    (batch !== undefined || discover !== undefined) &&
    (option(args, "--limit") !== undefined ||
      option(args, "--cursor") !== undefined)
  )
    fail("Batch and Inbox discovery modes do not support pagination.");
  if (batch !== undefined) {
    const message_ids = count(
      batch.split(",").map((value) => id(value.trim(), "--message-ids", 256)),
      1,
      50,
      "--message-ids",
    );
    if (new Set(message_ids).size !== message_ids.length)
      fail("--message-ids cannot contain duplicate IDs.");
    return { input: { message_ids } };
  }
  if (discover !== undefined) return { input: { list_inboxes: true } };
  if (inbox !== undefined) {
    if (
      !/^(?:room|thread|task|meta|taskmeta):[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(
        inbox,
      ) ||
      inbox.length > 512
    )
      fail(
        "--inbox accepts only room:, thread:, task:, meta: or taskmeta: addresses.",
      );
    return {
      input: { inbox_id: inbox, ...paging(args) },
      target: { type: "inbox", id: inbox },
    };
  }
  const target = destination.target;
  return {
    ...destination,
    input: {
      ...(target ? { thread_id: id(target.id, "--thread") } : {}),
      ...paging(args),
    },
  };
}

export const messageCommandDefinitions: readonly CommandDefinition[] = [
  {
    command: ["message", "read"],
    toolName: "read_messages",
    description:
      "Read an authorized conversation or a batch of complete messages.",
    readOnly: true,
    schema: true,
    defaultTarget: "room-or-task",
    usage: [
      "[--thread <id>] [flags]",
      "--message-ids <id1,id2,...>",
      "--inbox <inbox-id>",
      "--list-inboxes",
    ],
    options: {
      "--thread": targetOptions["--thread"]!,
      "--message-ids": {
        description:
          "1-50 comma-separated unique message IDs, returned in input order.",
      },
      "--inbox": {
        description:
          "Explicit authorized room:, thread:, task:, private meta: or taskmeta: Inbox address.",
      },
      "--list-inboxes": {
        description:
          "Discover all authorized Inboxes without default filtering.",
        boolean: true,
      },
      ...pageOptions,
    },
    inputSchema: messageReadInputSchema,
    outputSchema: messageReadOutputSchema,
    normalize: normalizeRead,
    execute: (input, context) =>
      teamHubData(
        context.client.api.POST("/api/agent/v1/messages/read", { body: input }),
      ),
    render: renderMessageRead,
  },
  {
    command: ["message", "search"],
    toolName: "search_messages",
    description:
      "Search authorized message history, optionally within explicit Inboxes.",
    readOnly: true,
    schema: true,
    usage: ["<query> [--inbox <inbox-id> ...] [flags]"],
    arguments: [
      "<query>  Nonblank case-insensitive substring; preserved literally. Matches message text only, not author names.",
    ],
    options: {
      "--inbox": {
        description:
          "Explicit authorized Inbox filter; repeat up to 100 times.",
        repeatable: true,
      },
      ...pageOptions,
    },
    normalize: async (args) => {
      assertPositionals(args, 1, 1);
      const query = string(args.positionals[0], "query", 1000);
      const inbox_ids = count(
        [...values(args, "--inbox")],
        0,
        100,
        "--inbox",
      ).map((value) => id(value, "--inbox", 512));
      return {
        input: {
          query,
          ...(inbox_ids.length ? { inbox_ids } : {}),
          ...paging(args),
        },
      };
    },
    inputSchema: messageSearchInputSchema,
    outputSchema: messageSearchOutputSchema,
    render: renderMessageSearch,
  },
  {
    command: ["message", "send"],
    toolName: "send_message",
    unavailableInTask: reportInFinalReply,
    description:
      "Send one message and optional resources, or coordinate privately.",
    readOnly: false,
    schema: true,
    defaultTarget: "room-or-task",
    usage: [
      "[target] (--content <text> | --file <path|->) [--attach <path> ...]",
      "[target] (--message <JSON> | --message-file <path|->)",
    ],
    options: {
      ...targetOptions,
      ...bodyOptions,
      ...completeOptions,
      "--attach": {
        description:
          "Public file delivery appended after the body; repeatable, no directories.",
        repeatable: true,
      },
      "--reply-to": {
        description: "Reply source for the whole message; Room/Thread only.",
      },
      "--continuing": {
        description:
          "Declare that more work in this turn follows this message (acknowledgement or stage update). Never use it on the final answer.",
        boolean: true,
      },
    },
    notes: [
      'Complete message: {"segments":[...]}; 1-1000 ordered segments.',
      "text: content. reference: content, target, target_type=user|agent.",
      "document: document_id + content, optional presentation=inline|card|canvas (canvas also opens it in the side panel of people viewing the Room); OR content-path + optional content/mode=document|file|tree.",
      "Images and videos are files: attach them like any other file (content-path, or --attach).",
      "fragment: a title plus exactly one inline HTML/SVG content or UTF-8 content-path. title is one plain line of at most 120 characters (e.g. Launch tracker) that previews and quotes show; do not repeat it as a heading inside the fragment. Read the chat-card skill for the fragment's shape and theme before writing one.",
      "--content/--file support [@Name](user:actor_id) or [@Name](agent:actor_id); code/escaped mentions stay literal. Complete messages require explicit reference segments.",
      "An Agent receives a Room/Thread handoff notification only when you @ it with an Agent reference; writing its name or plain @Name does not notify it.",
      "Resource paths cannot use stdin or URLs. Publication and message commit are atomic.",
      "--continuing keeps the turn shown as working after this message; omit it on the final or only answer.",
    ],
    examples: [
      'teamhub message send --content "Done."',
      'teamhub message send --content "[@Reviewer](agent:actor_reviewer) Please review this result."',
      `teamhub message send --message '{"segments":[{"type":"fragment","title":"Weekly sales","content-path":"./playground/weekly-sales.html"}]}'`,
    ],
    normalize: normalizeSend,
    execute: async (input, context) =>
      (await import("./message-send-executor.js")).executeMessageSend(
        input,
        context,
      ),
    inputSchema: messageSendInputSchema,
    outputSchema: messageSendOutputSchema,
    render: renderMessageSend,
  },
  {
    command: ["message", "card"],
    toolName: "send_message_card",
    unavailableInTask: reportInFinalReply,
    description:
      "Send one light card to the Room or one of its Threads: a title, a one-line result and files. Deliver a finished background Task's result with it, or point out something the user must notice; reply in ordinary messages otherwise.",
    readOnly: false,
    schema: true,
    defaultTarget: "room",
    usage: [
      "[--thread <id>] [--kind profile] --title <text> (--content <text> | --file <path|->) [--attach <path> ...] [--document <id> ...]",
    ],
    options: {
      ...targetOptions,
      "--title": {
        description: "The card's title: one line, at most 120 characters.",
      },
      "--kind": {
        description:
          "Only profile: marks the delivery of the Human's Personal Profile.",
      },
      ...bodyOptions,
      "--attach": {
        description:
          "Local file published with the card, e.g. from ./playground/<task-id>/; repeatable, no directories.",
        repeatable: true,
      },
      "--document": {
        description: "Existing Document ID shown on the card; repeatable.",
        repeatable: true,
      },
    },
    notes: [
      "The body is a one-line result kept with the card; the Web shows only the title and files (and the body of a profile card). Put details in the files, and say what the user should add or check in one ordinary message after the card.",
      "--content/--file support [@Name](user:actor_id) or [@Name](agent:actor_id).",
      "A failed Task is not delivered as a card; say what happened in an ordinary message.",
      "Resource paths cannot use stdin or URLs. Publication and message commit are atomic.",
    ],
    examples: [
      'teamhub message card --title "Competitor comparison" --content "A cut its enterprise price 15%; B moved its launch to early November." --attach ./playground/task_8f2c/comparison.xlsx',
    ],
    normalize: normalizeCard,
    execute: async (input, context) =>
      (await import("./message-send-executor.js")).executeMessageSend(
        input,
        context,
      ),
    inputSchema: messageCardInputSchema,
    outputSchema: messageSendOutputSchema,
    render: renderMessageSend,
  },
  {
    command: ["message", "sequence"],
    toolName: "send_message_sequence",
    unavailableInTask: reportInFinalReply,
    description: "Queue 2-8 ordered conversational bubbles in a Room.",
    readOnly: false,
    schema: true,
    defaultTarget: "room",
    usage: [
      "(--content <text> | --file <path|->) ... --pause <tier>",
      "(--message <JSON> | --message-file <path|->)",
    ],
    options: {
      ...Object.fromEntries(
        Object.entries(bodyOptions).map(([key, value]) => [
          key,
          { ...value, repeatable: true },
        ]),
      ),
      ...completeOptions,
      "--pause": {
        description: "Required ordinary-mode rhythm: none, brief or natural.",
      },
      "--reply-to": {
        description: "Shared reply source for the whole sequence.",
      },
    },
    notes: [
      "First bubble pause_before is always none. Complete input specifies every pause explicitly.",
      "Presentation is queued; accepted does not mean every bubble has been displayed.",
      "Only the current AnotherMe Meta collaboration identity may queue sequences.",
    ],
    normalize: async (args, reader) => {
      assertPositionals(args, 0, 0);
      const complete =
        option(args, "--message") !== undefined ||
        option(args, "--message-file") !== undefined;
      if (
        complete &&
        (args.ordered.some(
          (item) => item.name === "--content" || item.name === "--file",
        ) ||
          option(args, "--pause") !== undefined)
      )
        fail(
          "Complete sequence input cannot be combined with bodies or --pause.",
        );
      let messages: unknown;
      if (complete)
        messages = strict(
          await jsonSource(args, reader, "--message", "--message-file"),
          ["messages"],
          ["messages"],
          "Sequence",
        ).messages;
      else {
        const pause = requiredOption(args, "--pause");
        if (!["none", "brief", "natural"].includes(pause))
          fail("--pause must be none, brief or natural.");
        messages = (await ordinaryBodies(args, reader)).map(
          (content, index) => ({
            content,
            pause_before: index === 0 ? "none" : pause,
          }),
        );
      }
      if (!Array.isArray(messages)) fail("Sequence messages must be an array.");
      const normalized = count(
        messages as unknown[],
        2,
        8,
        "Sequence messages",
      ).map((value, index) => {
        const bubble = strict(
          value,
          ["content", "pause_before"],
          ["content", "pause_before"],
          "Sequence bubble",
        );
        string(bubble.content, "Bubble content");
        if (
          !["none", "brief", "natural"].includes(String(bubble.pause_before)) ||
          (index === 0 && bubble.pause_before !== "none")
        )
          fail("Every bubble requires pause_before; the first must be none.");
        return bubble;
      });
      return { input: { messages: normalized, ...reply(args, true) } };
    },
    inputSchema: messageSequenceInputSchema,
    outputSchema: messageSequenceOutputSchema,
    render: renderMessageSequence,
  },
  {
    command: ["message", "emoji"],
    toolName: "send_emoji",
    unavailableInTask: reportInFinalReply,
    description: "React to a visible message with one emoji.",
    readOnly: false,
    schema: true,
    usage: ["<message-id> <emoji>"],
    arguments: [
      "<message-id>  Message in a Room or Thread you belong to.",
      "<emoji>  Emoji ID from the official Reaction library, e.g. joy, ok_hand, +1, heart, tada.",
    ],
    options: {},
    notes: [
      "A Reaction is not a message: it never notifies or wakes anyone.",
      "Repeating the same emoji on the same message changes nothing.",
    ],
    normalize: async (args) => {
      assertPositionals(args, 2, 2);
      const messageID = id(args.positionals[0], "<message-id>", 64);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(messageID))
        fail("<message-id> is not a valid message ID.");
      const emoji = args.positionals[1]!;
      if (!/^[a-z0-9_+-]{1,64}$/u.test(emoji))
        fail("<emoji> must be an emoji ID such as joy, ok_hand or +1.");
      return { input: { message_id: messageID, emoji } };
    },
    inputSchema: messageEmojiInputSchema,
    outputSchema: messageEmojiOutputSchema,
    render: renderMessageEmoji,
  },
  {
    command: ["message", "ask-user"],
    toolName: "ask_user",
    unavailableInTask:
      "In a Task you don't ask people. Put the question in your final reply; the Meta decides whether to ask.",
    description:
      "Ask your Sponsor in this Room, or in one of its Threads, with a question card; returns at once without waiting for the answer.",
    readOnly: false,
    schema: true,
    usage: ["[--thread <id>] --title <text> --questions <JSON>"],
    options: {
      ...targetOptions,
      "--title": {
        description: "The card's title: one line, at most 120 characters.",
      },
      "--questions": {
        description:
          'JSON array of 1-20 questions, each {"question": "...", "options": ["...", "..."], "multiple": true}. Your Sponsor picks one option, or several when "multiple" is true, and can also write an answer of their own; every question needs 1-20 options.',
      },
    },
    examples: [
      `teamhub message ask-user --title "Friday team outing" --questions '[{"question":"Where should we go?","options":["Hotpot","BBQ"]},{"question":"What else would you like to do?","options":["KTV","Board games","Movie"],"multiple":true}]'`,
    ],
    notes: [
      "A card only offers choices. For an open question or a missing fact, ask in an ordinary message; your Sponsor replies in the chat.",
      "Only your Sponsor can answer the card; a Sponsor outside this Room cannot be asked.",
      "Every question must be answered and each multiple-choice question needs at least one pick, so don't add optional questions.",
      'The answer arrives later as a new message where the card was posted, "Human interaction <id> answered:" followed by one "- <question> → <answer>" line per question; several picks are joined with ", ".',
      "Meanwhile keep doing work that doesn't depend on the answer; if everything depends on it, end your turn. Never invent the answer, and never post the same question twice.",
    ],
    normalize: async (args) => {
      assertPositionals(args, 0, 0);
      const thread = targetFromFlags(args, ["thread"]).target;
      return {
        input: {
          ...(thread ? { thread_id: thread.id } : {}),
          title: cardTitle(args),
          questions: askUserQuestions(
            parseJsonValue(requiredOption(args, "--questions")),
          ),
        },
      };
    },
    inputSchema: messageAskUserInputSchema,
    outputSchema: messageAskUserOutputSchema,
    render: renderMessageAskUser,
  },
  {
    command: ["message", "direct"],
    toolName: "send_direct_message",
    unavailableInTask: reportInFinalReply,
    description: "Send private messages to the current Agent's Human sponsor.",
    readOnly: false,
    schema: true,
    usage: [
      "(--content <text> | --file <path|->) ...",
      "(--messages <JSON> | --messages-file <path|->)",
    ],
    options: {
      ...Object.fromEntries(
        Object.entries(bodyOptions).map(([key, value]) => [
          key,
          { ...value, repeatable: true },
        ]),
      ),
      "--messages": {
        description: "Complete array of 1-100 nonblank strings.",
      },
      "--messages-file": {
        description: "Read the complete string array from a file or stdin.",
      },
    },
    notes: [
      "Each body is one complete message; blank lines do not split messages.",
      "TeamHub resolves the Sponsor. No recipient lookup or configured Room fallback.",
      "Bodies do not create structured mentions or upload resources.",
    ],
    normalize: async (args, reader) => {
      assertPositionals(args, 0, 0);
      const complete =
        option(args, "--messages") !== undefined ||
        option(args, "--messages-file") !== undefined;
      if (
        complete &&
        args.ordered.some(
          (item) => item.name === "--content" || item.name === "--file",
        )
      )
        fail("Complete messages input cannot be combined with body inputs.");
      const messages = complete
        ? await jsonSource(args, reader, "--messages", "--messages-file")
        : await ordinaryBodies(args, reader);
      if (!Array.isArray(messages))
        fail("--messages must be an array of strings.");
      return {
        input: {
          messages: count(messages as unknown[], 1, 100, "Messages").map(
            (value) => string(value, "Message body"),
          ),
        },
      };
    },
    inputSchema: messageDirectInputSchema,
    outputSchema: messageDirectOutputSchema,
    render: renderMessageDirect,
  },
];
