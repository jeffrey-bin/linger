import type { Query, QueryClient, QueryFilters } from "@tanstack/react-query";

interface Refresh {
  dirty: boolean;
  running: boolean;
  retryMs: number;
  timer?: ReturnType<typeof setTimeout>;
}
const clients = new WeakMap<QueryClient, Map<Query, Refresh>>();

/** Apply the dirty hint locally; network requests must not hold the event queue. */
export async function refreshQueriesInBackground(
  client: QueryClient,
  filters: QueryFilters,
) {
  await client.invalidateQueries({ ...filters, refetchType: "none" });
  let states = clients.get(client);
  if (!states) {
    states = new Map();
    clients.set(client, states);
    const owned = states;
    client.getQueryCache().subscribe((event) => {
      if (
        event.type !== "removed" &&
        !(event.type === "observerRemoved" && !event.query.isActive())
      )
        return;
      const state = owned.get(event.query);
      if (state?.timer) clearTimeout(state.timer);
      owned.delete(event.query);
    });
  }
  for (const query of client.getQueryCache().findAll(filters)) {
    if (!query.isActive()) continue;
    const state = states.get(query) ?? {
      dirty: false,
      running: false,
      retryMs: 1000,
    };
    states.set(query, state);
    state.dirty = true;
    const owned = states;
    const start = () => {
      if (
        owned.get(query) !== state ||
        !query.isActive() ||
        state.running ||
        state.timer ||
        !state.dirty
      )
        return;
      state.dirty = query.state.fetchStatus === "fetching";
      state.running = true;
      // A later hint may arrive while the first request still represents old state.
      query.invalidate();
      void client
        .refetchQueries(
          { queryKey: query.queryKey, exact: true, type: "active" },
          { throwOnError: true, cancelRefetch: false },
        )
        .then(() => {
          state.retryMs = 1000;
        })
        .catch(() => {
          query.invalidate();
          state.dirty = true;
          if (owned.get(query) === state && query.isActive()) {
            state.timer = setTimeout(() => {
              state.timer = undefined;
              start();
            }, state.retryMs);
            state.retryMs = Math.min(state.retryMs * 2, 30_000);
          }
        })
        .finally(() => {
          state.running = false;
          if (state.dirty) {
            query.invalidate();
            start();
          } else if (owned.get(query) === state) owned.delete(query);
        });
    };
    start();
  }
}
