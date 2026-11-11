// A nuqs adapter for TanStack Router under hash history.
//
// Why not `nuqs/adapters/tanstack-router`: nuqs merges a queued update into the URL's
// current search params, which it reads from `location.search` unless the adapter supplies
// `getSearchParamsSnapshot`. The stock TanStack adapter does not, and under hash history the
// params live in `location.hash`, so `location.search` is always empty: setting a second
// param drops the first (measured in e2e/dashboard.pw.ts, see the P2-02 report).
// This adapter is the stock one (nuqs 2.10.3, MIT) plus that one function, reading the raw
// search string from the router. It uses nuqs's `adapters/custom` entry; no other library.
// Not carried over: the stock adapter's history spy that flushes pending throttled writes on
// Back/Forward (it needs nuqs internals that are not exported).
import { useLocation, useRouter, useRouterState } from "@tanstack/react-router";
import {
  type unstable_AdapterInterface as AdapterInterface,
  unstable_createAdapterProvider as createAdapterProvider,
  renderQueryString,
} from "nuqs/adapters/custom";
import { startTransition, useCallback, useMemo } from "react";

function useNuqsHashAdapter(watchKeys: string[]): AdapterInterface {
  const pathname = useLocation({ select: (state) => state.pathname });
  const searchStr = useRouterState({
    select: (state) => state.location.searchStr,
  });
  const { navigate } = useRouter();

  const watched = watchKeys.join(",");
  const searchParams = useMemo(() => {
    const keys = watched.split(",");
    const filtered = new URLSearchParams();
    for (const [key, value] of new URLSearchParams(searchStr)) {
      if (keys.includes(key)) filtered.append(key, value);
    }
    return filtered;
  }, [searchStr, watched]);

  const router = useRouter();
  const updateUrl = useCallback<AdapterInterface["updateUrl"]>(
    (search, options) => {
      startTransition(() => {
        navigate({
          from: "/",
          to: pathname + renderQueryString(search),
          replace: options.history === "replace",
          resetScroll: options.scroll,
          hash: (prevHash) => prevHash ?? "",
          state: (prev) => prev,
        });
      });
    },
    [navigate, pathname],
  );

  return {
    searchParams,
    updateUrl,
    // The full current search, read at call time, so a write keeps the params it does not own.
    getSearchParamsSnapshot: () =>
      new URLSearchParams(router.state.location.searchStr),
    rateLimitFactor: 1,
  };
}

export const NuqsHashAdapter: ReturnType<typeof createAdapterProvider> =
  createAdapterProvider(useNuqsHashAdapter);
