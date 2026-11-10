import { describe, expect, it } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import {
  externalConnectionQueryOptions,
  externalConnectionsQueryOptions,
  isExternalSourceAccountQuery,
  tenantExternalConnectionsQueryOptions,
} from "./connected-apps-queries";

describe("Tenant external connection queries", () => {
  it("uses the Tenant freshness lifecycle without module polling", () => {
    const client = createTestTeamHubRuntime().client;
    const options = tenantExternalConnectionsQueryOptions(client, "tenant-a");

    expect(options.queryKey).toEqual([
      "teamhub",
      "tenant-a",
      "external-connections",
    ]);
    expect(options.refetchInterval).toBeUndefined();
  });

  it("does not poll account-scoped connection workflows while delivery SSE is healthy", () => {
    const client = createTestTeamHubRuntime().client;
    const options = [
      externalConnectionsQueryOptions(client),
      externalConnectionQueryOptions(client, "connection-a"),
    ];

    expect(
      options.every((option) => option.refetchInterval === undefined),
    ).toBe(true);
  });

  it("identifies account-scoped connection queries for the shared fallback", () => {
    expect(
      isExternalSourceAccountQuery([
        "teamhub",
        "external-connections",
        "connection-a",
      ]),
    ).toBe(true);
    expect(
      isExternalSourceAccountQuery(["teamhub", "tenant-a", "work-items"]),
    ).toBe(false);
  });
});
