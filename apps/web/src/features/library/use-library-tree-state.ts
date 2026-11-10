import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore, type SetStateAction } from "react";

interface TreeState<Value> {
  read: () => Value;
  set: (next: SetStateAction<Value>) => void;
  subscribe: (listener: () => void) => () => void;
}

const states = new WeakMap<QueryClient, Map<string, unknown>>();

export function useLibraryTreeState<Value>(
  tenantId: string,
  section: string,
  initialize: () => Value,
) {
  const client = useQueryClient();
  let cache = states.get(client);
  if (!cache) {
    cache = new Map();
    states.set(client, cache);
  }
  const key = JSON.stringify([tenantId, section]);
  let store = cache.get(key) as TreeState<Value> | undefined;
  if (!store) {
    let value = initialize();
    const listeners = new Set<() => void>();
    store = {
      read: () => value,
      set: (next) => {
        const result =
          typeof next === "function"
            ? (next as (previous: Value) => Value)(value)
            : next;
        if (Object.is(result, value)) return;
        value = result;
        for (const listener of listeners) listener();
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    cache.set(key, store);
  }
  return [
    useSyncExternalStore(store.subscribe, store.read, store.read),
    store.set,
  ] as const;
}
