import type { RouteStats } from "@nestrix-js/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { getRouteHistogram } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { HistogramChart, type Marker } from "@/views/routes/histogram-chart";
import {
  bucketFilter,
  bucketLabel,
  markerX,
  requestsLink,
} from "@/views/routes/route-insights";

/**
 * The latency distribution of the selected route over the window, counted before sampling, with
 * p50/p95/p99 marked. A click on a bar (or on its entry in the list under the chart) opens the
 * request list narrowed to that latency range, route and method.
 */
export function RouteHistogram({
  stats,
  windowMinutes,
  service,
  label,
}: {
  stats: Pick<RouteStats, "method" | "route">;
  windowMinutes: number;
  service: string | undefined;
  label: string;
}) {
  const [paused] = usePaused();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: [
      "routes",
      "histogram",
      stats.route,
      stats.method,
      windowMinutes,
      service,
    ],
    queryFn: () =>
      getRouteHistogram({
        route: stats.route,
        method: stats.method === "*" ? undefined : stats.method,
        windowMinutes,
        service,
      }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const h = query.data;
  const markers = useMemo<Marker[]>(
    () =>
      h === undefined || h.count === 0
        ? []
        : [
            {
              label: "p50",
              color: "--foreground",
              x: markerX(h.buckets, h.p50Ms),
            },
            {
              label: "p95",
              color: "--chart-2",
              x: markerX(h.buckets, h.p95Ms),
            },
            {
              label: "p99",
              color: "--chart-3",
              x: markerX(h.buckets, h.p99Ms),
            },
          ],
    [h],
  );
  const open = (index: number) => {
    const bucket = h?.buckets[index];
    if (h === undefined || bucket === undefined) return;
    void navigate({ to: requestsLink(bucketFilter(h, bucket)) });
  };

  return (
    <div className="space-y-2" data-testid="route-histogram">
      <h4 className="text-sm font-medium">Latency distribution</h4>
      {query.isError && h === undefined && (
        <p role="alert" className="text-sm text-muted-foreground">
          Could not load the histogram: {query.error?.message}
        </p>
      )}
      {h !== undefined &&
        (h.count === 0 ? (
          <p className="text-sm text-muted-foreground">
            No requests of this route in the last {windowMinutes} minutes.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {h.count} requests counted before sampling; p50{" "}
              <span data-testid="histogram-p50">{formatDuration(h.p50Ms)}</span>
              , p95{" "}
              <span data-testid="histogram-p95">{formatDuration(h.p95Ms)}</span>
              , p99{" "}
              <span data-testid="histogram-p99">{formatDuration(h.p99Ms)}</span>
              . Click a bar to list the requests in that range.
            </p>
            <HistogramChart
              buckets={h.buckets}
              markers={markers}
              label={`Latency distribution of ${label}`}
              onSelect={open}
            />
            <ul
              data-testid="histogram-buckets"
              className="flex flex-wrap gap-1 text-xs"
            >
              {h.buckets.flatMap((bucket, i) =>
                bucket.count > 0
                  ? [
                      <li key={bucket.fromMs}>
                        <button
                          type="button"
                          data-testid="histogram-bucket"
                          onClick={() => open(i)}
                          className="rounded border border-border px-1.5 py-0.5 hover:bg-muted"
                        >
                          {bucketLabel(bucket)}: {bucket.count}
                        </button>
                      </li>,
                    ]
                  : [],
              )}
            </ul>
          </>
        ))}
    </div>
  );
}
