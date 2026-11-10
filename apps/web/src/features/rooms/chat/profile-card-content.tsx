import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { externalAppsQueryOptions } from "@/features/apps/connected-apps-queries";
import {
  personalProfileQueryKey,
  personalProfileQueryOptions,
} from "@/features/settings/personal-profile-queries";
import { AppLogo } from "@/features/apps/app-logo";
import { anotherMeQueryKey } from "@/features/rooms/room-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useOptionalTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubPersonalProfileDocument } from "@/features/teamhub/teamhub-types";

/** Select a short paragraph from the published Profile's fields. */
export function profilePreview(
  profile: TeamHubPersonalProfileDocument,
): string | undefined {
  const modules = [
    profile.background,
    profile.communication_style,
    profile.working_style,
    profile.preferences,
    profile.writing_style,
  ];
  const paragraph = [
    ...modules.map((module) => module.overview),
    ...modules.flatMap((module) => module.points.map((point) => point.text)),
  ]
    .map((text) => text.replace(/\s+/g, " ").trim())
    .find((text) => text.length >= 40);
  if (!paragraph) return undefined;
  return paragraph.length > 280
    ? `${paragraph.slice(0, 280).trimEnd()}…`
    : paragraph;
}

export function useProfileCardContent({
  children,
  tenantId,
  roomId,
  authorId,
}: {
  children: ReactNode;
  tenantId?: string;
  roomId?: string;
  authorId?: string;
}) {
  const runtime = useOptionalTeamHubRuntime();
  const anotherMe = useQuery({
    queryKey: anotherMeQueryKey(tenantId ?? ""),
    queryFn: () =>
      teamHubData(
        runtime!.client.api.GET("/v0/tenants/{tenantId}/another-me", {
          params: { path: { tenantId: tenantId! } },
        }),
      ),
    enabled: Boolean(runtime && tenantId && roomId && authorId),
    retry: false,
    staleTime: 30_000,
  });
  const isOwnProfileDelivery = Boolean(
    anotherMe.data?.room_id === roomId &&
    anotherMe.data?.agent_actor_id === authorId &&
    roomId &&
    authorId,
  );
  const profile = useQuery({
    ...(runtime
      ? personalProfileQueryOptions(runtime.client, tenantId ?? "")
      : {
          queryKey: personalProfileQueryKey(tenantId ?? ""),
          queryFn: () => Promise.reject(new Error("No runtime")),
        }),
    enabled: Boolean(runtime && tenantId && isOwnProfileDelivery),
    retry: false,
    staleTime: 5_000,
  });
  const sourceApps = isOwnProfileDelivery
    ? profile.data?.current?.source_apps
    : undefined;
  const catalog = useQuery({
    ...(runtime
      ? externalAppsQueryOptions(runtime.client)
      : {
          queryKey: ["teamhub", "external-apps"],
          queryFn: () => Promise.reject(new Error("No runtime")),
        }),
    enabled: Boolean(runtime && sourceApps?.length),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const apps = (sourceApps ?? []).map((key) => {
    const app = catalog.data?.apps.find((item) => item.key === key);
    return { key, name: app?.display_name ?? key, logoUrl: app?.logo_url };
  });
  const current = isOwnProfileDelivery ? profile.data?.current : undefined;
  const preview = current ? profilePreview(current.profile) : undefined;
  return {
    isOwnProfileDelivery,
    body: preview ? (
      <p className="line-clamp-4 whitespace-pre-line text-sm leading-6 text-app-body">
        {preview}
      </p>
    ) : (
      children
    ),
    sources: apps.length ? (
      <ul
        aria-label="Profile sources"
        className="flex flex-wrap items-center gap-1.5"
      >
        {apps.map((app) => (
          <li
            key={app.key}
            title={app.name}
            aria-label={app.name}
            className="grid size-8 place-items-center rounded-full border border-app-border bg-app-surface"
          >
            <AppLogo name={app.name} size="profile" url={app.logoUrl} />
          </li>
        ))}
      </ul>
    ) : null,
  };
}
