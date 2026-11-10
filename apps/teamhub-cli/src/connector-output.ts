import {
  array,
  id,
  object,
  pageOutput,
  rootSchema,
  str,
} from "./connector-schemas.js";
import type { Json } from "./connector-runtime.js";
const flag = { type: "boolean" },
  integer = { type: "integer", minimum: 0 },
  anyObject = { type: "object", additionalProperties: true };
const downloaded = {
  path: id,
  sizeBytes: integer,
  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
};
const driveFile = object(
  {
    fileId: id,
    name: id,
    mimeType: str,
    kind: { enum: ["file", "folder"] },
    sizeBytes: integer,
    parentIds: array(str),
    parentId: str,
    parentPath: str,
    modifiedAt: str,
    url: str,
    driveId: str,
  },
  ["fileId", "name"],
);
const slackFile = object(
  { fileId: id, name: str, mimeType: str, sizeBytes: integer },
  ["fileId"],
);
const slackMessage = object(
  {
    messageId: id,
    channelId: str,
    threadId: str,
    authorId: str,
    text: str,
    url: str,
    files: array(slackFile),
  },
  ["messageId"],
);
const notionPage = object(
  {
    page_id: id,
    title: str,
    url: id,
    parent: anyObject,
    last_edited_time: str,
    markdown: str,
    truncated: flag,
    unknown_block_ids: array(str),
    complete: flag,
    warnings: array(str),
  },
  ["page_id", "title", "url"],
);
const write = object({ action: id, acknowledged: { const: true } }, [
  "action",
  "acknowledged",
]);
write.additionalProperties = true;
function localFile(base: Json): Json {
  return object({ ...(base.properties as Json), ...downloaded, format: str }, [
    ...(base.required as string[]),
    "path",
    "sizeBytes",
    "sha256",
  ]);
}
// Open metadata objects are intentional provider facets (e.g. identities and
// recurrence). Business root fields and file/message projections stay explicit.
export function connectorOutput(
  command: readonly string[],
  readOnly: boolean,
): Json {
  const [app, first, second] = command;
  const action = second ? `${first} ${second}` : first;
  if (!readOnly) return rootSchema({ result: write });
  if (app === "slack") {
    if (action === "channels")
      return rootSchema(
        {
          channels: array(
            object(
              { channelId: id, name: id, isPrivate: flag, isMember: flag },
              ["channelId", "name"],
            ),
          ),
          ...pageOutput,
        },
        ["channels", "hasMore"],
      );
    if (action === "download")
      return rootSchema({ file: localFile(slackFile) });
    return rootSchema(
      {
        channelId: str,
        threadId: str,
        messageId: str,
        userId: str,
        messages: array(slackMessage),
        ...pageOutput,
      },
      ["messages", "hasMore"],
    );
  }
  if (app === "notion")
    return action === "search"
      ? rootSchema({ pages: array(notionPage), ...pageOutput }, [
          "pages",
          "hasMore",
        ])
      : rootSchema({ page: notionPage });
  if (app === "gdrive") {
    if (action === "read") return rootSchema({ file: driveFile });
    if (action === "download")
      return rootSchema({ file: localFile(driveFile) });
    return rootSchema(
      {
        driveId: id,
        folder: driveFile,
        files: array(driveFile),
        ...pageOutput,
      },
      ["files", "hasMore"],
    );
  }
  if (app === "figma") {
    if (action === "comments")
      return rootSchema({ fileKey: id, comments: array(anyObject) });
    if (action === "export")
      return rootSchema({
        fileKey: id,
        files: array(
          object({
            nodeId: id,
            format: { enum: ["png", "jpg", "svg", "pdf"] },
            ...downloaded,
          }),
        ),
      });
    return rootSchema({
      file: object(
        {
          fileKey: id,
          name: str,
          version: str,
          lastModified: str,
          document: anyObject,
        },
        ["fileKey", "name", "document"],
      ),
    });
  }
  if (app === "github") {
    const repository = {
      fullName: id,
      description: str,
      url: str,
      private: flag,
      fork: flag,
      archived: flag,
      language: str,
      topics: array(str),
      stars: integer,
      forks: integer,
      openIssues: integer,
      defaultBranch: str,
      homepage: str,
      pushedAt: str,
      updatedAt: str,
    };
    const issue = {
      repository: id,
      number: integer,
      kind: { enum: ["issue", "pull_request"] },
      title: str,
      state: str,
      stateReason: str,
      author: str,
      url: str,
      labels: array(str),
      assignees: array(str),
      commentCount: integer,
      createdAt: str,
      updatedAt: str,
      closedAt: str,
    };
    const issueRequired = ["repository", "number", "kind", "title"];
    if (action === "me")
      return rootSchema({
        user: object(
          {
            login: id,
            name: str,
            bio: str,
            company: str,
            blog: str,
            location: str,
            email: str,
            url: str,
            publicRepos: integer,
            followers: integer,
            following: integer,
            createdAt: str,
          },
          ["login"],
        ),
      });
    if (action === "repos")
      return rootSchema(
        {
          repositories: array(object(repository, ["fullName"])),
          ...pageOutput,
        },
        ["repositories", "hasMore"],
      );
    if (action === "repo")
      return rootSchema({
        repository: object(
          {
            ...repository,
            readme: object(
              { available: flag, path: str, text: str, complete: flag },
              ["available"],
            ),
          },
          ["fullName", "readme"],
        ),
      });
    if (action === "search")
      return rootSchema(
        {
          totalCount: integer,
          incomplete: flag,
          items: array(object(issue, issueRequired)),
          ...pageOutput,
        },
        ["totalCount", "items", "hasMore"],
      );
    return rootSchema({
      item: object(
        {
          ...issue,
          body: str,
          comments: array(
            object(
              {
                commentId: id,
                author: str,
                body: str,
                url: str,
                createdAt: str,
                updatedAt: str,
              },
              ["commentId", "body"],
            ),
          ),
          commentsComplete: flag,
          draft: flag,
          merged: flag,
          mergedAt: str,
          head: str,
          base: str,
          additions: integer,
          deletions: integer,
          files: array(
            object(
              {
                path: id,
                status: str,
                additions: integer,
                deletions: integer,
                previousPath: str,
              },
              ["path"],
            ),
          ),
          filesComplete: flag,
        },
        [...issueRequired, "body", "comments", "commentsComplete"],
      ),
    });
  }
  return rootSchema({});
}

export function connectorOutputDescription(command: readonly string[]): string {
  const [app, ...parts] = command;
  const action = parts.join(" ");
  if (app === "gmail" || app === "outlook")
    return (
      {
        list: "Message IDs, subjects, senders, unread state, and next-page cursor.",
        read: "Message body, recipients, and attachments; thread mode includes the message list, draft mode includes the draft ID.",
        download:
          "Message ID, saved attachment name/ID/absolute path/byte size/SHA-256, and skipped items.",
        draft: "Saved draft ID and operation receipt; the draft is not sent.",
        send: "Upstream send-accepted receipt and any available message/thread IDs; this does not mean delivery.",
        reply:
          "Reply send receipt; keeps a created draft ID when a later step fails.",
        archive: "The actual message ID and archive receipt.",
      } as Record<string, string>
    )[action]!;
  if (app === "gcal")
    return (
      {
        calendars:
          "Calendar IDs, names, time zones, access roles, and next-page cursor.",
        list: "Event IDs, titles, start/end times, and next-page cursor.",
        read: "Event details, organizer, attendees, and any available meeting link.",
        free: "Time ranges that are free on every selected calendar; does not create events.",
        create:
          "The event after create, plus a meeting link when the provider returns one.",
        update: "The event and attendees after update.",
        cancel: "The actual event ID and cancel receipt.",
      } as Record<string, string>
    )[action]!;
  if (app === "slack")
    return (
      {
        channels: "Channel names, IDs, types, and next-page cursor.",
        search:
          "Matching message bodies, channels, message IDs/URLs, and next-page cursor.",
        read: "Message or thread bodies, authors, files, and next-page cursor.",
        send: "The actual channel or DM, message, and file-share receipts.",
        react: "The actual message target, emoji name, and add/remove receipt.",
        download:
          "Absolute path, actual byte size, and SHA-256 of the saved file.",
      } as Record<string, string>
    )[action]!;
  if (app === "gdrive")
    return (
      {
        list: "Names, IDs, and types of one folder level, plus next-page cursor.",
        search: "Matching file names, IDs, types, and next-page cursor.",
        read: "File or folder metadata; does not read online-document bodies.",
        mkdir: "The new folder's actual ID, name, and parent.",
        upload:
          "The remote file after name, size, and target folder are verified.",
        download:
          "Absolute path, actual byte size, and SHA-256 of the saved file.",
      } as Record<string, string>
    )[action]!;
  if (app === "notion")
    return (
      {
        search: "Visible page titles, IDs, URLs, and next-page cursor.",
        read: "Page info, Markdown body, and completeness flags.",
        create: "New page ID/URL and read-back verification.",
        append: "Append receipt plus read-back verification and completeness.",
        edit: "Receipt for the unique matched edit plus read-back verification.",
      } as Record<string, string>
    )[action]!;
  if (app === "figma")
    return (
      {
        read: "File info and a depth-limited design node tree.",
        export: "Saved path, format, byte size, and SHA-256 for each node.",
        comments: "File comments and root-comment/reply relationships.",
        comment: "The published comment ID and reply target when present.",
      } as Record<string, string>
    )[action]!;
  if (app === "github")
    return (
      {
        me: "Login, name, bio, company, blog, location, and public counts of the connected account.",
        repos:
          "Repository names, descriptions, languages, visibility, activity times, and next-page cursor.",
        repo: "Repository details and the README text with a completeness flag.",
        search:
          "Matching issues and pull requests with repository, number, state, author, and next-page cursor.",
        read: "Issue or pull request body and comments; a pull request adds its branches, merge state, and changed files, each list with a completeness flag.",
        comment: "The posted comment's ID and link.",
        "create-issue": "The created issue's number and link.",
      } as Record<string, string>
    )[action]!;
  return "Actual object IDs, operation receipts, and verifiable state; upstream acceptance is not reported as final completion.";
}
