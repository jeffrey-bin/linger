import { sliceConnectorPage } from "./connector-pages.js";
import path from "node:path";
import { lstat } from "node:fs/promises";
import {
  assertNewOutput,
  connectorTransferURL,
  readConnectorFile,
  saveConnectorDownload,
  validateLocalFiles,
} from "./connector-files.js";
import type { CommandDefinition } from "./command-definition.js";
import { assertPositionals, bodySource, option } from "./command-input.js";
import {
  booleanSchema,
  choice,
  emails,
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
import { ConnectorError as CliError } from "./errors.js";
import {
  array,
  id,
  mailSchema,
  mailSummarySchema,
  mailWriteSchema,
  object,
  pageOutput,
  rootSchema,
} from "./connector-schemas.js";
import { displayText } from "./display-text.js";

const pageOptions = {
  "--limit": value("1–100 items per page; default 20."),
  "--cursor": value(
    "Cursor returned by the previous page; keep the same account and filters.",
  ),
};
const bodyOptions = {
  "--attach": value(
    "Attach a local regular file; repeatable; stdin is rejected.",
    true,
  ),
  "--content": value("Body text; exclusive with --file."),
  "--file": value("UTF-8 body file; - reads stdin, not an attachment."),
  "--markdown": toggle("TeamHub converts Markdown to HTML on the backend."),
  "--html": toggle("Use HTML body text as-is."),
};
const recipientOptions = {
  "--to": value("One bare email address; repeatable.", true),
  "--cc": value("One Cc email address; repeatable.", true),
  "--bcc": value("One Bcc email address; repeatable.", true),
  "--subject": value("Subject with no line breaks."),
};
const actions = [
  "list",
  "read",
  "send",
  "reply",
  "draft",
  "archive",
  "download",
] as const;
type Action = (typeof actions)[number];
const summaries: Record<Action, string> = {
  download:
    "Download selected attachments from a message to local files without overwriting.",
  list: "List the inbox or search messages.",
  read: "Read a message, thread, or known draft without changing read state.",
  send: "Send a new message or an existing draft.",
  reply: "Reply to a message and keep the thread.",
  draft: "Create a draft or update the same draft without sending.",
  archive: "Move a message out of the inbox and keep the message.",
};
const options: Record<Action, Json> = {
  list: {
    ...pageOptions,
    "--folder": value("inbox / sent / all; default inbox."),
    "--query": value("Search text; Gmail accepts native query syntax."),
    "--unread": toggle("List unread messages only."),
  },
  read: {
    ...pageOptions,
    "--thread": toggle("Read the containing thread."),
    "--draft": value(
      "Read by draft ID; exclusive with the positional argument and thread options.",
    ),
  },
  send: {
    ...bodyOptions,
    ...recipientOptions,
    "--draft": value(
      "Send a saved draft; exclusive with body, recipients, and format flags.",
    ),
  },
  reply: {
    ...bodyOptions,
    "--all": toggle("Reply to every visible recipient except yourself."),
  },
  draft: {
    ...bodyOptions,
    ...recipientOptions,
    "--update": value(
      "Update the same draft; omitted fields and attachments are kept.",
    ),
  },
  archive: {},
  download: {
    "--attachment": value(
      "Exact attachment name; use --attachment-id when names collide.",
    ),
    "--attachment-id": value(
      "Attachment ID from read; exclusive with name and --all.",
    ),
    "--all": toggle(
      "Download every regular-file attachment; skip inline images and non-file attachments.",
    ),
    "--output": value(
      "New file path for a single attachment; an existing directory with --all. Does not overwrite.",
    ),
  },
};
export const mailCommandDefinitions: CommandDefinition[] = [
  "gmail",
  "outlook",
].flatMap((app) =>
  actions.map((action) =>
    connectorDefinition({
      command: [app, action],
      description: summaries[action],
      readOnly: ["list", "read", "download"].includes(action),
      options: options[action] as CommandDefinition["options"],
      usage: mailUsage(app, action),
      examples:
        action === "list"
          ? [
              `teamhub ${app} list --unread`,
              `teamhub ${app} list --query 'from:alice@example.invalid' --json`,
            ]
          : action === "read"
            ? [
                `teamhub ${app} read message_example --thread`,
                `teamhub ${app} read --draft draft_example`,
              ]
            : action === "send"
              ? [
                  `teamhub ${app} send --to alice@example.invalid --subject 'Project update' --markdown --file ./weekly.md --attach ./proposal.pdf`,
                  `teamhub ${app} send --draft draft_example`,
                ]
              : action === "reply"
                ? [
                    `teamhub ${app} reply message_example --all --content 'Received; will finish by Friday.'`,
                  ]
                : action === "draft"
                  ? [
                      `teamhub ${app} draft --to alice@example.invalid --subject 'Project update' --markdown --file ./weekly.md`,
                      `teamhub ${app} draft --update draft_example --subject 'Project update (revised)'`,
                    ]
                  : action === "archive"
                    ? [`teamhub ${app} archive message_example`]
                    : [
                        `teamhub ${app} download message_example --attachment 'proposal.pdf' --output ./proposal.pdf`,
                        `teamhub ${app} download message_example --all --output ./attachments`,
                      ],
      inputSchema: mailInputSchema(action),
      sourceFiles: (input) => (input.attachments ?? []) as string[],
      outputSchema:
        action === "download"
          ? rootSchema({
              messageId: id,
              files: array(
                object({
                  path: id,
                  attachmentId: id,
                  name: id,
                  sizeBytes: { type: "integer", minimum: 0 },
                  sha256: id,
                }),
              ),
              skipped: array(
                object(
                  {
                    attachmentId: id,
                    name: id,
                    reason: { enum: ["inline", "item", "reference"] },
                  },
                  ["attachmentId", "reason"],
                ),
              ),
            })
          : action === "list"
            ? rootSchema(
                { messages: array(mailSummarySchema), ...pageOutput },
                ["messages", "hasMore"],
              )
            : action === "read"
              ? {
                  oneOf: [
                    rootSchema({ mail: mailSchema }),
                    rootSchema({
                      draft: object({ draftId: id, mail: mailSchema }),
                    }),
                    rootSchema({
                      thread: object(
                        {
                          threadId: id,
                          messages: array(mailSchema),
                          ...pageOutput,
                        },
                        ["threadId", "messages", "hasMore"],
                      ),
                    }),
                  ],
                }
              : rootSchema({ result: mailWriteSchema }),
      normalize: async (args, reader) => {
        const input: Json = {};
        if (action === "download") {
          assertPositionals(args, 1);
          input.messageId = text(args.positionals[0], "message ID");
          const name = option(args, "--attachment"),
            attachmentId = option(args, "--attachment-id");
          const all = option(args, "--all");
          if (
            [
              name !== undefined,
              attachmentId !== undefined,
              Boolean(all),
            ].filter(Boolean).length !== 1
          )
            usage(
              "Choose exactly one of --attachment, --attachment-id, or --all.",
            );
          if (name !== undefined)
            input.attachmentName = text(name, "--attachment", 1024);
          if (attachmentId !== undefined)
            input.attachmentId = text(attachmentId, "--attachment-id");
          const output = text(option(args, "--output"), "--output", 4096);
          if (output === "-") usage("--output must be a local path.");
          if (all) {
            input.all = true;
            input.output = path.resolve(reader.cwd, output);
            const directory = await lstat(String(input.output)).catch(
              () => null,
            );
            if (!directory?.isDirectory() || directory.isSymbolicLink())
              throw new CliError(
                "invalid_path",
                "--all requires an existing ordinary directory.",
              );
          } else input.output = await assertNewOutput(output, reader.cwd);
        } else if (action === "list") {
          assertPositionals(args, 0);
          Object.assign(input, pageInput(args), {
            folder: choice(
              option(args, "--folder"),
              ["inbox", "sent", "all"],
              "--folder",
              "inbox",
            ),
          });
          if (option(args, "--query") !== undefined)
            input.query = text(option(args, "--query"), "--query", 2000);
          if (option(args, "--unread")) input.unreadOnly = true;
          if (app === "outlook" && input.query && input.unreadOnly)
            throw new CliError(
              "unsupported_combination",
              "Outlook search cannot be combined with --unread; use the separate list filters.",
            );
        } else if (action === "read") {
          const draft = option(args, "--draft");
          if (draft !== undefined) {
            assertPositionals(args, 0);
            if (
              ["--thread", "--limit", "--cursor"].some(
                (x) => option(args, x) !== undefined,
              )
            )
              usage(
                "--draft cannot be combined with thread or pagination options.",
              );
            input.draftId = text(draft, "--draft");
          } else {
            assertPositionals(args, 1);
            input.messageId = text(args.positionals[0], "message ID");
            if (option(args, "--thread"))
              Object.assign(input, pageInput(args), { thread: true });
            else if (
              ["--limit", "--cursor"].some((x) => option(args, x) !== undefined)
            )
              usage("Pagination is only available with --thread.");
          }
        } else if (action === "archive") {
          assertPositionals(args, 1);
          input.messageId = text(args.positionals[0], "message ID");
        } else {
          assertPositionals(args, action === "reply" ? 1 : 0);
          if (action === "reply") {
            input.messageId = text(args.positionals[0], "message ID");
            if (option(args, "--all")) input.replyAll = true;
          }
          if (action === "send" && option(args, "--draft") !== undefined) {
            if (
              [
                ...Object.keys(bodyOptions),
                ...Object.keys(recipientOptions),
              ].some((x) => option(args, x) !== undefined)
            )
              usage(
                "--draft cannot be combined with body, format, or recipient options.",
              );
            return {
              input: { draftId: text(option(args, "--draft"), "--draft") },
            };
          }
          const attachments = args.options["--attach"];
          if (attachments)
            input.attachments = await validateLocalFiles(
              attachments,
              reader.cwd,
              app === "outlook" ? 150 * 1024 * 1024 : 25 * 1024 * 1024,
            );
          const update = option(args, "--update");
          if (update !== undefined)
            input.updateDraftId = text(update, "--update");
          for (const name of ["to", "cc", "bcc"]) {
            const list = emails(args, `--${name}`);
            if (list) input[name] = list;
          }
          if (
            (
              [input.to, input.cc, input.bcc] as (string[] | undefined)[]
            ).reduce((n, x) => n + (x?.length ?? 0), 0) > 100
          )
            usage("At most 100 recipient addresses are allowed.");
          const subject = option(args, "--subject");
          if (subject !== undefined)
            input.subject = text(
              subject,
              "--subject",
              app === "outlook" ? 255 : 500,
            );
          const content = await bodySource(args, reader, update === undefined);
          if (option(args, "--markdown") && option(args, "--html"))
            usage("Choose --markdown or --html.");
          if (content !== undefined) {
            if (
              !content.trim() ||
              Buffer.byteLength(content) > 1 << 20 ||
              content.includes("\u0000")
            )
              usage("The body must be nonblank UTF-8 text of at most 1 MiB.");
            input.content = content;
            input.bodyFormat = option(args, "--markdown")
              ? "markdown"
              : option(args, "--html")
                ? "html"
                : "text";
          } else if (option(args, "--markdown") || option(args, "--html"))
            usage("A format option requires a new body.");
          if (
            update !== undefined &&
            !["to", "cc", "bcc", "subject", "content", "attachments"].some(
              (x) => input[x] !== undefined,
            )
          )
            usage("--update requires at least one changed field.");
          if (
            update === undefined &&
            action !== "reply" &&
            (!Array.isArray(input.to) ||
              !input.to.length ||
              input.to.length > 50 ||
              input.subject === undefined)
          )
            usage("Provide --to and --subject for a new message or draft.");
        }
        return { input };
      },
      bindings: (input) => mailBindings(app, action, input),
      execute: async (input, runtime) => {
        const result = await executeMail(app, action, input, runtime);
        return ["list", "read", "download"].includes(action)
          ? result
          : { result };
      },
    }),
  ),
);

function mailUsage(app: string, action: Action): string[] {
  const prefix = `teamhub ${app} ${action}`;
  switch (action) {
    case "read":
      return [
        `${prefix} <message-id> [--thread] [flags]`,
        `${prefix} --draft <draft-id> [flags]`,
      ];
    case "download":
      return [
        `${prefix} <message-id> (--attachment <name> | --attachment-id <id>) --output <path> [flags]`,
        `${prefix} <message-id> --all --output <directory> [flags]`,
      ];
    case "send":
      return [
        `${prefix} --to <email> --subject <text> (--content <text> | --file <path|->) [--markdown | --html] [--attach <path>] [flags]`,
        `${prefix} --draft <draft-id> [flags]`,
      ];
    case "draft":
      return [
        `${prefix} --to <email> --subject <text> (--content <text> | --file <path|->) [flags]`,
        `${prefix} --update <draft-id> [--subject <text>] [--content <text> | --file <path|->] [--attach <path>] [flags]`,
      ];
    case "reply":
      return [
        `${prefix} <message-id> (--content <text> | --file <path|->) [--all] [--markdown | --html] [--attach <path>] [flags]`,
      ];
    case "archive":
      return [`${prefix} <message-id> [flags]`];
    default:
      return [`${prefix} [flags]`];
  }
}

function mailInputSchema(action: Action): Json {
  const body = {
    content: { type: "string", minLength: 1, maxLength: 1048576 },
    bodyFormat: { enum: ["text", "markdown", "html"] },
  };
  const recipients = Object.fromEntries(
    ["to", "cc", "bcc"].map((x) => [
      x,
      {
        type: "array",
        items: { type: "string", format: "email" },
        minItems: 1,
        maxItems: 100,
      },
    ]),
  );
  return schema(
    action === "download"
      ? {
          messageId: stringSchema,
          attachmentId: stringSchema,
          attachmentName: stringSchema,
          all: booleanSchema,
          output: stringSchema,
        }
      : action === "list"
        ? {
            ...pageSchema,
            folder: { enum: ["inbox", "sent", "all"], default: "inbox" },
            query: { ...stringSchema, maxLength: 2000 },
            unreadOnly: booleanSchema,
          }
        : action === "read"
          ? {
              ...pageSchema,
              messageId: stringSchema,
              draftId: stringSchema,
              thread: booleanSchema,
            }
          : action === "archive"
            ? { messageId: stringSchema }
            : {
                ...body,
                attachments: {
                  type: "array",
                  items: stringSchema,
                  minItems: 1,
                  maxItems: 20,
                },
                ...(action === "reply"
                  ? { messageId: stringSchema, replyAll: booleanSchema }
                  : {
                      ...recipients,
                      subject: stringSchema,
                      ...(action === "send"
                        ? { draftId: stringSchema }
                        : { updateDraftId: stringSchema }),
                    }),
              },
  );
}
function mailBindings(app: string, action: Action, input: Json): string[] {
  if (app === "gmail") {
    if (action === "download")
      return ["GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_GET_ATTACHMENT"];
    if (action === "list") return ["GMAIL_FETCH_EMAILS"];
    if (action === "read")
      return input.draftId
        ? ["GMAIL_GET_DRAFT"]
        : input.thread
          ? [
              "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
              "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
            ]
          : ["GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"];
    if (action === "send")
      return [input.draftId ? "GMAIL_SEND_DRAFT" : "GMAIL_SEND_EMAIL"];
    if (action === "draft")
      return input.updateDraftId
        ? ["GMAIL_GET_DRAFT", "GMAIL_UPDATE_DRAFT", "GMAIL_GET_ATTACHMENT"]
        : ["GMAIL_CREATE_EMAIL_DRAFT"];
    if (action === "reply")
      return [
        "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        "GMAIL_GET_PROFILE",
        "GMAIL_REPLY_TO_THREAD",
      ];
    return ["GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_BATCH_MODIFY_MESSAGES"];
  }
  if (action === "download")
    return [
      "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS",
      "OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT",
    ];
  if (input.attachments && ["send", "draft", "reply"].includes(action))
    return [
      ...new Set([
        ...mailBindings(app, action, { ...input, attachments: undefined }),
        "OUTLOOK_CREATE_DRAFT",
        "OUTLOOK_SEND_DRAFT",
        "OUTLOOK_ADD_MAIL_ATTACHMENT",
        "OUTLOOK_CREATE_ATTACHMENT_UPLOAD_SESSION",
        "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS",
      ]),
    ];
  if (action === "read")
    return [
      ...(input.thread
        ? ["OUTLOOK_GET_MESSAGE", "OUTLOOK_QUERY_EMAILS"]
        : ["OUTLOOK_GET_MESSAGE"]),
      "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS",
    ];
  if (action === "list")
    return [input.query ? "OUTLOOK_LIST_MESSAGES" : "OUTLOOK_QUERY_EMAILS"];
  if (action === "send")
    return [input.draftId ? "OUTLOOK_SEND_DRAFT" : "OUTLOOK_SEND_EMAIL"];
  if (action === "draft")
    return input.updateDraftId
      ? ["OUTLOOK_GET_MESSAGE", "OUTLOOK_UPDATE_EMAIL"]
      : ["OUTLOOK_CREATE_DRAFT"];
  if (action === "reply")
    return [
      "OUTLOOK_GET_MESSAGE",
      input.replyAll
        ? "OUTLOOK_CREATE_REPLY_ALL_DRAFT"
        : "OUTLOOK_CREATE_DRAFT_REPLY",
      "OUTLOOK_UPDATE_EMAIL",
      "OUTLOOK_SEND_DRAFT",
    ];
  return ["OUTLOOK_MOVE_MESSAGE"];
}

async function executeMail(
  app: string,
  action: Action,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  if (action === "download") return downloadMail(app, input, runtime);
  if (action === "list") return listMail(app, input, runtime);
  if (action === "read") {
    const raw = await runtime.call(
      app === "gmail"
        ? input.draftId
          ? "GMAIL_GET_DRAFT"
          : "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"
        : "OUTLOOK_GET_MESSAGE",
      app === "gmail"
        ? input.draftId
          ? { draft_id: input.draftId, format: "full" }
          : { message_id: input.messageId, format: "full" }
        : { message_id: input.draftId ?? input.messageId },
    );
    const message =
      input.draftId && app === "gmail" ? record(raw.message) : raw;
    if (input.draftId && app === "outlook" && raw.isDraft !== true)
      throw new CliError("conflict", "The selected message is not a draft.");
    if (app === "outlook")
      message.attachments = await outlookAttachments(
        String(input.draftId ?? input.messageId),
        runtime,
      );
    const mail = decodeMail(app, message, false, Boolean(input.draftId));
    if (input.draftId)
      return {
        draft: {
          draftId:
            app === "gmail"
              ? requiredString(raw.id, "draft ID")
              : mail.messageId,
          mail,
        },
      };
    if (!input.thread) return { mail };
    return readThread(app, input, runtime, mail);
  }
  if (action === "archive") {
    if (app === "gmail") {
      const before = await runtime.call("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
        message_id: input.messageId,
        format: "metadata",
      });
      requiredString(before.messageId ?? before.id, "mail ID");
      if (!Array.isArray(before.labelIds))
        throw new CliError(
          "incomplete_response",
          "The original mail labels are unavailable.",
          { operation_rejected: true },
        );
    }
    const raw = await runtime.call(
      app === "gmail" ? "GMAIL_BATCH_MODIFY_MESSAGES" : "OUTLOOK_MOVE_MESSAGE",
      app === "gmail"
        ? { messageIds: [input.messageId], removeLabelIds: ["INBOX"] }
        : { message_id: input.messageId, destination_id: "archive" },
      true,
    );
    if (app === "gmail") {
      const after = await runtime.call("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
        message_id: input.messageId,
        format: "metadata",
      });
      if (!Array.isArray(after.labelIds) || after.labelIds.includes("INBOX"))
        throw new CliError(
          "outcome_unknown",
          "The mail archive state was not confirmed.",
        );
      return {
        action: "archived",
        acknowledged: true,
        messageId: requiredString(
          after.messageId ?? after.id,
          "archived message ID",
        ),
      };
    }
    return optionalFields({
      action: "archived",
      acknowledged: true,
      messageId: raw.id,
    });
  }
  if (action === "send" && input.draftId) {
    const raw = await runtime.call(
      app === "gmail" ? "GMAIL_SEND_DRAFT" : "OUTLOOK_SEND_DRAFT",
      app === "gmail"
        ? { draft_id: input.draftId }
        : { message_id: input.draftId },
      true,
    );
    return mailWrite("sent", raw);
  }
  if (action === "reply") return replyMail(app, input, runtime);
  if (input.updateDraftId) return updateDraft(app, input, runtime);
  if (app === "outlook" && runtime.files.length) {
    const draft = await runtime.call(
      "OUTLOOK_CREATE_DRAFT",
      optionalFields({
        subject: input.subject,
        body: input.content,
        is_html: input.bodyFormat === "html",
        to_recipients: input.to,
        cc_recipients: input.cc,
        bcc_recipients: input.bcc,
      }),
      true,
    );
    const id = requiredString(draft.id, "draft ID");
    await attachOutlook(id, runtime);
    return action === "draft"
      ? mailWrite("drafted", draft, id)
      : mailWrite(
          "sent",
          await runtime.call("OUTLOOK_SEND_DRAFT", { message_id: id }, true),
          id,
        );
  }
  const to = input.to as string[];
  const args =
    app === "gmail"
      ? optionalFields({
          recipient_email: to[0],
          extra_recipients: to.slice(1),
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          body: input.content,
          is_html: input.bodyFormat === "html",
        })
      : action === "draft"
        ? optionalFields({
            subject: input.subject,
            body: input.content,
            is_html: input.bodyFormat === "html",
            to_recipients: to,
            cc_recipients: input.cc,
            bcc_recipients: input.bcc,
          })
        : optionalFields({
            to,
            subject: input.subject,
            body: input.content,
            is_html: input.bodyFormat === "html",
            cc_emails: input.cc,
            bcc_emails: input.bcc,
          });
  const slug =
    app === "gmail"
      ? action === "draft"
        ? "GMAIL_CREATE_EMAIL_DRAFT"
        : "GMAIL_SEND_EMAIL"
      : action === "draft"
        ? "OUTLOOK_CREATE_DRAFT"
        : "OUTLOOK_SEND_EMAIL";
  if (runtime.files.length)
    args.attachment = await Promise.all(
      runtime.files.map((file) => runtime.stageFile(file, slug)),
    );
  const raw = await runtime.call(slug, args, true);
  if (action === "draft") requiredString(raw.id, "created draft ID");
  return mailWrite(
    action === "draft" ? "drafted" : "sent",
    raw,
    action === "draft" ? String(raw.id) : undefined,
  );
}

function mailWrite(action: string, raw: Json, draftId?: unknown): Json {
  const message =
    raw.message && typeof raw.message === "object"
      ? record(raw.message)
      : raw.response_data && typeof raw.response_data === "object"
        ? record(raw.response_data)
        : raw;
  return optionalFields({
    action,
    acknowledged: true,
    draftId,
    messageId: message.id ?? message.messageId,
    threadId: message.threadId,
    url: raw.display_url ?? raw.webLink,
  });
}
// Gmail list results carry each message's text even without its payload, so
// a page of 100 long messages can exceed what TeamHub reads from the provider.
// A requested page is fetched in provider pages of at most this many messages.
const gmailListProviderPage = 20;

async function fetchGmailList(
  runtime: ConnectorRuntime,
  query: string,
  limit: number,
  token: unknown,
): Promise<Json> {
  const messages: unknown[] = [];
  let next = token;
  for (;;) {
    const size = Math.min(gmailListProviderPage, limit - messages.length);
    const raw = await runtime.call(
      "GMAIL_FETCH_EMAILS",
      optionalFields({
        query,
        max_results: size,
        page_token: next,
        include_payload: false,
        include_spam_trash: false,
      }),
    );
    if (!Array.isArray(raw.messages)) return raw;
    messages.push(...raw.messages);
    next = raw.nextPageToken ?? raw.next_page_token;
    // A short provider page ends the requested page, so the returned token
    // always continues right after the last message returned.
    if (!next || raw.messages.length < size || messages.length >= limit)
      return { messages, nextPageToken: next };
  }
}

async function listMail(
  app: string,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const fingerprint = {
    account: runtime.account.connection_id,
    app,
    folder: input.folder,
    query: input.query ?? "",
    unreadOnly: input.unreadOnly ?? false,
    limit: input.limit,
  };
  const state = cursor(input.cursor, fingerprint);
  let raw: Json;
  if (app === "gmail") {
    const parts = [
      input.query ? `(${displayText(input.query)})` : "",
      input.folder === "sent"
        ? "in:sent"
        : input.folder === "inbox"
          ? "in:inbox"
          : "",
      input.unreadOnly ? "is:unread" : "",
    ].filter(Boolean);
    raw = await fetchGmailList(
      runtime,
      parts.join(" "),
      Number(input.limit),
      state.token,
    );
  } else {
    raw = await runtime.call(
      input.query ? "OUTLOOK_LIST_MESSAGES" : "OUTLOOK_QUERY_EMAILS",
      optionalFields({
        top: input.limit,
        folder:
          input.folder === "all"
            ? "allfolders"
            : input.folder === "sent"
              ? "sentitems"
              : "inbox",
        filter: input.unreadOnly
          ? "receivedDateTime ge 0001-01-01T00:00:00Z and isRead eq false"
          : undefined,
        orderby: input.query ? [] : ["receivedDateTime desc"],
        search: input.query,
        page_token: state.token,
      }),
    );
  }
  const rows = app === "gmail" ? raw.messages : raw.value;
  if (!Array.isArray(rows))
    throw new CliError(
      "incomplete_response",
      "The mailbox list has no message array.",
    );
  const token =
    app === "gmail"
      ? (raw.nextPageToken ?? raw.next_page_token)
      : raw.next_page_token;
  if (!token && raw["@odata.nextLink"])
    throw new CliError(
      "incomplete_response",
      "The selected tool did not provide a usable continuation token.",
    );
  return {
    messages: rows.map((x) => decodeMail(app, record(x), true)),
    hasMore: Boolean(token),
    ...(token ? { nextCursor: nextCursor({ token }, fingerprint) } : {}),
  };
}
async function readThread(
  app: string,
  input: Json,
  runtime: ConnectorRuntime,
  mail: Json,
): Promise<Json> {
  const threadId = requiredString(mail.threadId, "thread ID");
  const fingerprint = {
    account: runtime.account.connection_id,
    app,
    messageId: input.messageId,
    threadId,
    limit: input.limit,
  };
  const state = cursor(input.cursor, fingerprint);
  const page = await sliceConnectorPage(
    runtime,
    state,
    Number(input.limit),
    async () => {
      const raw = await runtime.call(
        app === "gmail"
          ? "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"
          : "OUTLOOK_QUERY_EMAILS",
        app === "gmail"
          ? optionalFields({ thread_id: threadId, page_token: state.token })
          : optionalFields({
              filter: `receivedDateTime ge 0001-01-01T00:00:00Z and conversationId eq '${threadId.replaceAll("'", "''")}'`,
              orderby: ["receivedDateTime asc"],
              top: input.limit,
              page_token: state.token,
            }),
      );
      const rows = app === "gmail" ? raw.messages : raw.value;
      if (!Array.isArray(rows))
        throw new CliError(
          "incomplete_response",
          "The thread has no message array.",
        );
      const token = raw.nextPageToken ?? raw.next_page_token;
      if (!token && raw["@odata.nextLink"])
        throw new CliError(
          "incomplete_response",
          "The thread continuation is incomplete.",
        );
      return { rows: rows.map((x) => decodeMail(app, record(x))), token };
    },
  );
  return {
    thread: {
      threadId,
      messages: page.rows,
      hasMore: Boolean(page.next),
      ...(page.next ? { nextCursor: nextCursor(page.next, fingerprint) } : {}),
    },
  };
}
async function updateDraft(
  app: string,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const id = String(input.updateDraftId);
  const raw = await runtime.call(
    app === "gmail" ? "GMAIL_GET_DRAFT" : "OUTLOOK_GET_MESSAGE",
    app === "gmail" ? { draft_id: id, format: "full" } : { message_id: id },
  );
  let args: Json;
  if (app === "gmail") {
    const original = record(raw.message);
    if (!original.payload || !Array.isArray(record(original.payload).headers))
      throw new CliError(
        "incomplete_response",
        "Cannot prove all unchanged Gmail draft headers are present.",
        { operation_rejected: true },
      );
    const mail = decodeMail(app, record(raw.message), false, true);
    const existing = (mail.attachments ?? []) as Json[];
    if (existing.some((file) => file.isInline || !file.attachmentId))
      throw new CliError(
        "unsupported_combination",
        "Inline or opaque Gmail attachments cannot be preserved safely; the draft was not changed.",
        { operation_rejected: true },
      );
    if (
      containsHTMLPart(record(original.payload)) &&
      mail.bodyHtml === undefined
    )
      throw new CliError(
        "incomplete_response",
        "The original HTML body cannot be reconstructed safely; the draft was not changed.",
        { operation_rejected: true },
      );
    if (
      existing.some(
        (file) =>
          !Number.isSafeInteger(file.sizeBytes) || Number(file.sizeBytes) < 0,
      )
    )
      throw new CliError(
        "incomplete_response",
        "The original attachment sizes are unavailable; the draft was not changed.",
        { operation_rejected: true },
      );
    const encodedSize = [
      ...existing.map((file) => Number(file.sizeBytes)),
      ...runtime.files.map((file) => file.sizeBytes),
    ].reduce(
      (sum, size) => sum + Math.ceil(size / 3) * 4 + 2048,
      Buffer.byteLength(
        String(input.content ?? mail.bodyHtml ?? mail.bodyText),
      ) *
        2 +
        8192,
    );
    if (encodedSize > 25 * 1024 * 1024)
      throw new CliError(
        "too_large",
        "The reconstructed draft would exceed Gmail's encoded message limit.",
        { operation_rejected: true },
      );
    const kept = [];
    for (const file of existing) {
      const downloaded = await runtime.call("GMAIL_GET_ATTACHMENT", {
        message_id: mail.messageId,
        attachment_id: file.attachmentId,
        file_name: requiredString(file.name, "attachment filename"),
      });
      const remote = record(downloaded.file);
      kept.push(
        await runtime.stageDownloadedFile(remote, "GMAIL_UPDATE_DRAFT"),
      );
    }
    const to = (input.to ??
      (mail.to as Json[] | undefined)?.map((x) => x.email)) as
      | string[]
      | undefined;
    if (
      !to?.length ||
      mail.subject === undefined ||
      (mail.bodyText === undefined && mail.bodyHtml === undefined)
    )
      throw new CliError(
        "incomplete_response",
        "Cannot reconstruct all unchanged draft fields.",
        { operation_rejected: true },
      );
    args = optionalFields({
      attachment: [
        ...kept,
        ...(await Promise.all(
          runtime.files.map((file) =>
            runtime.stageFile(file, "GMAIL_UPDATE_DRAFT"),
          ),
        )),
      ],
      draft_id: id,
      recipient_email: to[0],
      extra_recipients: to.slice(1),
      cc: input.cc ?? (mail.cc as Json[] | undefined)?.map((x) => x.email),
      bcc: input.bcc ?? (mail.bcc as Json[] | undefined)?.map((x) => x.email),
      subject: input.subject ?? mail.subject,
      body: input.content ?? mail.bodyHtml ?? mail.bodyText,
      is_html:
        input.content !== undefined
          ? input.bodyFormat === "html"
          : mail.bodyHtml !== undefined,
      thread_id: mail.threadId,
    });
  } else {
    if (raw.isDraft !== true)
      throw new CliError("conflict", "The selected message is not a draft.", {
        operation_rejected: true,
      });
    const recipient = (list: unknown) =>
      Array.isArray(list) ? list.map((address) => ({ address })) : undefined;
    args = optionalFields({
      message_id: id,
      subject: input.subject,
      body:
        input.content === undefined
          ? undefined
          : {
              content: input.content,
              contentType: input.bodyFormat === "html" ? "HTML" : "Text",
            },
      to_recipients: recipient(input.to),
      cc_recipients: recipient(input.cc),
      bcc_recipients: recipient(input.bcc),
    });
  }
  const updated = await runtime.call(
    app === "gmail" ? "GMAIL_UPDATE_DRAFT" : "OUTLOOK_UPDATE_EMAIL",
    args,
    true,
  );
  if (updated.id !== id)
    throw new CliError(
      "outcome_unknown",
      "The application did not confirm the same updated draft ID.",
    );
  if (app === "outlook") await attachOutlook(id, runtime);
  return mailWrite("draft_updated", updated, id);
}
async function replyMail(
  app: string,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  if (app === "outlook") {
    const original = await runtime.call("OUTLOOK_GET_MESSAGE", {
      message_id: input.messageId,
    });
    const draft = await runtime.call(
      input.replyAll
        ? "OUTLOOK_CREATE_REPLY_ALL_DRAFT"
        : "OUTLOOK_CREATE_DRAFT_REPLY",
      {
        message_id: input.messageId,
        ...(input.replyAll
          ? {
              mail_folder_id: requiredString(
                original.parentFolderId,
                "original mail folder ID",
              ),
            }
          : {}),
      },
      true,
    );
    const draftId = requiredString(draft.id, "reply draft ID");
    try {
      await runtime.call(
        "OUTLOOK_UPDATE_EMAIL",
        {
          message_id: draftId,
          body: {
            content: input.content,
            contentType: input.bodyFormat === "html" ? "HTML" : "Text",
          },
        },
        true,
      );
      await attachOutlook(draftId, runtime);
      return mailWrite(
        "sent",
        await runtime.call("OUTLOOK_SEND_DRAFT", { message_id: draftId }, true),
        draftId,
      );
    } catch {
      throw new CliError(
        "outcome_unknown",
        "A reply draft exists; check it before sending again.",
        { draft_id: draftId },
      );
    }
  }
  const raw = await runtime.call("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
    message_id: input.messageId,
    format: "full",
  });
  const mail = decodeMail(app, raw);
  const profile = await runtime.call("GMAIL_GET_PROFILE", {});
  const own = requiredString(
    profile.emailAddress,
    "mailbox identity",
  ).toLowerCase();
  const primary = parseAddresses(
    header(raw, "reply-to") ?? raw.sender ?? header(raw, "from"),
  );
  const to = [
    ...primary,
    ...(input.replyAll ? ((mail.to as Json[] | undefined) ?? []) : []),
  ]
    .map((x) => String(x.email))
    .filter((x) => x.toLowerCase() !== own);
  const unique = [...new Set(to)];
  if (!unique.length)
    throw new CliError("invalid_input", "No valid reply recipient remains.", {
      operation_rejected: true,
    });
  const cc = input.replyAll
    ? ((mail.cc as Json[] | undefined) ?? [])
        .map((x) => String(x.email))
        .filter((x) => x.toLowerCase() !== own && !unique.includes(x))
    : undefined;
  const attachment = runtime.files.length
    ? await Promise.all(
        runtime.files.map((file) =>
          runtime.stageFile(file, "GMAIL_REPLY_TO_THREAD"),
        ),
      )
    : undefined;
  return mailWrite(
    "sent",
    await runtime.call(
      "GMAIL_REPLY_TO_THREAD",
      optionalFields({
        attachment,
        thread_id: requiredString(mail.threadId, "thread ID"),
        recipient_email: unique[0],
        extra_recipients: unique.slice(1),
        cc,
        message_body: input.content,
        is_html: input.bodyFormat === "html",
      }),
      true,
    ),
  );
}

function header(raw: Json, name: string): string | undefined {
  const payload =
    raw.payload && typeof raw.payload === "object" ? (raw.payload as Json) : {};
  const headers = Array.isArray(payload.headers)
    ? (payload.headers as Json[])
    : [];
  const h = headers.find((x) => String(x.name).toLowerCase() === name);
  return typeof h?.value === "string" ? h.value : undefined;
}
export function parseAddresses(raw: unknown): Json[] {
  if (typeof raw !== "string") return [];
  return (raw.match(/(?:[^,"]|"[^"]*")+/gu) ?? []).map((item) => {
    const match = /^(.*?)<([^<>]+)>\s*$/u.exec(item.trim());
    const email = (match?.[2] ?? item).trim();
    if (!/^[^\s@<>]+@[^\s@<>]+$/u.test(email))
      throw new CliError(
        "incomplete_response",
        "An email address in the original message cannot be decoded safely.",
      );
    return optionalFields({
      email,
      name: match?.[1]?.trim().replace(/^"|"$/gu, "") || undefined,
    });
  });
}
export function decodeMail(
  app: string,
  raw: Json,
  summary = false,
  draft = false,
): Json {
  if (app === "outlook") {
    const recipient = (v: unknown): Json => {
      const r = record(record(v).emailAddress);
      return optionalFields({
        email: requiredString(r.address, "recipient email"),
        name: r.name,
      });
    };
    const body =
      raw.body && typeof raw.body === "object" ? record(raw.body) : undefined;
    if (
      !summary &&
      (!body ||
        typeof body.content !== "string" ||
        !["text", "html"].includes(String(body.contentType).toLowerCase()))
    )
      throw new CliError("incomplete_response", "The mail body is incomplete.");
    return optionalFields({
      messageId: requiredString(raw.id, "message ID"),
      threadId: raw.conversationId,
      subject: raw.subject,
      from: raw.from ? recipient(raw.from) : undefined,
      receivedAt: raw.receivedDateTime,
      unread: typeof raw.isRead === "boolean" ? !raw.isRead : undefined,
      snippet: raw.bodyPreview,
      ...(summary
        ? {}
        : {
            to: Array.isArray(raw.toRecipients)
              ? raw.toRecipients.map(recipient)
              : undefined,
            cc: Array.isArray(raw.ccRecipients)
              ? raw.ccRecipients.map(recipient)
              : undefined,
            ...(draft && Array.isArray(raw.bccRecipients)
              ? { bcc: raw.bccRecipients.map(recipient) }
              : {}),
            [String(body!.contentType).toLowerCase() === "html"
              ? "bodyHtml"
              : "bodyText"]: body!.content,
            attachments: Array.isArray(raw.attachments)
              ? raw.attachments.map((x) => {
                  const a = record(x);
                  return optionalFields({
                    attachmentId: a.id,
                    name: a.name,
                    mimeType: a.contentType,
                    sizeBytes: a.size,
                    isInline: a.isInline,
                  });
                })
              : undefined,
          }),
    });
  }
  const result: Json = optionalFields({
    messageId: requiredString(raw.messageId ?? raw.id, "message ID"),
    threadId: raw.threadId,
    subject: raw.subject ?? header(raw, "subject"),
    from: parseAddresses(raw.sender ?? header(raw, "from"))[0],
    snippet: typeof raw.preview === "string" ? raw.preview : raw.snippet,
    unread: Array.isArray(raw.labelIds)
      ? raw.labelIds.includes("UNREAD")
      : undefined,
  });
  const timestamp = raw.messageTimestamp ?? raw.internalDate;
  if (typeof timestamp === "string" || typeof timestamp === "number") {
    const date = new Date(
      /^\d+$/u.test(String(timestamp)) ? Number(timestamp) : String(timestamp),
    );
    if (!Number.isNaN(date.valueOf())) result.receivedAt = date.toISOString();
  }
  if (summary) return result;
  result.to = parseAddresses(raw.to ?? header(raw, "to"));
  result.cc = parseAddresses(header(raw, "cc"));
  if (draft) result.bcc = parseAddresses(header(raw, "bcc"));
  const attachments: Json[] = [];
  const visit = (part: Json) => {
    const body =
      part.body && typeof part.body === "object" ? (part.body as Json) : {};
    const headers = Array.isArray(part.headers) ? (part.headers as Json[]) : [];
    if (
      part.filename ||
      (body.attachmentId &&
        !["text/plain", "text/html"].includes(String(part.mimeType)))
    )
      attachments.push(
        optionalFields({
          attachmentId: body.attachmentId,
          name: part.filename,
          mimeType: part.mimeType,
          sizeBytes: body.size,
          isInline: headers.some(
            (h) => String(h.name).toLowerCase() === "content-id",
          ),
        }),
      );
    else if (
      typeof body.data === "string" &&
      ["text/plain", "text/html"].includes(String(part.mimeType))
    ) {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(body.data, "base64url"),
      );
      result[part.mimeType === "text/html" ? "bodyHtml" : "bodyText"] = decoded;
    }
    if (Array.isArray(part.parts)) part.parts.forEach((x) => visit(record(x)));
  };
  if (raw.payload && typeof raw.payload === "object")
    visit(record(raw.payload));
  if (
    result.bodyText === undefined &&
    result.bodyHtml === undefined &&
    typeof raw.messageText === "string"
  )
    result.bodyText = raw.messageText;
  if (result.bodyText === undefined && result.bodyHtml === undefined)
    throw new CliError("incomplete_response", "The mail body is incomplete.");
  if (
    Array.isArray(raw.attachmentList) &&
    raw.attachmentList.length > attachments.length
  )
    throw new CliError(
      "incomplete_response",
      "Some attachment metadata is missing from the full MIME payload.",
    );
  result.attachments = attachments;
  return result;
}

async function outlookAttachments(
  messageId: string,
  runtime: ConnectorRuntime,
): Promise<Json[]> {
  const raw = await runtime.call("OUTLOOK_LIST_OUTLOOK_ATTACHMENTS", {
    message_id: messageId,
    response_detail: "minimal",
    top: 1000,
  });
  const data = raw.response_data ? record(raw.response_data) : raw;
  if (!Array.isArray(data.value) || data["@odata.nextLink"])
    throw new CliError(
      "incomplete_response",
      "The complete attachment list is unavailable.",
    );
  return data.value.map((x) => record(x));
}
async function downloadMail(
  app: string,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  let attachments: Json[];
  if (app === "gmail") {
    const mail = decodeMail(
      app,
      await runtime.call("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
        message_id: input.messageId,
        format: "full",
      }),
    );
    attachments = (mail.attachments as Json[]).map((x) => ({
      ...x,
      type: "file",
    }));
  } else {
    attachments = (
      await outlookAttachments(String(input.messageId), runtime)
    ).map((x) => ({
      attachmentId: x.id,
      name: x.name,
      sizeBytes: x.size,
      isInline: x.isInline,
      type:
        x["@odata.type"] === "#microsoft.graph.fileAttachment"
          ? "file"
          : x["@odata.type"] === "#microsoft.graph.itemAttachment"
            ? "item"
            : x["@odata.type"] === "#microsoft.graph.referenceAttachment"
              ? "reference"
              : undefined,
    }));
  }
  const ids = attachments.map((x) =>
    requiredString(x.attachmentId, "attachment ID"),
  );
  if (new Set(ids).size !== ids.length)
    throw new CliError(
      "incomplete_response",
      "The attachment list contains duplicate identities.",
    );
  const skipped: Json[] = [];
  let selected: Json[];
  if (input.all) {
    selected = [];
    for (const file of attachments) {
      if (
        !["file", "item", "reference"].includes(String(file.type)) ||
        (file.type === "file" && typeof file.isInline !== "boolean")
      )
        throw new CliError(
          "incomplete_response",
          "Attachment type or inline metadata is incomplete.",
        );
      if (file.type !== "file" || file.isInline)
        skipped.push(
          optionalFields({
            attachmentId: file.attachmentId,
            name: file.name,
            reason: file.type !== "file" ? file.type : "inline",
          }),
        );
      else selected.push(file);
    }
  } else {
    selected = attachments.filter((x) =>
      input.attachmentId
        ? x.attachmentId === input.attachmentId
        : x.name === input.attachmentName,
    );
    if (!selected.length)
      throw new CliError(
        "not_found",
        "The attachment does not belong to this message.",
      );
    if (selected.length > 1)
      throw new CliError(
        "target_ambiguous",
        "Attachment names are ambiguous; use --attachment-id from read.",
        {
          issues: selected.map((x) => ({
            attachmentId: x.attachmentId,
            name: x.name,
          })),
        },
      );
    if (selected[0]!.type !== "file")
      throw new CliError(
        "unsupported_combination",
        "Only ordinary file attachments can be downloaded.",
      );
  }
  // Validate every output before downloading any file. Provider names never become paths unchecked.
  const destinations = new Set<string>();
  const plan: { file: Json; output: string }[] = [];
  for (const file of selected) {
    const name = requiredString(file.name, "attachment filename");
    if (
      input.all &&
      (name === "." ||
        name === ".." ||
        path.isAbsolute(name) ||
        /[\\/\r\n\p{Cc}]/u.test(name))
    )
      throw new CliError(
        "invalid_path",
        "An attachment filename is unsafe; download it separately with an explicit output path.",
      );
    const output = await assertNewOutput(
      input.all ? path.join(String(input.output), name) : String(input.output),
      runtime.context.cwd,
    );
    if (destinations.has(output))
      throw new CliError(
        "target_ambiguous",
        "Multiple attachments have the same output name; download them separately by ID.",
      );
    destinations.add(output);
    plan.push({ file, output });
  }
  const files: Json[] = [];
  for (const { file, output } of plan) {
    try {
      const raw = await runtime.call(
        app === "gmail"
          ? "GMAIL_GET_ATTACHMENT"
          : "OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT",
        {
          message_id: input.messageId,
          attachment_id: file.attachmentId,
          file_name: file.name,
        },
      );
      files.push({
        attachmentId: file.attachmentId,
        name: file.name,
        ...(await saveConnectorDownload(
          record(raw.file).s3url,
          output,
          runtime.context,
          (bytes) => {
            if (
              Number.isSafeInteger(file.sizeBytes) &&
              bytes.length !== file.sizeBytes
            )
              throw new CliError(
                "incomplete_response",
                "The attachment byte count does not match its metadata.",
              );
          },
        )),
      });
    } catch (error) {
      if (!files.length) throw error;
      throw new CliError(
        "file_transfer_failed",
        "Some attachments were saved; download the failed attachment separately.",
        {
          partial_receipts: [
            ...files,
            { attachmentId: file.attachmentId, status: "failed" },
          ],
        },
      );
    }
  }
  return { messageId: input.messageId, files, skipped };
}
async function attachOutlook(
  messageId: string,
  runtime: ConnectorRuntime,
): Promise<void> {
  for (const file of runtime.files) {
    if (file.sizeBytes < 3 * 1024 * 1024) {
      const raw = await runtime.call(
        "OUTLOOK_ADD_MAIL_ATTACHMENT",
        {
          message_id: messageId,
          attachment: await runtime.stageFile(
            file,
            "OUTLOOK_ADD_MAIL_ATTACHMENT",
          ),
        },
        true,
      );
      requiredString(raw.id, "attached file ID");
      continue;
    }
    const before = new Set(
      (await outlookAttachments(messageId, runtime)).map((x) =>
        requiredString(x.id, "attachment ID"),
      ),
    );
    const session = await runtime.call(
      "OUTLOOK_CREATE_ATTACHMENT_UPLOAD_SESSION",
      {
        message_id: messageId,
        attachment_item: {
          attachmentType: "file",
          name: file.name,
          size: file.sizeBytes,
          contentType: file.mimetype,
        },
      },
      true,
    );
    const url = connectorTransferURL(session.uploadUrl);
    const bytes = await readConnectorFile(file);
    // Outlook attachment sessions use fragments smaller than 4 MiB. Each
    // acknowledged range must advance exactly; uncertainty never resends it.
    for (let start = 0; start < bytes.length; ) {
      const end = Math.min(start + 2 * 1024 * 1024, bytes.length);
      runtime.writeAttempts++;
      let response: Response;
      try {
        response = await (runtime.context.fetch ?? globalThis.fetch)(url, {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "content-range": `bytes ${start}-${end - 1}/${bytes.length}`,
          },
          body: new Uint8Array(bytes.subarray(start, end)),
          redirect: "error",
          signal: AbortSignal.timeout(180000),
        });
      } catch {
        throw new CliError(
          "outcome_unknown",
          "The attachment upload outcome is unknown.",
          { draft_id: messageId },
        );
      }
      if (![200, 201, 202].includes(response.status)) {
        await response.body?.cancel();
        throw new CliError(
          "outcome_unknown",
          "The attachment upload was interrupted.",
          { draft_id: messageId },
        );
      }
      const text = await response.text();
      let ack: Json = {};
      try {
        if (text) ack = record(JSON.parse(text));
      } catch {
        throw new CliError(
          "outcome_unknown",
          "The upload acknowledgement is incomplete.",
          { draft_id: messageId },
        );
      }
      if (
        end < bytes.length &&
        (!Array.isArray(ack.nextExpectedRanges) ||
          ack.nextExpectedRanges.length !== 1 ||
          ack.nextExpectedRanges[0] !== `${end}-`)
      )
        throw new CliError(
          "outcome_unknown",
          "The attachment upload range was not confirmed.",
          { draft_id: messageId },
        );
      runtime.completedWrites++;
      start = end;
    }
    const added = (await outlookAttachments(messageId, runtime)).filter(
      (x) =>
        !before.has(String(x.id)) &&
        x.name === file.name &&
        x.size === file.sizeBytes,
    );
    if (added.length !== 1)
      throw new CliError(
        "outcome_unknown",
        "The completed attachment could not be identified uniquely.",
        { draft_id: messageId },
      );
    runtime.receipts.push({
      draftId: messageId,
      attachmentId: requiredString(added[0]!.id, "attachment ID"),
    });
  }
}

function containsHTMLPart(part: Json): boolean {
  return (
    part.mimeType === "text/html" ||
    (Array.isArray(part.parts) &&
      part.parts.some((value) => containsHTMLPart(record(value))))
  );
}
