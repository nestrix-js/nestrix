import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import type { QueryParams } from "@/lib/api";
import {
  applyHead,
  applyInitial,
  applyOlder,
  type CursorItem,
  type CursorPage,
  type CursorState,
  cursorListKey,
  emptyCursorState,
} from "@/lib/cursor-list";
import { useEnvironment } from "@/lib/environment";
import { pollInterval, usePaused } from "@/lib/live";

interface Snapshot<T extends CursorItem> {
  list: CursorState<T>;
  loadingOlder: boolean;
  olderError: Error | null;
}

/**
 * The list state lives outside React state so a poll and "load older" that finish in the
 * same tick both see the other's result (each step reads `list` after its own await).
 */
class CursorStore<T extends CursorItem> {
  alive = true;
  constructor(readonly environment: string | undefined) {}
  private listeners = new Set<() => void>();
  snapshot: Snapshot<T> = {
    list: emptyCursorState<T>(),
    loadingOlder: false,
    olderError: null,
  };

  get list(): CursorState<T> {
    return this.snapshot.list;
  }

  patch(change: Partial<Snapshot<T>>): void {
    if (!this.alive) return;
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): Snapshot<T> => this.snapshot;
}

/** The filters with the store's own environment, so an answer in flight keeps its scope. */
const scoped = (params: QueryParams, store: { environment?: string }) =>
  store.environment === undefined
    ? params
    : { ...params, environment: store.environment };

export interface UseCursorListOptions<T extends CursorItem> {
  /** Query-cache namespace, e.g. "traces". */
  name: string;
  /** Filters only; the hook adds `after` and `before` itself. */
  params: QueryParams;
  fetchPage: (params: QueryParams) => Promise<CursorPage<T>>;
}

export interface CursorListResult<T extends CursorItem> {
  items: T[];
  status: "loading" | "error" | "ready";
  error: Error | null;
  hasOlder: boolean;
  loadOlder: () => Promise<void>;
  loadingOlder: boolean;
  olderError: Error | null;
  /** Drops everything held and loads the newest page again. */
  reload: () => void;
}

/**
 * A live, cursor-paged list: the first page, `after=head` polls every 2 s while the tab is
 * visible and live is not paused, and `before=older` on demand.
 *
 * State belongs to one filter set: when `name` or `params` change the held items are dropped
 * and the first page of the new filters is loaded.
 */
export function useCursorList<T extends CursorItem>(
  options: UseCursorListOptions<T>,
): CursorListResult<T> {
  const { name, params, fetchPage } = options;
  // One store per filter set: a filter change starts from nothing, and the old store (no
  // longer alive) drops any answer still in flight for the old filters.
  // The selected environment is part of the identity and of every request the store makes.
  const [environment] = useEnvironment();
  const filterKey = cursorListKey(name, params, environment);
  // biome-ignore lint/correctness/useExhaustiveDependencies: filterKey stands for name, params and environment
  const store = useMemo(() => new CursorStore<T>(environment), [filterKey]);
  const latest = useRef({ params, fetchPage });
  latest.current = { params, fetchPage };

  // StrictMode runs effects twice; `alive` must end up true.
  useEffect(() => {
    store.alive = true;
    return () => {
      store.alive = false;
    };
  }, [store]);

  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const [paused] = usePaused();

  const query = useQuery({
    queryKey: [name, environment ?? null, params],
    queryFn: async () => {
      const { params: p0, fetchPage: fetcher } = latest.current;
      const p = scoped(p0, store);
      const head = store.list.loaded ? store.list.head : null;
      if (head !== null) {
        const page = await fetcher({ ...p, after: head });
        store.patch({ list: applyHead(store.list, page) });
      } else {
        const page = await fetcher(p);
        store.patch({ list: applyInitial(page) });
      }
      return Date.now();
    },
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
  });

  const loadOlder = useCallback(async () => {
    const { older } = store.list;
    if (older === null || store.snapshot.loadingOlder) return;
    store.patch({ loadingOlder: true, olderError: null });
    try {
      const { params: p0, fetchPage: fetcher } = latest.current;
      const page = await fetcher({ ...scoped(p0, store), before: older });
      store.patch({ list: applyOlder(store.list, page), loadingOlder: false });
    } catch (error) {
      store.patch({
        loadingOlder: false,
        olderError: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }, [store]);

  const { refetch } = query;
  const reload = useCallback(() => {
    store.patch({ list: emptyCursorState<T>(), olderError: null });
    void refetch();
  }, [store, refetch]);

  const { list } = snapshot;
  return {
    items: list.items,
    status: list.loaded ? "ready" : query.isError ? "error" : "loading",
    error: query.error,
    hasOlder: list.older !== null,
    loadOlder,
    loadingOlder: snapshot.loadingOlder,
    olderError: snapshot.olderError,
    reload,
  };
}
