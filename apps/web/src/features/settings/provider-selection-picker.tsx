import { Loading03Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubPersonalProfileSourceSelection } from "@/features/teamhub/teamhub-types";

export const sourceCheckClassName =
  "size-4 shrink-0 cursor-pointer rounded-[4px] border-app-border-strong accent-[var(--app-action)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus disabled:cursor-not-allowed disabled:opacity-45";

export type SelectionPickerProvider =
  | "discord"
  | "github"
  | "google_calendar"
  | "notion"
  | "slack";

const PICKER_MAXIMUM: Record<SelectionPickerProvider, number> = {
  discord: 20,
  github: 5,
  google_calendar: 10,
  notion: 10,
  slack: 5,
};

const PICKER_TITLE: Record<SelectionPickerProvider, string> = {
  discord: "Discord channels",
  github: "GitHub repositories",
  google_calendar: "Google calendars",
  notion: "Notion pages and databases",
  slack: "Slack channels",
};

const PICKER_LOAD_MORE: Record<SelectionPickerProvider, string> = {
  discord: "channels",
  github: "repositories",
  google_calendar: "calendars",
  notion: "pages",
  slack: "channels",
};

export function ProviderSelectionPicker({
  client,
  connectionId,
  onChange,
  provider,
  selections,
}: {
  client: TeamHubClient;
  connectionId: string;
  onChange: (selections: TeamHubPersonalProfileSourceSelection[]) => void;
  provider: SelectionPickerProvider;
  selections: TeamHubPersonalProfileSourceSelection[];
}) {
  const slackQuery = useInfiniteQuery({
    enabled: provider === "slack",
    queryKey: ["teamhub", "profile-source-selections", "slack", connectionId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.listSlackConversations(connectionId, {
        cursor: pageParam,
        limit: 100,
      }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    retry: false,
  });
  const discordQuery = useQuery({
    enabled: provider === "discord",
    queryKey: ["teamhub", "profile-source-selections", "discord", connectionId],
    queryFn: () => client.listDiscordChannels(connectionId),
    retry: false,
  });
  const calendarQuery = useInfiniteQuery({
    enabled: provider === "google_calendar",
    queryKey: [
      "teamhub",
      "profile-source-selections",
      "calendar",
      connectionId,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.listGoogleCalendars(connectionId, {
        limit: 100,
        pageToken: pageParam,
      }),
    getNextPageParam: (page) => page.next_page_token ?? undefined,
    retry: false,
  });
  const githubQuery = useInfiniteQuery({
    enabled: provider === "github",
    queryKey: ["teamhub", "profile-source-selections", "github", connectionId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.listGitHubRepositories(connectionId, {
        cursor: pageParam,
        limit: 50,
      }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    retry: false,
  });
  const notionQuery = useInfiniteQuery({
    enabled: provider === "notion",
    queryKey: ["teamhub", "profile-source-selections", "notion", connectionId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.listNotionResources(connectionId, {
        cursor: pageParam,
        limit: 50,
      }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    retry: false,
  });
  const options: TeamHubPersonalProfileSourceSelection[] =
    provider === "slack"
      ? (slackQuery.data?.pages.flatMap((page) =>
          page.conversations.map((item) => ({
            is_private: item.is_private,
            kind: item.kind,
            name: item.name,
            remote_id: item.id,
          })),
        ) ?? [])
      : provider === "discord"
        ? (discordQuery.data?.channels ?? []).map((item) => ({
            is_private: false,
            kind: `${item.kind}_channel` as TeamHubPersonalProfileSourceSelection["kind"],
            name: item.name,
            remote_id: item.id,
          }))
        : provider === "github"
          ? (githubQuery.data?.pages.flatMap((page) =>
              page.repositories.map((item) => ({
                is_private: false,
                kind: "github_repository",
                name: item.full_name,
                remote_id: item.id,
              })),
            ) ?? [])
          : provider === "notion"
            ? (notionQuery.data?.pages.flatMap((page) =>
                page.resources.map((item) => ({
                  is_private: false,
                  kind: item.kind,
                  name: item.title,
                  remote_id: item.id,
                })),
              ) ?? [])
            : (calendarQuery.data?.pages.flatMap((page) =>
                page.calendars.map((item) => ({
                  is_private: false,
                  kind: "google_calendar",
                  name: item.summary,
                  remote_id: item.id,
                })),
              ) ?? []);
  const maximum = PICKER_MAXIMUM[provider];
  const queryError =
    provider === "slack"
      ? slackQuery.error
      : provider === "discord"
        ? discordQuery.error
        : provider === "github"
          ? githubQuery.error
          : provider === "notion"
            ? notionQuery.error
            : calendarQuery.error;
  const queryPending =
    provider === "slack"
      ? slackQuery.isPending
      : provider === "discord"
        ? discordQuery.isPending
        : provider === "github"
          ? githubQuery.isPending
          : provider === "notion"
            ? notionQuery.isPending
            : calendarQuery.isPending;
  const hasNextPage =
    provider === "slack"
      ? slackQuery.hasNextPage
      : provider === "github"
        ? githubQuery.hasNextPage
        : provider === "google_calendar"
          ? calendarQuery.hasNextPage
          : provider === "notion"
            ? notionQuery.hasNextPage
            : false;
  const fetchingNextPage =
    provider === "slack"
      ? slackQuery.isFetchingNextPage
      : provider === "github"
        ? githubQuery.isFetchingNextPage
        : provider === "notion"
          ? notionQuery.isFetchingNextPage
          : calendarQuery.isFetchingNextPage;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-app-ink">
          {PICKER_TITLE[provider]}
        </h3>
        <span className="text-xs text-app-muted">
          {selections.length}/{maximum} selected
        </span>
      </div>
      {provider === "github" ? (
        <p className="mt-1 text-xs leading-5 text-app-muted">
          Your public profile is always included.
        </p>
      ) : null}
      {provider === "notion" && !queryPending && options.length === 0 ? (
        <p className="mt-1 text-xs leading-5 text-app-muted">
          Share pages or databases with the Notion integration first.
        </p>
      ) : null}
      <div className="workspace-scrollbar mt-2 grid max-h-64 gap-0.5 overflow-y-auto rounded-md border border-app-border p-1">
        {options.map((option) => {
          const selected = selections.some(
            (item) => item.remote_id === option.remote_id,
          );
          return (
            <label
              className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm transition-colors duration-150 motion-reduce:transition-none ${
                selected
                  ? "bg-app-selected text-app-ink"
                  : "text-app-body hover:bg-app-hover"
              } ${!selected && selections.length >= maximum ? "cursor-not-allowed opacity-45" : ""}`}
              key={option.remote_id}
            >
              <input
                checked={selected}
                className={sourceCheckClassName}
                disabled={!selected && selections.length >= maximum}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selections, option]
                      : selections.filter(
                          (item) => item.remote_id !== option.remote_id,
                        ),
                  )
                }
                type="checkbox"
              />
              <span className="truncate">
                {["google_calendar", "github", "notion"].includes(provider)
                  ? ""
                  : "# "}
                {option.name}
              </span>
              {option.is_private ? (
                <span className="ml-auto text-xs text-app-muted">Private</span>
              ) : null}
            </label>
          );
        })}
      </div>
      {queryError ? (
        <p className="mt-2 text-sm text-app-danger" role="alert">
          {queryError.message}
        </p>
      ) : null}
      {hasNextPage ? (
        <Button
          className="mt-3"
          disabled={fetchingNextPage}
          onClick={() => {
            void (provider === "slack"
              ? slackQuery.fetchNextPage()
              : provider === "github"
                ? githubQuery.fetchNextPage()
                : provider === "notion"
                  ? notionQuery.fetchNextPage()
                  : calendarQuery.fetchNextPage());
          }}
          size="compact"
        >
          {fetchingNextPage ? (
            <Icon icon={Loading03Icon} className="animate-spin" size={14} />
          ) : (
            <Icon icon={RefreshIcon} size={14} />
          )}
          Load more {PICKER_LOAD_MORE[provider]}
        </Button>
      ) : null}
    </div>
  );
}
