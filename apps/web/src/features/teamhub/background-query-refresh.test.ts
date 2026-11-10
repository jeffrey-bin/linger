import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { refreshQueriesInBackground } from "./background-query-refresh";

afterEach(() => vi.useRealTimers());

it("retries a failed active refresh without another event and stops after unmount", async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const queryKey = ["retry"];
  client.setQueryData(queryKey, "old");
  const queryFn = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue("new");
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn,
    staleTime: Infinity,
  });
  const stop = observer.subscribe(() => undefined);
  await refreshQueriesInBackground(client, { queryKey });
  await vi.advanceTimersByTimeAsync(0);
  expect(client.getQueryState(queryKey)?.isInvalidated).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(client.getQueryData(queryKey)).toBe("new");
  expect(queryFn).toHaveBeenCalledTimes(2);
  queryFn.mockRejectedValue(new Error("offline"));
  await refreshQueriesInBackground(client, { queryKey });
  await vi.advanceTimersByTimeAsync(0);
  stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(queryFn).toHaveBeenCalledTimes(3);
  expect(client.getQueryState(queryKey)?.isInvalidated).toBe(true);
  client.clear();
});

it("coalesces dirty hints during an older request and does not resurrect cleared queries", async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  const queryKey = ["coalesce"];
  client.setQueryData(queryKey, "old");
  let release!: (value: string) => void;
  const queryFn = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue("latest");
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn,
    staleTime: Infinity,
  });
  const stop = observer.subscribe(() => undefined);
  const initial = client.refetchQueries({ queryKey });
  await Promise.all(
    Array.from({ length: 20 }, () =>
      refreshQueriesInBackground(client, { queryKey }),
    ),
  );
  expect(queryFn).toHaveBeenCalledOnce();
  release("older request");
  await initial;
  await vi.advanceTimersByTimeAsync(0);
  expect(queryFn).toHaveBeenCalledTimes(2);
  expect(client.getQueryData(queryKey)).toBe("latest");
  queryFn.mockRejectedValue(new Error("offline"));
  await refreshQueriesInBackground(client, { queryKey });
  client.clear();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(client.getQueryCache().findAll()).toHaveLength(0);
  stop();
});
