import type { CommandDefinition } from "./command-definition.js";
import { assertPositionals, bodySource, option } from "./command-input.js";
import {
  booleanSchema,
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
const descriptions = {
  search: "Find accessible Notion pages by title.",
  read: "Read the page body and report completeness explicitly.",
  create: "Create an ordinary document under a parent page.",
  append: "Append content at the end of the page and keep the existing body.",
  edit: "Replace one exact original match; does not overwrite the whole page.",
};
type Action = keyof typeof descriptions;
const bodies = {
  "--content": value(
    "Body text; exclusive with --file; plain text by default.",
  ),
  "--file": value("UTF-8 body file; - reads stdin."),
  "--markdown": toggle(
    "Use the common Markdown subset validated by the backend.",
  ),
};
export const notionCommandDefinitions: CommandDefinition[] = (
  Object.keys(descriptions) as Action[]
).map((action) =>
  connectorDefinition({
    command: ["notion", action],
    description: descriptions[action],
    readOnly: ["search", "read"].includes(action),
    options:
      action === "search"
        ? {
            "--query": value(
              "Search by title; lists visible pages when omitted.",
            ),
            "--limit": value("1–100 items per page; default 20."),
            "--cursor": value("Cursor from the previous page."),
          }
        : action === "read"
          ? {}
          : {
              ...bodies,
              ...(action === "create"
                ? {
                    "--parent": value("Parent page URL or UUID."),
                    "--title": value("Title of the new document."),
                  }
                : action === "edit"
                  ? {
                      "--find": value(
                        "Exact original text copied from read; not a regular expression.",
                      ),
                      "--find-file": value(
                        "UTF-8 original-text file; exclusive with --find.",
                      ),
                    }
                  : {}),
            },
    usage: [
      `teamhub notion ${action}${["read", "append", "edit"].includes(action) ? " <page>" : ""}${action === "create" ? " --parent <page> --title <text>" : ""} [flags]`,
    ],
    examples:
      action === "search"
        ? ["teamhub notion search --query 'team weekly'"]
        : action === "create"
          ? [
              "teamhub notion create --parent '<parent-page-url>' --title '16 Oct weekly' --markdown --file ./weekly.md",
            ]
          : action === "edit"
            ? [
                "teamhub notion edit '<page-url>' --find 'Publish date: Friday' --content 'Publish date: next Monday'",
              ]
            : [
                `teamhub notion ${action} '<page-url>'${action === "append" ? " --content 'Follow-up: acceptance completed on Friday.'" : ""}`,
              ],
    notes: [
      "A fragment in a page URL does not narrow the read or edit range; databases and whole-page overwrite are out of scope.",
    ],
    inputSchema: schema(
      action === "search"
        ? { ...pageSchema, query: stringSchema }
        : action === "read"
          ? { pageId: stringSchema }
          : {
              ...(action === "create"
                ? { parentId: stringSchema, title: stringSchema }
                : { pageId: stringSchema }),
              content: { type: "string", maxLength: 1048576 },
              markdown: booleanSchema,
              ...(action === "edit" ? { find: stringSchema } : {}),
            },
    ),
    normalize: async (args, reader) => {
      const input: Json = {};
      assertPositionals(
        args,
        ["read", "append", "edit"].includes(action) ? 1 : 0,
      );
      if (action === "search") {
        Object.assign(input, pageInput(args));
        if (option(args, "--query") !== undefined)
          input.query = text(option(args, "--query"), "--query", 2000);
      } else {
        if (action === "create") {
          input.parentId = notionPage(
            text(option(args, "--parent"), "--parent", 4096),
          );
          input.title = text(option(args, "--title"), "--title", 2000);
        } else
          input.pageId = notionPage(text(args.positionals[0], "page", 4096));
        if (action !== "read") {
          if (action === "edit") {
            const direct = option(args, "--find"),
              file = option(args, "--find-file");
            if ((direct === undefined) === (file === undefined))
              usage("Choose --find or --find-file.");
            if (file === "-" && option(args, "--file") === "-")
              usage("Only one source may read stdin.");
            input.find = file === undefined ? direct : await reader.text(file);
            if (
              typeof input.find !== "string" ||
              !input.find.length ||
              Buffer.byteLength(input.find) > 1048576
            )
              usage("Provide nonempty exact source text of at most 1 MiB.");
          }
          input.content = await bodySource(args, reader, true);
          if (
            typeof input.content !== "string" ||
            Buffer.byteLength(input.content) > 1048576 ||
            input.content.includes("\u0000") ||
            (action !== "edit" && !input.content.trim())
          )
            usage(
              "Provide UTF-8 body text of at most 1 MiB; only edit allows empty replacement.",
            );
          input.markdown = Boolean(option(args, "--markdown"));
        }
      }
      return { input };
    },
    bindings: () =>
      action === "search"
        ? ["NOTION_SEARCH_NOTION_PAGE"]
        : action === "read"
          ? ["NOTION_RETRIEVE_PAGE", "NOTION_GET_PAGE_MARKDOWN"]
          : [
              "NOTION_RETRIEVE_PAGE",
              "NOTION_GET_PAGE_MARKDOWN",
              action === "create"
                ? "NOTION_CREATE_NOTION_PAGE"
                : action === "append"
                  ? "NOTION_ADD_MULTIPLE_PAGE_CONTENT"
                  : "NOTION_UPDATE_PAGE_MARKDOWN",
            ],
    execute: (input, runtime) => executeNotion(action, input, runtime),
  }),
);
export function notionPage(value: string): string {
  let candidate = value;
  if (value.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      usage("Use a Notion page UUID or copied page link.");
    }
    const host = url!.hostname.toLowerCase();
    if (
      url!.username ||
      url!.password ||
      url!.port ||
      (!["notion.so", "www.notion.so", "app.notion.com"].includes(host) &&
        !host.endsWith(".notion.site"))
    )
      usage("Use a supported Notion page link.");
    const tail = url!.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const match =
      /(?:^|-)([a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/u.exec(
        tail,
      );
    if (!match)
      usage(
        "This link has no explicit page UUID; use the ID returned by search.",
      );
    candidate = match![1]!;
  }
  if (
    !/^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/u.test(
      candidate,
    )
  )
    usage("Use a Notion page UUID, not a title or database view.");
  const hex = candidate.replaceAll("-", "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function notionMeta(raw: Json): Json {
  if (raw.object !== "page")
    throw new CliError(
      "unsupported_combination",
      "The selected object is not a Notion page.",
    );
  const props = record(raw.properties);
  const titles = Object.values(props)
    .map((x) => record(x))
    .filter((x) => x.type === "title" || Array.isArray(x.title));
  if (titles.length !== 1 || !Array.isArray(titles[0]!.title))
    throw new CliError("incomplete_response", "The page title is unavailable.");
  const title = (titles[0]!.title as unknown[])
    .map((x) => {
      const r = record(x);
      return typeof r.plain_text === "string"
        ? r.plain_text
        : requiredString(record(r.text).content, "title fragment");
    })
    .join("");
  return optionalFields({
    page_id: requiredString(raw.id, "page ID"),
    url: requiredString(raw.url, "page URL"),
    title,
    parent: raw.parent,
    last_edited_time: raw.last_edited_time,
  });
}
function notionBody(raw: Json): Json {
  if (
    raw.object !== "page_markdown" ||
    typeof raw.markdown !== "string" ||
    typeof raw.truncated !== "boolean" ||
    !Array.isArray(raw.unknown_block_ids) ||
    !raw.unknown_block_ids.every((x) => typeof x === "string")
  )
    throw new CliError(
      "incomplete_response",
      "The page body completeness is unavailable.",
    );
  return {
    markdown: raw.markdown,
    truncated: raw.truncated,
    unknown_block_ids: raw.unknown_block_ids,
    complete: !raw.truncated && !raw.unknown_block_ids.length,
    warnings: [
      "Child pages are kept as references only; embedded documents and database records are not read recursively.",
      ...(raw.truncated
        ? ["The body was truncated by the upstream provider."]
        : []),
      ...(raw.unknown_block_ids.length
        ? ["Some blocks could not be converted."]
        : []),
    ],
  };
}
async function readNotion(
  pageId: string,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const meta = notionMeta(
    await runtime.call("NOTION_RETRIEVE_PAGE", { page_id: pageId }),
  );
  if (notionPage(String(meta.page_id)) !== notionPage(pageId))
    throw new CliError(
      "incomplete_response",
      "The page identity does not match.",
    );
  return {
    ...meta,
    ...notionBody(
      await runtime.call("NOTION_GET_PAGE_MARKDOWN", { page_id: pageId }),
    ),
  };
}
async function executeNotion(
  action: Action,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  if (action === "search") {
    const fp = {
      account: runtime.account.connection_id,
      query: input.query ?? "",
      limit: input.limit,
    };
    const state = cursor(input.cursor, fp);
    const raw = await runtime.call(
      "NOTION_SEARCH_NOTION_PAGE",
      optionalFields({
        query: input.query,
        page_size: input.limit,
        start_cursor: state.token,
        filter_value: "page",
        filter_property: "object",
        direction: "descending",
        timestamp: "last_edited_time",
      }),
    );
    if (
      !Array.isArray(raw.results) ||
      typeof raw.has_more !== "boolean" ||
      (raw.has_more && !raw.next_cursor)
    )
      throw new CliError(
        "incomplete_response",
        "The page search result is incomplete.",
      );
    return {
      pages: raw.results.map((x) => notionMeta(record(x))),
      hasMore: raw.has_more,
      ...(raw.has_more
        ? { nextCursor: nextCursor({ token: raw.next_cursor }, fp) }
        : {}),
    };
  }
  if (action === "read")
    return { page: await readNotion(String(input.pageId), runtime) };
  if (action === "create") {
    const parent = notionMeta(
      await runtime.call("NOTION_RETRIEVE_PAGE", { page_id: input.parentId }),
    );
    if (notionPage(String(parent.page_id)) !== input.parentId)
      throw new CliError(
        "incomplete_response",
        "The parent page identity does not match.",
      );
    const created = notionMeta(
      await runtime.call(
        "NOTION_CREATE_NOTION_PAGE",
        {
          parent_id: input.parentId,
          title: input.title,
          markdown: input._markdown,
        },
        true,
      ),
    );
    const page = await readNotion(String(created.page_id), runtime);
    return {
      result: {
        action: "created",
        acknowledged: true,
        ...created,
        verified: page.complete === true && page.title === input.title,
        complete: page.complete,
        warnings: page.warnings,
      },
    };
  }
  const before = await readNotion(String(input.pageId), runtime);
  if (before.complete !== true)
    throw new CliError(
      "incomplete_response",
      "The page must be read completely before it can be changed.",
    );
  if (action === "append") {
    const blocks = input._blocks as Json[];
    if (!blocks.length) usage("Provide at least one content block.");
    await runtime.call(
      "NOTION_ADD_MULTIPLE_PAGE_CONTENT",
      {
        parent_block_id: input.pageId,
        content_blocks: blocks.map((content_block) => ({ content_block })),
      },
      true,
    );
    const after = await readNotion(String(input.pageId), runtime);
    return {
      result: {
        action: "appended",
        acknowledged: true,
        page_id: after.page_id,
        url: after.url,
        verified: after.complete === true,
        blockCount: blocks.length,
        warnings: after.warnings,
      },
    };
  }
  const source = String(before.markdown),
    find = String(input.find);
  const first = source.indexOf(find);
  if (first < 0 || source.indexOf(find, first + 1) >= 0)
    throw new CliError(
      "conflict",
      "The source must match exactly once; copy a larger unique context from notion read.",
    );
  if (/<\/?(?:page|database|unknown|synced_block)\b/iu.test(find))
    throw new CliError(
      "unsupported_combination",
      "Child page and database references cannot be edited.",
    );
  const updated = await runtime.call(
    "NOTION_UPDATE_PAGE_MARKDOWN",
    {
      page_id: input.pageId,
      type: "update_content",
      update_content: {
        content_updates: [
          {
            old_str: find,
            new_str: input._markdown,
            replace_all_matches: false,
          },
        ],
        allow_deleting_content: false,
      },
    },
    true,
  );
  const ack = notionBody(updated);
  const after = await readNotion(String(input.pageId), runtime);
  const expected =
    source.slice(0, first) +
    String(input._markdown) +
    source.slice(first + find.length);
  return {
    result: {
      action: "edited",
      acknowledged: true,
      page_id: after.page_id,
      url: after.url,
      replaced: 1,
      verified:
        ack.complete === true &&
        after.complete === true &&
        after.markdown === expected,
      warnings: after.warnings,
    },
  };
}
