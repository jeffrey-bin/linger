import type { QueryClient } from "@tanstack/react-query";

import {
  TeamHubError,
  TeamHubTransportError,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import type { TeamHubRuntimePresentationEventPage } from "@/features/teamhub/teamhub-types";

import { roomRuntimePresentationEventsQueryKey } from "../room-queries";
import {
  collectRuntimePresentationEvents,
  roomRuntimePresentationEventsQueryOptions,
} from "./runtime-presentation-events-query";

const WAKE_COALESCE_MS = 100;
const MAX_CONCURRENT_SYNCS = 4;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 5_000;

type RuntimePresentationSyncClient = Pick<TeamHubClient, "api">;

interface LimitedSyncJob {
  cancelled: boolean;
  run: () => Promise<void>;
}

interface RuntimePresentationSyncRegistry {
  active: number;
  runStatuses: Map<string, RunStatusSyncState>;
  queue: LimitedSyncJob[];
}

interface RunStatusSyncState {
  attemptedRevision: number;
  blocked: boolean;
  client: RuntimePresentationSyncClient;
  completedRevision: number;
  runStatusId: string;
  job?: LimitedSyncJob;
  key: string;
  owners: Set<symbol>;
  queryClient: QueryClient;
  queryKey: ReturnType<typeof roomRuntimePresentationEventsQueryKey>;
  registry: RuntimePresentationSyncRegistry;
  requestedRevision: number;
  retryAttempt: number;
  roomId: string;
  running?: Promise<TeamHubRuntimePresentationEventPage>;
  tenantId: string;
  timer?: ReturnType<typeof setTimeout>;
}

const registries = new WeakMap<QueryClient, RuntimePresentationSyncRegistry>();

export function createRuntimePresentationEventsSync({
  client,
  queryClient,
  roomId,
  tenantId,
}: {
  client: RuntimePresentationSyncClient;
  queryClient: QueryClient;
  roomId: string;
  tenantId: string;
}) {
  const owner = Symbol("runtime-presentation-events-sync");
  const ownedStates = new Map<string, RunStatusSyncState>();
  const registry = getRegistry(queryClient);
  let disposed = false;

  function release(state: RunStatusSyncState) {
    if (ownedStates.get(state.key) !== state) return;
    ownedStates.delete(state.key);
    state.owners.delete(owner);
    if (state.owners.size === 0) removeState(state);
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of ownedStates.values()) release(state);
    },
    isRevisionComplete(runStatusId: string, revision: number) {
      const key = JSON.stringify(
        roomRuntimePresentationEventsQueryKey(tenantId, roomId, runStatusId),
      );
      const state = ownedStates.get(key);
      return state !== undefined && state.completedRevision >= revision;
    },
    request(runStatusId: string, revision: number) {
      if (disposed) return;
      const queryKey = roomRuntimePresentationEventsQueryKey(
        tenantId,
        roomId,
        runStatusId,
      );
      const key = JSON.stringify(queryKey);
      let state = registry.runStatuses.get(key);
      if (!state) {
        state = {
          attemptedRevision: -1,
          blocked: false,
          client,
          completedRevision: -1,
          runStatusId,
          key,
          owners: new Set(),
          queryClient,
          queryKey,
          registry,
          requestedRevision: revision,
          retryAttempt: 0,
          roomId,
          tenantId,
        };
        registry.runStatuses.set(key, state);
      } else {
        state.client = client;
        state.requestedRevision = Math.max(state.requestedRevision, revision);
        if (state.requestedRevision > state.attemptedRevision) {
          state.retryAttempt = 0;
        }
      }
      if (!state.owners.has(owner)) {
        state.owners.add(owner);
        ownedStates.set(key, state);
      }
      if (state.requestedRevision > state.completedRevision) schedule(state);
    },
    retain(runStatusIds: ReadonlySet<string>) {
      for (const state of ownedStates.values()) {
        if (!runStatusIds.has(state.runStatusId)) release(state);
      }
    },
  };
}

function schedule(state: RunStatusSyncState) {
  if (
    !isCurrent(state) ||
    state.job ||
    state.running ||
    state.timer !== undefined ||
    state.blocked
  ) {
    return;
  }

  const cached = state.queryClient.getQueryData(state.queryKey);
  if (state.completedRevision < 0 && !cached) {
    enqueue(state);
    return;
  }
  state.timer = setTimeout(() => {
    state.timer = undefined;
    enqueue(state);
  }, WAKE_COALESCE_MS);
}

function enqueue(state: RunStatusSyncState) {
  if (!isCurrent(state) || state.running || state.job) return;
  const job: LimitedSyncJob = {
    cancelled: false,
    run: () => {
      if (job.cancelled || !isCurrent(state) || state.job !== job) {
        return Promise.resolve();
      }
      state.job = undefined;
      return start(state);
    },
  };
  state.job = job;
  enqueueLimitedSync(state.registry, job);
}

function start(state: RunStatusSyncState): Promise<void> {
  if (!isCurrent(state) || state.running) return Promise.resolve();
  const targetRevision = state.requestedRevision;
  state.attemptedRevision = targetRevision;
  const previous =
    state.queryClient.getQueryData<TeamHubRuntimePresentationEventPage>(
      state.queryKey,
    );
  const options = roomRuntimePresentationEventsQueryOptions(
    state.client,
    state.tenantId,
    state.roomId,
    state.runStatusId,
  );
  const running = state.queryClient.fetchQuery({
    ...options,
    queryFn: ({ signal }) =>
      collectRuntimePresentationEvents(
        state.client,
        state.roomId,
        state.runStatusId,
        previous,
        signal,
      ),
    staleTime: 0,
    retry: false,
  });
  state.running = running;
  return running.then(
    () => {
      if (state.running !== running) return;
      state.running = undefined;
      if (!isCurrent(state)) return;
      state.retryAttempt = 0;
      state.completedRevision = Math.max(
        state.completedRevision,
        targetRevision,
      );
      if (state.requestedRevision > state.completedRevision) schedule(state);
    },
    (error: unknown) => {
      if (state.running !== running) return;
      state.running = undefined;
      if (!isCurrent(state)) return;
      if (isRetryableSyncError(error)) {
        state.retryAttempt = Math.min(state.retryAttempt + 1, 31);
        const exponentialDelay = Math.min(
          RETRY_BASE_DELAY_MS * 2 ** (state.retryAttempt - 1),
          RETRY_MAX_DELAY_MS,
        );
        const retryAfterDelay =
          error instanceof TeamHubError && error.retryAfterSeconds
            ? error.retryAfterSeconds * 1_000
            : 0;
        state.timer = setTimeout(
          () => {
            state.timer = undefined;
            enqueue(state);
          },
          Math.max(exponentialDelay, retryAfterDelay),
        );
      } else {
        state.blocked = true;
      }
    },
  );
}

function removeState(state: RunStatusSyncState) {
  if (state.timer !== undefined) clearTimeout(state.timer);
  if (state.job) {
    state.job.cancelled = true;
    state.job = undefined;
  }
  if (state.registry.runStatuses.get(state.key) !== state) return;
  state.registry.runStatuses.delete(state.key);
  void state.queryClient.cancelQueries({
    exact: true,
    queryKey: state.queryKey,
  });
}

function isCurrent(state: RunStatusSyncState) {
  return (
    state.owners.size > 0 && state.registry.runStatuses.get(state.key) === state
  );
}

function getRegistry(queryClient: QueryClient) {
  let registry = registries.get(queryClient);
  if (!registry) {
    registry = { active: 0, runStatuses: new Map(), queue: [] };
    registries.set(queryClient, registry);
  }
  return registry;
}

function enqueueLimitedSync(
  registry: RuntimePresentationSyncRegistry,
  job: LimitedSyncJob,
) {
  registry.queue.push(job);
  pumpLimiter(registry);
}

function pumpLimiter(registry: RuntimePresentationSyncRegistry) {
  while (registry.active < MAX_CONCURRENT_SYNCS && registry.queue.length > 0) {
    const job = registry.queue.shift()!;
    if (job.cancelled) continue;
    registry.active += 1;
    void Promise.resolve()
      .then(job.run)
      .finally(() => {
        registry.active -= 1;
        pumpLimiter(registry);
      });
  }
}

function isRetryableSyncError(error: unknown) {
  if (error instanceof TeamHubTransportError) return true;
  if (error instanceof TeamHubError) return Boolean(error.retryable);
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "CancelledError")
  );
}
