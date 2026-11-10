import type { CommandDefinition } from "./command-definition.js";
import { assertPositionals, bodySource, option } from "./command-input.js";
import {
  choice,
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
  value,
  type ConnectorRuntime,
  type Json,
} from "./connector-runtime.js";
import { CliError, ConnectorError } from "./errors.js";
import { displayText } from "./display-text.js";
const descriptions = {
  me: "Read the profile of the connected GitHub account.",
  repos:
    "List repositories the connected account owns, collaborates on, or belongs to through an organization.",
  repo: "Read one repository and its README.",
  search: "Search issues and pull requests with GitHub search syntax.",
  read: "Read an issue or pull request with all its comments; a pull request also lists its changed files.",
  comment: "Comment on an issue or pull request.",
  "create-issue": "Create an issue in a repository.",
};
type Action = keyof typeof descriptions;
const repoSorts = ["updated", "pushed", "created", "full_name"];
// GitHub rejects longer comment and issue bodies.
const maxBody = 65536;
// Comments and changed files are read 100 at a time, up to this many pages.
const maxPages = 10;
// A README longer than this is cut, and reported as incomplete.
const maxReadme = 100000;
const issueTarget = {
  owner: stringSchema,
  repo: stringSchema,
  number: { type: "integer", minimum: 1 },
};
const bodies = {
  "--content": value("Markdown body; exclusive with --file."),
  "--file": value("UTF-8 Markdown body file; - reads stdin."),
};
export const githubCommandDefinitions: CommandDefinition[] = (
  Object.keys(descriptions) as Action[]
).map((action) =>
  connectorDefinition({
    command: ["github", action],
    description: descriptions[action],
    readOnly: !["comment", "create-issue"].includes(action),
    options:
      action === "repos"
        ? {
            "--sort": value(
              "updated / pushed / created / full_name; default updated.",
            ),
            "--limit": value("1–100 items per page; default 20."),
            "--cursor": value("Cursor from the previous page."),
          }
        : action === "search"
          ? {
              "--limit": value("1–100 items per page; default 20."),
              "--cursor": value("Cursor from the previous page."),
            }
          : action === "comment"
            ? bodies
            : action === "create-issue"
              ? {
                  "--repo": value("Repository as owner/name or its link."),
                  "--title": value("Issue title."),
                  ...bodies,
                }
              : {},
    usage: [
      action === "repo"
        ? "teamhub github repo <owner/name|url> [flags]"
        : action === "search"
          ? "teamhub github search <query> [flags]"
          : action === "read"
            ? "teamhub github read <owner/name#number|url> [flags]"
            : action === "comment"
              ? "teamhub github comment <owner/name#number|url> (--content <text> | --file <path|->) [flags]"
              : action === "create-issue"
                ? "teamhub github create-issue --repo <owner/name|url> --title <text> [--content <text> | --file <path|->] [flags]"
                : `teamhub github ${action} [flags]`,
    ],
    examples:
      action === "repos"
        ? ["teamhub github repos --sort pushed --limit 50"]
        : action === "repo"
          ? ["teamhub github repo octo-org/api"]
          : action === "search"
            ? [
                "teamhub github search 'author:@me is:pr updated:>2026-08-01'",
                "teamhub github search 'repo:octo-org/api is:issue is:open label:bug'",
              ]
            : action === "read"
              ? [
                  "teamhub github read 'https://github.com/octo-org/api/pull/42'",
                ]
              : action === "comment"
                ? [
                    "teamhub github comment octo-org/api#42 --content 'Verified the fix on staging.'",
                  ]
                : action === "create-issue"
                  ? [
                      "teamhub github create-issue --repo octo-org/api --title 'Login fails after reset' --file ./issue.md",
                    ]
                  : ["teamhub github me"],
    notes:
      action === "search"
        ? [
            "GitHub returns at most the first 1,000 matches of a search; @me means the connected account.",
          ]
        : action === "read"
          ? [
              "Reads up to 1,000 comments and 1,000 changed files and reports whether each list is complete; review comments and diffs are out of scope.",
            ]
          : [],
    inputSchema:
      action === "repos"
        ? schema({ ...pageSchema, sort: { enum: repoSorts } })
        : action === "search"
          ? schema({ ...pageSchema, query: stringSchema }, ["query"])
          : action === "repo"
            ? schema({ owner: stringSchema, repo: stringSchema }, [
                "owner",
                "repo",
              ])
            : action === "read"
              ? schema(issueTarget, ["owner", "repo", "number"])
              : action === "comment"
                ? schema(
                    {
                      ...issueTarget,
                      content: { type: "string", maxLength: maxBody },
                    },
                    ["owner", "repo", "number", "content"],
                  )
                : action === "create-issue"
                  ? schema(
                      {
                        owner: stringSchema,
                        repo: stringSchema,
                        title: stringSchema,
                        content: { type: "string", maxLength: maxBody },
                      },
                      ["owner", "repo", "title"],
                    )
                  : schema({}),
    normalize: async (args, reader) => {
      const input: Json = {};
      if (action === "me") assertPositionals(args, 0);
      if (action === "repos") {
        assertPositionals(args, 0);
        Object.assign(input, pageInput(args));
        input.sort = choice(
          option(args, "--sort"),
          repoSorts,
          "--sort",
          "updated",
        );
      }
      if (action === "search") {
        assertPositionals(args, 1);
        Object.assign(input, pageInput(args));
        input.query = text(args.positionals[0], "query", 256);
      }
      if (action === "repo") {
        assertPositionals(args, 1);
        const found = githubTarget(
          text(args.positionals[0], "repository", 4096),
        );
        if (found.number !== undefined)
          usage("Use a repository, not an issue or pull request.");
        Object.assign(input, found);
      }
      if (action === "read" || action === "comment") {
        assertPositionals(args, 1);
        const found = githubTarget(
          text(args.positionals[0], "issue or pull request", 4096),
        );
        if (found.number === undefined)
          usage("Use an issue or pull request, such as owner/name#42.");
        Object.assign(input, found);
      }
      if (action === "create-issue") {
        assertPositionals(args, 0);
        const found = githubTarget(
          text(option(args, "--repo"), "--repo", 4096),
        );
        if (found.number !== undefined)
          usage("--repo takes a repository, not an issue or pull request.");
        Object.assign(input, found);
        input.title = text(option(args, "--title"), "--title", 256);
      }
      if (action === "comment" || action === "create-issue") {
        const body = await bodySource(args, reader, action === "comment");
        if (body !== undefined) {
          if ([...body].length > maxBody || body.includes("\u0000"))
            usage(
              `The body must be UTF-8 text of at most ${maxBody} characters.`,
            );
          if (action === "comment" && !body.trim())
            usage("Provide a nonblank comment.");
          input.content = body;
        }
      }
      return { input };
    },
    bindings: () =>
      ({
        me: ["GITHUB_GET_THE_AUTHENTICATED_USER"],
        repos: ["GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER"],
        repo: ["GITHUB_GET_A_REPOSITORY", "GITHUB_GET_A_REPOSITORY_README"],
        search: ["GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS"],
        read: [
          "GITHUB_GET_AN_ISSUE",
          "GITHUB_LIST_ISSUE_COMMENTS",
          "GITHUB_GET_A_PULL_REQUEST",
          "GITHUB_LIST_PULL_REQUESTS_FILES",
        ],
        comment: ["GITHUB_GET_AN_ISSUE", "GITHUB_CREATE_AN_ISSUE_COMMENT"],
        "create-issue": ["GITHUB_GET_A_REPOSITORY", "GITHUB_CREATE_AN_ISSUE"],
      })[action],
    execute: (input, runtime) => executeGitHub(action, input, runtime),
  }),
);
const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const repoPattern = /^[A-Za-z0-9._-]{1,100}$/u;
/** Parses owner/name, owner/name#number, or a github.com link to either. */
function githubTarget(value: string): {
  owner: string;
  repo: string;
  number?: number;
} {
  let owner: string | undefined,
    repo: string | undefined,
    number: string | undefined;
  if (value.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      usage("Use a github.com link.");
    }
    if (
      !["github.com", "www.github.com"].includes(url!.hostname) ||
      url!.username ||
      url!.password ||
      url!.port
    )
      usage("Use a github.com repository, issue, or pull request link.");
    const parts = url!.pathname.split("/").filter(Boolean);
    [owner, repo] = parts;
    repo = repo?.replace(/\.git$/u, "");
    if (parts.length > 2) {
      if (!["issues", "pull"].includes(parts[2]!) || !parts[3])
        usage("Use a repository, issue, or pull request link.");
      number = parts[3];
    }
  } else {
    const match = /^([^/#]+)\/([^/#]+)(?:#(.+))?$/u.exec(value);
    if (!match)
      usage("Use owner/name, owner/name#number, or a github.com link.");
    [, owner, repo, number] = match!;
  }
  if (
    !owner ||
    !repo ||
    !ownerPattern.test(owner) ||
    !repoPattern.test(repo) ||
    repo === "." ||
    repo === ".."
  )
    usage("The repository owner or name is invalid.");
  if (number !== undefined && !/^[1-9]\d{0,9}$/u.test(number))
    usage("The issue or pull request number is invalid.");
  return {
    owner: owner!,
    repo: repo!,
    ...(number === undefined ? {} : { number: Number(number) }),
  };
}
function login(value: unknown): string | undefined {
  return value && typeof value === "object"
    ? (record(value).login as string | undefined)
    : undefined;
}
/** Composio wraps each GitHub list in an object under a tool-specific key. */
function rows(raw: Json, key: string): Json[] {
  const list = raw[key];
  if (!Array.isArray(list))
    throw new ConnectorError(
      "incomplete_response",
      `The GitHub response has no ${key} list.`,
    );
  return list.map((item) => record(item));
}
function githubUser(raw: Json): Json {
  return optionalFields({
    login: requiredString(raw.login, "GitHub login"),
    name: raw.name,
    bio: raw.bio,
    company: raw.company,
    blog: raw.blog || undefined,
    location: raw.location,
    email: raw.email,
    url: raw.html_url,
    publicRepos: raw.public_repos,
    followers: raw.followers,
    following: raw.following,
    createdAt: raw.created_at,
  });
}
function githubRepository(raw: Json): Json {
  return optionalFields({
    fullName: requiredString(raw.full_name, "repository name"),
    description: raw.description,
    url: raw.html_url,
    private: raw.private,
    fork: raw.fork,
    archived: raw.archived,
    language: raw.language,
    topics:
      Array.isArray(raw.topics) && raw.topics.length ? raw.topics : undefined,
    stars: raw.stargazers_count,
    forks: raw.forks_count,
    openIssues: raw.open_issues_count,
    defaultBranch: raw.default_branch,
    homepage: raw.homepage || undefined,
    pushedAt: raw.pushed_at,
    updatedAt: raw.updated_at,
  });
}
function repositoryOf(raw: Json): string {
  // Search results name their repository only by its API URL.
  const match = /\/repos\/([^/]+\/[^/]+)$/u.exec(String(raw.repository_url));
  return requiredString(match?.[1], "repository");
}
function githubIssue(raw: Json): Json {
  return optionalFields({
    repository: repositoryOf(raw),
    number: raw.number,
    kind: raw.pull_request ? "pull_request" : "issue",
    title: requiredString(raw.title, "title"),
    state: raw.state,
    stateReason: raw.state_reason,
    author: login(raw.user),
    url: raw.html_url,
    labels: Array.isArray(raw.labels)
      ? raw.labels
          .map((label) =>
            typeof label === "string" ? label : record(label).name,
          )
          .filter((name) => typeof name === "string")
      : undefined,
    assignees: Array.isArray(raw.assignees)
      ? raw.assignees.map(login).filter((name) => typeof name === "string")
      : undefined,
    commentCount: raw.comments,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at,
  });
}
function githubComment(raw: Json): Json {
  return optionalFields({
    commentId: String(raw.id),
    author: login(raw.user),
    body: raw.body ?? "",
    url: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  });
}
/** Reads 100 rows a page until a short page or the page cap. */
async function allPages(
  load: (page: number) => Promise<Json>,
  key: string,
): Promise<{ rows: Json[]; complete: boolean }> {
  const result: Json[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const found = rows(await load(page), key);
    result.push(...found);
    if (found.length < 100) return { rows: result, complete: true };
  }
  return { rows: result, complete: false };
}
async function executeGitHub(
  action: Action,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const where = { owner: input.owner, repo: input.repo };
  if (action === "me")
    return {
      user: githubUser(
        await runtime.call("GITHUB_GET_THE_AUTHENTICATED_USER", {}),
      ),
    };
  if (action === "repos" || action === "search") {
    const fp = {
      account: runtime.account.connection_id,
      action,
      query: input.query ?? "",
      sort: input.sort ?? "",
      limit: input.limit,
    };
    const page = cursor(input.cursor, fp).page ?? 1;
    if (!Number.isSafeInteger(page) || Number(page) < 1)
      throw new ConnectorError(
        "cursor_mismatch",
        "Use the returned cursor with the same account and filters.",
      );
    const limit = Number(input.limit);
    if (action === "repos") {
      const found = rows(
        await runtime.call(
          "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
          {
            sort: input.sort,
            per_page: limit,
            page,
          },
        ),
        "repositories",
      );
      // The list reports no total; a full page may be followed by more.
      const hasMore = found.length === limit;
      return {
        repositories: found.map(githubRepository),
        hasMore,
        ...(hasMore
          ? { nextCursor: nextCursor({ page: Number(page) + 1 }, fp) }
          : {}),
      };
    }
    const raw = await runtime.call("GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS", {
      q: input.query,
      per_page: limit,
      page,
      response_detail: "full",
    });
    if (typeof raw.total_count !== "number")
      throw new ConnectorError(
        "incomplete_response",
        "The search result is incomplete.",
      );
    const hasMore = Number(page) * limit < Math.min(raw.total_count, 1000);
    return optionalFields({
      totalCount: raw.total_count,
      // GitHub stops a slow search early and says so.
      incomplete: raw.incomplete_results === true || undefined,
      items: rows(raw, "items").map(githubIssue),
      hasMore,
      ...(hasMore
        ? { nextCursor: nextCursor({ page: Number(page) + 1 }, fp) }
        : {}),
    });
  }
  if (action === "repo") {
    const repository = githubRepository(
      await runtime.call("GITHUB_GET_A_REPOSITORY", where),
    );
    let readme: Json;
    try {
      readme = githubReadme(
        await runtime.call("GITHUB_GET_A_REPOSITORY_README", where),
      );
    } catch (error) {
      // GitHub answers a repository without a README with Not Found, which
      // TeamHub reports as a failed provider call; anything else is real.
      if (
        !(error instanceof CliError) ||
        error.code !== "tool_execution_failed"
      )
        throw error;
      readme = { available: false };
    }
    return { repository: { ...repository, readme } };
  }
  if (action === "create-issue") {
    const repository = await runtime.call("GITHUB_GET_A_REPOSITORY", where);
    if (repository.has_issues === false)
      throw new ConnectorError(
        "unsupported_combination",
        "Issues are disabled in this repository.",
        { operation_rejected: true },
      );
    const created = await runtime.call(
      "GITHUB_CREATE_AN_ISSUE",
      optionalFields({ ...where, title: input.title, body: input.content }),
      true,
    );
    return {
      result: optionalFields({
        action: "issue_created",
        acknowledged: true,
        repository: `${String(input.owner)}/${String(input.repo)}`,
        number: created.number,
        url: created.html_url,
      }),
    };
  }
  const numbered = { ...where, issue_number: input.number };
  const issue = await runtime.call("GITHUB_GET_AN_ISSUE", numbered);
  if (action === "comment") {
    const created = await runtime.call(
      "GITHUB_CREATE_AN_ISSUE_COMMENT",
      { ...numbered, body: input.content },
      true,
    );
    return {
      result: optionalFields({
        action: "commented",
        acknowledged: true,
        repository: repositoryOf(issue),
        number: input.number,
        commentId:
          created.id === undefined ? undefined : displayText(created.id),
        url: created.html_url,
      }),
    };
  }
  const comments = await allPages(
    (page) =>
      runtime.call("GITHUB_LIST_ISSUE_COMMENTS", {
        ...numbered,
        per_page: 100,
        page,
      }),
    "comments",
  );
  const item: Json = {
    ...githubIssue(issue),
    body: issue.body ?? "",
    comments: comments.rows.map(githubComment),
    commentsComplete: comments.complete,
  };
  if (issue.pull_request) {
    const pullNumber = { ...where, pull_number: input.number };
    const pull = await runtime.call("GITHUB_GET_A_PULL_REQUEST", pullNumber);
    const files = await allPages(
      (page) =>
        runtime.call("GITHUB_LIST_PULL_REQUESTS_FILES", {
          ...pullNumber,
          per_page: 100,
          page,
        }),
      "details",
    );
    Object.assign(
      item,
      optionalFields({
        draft: pull.draft,
        merged: pull.merged,
        mergedAt: pull.merged_at,
        head: record(pull.head ?? {}).ref,
        base: record(pull.base ?? {}).ref,
        additions: pull.additions,
        deletions: pull.deletions,
        files: files.rows.map((file) =>
          optionalFields({
            path: requiredString(file.filename, "file path"),
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            previousPath: file.previous_filename,
          }),
        ),
        filesComplete: files.complete,
      }),
    );
  }
  return { item };
}
function githubReadme(raw: Json): Json {
  if (raw.encoding !== "base64" || typeof raw.content !== "string")
    throw new ConnectorError(
      "incomplete_response",
      "The README content is unavailable.",
    );
  const content = Buffer.from(raw.content, "base64").toString("utf8");
  const complete = content.length <= maxReadme;
  return optionalFields({
    available: true,
    path: raw.path,
    text: complete ? content : content.slice(0, maxReadme),
    complete,
  });
}
