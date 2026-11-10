import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { useLocalRuntimeSelection } from "./use-local-runtime-selection";

describe("useLocalRuntimeSelection freshness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not poll after an online Computer is available", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fixture = createTestTeamHubRuntime();

    const inventory =
      await fixture.client.listTenantLocalComputers("tenant-northstar");
    const listLocalComputers = vi
      .spyOn(fixture.client, "listTenantLocalComputers")
      .mockResolvedValue(inventory);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={fixture}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () =>
        useLocalRuntimeSelection({
          tenantId: "tenant-northstar",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.computer).toBeDefined());
    expect(listLocalComputers).toHaveBeenCalledOnce();

    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(listLocalComputers).toHaveBeenCalledOnce();
  });

  it("does not poll while waiting for a Computer invalidation hint", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fixture = createTestTeamHubRuntime();

    const listLocalComputers = vi
      .spyOn(fixture.client, "listTenantLocalComputers")
      .mockResolvedValue({ items: [] });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={fixture}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );

    renderHook(
      () =>
        useLocalRuntimeSelection({
          tenantId: "tenant-northstar",
        }),
      { wrapper },
    );

    await waitFor(() => expect(listLocalComputers).toHaveBeenCalledOnce());
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(listLocalComputers).toHaveBeenCalledOnce();
  });

  it("polls while Local creation is waiting for a Computer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fixture = createTestTeamHubRuntime();

    const listLocalComputers = vi
      .spyOn(fixture.client, "listTenantLocalComputers")
      .mockResolvedValue({ items: [] });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={fixture}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );

    renderHook(
      () =>
        useLocalRuntimeSelection({
          tenantId: "tenant-northstar",
          watchForComputer: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(listLocalComputers).toHaveBeenCalledOnce());
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(listLocalComputers.mock.calls.length).toBeGreaterThan(1);
  });
});
