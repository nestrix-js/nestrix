import type { MapNodeKind } from "@nestrix/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Box,
  Database,
  Globe,
  Inbox,
  type LucideIcon,
  RefreshCw,
  Server,
  Zap,
} from "lucide-react";
import { useQueryStates } from "nuqs";
import { useMemo } from "react";

import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getMap } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { routeWindowParser } from "@/lib/params";
import { cn } from "@/lib/utils";
import {
  type ErrorLevel,
  errorLevel,
  formatRate,
  layoutMap,
  MAP_HEIGHT,
  MAP_WIDTH,
  truncate,
} from "@/views/map/map-layout";

const WINDOWS = [15, 60] as const;
const DEFAULT_WINDOW = 15;
const parsers = { windowMinutes: routeWindowParser };

const ICONS: Record<MapNodeKind, LucideIcon> = {
  app: Server,
  database: Database,
  cache: Zap,
  http: Globe,
  queue: Inbox,
  other: Box,
};
const KIND_LABEL: Record<MapNodeKind, string> = {
  app: "app",
  database: "database",
  cache: "cache",
  http: "HTTP service",
  queue: "queue",
  other: "other",
};

// Classes, not inline styles: the dashboard's CSP forbids style attributes.
const EDGE_STROKE: Record<ErrorLevel, string> = {
  none: "stroke-muted-foreground",
  low: "stroke-destructive/50",
  high: "stroke-destructive",
};
const EDGE_TEXT: Record<ErrorLevel, string> = {
  none: "fill-muted-foreground",
  low: "fill-destructive",
  high: "fill-destructive",
};

const NODE_W = 160;
const NODE_H = 44;

export function MapPage() {
  const [query, setQuery] = useQueryStates(parsers);
  const windowMinutes = query.windowMinutes ?? DEFAULT_WINDOW;
  const [paused] = usePaused();

  const map = useQuery({
    queryKey: ["map", windowMinutes],
    queryFn: () => getMap({ windowMinutes }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });

  const layout = useMemo(
    () => layoutMap(map.data?.nodes ?? [], map.data?.edges ?? []),
    [map.data],
  );
  const names = useMemo(
    () => new Map(layout.nodes.map((n) => [n.id, n.name])),
    [layout],
  );
  const shownWindow = map.data?.windowMinutes ?? windowMinutes;

  return (
    <section className="space-y-4" aria-label="Map">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Map</h2>
        <div className="flex items-center gap-2">
          <fieldset
            className="flex items-center gap-1"
            aria-label="Time window"
          >
            {WINDOWS.map((minutes) => (
              <Button
                key={minutes}
                size="sm"
                variant={windowMinutes === minutes ? "default" : "outline"}
                aria-pressed={windowMinutes === minutes}
                onClick={() =>
                  void setQuery({
                    windowMinutes: minutes === DEFAULT_WINDOW ? null : minutes,
                  })
                }
              >
                {minutes} min
              </Button>
            ))}
          </fieldset>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Reload"
            onClick={() => void map.refetch()}
          >
            <RefreshCw />
            Reload
          </Button>
        </div>
      </div>
      <p
        data-testid="map-note"
        className="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground"
      >
        The map is built from sampled traces: calls, error rates and percentiles
        describe the traces in the store, not every call.
      </p>

      {map.isPending && <DataTableSkeleton columnCount={7} />}
      {map.isError && map.data === undefined && (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-border p-6 text-center"
        >
          <p className="font-medium">Could not load the map.</p>
          <p className="text-sm text-muted-foreground">{map.error?.message}</p>
          <Button variant="outline" onClick={() => void map.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {map.data !== undefined &&
        (layout.edges.length === 0 ? (
          <p
            data-testid="map-empty"
            className="rounded-lg border border-border p-6 text-center text-muted-foreground"
          >
            No calls to other services in the last {shownWindow} minutes.
          </p>
        ) : (
          <>
            <div className="rounded-lg border border-border p-2">
              <svg
                data-testid="map"
                viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
                role="img"
                aria-label={`Map of the app and the ${layout.nodes.length - 1} services it calls; the same data is in the table below`}
                className="h-auto w-full"
              >
                {layout.edges.map((e) => {
                  const level = errorLevel(e.errors, e.calls);
                  return (
                    <line
                      key={`${e.from}>${e.to}`}
                      data-testid="map-edge"
                      data-level={level}
                      x1={e.x1}
                      y1={e.y1}
                      x2={e.x2}
                      y2={e.y2}
                      strokeWidth={level === "none" ? 1.5 : 2.5}
                      className={EDGE_STROKE[level]}
                    />
                  );
                })}
                {layout.edges.map((e) => {
                  const level = errorLevel(e.errors, e.calls);
                  return (
                    <text
                      key={`${e.from}>${e.to}`}
                      data-testid="map-edge-label"
                      x={e.labelX}
                      y={e.labelY}
                      textAnchor="middle"
                      paintOrder="stroke"
                      strokeWidth={4}
                      className={cn(
                        "stroke-background text-[11px]",
                        EDGE_TEXT[level],
                      )}
                    >
                      <tspan x={e.labelX} dy="-0.3em">
                        {e.calls} calls
                      </tspan>
                      <tspan x={e.labelX} dy="1.3em">
                        p95 {formatDuration(e.p95Ms)} ·{" "}
                        {formatRate(e.errors, e.calls)} err
                      </tspan>
                    </text>
                  );
                })}
                {layout.nodes.map((n) => {
                  const Icon = ICONS[n.kind] ?? Box;
                  return (
                    <g
                      key={n.id}
                      data-testid="map-node"
                      data-kind={n.kind}
                      transform={`translate(${n.x - NODE_W / 2} ${n.y - NODE_H / 2})`}
                    >
                      <title>{`${n.name} (${KIND_LABEL[n.kind] ?? n.kind})`}</title>
                      <rect
                        width={NODE_W}
                        height={NODE_H}
                        rx={8}
                        strokeWidth={n.kind === "app" ? 2 : 1}
                        className={cn(
                          "stroke-border",
                          n.kind === "app"
                            ? "fill-primary stroke-primary"
                            : "fill-background",
                        )}
                      />
                      <Icon
                        x={10}
                        y={NODE_H / 2 - 9}
                        width={18}
                        height={18}
                        className={
                          n.kind === "app"
                            ? "stroke-primary-foreground"
                            : "stroke-foreground"
                        }
                        aria-hidden="true"
                      />
                      <text
                        x={36}
                        y={NODE_H / 2}
                        dominantBaseline="central"
                        className={cn(
                          "font-mono text-[12px]",
                          n.kind === "app"
                            ? "fill-primary-foreground"
                            : "fill-foreground",
                        )}
                      >
                        {truncate(n.name, 17)}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
            <div className="rounded-lg border border-border">
              <Table data-testid="map-edges">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Errors</TableHead>
                    <TableHead className="text-right">Error rate</TableHead>
                    <TableHead className="text-right">p50</TableHead>
                    <TableHead className="text-right">p95</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {layout.edges.map((e) => (
                    <TableRow
                      key={`${e.from}>${e.to}`}
                      data-testid="map-edge-row"
                    >
                      <TableCell className="font-mono">
                        {names.get(e.from)}
                      </TableCell>
                      <TableCell className="font-mono">
                        {names.get(e.to)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {e.calls}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono",
                          e.errors > 0 && "text-destructive",
                        )}
                      >
                        {e.errors}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatRate(e.errors, e.calls)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatDuration(e.p50Ms)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatDuration(e.p95Ms)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        ))}
    </section>
  );
}
