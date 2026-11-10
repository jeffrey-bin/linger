import type { CommandDefinition } from "./command-definition.js";
import { assertPositionals, bodySource, option } from "./command-input.js";
import {
  booleanSchema,
  email,
  pageInput,
  pageSchema,
  schema,
  stringSchema,
  text,
  usage,
} from "./connector-input.js";
import {
  connectorDefinition,
  cursor,
  nextCursor,
  optionalFields,
  record,
  requiredString,
  toggle,
  value,
  type ConnectorRuntime,
  type Json,
} from "./connector-runtime.js";
import {
  assertNewOutput,
  saveConnectorDownload,
  validateLocalFiles,
} from "./connector-files.js";
import { ConnectorError as CliError } from "./errors.js";
import { displayText } from "./display-text.js";

const pages = {
  "--limit": value("1–100 items per page; default 20."),
  "--cursor": value(
    "Cursor from the previous page; keep the same account and query.",
  ),
};
const targets = {
  "--channel-id": value("Conversation ID; skip name discovery."),
  "--user": value(
    "Full email; read looks up an existing DM, send may create one.",
  ),
  "--user-id": value("User ID; skip email lookup."),
  "--message-url": value("Slack HTTPS message URL."),
  "--thread": value("Parent message ID of the thread in that conversation."),
};
const descriptions = {
  channels: "List visible channels; does not join automatically.",
  search: "Search messages with Slack query syntax.",
  read: "Read a channel, existing DM, or thread without advancing the read cursor.",
  send: "Send body text or files to a channel or user, or reply in an existing thread.",
  react: "Add an emoji reaction; --remove only removes your own reaction.",
  download:
    "Download one Slack file locally without overwriting an existing file.",
};
type Action = keyof typeof descriptions;
export const slackCommandDefinitions: CommandDefinition[] = (
  Object.keys(descriptions) as Action[]
).map((action) =>
  connectorDefinition({
    command: ["slack", action],
    description: descriptions[action],
    readOnly: !["send", "react"].includes(action),
    options:
      action === "channels"
        ? pages
        : action === "search"
          ? pages
          : action === "read"
            ? { ...pages, ...targets }
            : action === "send"
              ? {
                  ...targets,
                  "--channel": value("Exact #channel name."),
                  "--content": value("Body text in Markdown."),
                  "--file": value("UTF-8 body file; - reads stdin."),
                  "--attach": value(
                    "Local regular file; repeatable; provide a body or at least one attachment.",
                    true,
                  ),
                }
              : action === "react"
                ? {
                    "--channel": value("Exact #channel name."),
                    "--channel-id": targets["--channel-id"],
                    "--message-id": value("Exact message ID to react to."),
                    "--message-url": targets["--message-url"],
                    "--remove": toggle("Remove your own reaction."),
                  }
                : {
                    "--file-id": value("Slack file ID with an F prefix."),
                    "--output": value("Local file path; does not overwrite."),
                  },
    usage:
      action === "read"
        ? [
            "teamhub slack read <#name> [--thread <id>] [flags]",
            "teamhub slack read (--channel-id <id> | --user <email> | --user-id <id> | --message-url <url>) [flags]",
          ]
        : action === "react"
          ? [
              "teamhub slack react <emoji> (--channel <#name> | --channel-id <id>) --message-id <id> [--remove] [flags]",
              "teamhub slack react <emoji> --message-url <url> [--remove] [flags]",
            ]
          : [
              `teamhub slack ${action}${action === "search" ? " <query>" : ""} [flags]`,
            ],
    examples:
      action === "send"
        ? [
            "teamhub slack send --channel '#engineering' --content '**Ship complete** :rocket:'",
            "teamhub slack send --user alice@example.com --attach ./proposal.pdf",
          ]
        : action === "react"
          ? [
              "teamhub slack react thumbsup --channel-id C012EXAMPLE --message-id 1792039200.000100",
            ]
          : action === "read"
            ? [
                "teamhub slack read '#engineering'",
                "teamhub slack read --user alice@example.com",
              ]
            : action === "search"
              ? ["teamhub slack search 'in:engineering after:2026-10-01'"]
              : action === "download"
                ? [
                    "teamhub slack download --file-id F012EXAMPLE --output ./proposal.pdf",
                  ]
                : ["teamhub slack channels --limit 50"],
    notes:
      action === "react"
        ? [
            "Common emoji names: 👍 thumbsup · 👎 thumbsdown · ✅ white_check_mark · 👀 eyes · 🎉 tada · ❤️ heart · 🙏 pray · 🚀 rocket. Use the name without colons or the glyph; known workspace custom names also work.",
          ]
        : action === "send"
          ? [
              "Body text is sent as Markdown, for example **bold**, _italic_, [link](https://example.com); with --attach it is the files' comment, in Slack mrkdwn.",
            ]
          : [],
    inputSchema: schema({
      ...(["channels", "search", "read"].includes(action) ? pageSchema : {}),
      ...(action === "search"
        ? { query: stringSchema }
        : ["send", "read", "react"].includes(action)
          ? {
              channelName: stringSchema,
              channelId: stringSchema,
              userEmail: stringSchema,
              userId: stringSchema,
              messageUrl: stringSchema,
              threadId: stringSchema,
              ...(action === "send"
                ? {
                    content: stringSchema,
                    attachments: { type: "array", items: stringSchema },
                  }
                : action === "react"
                  ? {
                      emoji: stringSchema,
                      messageId: stringSchema,
                      remove: booleanSchema,
                    }
                  : {}),
            }
          : action === "download"
            ? { fileId: stringSchema, output: stringSchema }
            : {}),
    }),
    sourceFiles: (input) => (input.attachments ?? []) as string[],
    normalize: async (args, reader) => {
      const input: Json = {};
      if (["channels", "search", "read"].includes(action))
        Object.assign(input, pageInput(args));
      if (action === "channels") assertPositionals(args, 0);
      else if (action === "search") {
        assertPositionals(args, 1);
        input.query = text(args.positionals[0], "query", 2000);
      } else if (action === "download") {
        assertPositionals(args, 0);
        input.fileId = slackId(
          text(option(args, "--file-id"), "--file-id"),
          "F",
        );
        input.output = await assertNewOutput(
          text(option(args, "--output"), "--output"),
          reader.cwd,
        );
      } else {
        assertPositionals(
          args,
          action === "react"
            ? 1
            : action === "read" && args.positionals.length
              ? 1
              : 0,
        );
        const channel =
          action === "read" ? args.positionals[0] : option(args, "--channel");
        if (channel !== undefined) {
          if (!/^#[a-zA-Z0-9_-]+$/u.test(channel))
            usage("Provide an exact #channel name; use --channel-id for IDs.");
          input.channelName = channel;
        }
        for (const [flag, key] of [
          ["--channel-id", "channelId"],
          ["--user", "userEmail"],
          ["--user-id", "userId"],
          ["--message-url", "messageUrl"],
          ["--thread", "threadId"],
        ]) {
          const v = option(args, flag!);
          if (v !== undefined)
            input[key!] =
              key === "userEmail"
                ? email(v)
                : key === "channelId"
                  ? slackId(v, "CGD")
                  : key === "userId"
                    ? slackId(v, "UW")
                    : key === "threadId"
                      ? timestamp(v)
                      : text(v, flag!);
        }
        if (
          [
            "channelName",
            "channelId",
            "userEmail",
            "userId",
            "messageUrl",
          ].filter((x) => input[x] !== undefined).length !== 1
        )
          usage("Choose exactly one channel, user, or message link target.");
        if (input.messageUrl) parseSlackURL(displayText(input.messageUrl));
        if (input.messageUrl && input.threadId)
          usage("--message-url cannot be combined with --thread.");
        if (action === "send") {
          if ((input.userEmail || input.userId) && input.threadId)
            usage("--thread requires a channel target.");
          const content = await bodySource(args, reader, false);
          if (content !== undefined) {
            if (
              !content.trim() ||
              Buffer.byteLength(content) > 1048576 ||
              content.includes("\u0000")
            )
              usage("Provide nonblank UTF-8 body text of at most 1 MiB.");
            input.content = content;
          }
          const files = args.options["--attach"];
          if (files)
            input.attachments = await validateLocalFiles(files, reader.cwd);
          if (content === undefined && !files?.length)
            usage("Provide --content, --file, or at least one --attach.");
        } else if (action === "react") {
          const emoji = text(args.positionals[0], "emoji", 100);
          if (!/^[a-zA-Z0-9_+-]+$/u.test(emoji))
            usage(
              "Use an emoji name such as thumbsup, without colons or Unicode glyphs.",
            );
          input.emoji = emoji;
          const message = option(args, "--message-id");
          if (input.messageUrl && message !== undefined)
            usage("A message URL already specifies the message.");
          if (!input.messageUrl)
            input.messageId = timestamp(text(message, "--message-id"));
          if (option(args, "--remove")) input.remove = true;
        }
      }
      return { input };
    },
    bindings: (input) => slackBindings(action, input),
    execute: (input, runtime) => executeSlack(action, input, runtime),
  }),
);
function slackId(value: string, prefix: string): string {
  if (!new RegExp(`^[${prefix}][A-Z0-9]+$`).test(value))
    usage("Provide a Slack ID using the matching explicit ID option.");
  return value;
}
function timestamp(value: string): string {
  if (!/^\d{10}\.\d{6}$/u.test(value))
    usage("Message IDs must retain their original timestamp precision.");
  return value;
}
function parseSlackURL(value: string): {
  channelId: string;
  messageId: string;
  url: URL;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    usage("Provide a Slack HTTPS message link.");
  }
  const match = /^\/archives\/([CGD][A-Z0-9]+)\/p(\d{10})(\d{6})$/u.exec(
    url!.pathname,
  );
  if (
    url!.protocol !== "https:" ||
    url!.port ||
    url!.username ||
    url!.password ||
    !/^[a-zA-Z0-9-]+\.slack\.com$/u.test(url!.hostname) ||
    !match ||
    url!.hash
  )
    usage("Provide a standard Slack message permalink.");
  return {
    channelId: match![1]!,
    messageId: `${match![2]}.${match![3]}`,
    url: url!,
  };
}
function slackBindings(action: Action, input: Json): string[] {
  if (action === "channels") return ["SLACK_LIST_ALL_CHANNELS"];
  if (action === "search") return ["SLACK_SEARCH_MESSAGES"];
  if (action === "download") return ["SLACK_DOWNLOAD_SLACK_FILE"];
  const tools: string[] = [];
  if (input.channelName) tools.push("SLACK_FIND_CHANNELS");
  if (input.userEmail) tools.push("SLACK_FIND_USER_BY_EMAIL_ADDRESS");
  if (input.userEmail || input.userId)
    tools.push(
      ...(action === "send"
        ? ["SLACK_OPEN_DM"]
        : [
            "SLACK_TEST_AUTH",
            "SLACK_LIST_ALL_CHANNELS",
            "SLACK_RETRIEVE_CONVERSATION_MEMBERS_LIST",
          ]),
    );
  if (input.messageUrl)
    tools.push(
      "SLACK_RETRIEVE_MESSAGE_PERMALINK_URL",
      "SLACK_FETCH_ITEM_REACTIONS",
    );
  if (input.threadId) tools.push("SLACK_FETCH_ITEM_REACTIONS");
  if (action === "send")
    tools.push(
      ...(input.attachments
        ? [
            "SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK",
            "SLACK_RETRIEVE_DETAILED_INFORMATION_ABOUT_A_FILE",
          ]
        : ["SLACK_SEND_MESSAGE"]),
    );
  else if (action === "react")
    tools.push(
      input.remove
        ? "SLACK_REMOVE_REACTION_FROM_ITEM"
        : "SLACK_ADD_REACTION_TO_AN_ITEM",
    );
  else
    tools.push(
      "SLACK_FETCH_CONVERSATION_HISTORY",
      "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION",
    );
  return tools;
}
function continuation(raw: Json): string | undefined {
  const meta = raw.response_metadata ? record(raw.response_metadata) : {};
  const token = meta.next_cursor;
  if (token !== undefined && typeof token !== "string")
    throw new CliError(
      "incomplete_response",
      "Slack returned an invalid cursor.",
    );
  if (raw.has_more === true && !token)
    throw new CliError(
      "incomplete_response",
      "Slack reported more data without a usable cursor.",
    );
  return typeof token === "string" && token.trim() ? token : undefined;
}
async function all(
  runtime: ConnectorRuntime,
  slug: string,
  args: Json,
  key: string,
): Promise<Json[]> {
  const rows: Json[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < 100; page++) {
    const raw = await runtime.call(
      slug,
      optionalFields({ ...args, cursor: token, limit: 100 }),
    );
    if (!Array.isArray(raw[key]))
      throw new CliError(
        "incomplete_response",
        "The discovery list is incomplete.",
      );
    rows.push(...(raw[key] as unknown[]).map((x) => record(x)));
    token = continuation(raw);
    if (!token) return rows;
    if (seen.has(token)) break;
    seen.add(token);
  }
  throw new CliError(
    "incomplete_response",
    "Slack discovery did not finish; use an explicit conversation ID.",
  );
}
async function resolveTarget(
  action: Action,
  input: Json,
  runtime: ConnectorRuntime,
  state: Json,
): Promise<Json> {
  if (state.target) return record(state.target);
  let channelId = input.channelId as string | undefined,
    userId = input.userId as string | undefined,
    messageId = input.messageId as string | undefined,
    threadId = input.threadId as string | undefined;
  if (input.channelName) {
    const channels = await all(
      runtime,
      "SLACK_FIND_CHANNELS",
      {
        query: displayText(input.channelName).slice(1),
        exact_match: true,
        types: "public_channel,private_channel",
        exclude_archived: true,
      },
      "channels",
    );
    const matches = channels.filter(
      (x) =>
        x.name === String(input.channelName).slice(1) && x.is_archived !== true,
    );
    if (matches.length !== 1)
      throw new CliError(
        matches.length ? "ambiguous_target" : "not_found",
        "No unique accessible channel matches this current name; use --channel-id.",
      );
    channelId = requiredString(matches[0]!.id, "channel ID");
  }
  if (input.userEmail) {
    const found = await runtime.call("SLACK_FIND_USER_BY_EMAIL_ADDRESS", {
      email: input.userEmail,
    });
    const user = record(found.user);
    if (record(user.profile).email !== input.userEmail)
      throw new CliError(
        "incomplete_response",
        "Slack did not confirm the exact email identity.",
      );
    userId = requiredString(user.id, "user ID");
  }
  if (userId) {
    if (action === "send")
      channelId = requiredString(
        record(
          (
            await runtime.call(
              "SLACK_OPEN_DM",
              { users: userId, return_im: true },
              true,
            )
          ).channel,
        ).id,
        "DM ID",
      );
    else {
      const own = requiredString(
        (await runtime.call("SLACK_TEST_AUTH", {})).user_id,
        "current Slack user ID",
      );
      const dms = await all(
        runtime,
        "SLACK_LIST_ALL_CHANNELS",
        { types: "im", exclude_archived: false },
        "channels",
      );
      const matches = [];
      for (const dm of dms) {
        if (dm.is_im !== true) continue;
        const members: string[] = [];
        const seen = new Set<string>();
        let token: string | undefined;
        for (let page = 0; page < 100; page++) {
          const raw = await runtime.call(
            "SLACK_RETRIEVE_CONVERSATION_MEMBERS_LIST",
            optionalFields({
              channel: requiredString(dm.id, "DM ID"),
              limit: 100,
              cursor: token,
            }),
          );
          if (
            !Array.isArray(raw.members) ||
            !raw.members.every((x) => typeof x === "string")
          )
            throw new CliError(
              "incomplete_response",
              "DM membership is unavailable.",
            );
          members.push(...raw.members);
          token = continuation(raw);
          if (!token) break;
          if (seen.has(token) || page === 99)
            throw new CliError(
              "incomplete_response",
              "DM membership paging did not finish.",
            );
          seen.add(token);
        }
        const actual = [...new Set(members)].sort();
        if (
          JSON.stringify(actual) ===
          JSON.stringify([...new Set([own, userId])].sort())
        )
          matches.push(dm);
      }
      if (matches.length !== 1)
        throw new CliError(
          matches.length ? "ambiguous_target" : "not_found",
          "No unique accessible existing DM was found; use --channel-id. No conversation was opened.",
        );
      channelId = requiredString(matches[0]!.id, "DM ID");
    }
  }
  if (input.messageUrl) {
    const parsed = parseSlackURL(displayText(input.messageUrl));
    channelId = parsed.channelId;
    messageId = parsed.messageId;
    const verified = await runtime.call(
      "SLACK_RETRIEVE_MESSAGE_PERMALINK_URL",
      { channel: channelId, message_ts: messageId },
    );
    const canonical = parseSlackURL(
      requiredString(verified.permalink, "message permalink"),
    );
    if (
      canonical.url.origin !== parsed.url.origin ||
      canonical.channelId !== channelId ||
      canonical.messageId !== messageId
    )
      throw new CliError(
        "invalid_input",
        "The message link does not match the selected workspace.",
      );
    const raw = await runtime.call("SLACK_FETCH_ITEM_REACTIONS", {
      channel: channelId,
      timestamp: messageId,
      full: true,
    });
    const msg = record(raw.message);
    if (msg.ts !== messageId)
      throw new CliError(
        "incomplete_response",
        "The linked message was not verified.",
      );
    threadId = displayText(msg.thread_ts ?? msg.ts);
  }
  if (input.threadId) {
    const raw = await runtime.call("SLACK_FETCH_ITEM_REACTIONS", {
      channel: channelId,
      timestamp: threadId,
      full: true,
    });
    const msg = record(raw.message);
    if (
      msg.ts !== threadId ||
      (msg.thread_ts !== undefined && msg.thread_ts !== threadId)
    )
      throw new CliError(
        "invalid_input",
        "--thread must identify a parent message in this conversation.",
      );
  }
  return optionalFields({
    channelId: requiredString(channelId, "resolved conversation ID"),
    userId,
    messageId,
    threadId,
  });
}
function slackFile(value: unknown): Json {
  const file = record(value);
  return optionalFields({
    fileId: requiredString(file.id, "file ID"),
    name: file.name ?? file.title,
    mimeType: file.mimetype,
    sizeBytes: file.size,
  });
}
function slackMessage(value: unknown, channel?: string): Json {
  const msg = record(value);
  return optionalFields({
    messageId: requiredString(msg.ts, "message ID"),
    channelId:
      channel ??
      (typeof msg.channel === "object" ? record(msg.channel).id : msg.channel),
    threadId: msg.thread_ts,
    authorId: msg.user ?? msg.bot_id,
    text: typeof msg.text === "string" ? msg.text : undefined,
    url: msg.permalink,
    files: Array.isArray(msg.files) ? msg.files.map(slackFile) : undefined,
  });
}
async function executeSlack(
  action: Action,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  if (action === "download") {
    const raw = await runtime.call("SLACK_DOWNLOAD_SLACK_FILE", {
      file: input.fileId,
    });
    const file = record(raw.file_info);
    if (file.id !== input.fileId)
      throw new CliError(
        "incomplete_response",
        "The downloaded file identity was not confirmed.",
      );
    return {
      file: {
        ...slackFile(file),
        ...(await saveConnectorDownload(
          record(raw.file_content).s3url,
          String(input.output),
          runtime.context,
        )),
      },
    };
  }
  const fingerprint = {
    account: runtime.account.connection_id,
    action,
    ...input,
    cursor: undefined,
  };
  const state = cursor(input.cursor, fingerprint);
  if (action === "channels") {
    const raw = await runtime.call(
      "SLACK_LIST_ALL_CHANNELS",
      optionalFields({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: input.limit,
        cursor: state.token,
      }),
    );
    if (!Array.isArray(raw.channels))
      throw new CliError(
        "incomplete_response",
        "The channel list is unavailable.",
      );
    const token = continuation(raw);
    return {
      channels: raw.channels.map((x) => {
        const c = record(x);
        return optionalFields({
          channelId: requiredString(c.id, "channel ID"),
          name: requiredString(c.name, "channel name"),
          isPrivate: c.is_private,
          isMember: c.is_member,
        });
      }),
      hasMore: Boolean(token),
      ...(token ? { nextCursor: nextCursor({ token }, fingerprint) } : {}),
    };
  }
  if (action === "search") {
    const raw = await runtime.call("SLACK_SEARCH_MESSAGES", {
      query: input.query,
      count: input.limit,
      cursor: state.token ?? "*",
      sort: "timestamp",
      sort_dir: "desc",
      highlight: false,
      auto_paginate: false,
    });
    const data = record(raw.messages);
    if (!Array.isArray(data.matches))
      throw new CliError(
        "incomplete_response",
        "The search result is unavailable.",
      );
    const token =
      continuation(raw) ??
      (typeof data.next_cursor === "string" ? data.next_cursor : undefined);
    if (!token && typeof data.paging === "object") {
      const p = record(data.paging);
      if (Number(p.page) < Number(p.pages))
        throw new CliError(
          "incomplete_response",
          "Slack search continuation is unavailable.",
        );
    }
    return {
      messages: data.matches.map((x) => slackMessage(x)),
      hasMore: Boolean(token),
      ...(token ? { nextCursor: nextCursor({ token }, fingerprint) } : {}),
    };
  }
  const target = await resolveTarget(action, input, runtime, state);
  const channelId = target.channelId;
  if (action === "read") {
    const raw = await runtime.call(
      target.threadId
        ? "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION"
        : "SLACK_FETCH_CONVERSATION_HISTORY",
      optionalFields({
        channel: channelId,
        ts: target.threadId,
        limit: input.limit,
        cursor: state.token,
      }),
    );
    if (!Array.isArray(raw.messages))
      throw new CliError(
        "incomplete_response",
        "The message page is unavailable.",
      );
    const token = continuation(raw);
    return {
      ...target,
      messages: raw.messages.map((x) => slackMessage(x, String(channelId))),
      hasMore: Boolean(token),
      ...(token
        ? { nextCursor: nextCursor({ token, target }, fingerprint) }
        : {}),
    };
  }
  if (action === "react") {
    await runtime.call(
      input.remove
        ? "SLACK_REMOVE_REACTION_FROM_ITEM"
        : "SLACK_ADD_REACTION_TO_AN_ITEM",
      { channel: channelId, timestamp: target.messageId, name: input.emoji },
      true,
    );
    return {
      result: {
        action: input.remove ? "reaction_removed" : "reacted",
        acknowledged: true,
        channelId,
      },
    };
  }
  if (runtime.files.length) {
    const file = await Promise.all(
      runtime.files.map((x) =>
        runtime.stageFile(x, "SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK"),
      ),
    );
    const raw = await runtime.call(
      "SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK",
      optionalFields({
        file,
        channels: channelId,
        thread_ts: target.threadId,
        initial_comment: input.content,
      }),
      true,
    );
    const uploaded = Array.isArray(raw.files)
      ? raw.files
      : raw.file
        ? [raw.file]
        : [];
    if (uploaded.length !== file.length)
      throw new CliError(
        "outcome_unknown",
        "Not all uploaded file IDs were returned.",
      );
    const files = [];
    for (const item of uploaded) {
      const id = requiredString(record(item).id, "uploaded file ID");
      const verified = record(
        (
          await runtime.call(
            "SLACK_RETRIEVE_DETAILED_INFORMATION_ABOUT_A_FILE",
            { file: id },
          )
        ).file,
      );
      const destinations = [
        ...(Array.isArray(verified.channels) ? verified.channels : []),
        ...(Array.isArray(verified.groups) ? verified.groups : []),
        ...(Array.isArray(verified.ims) ? verified.ims : []),
      ];
      const shares = verified.shares ? record(verified.shares) : {};
      const shared = [
        ...Object.keys(shares.public ? record(shares.public) : {}),
        ...Object.keys(shares.private ? record(shares.private) : {}),
      ];
      if (
        verified.id !== id ||
        ![...destinations, ...shared].includes(channelId)
      )
        throw new CliError(
          "outcome_unknown",
          "The file was uploaded but its destination was not confirmed.",
        );
      files.push(slackFile(verified));
    }
    return { result: { action: "sent", acknowledged: true, channelId, files } };
  }
  const raw = await runtime.call(
    "SLACK_SEND_MESSAGE",
    optionalFields({
      channel: channelId,
      markdown_text: input.content,
      thread_ts: target.threadId,
      reply_broadcast: false,
    }),
    true,
  );
  if (raw.channel !== channelId)
    throw new CliError(
      "outcome_unknown",
      "The sent message conversation was not confirmed.",
    );
  return {
    result: optionalFields({
      action: "sent",
      acknowledged: true,
      channelId,
      messageId: raw.ts ?? raw.message_ts,
    }),
  };
}
