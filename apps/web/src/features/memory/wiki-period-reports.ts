import { useQuery } from "@tanstack/react-query";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMemoryEntry } from "@/features/teamhub/teamhub-types";
import { bucketStart } from "./wiki-graph-model";

export type PeriodReportKind = "daily" | "weekly";

export function reportDate(entry: TeamHubMemoryEntry): string | undefined {
  const date =
    entry.date ?? /\/(\d{4}-\d{2}-\d{2})\.md$/u.exec(entry.path)?.[1];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== date
  )
    return;
  return entry.kind === "weekly" ? bucketStart(date, "week") : date;
}

async function listReports(
  client: TeamHubClient,
  tenantId: string,
  kind: PeriodReportKind,
) {
  const seen = new Set<string>();
  const entries = new Map<string, TeamHubMemoryEntry>();
  let cursor: string | undefined;
  while (true) {
    const page = await teamHubData(
      client.api.GET("/v0/tenants/{tenantId}/memory", {
        params: {
          path: { tenantId },
          query: { kind, limit: 100, ...(cursor ? { cursor } : {}) },
        },
      }),
    );
    for (const entry of page.items)
      if (entry.kind === kind && reportDate(entry))
        entries.set(entry.id, entry);
    if (!page.next_cursor) return [...entries.values()];
    if (seen.has(page.next_cursor))
      throw new Error("Report pagination returned a repeated cursor.");
    seen.add(page.next_cursor);
    cursor = page.next_cursor;
  }
}

export function usePeriodReports(tenantId: string, kind: PeriodReportKind) {
  const { client } = useTeamHubRuntime();
  return useQuery({
    queryKey: ["teamhub", tenantId, "personal-memory", `${kind}-entries`],
    queryFn: () => listReports(client, tenantId, kind),
    staleTime: 60_000,
  });
}

export function usePeriodReport(
  tenantId: string,
  kind: PeriodReportKind,
  day: string,
  entry?: TeamHubMemoryEntry,
  enabled = true,
) {
  const { client } = useTeamHubRuntime();
  return useQuery({
    queryKey: ["teamhub", tenantId, "personal-memory", kind, day],
    queryFn: () => {
      if (!entry) throw new Error("Report is unavailable.");
      return teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/memory/{entryId}", {
          params: { path: { tenantId, entryId: entry.id } },
        }),
      );
    },
    enabled: Boolean(entry) && enabled,
    staleTime: 60_000,
  });
}

export function periodLabel(day: string, kind: PeriodReportKind): string {
  if (kind === "daily") return day;
  const end = new Date(Date.parse(`${day}T00:00:00Z`) + 6 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return `${day} – ${end}`;
}
