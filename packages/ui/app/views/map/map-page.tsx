import type { MapNodeKind } from "@nestrix-js/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
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
import { useMemo, useState } from "react";

import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton";
import { BarCell } from "@/components/kit/bar-cell";
import { Chip } from "@/components/kit/chip";
import type { ChipTone } from "@/components/kit/format";
import { PageHeader } from "@/components/kit/page-header";
import { Section } from "@/components/kit/section";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { SkeletonChart, SkeletonKpiStrip } from "@/components/kit/skeletons";
import { KpiStrip, StatTile } from "@/components/kit/stat-tile";
import { EmptyState, ErrorState } from "@/components/kit/states";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getMap, getMeta } from "@/lib/api";
import { formatDuration, STANDALONE_STATISTICS_NOTE } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { routeWindowParser } from "@/lib/params";
import { useService } from "@/lib/service";
import { cn } from "@/lib/utils";
import {
  type ErrorLevel,
  edgesOf,
  edgeWidth,
  errorLevel,
  formatRate,
  HEALTH,
  HEALTH_LABEL,
  type Health,
  layoutMap,
  MAP_HEIGHT,
  MAP_WIDTH,
  type NodeStats,
  nodeStats,
  type PlacedNode,
  truncate,
} from "@/views/map/map-layout";

const WINDOWS = [
  { value: 15, label: "15 min" },
  { value: 60, label: "60 min" },
] as const;
const DEFAULT_WINDOW = 15;
const parsers = { windowMinutes: routeWindowParser };
const NO_PREVIOUS = "The map does not compare with a previous window.";
const SOURCE = "from sampled traces";

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
  low: "fill-destructive-text",
  high: "fill-destructive-text",
};
const HEALTH_STROKE: Record<Health, string> = {
  ok: "stroke-success",
  degraded: "stroke-warning",
  failing: "stroke-destructive",
  idle: "stroke-border",
};
const HEALTH_TONE: Record<Health, ChipTone> = {
  ok: "better",
  degraded: "warn",
  failing: "worse",
  idle: "neutral",
};
const HEALTH_DOT: Record<Health, string> = {
  ok: "bg-success",
  degraded: "bg-warning",
  failing: "bg-destructive",
  idle: "bg-muted-foreground",
};

const NODE_W = 160;
const NODE_H = 52;

const thousands = (n: number) => n.toLocaleString("en");

function HealthChip({ health }: { health: Health }) {
  return (
    <Chip tone={HEALTH_TONE[health]} data-health={health}>
      {HEALTH_LABEL[health]}
    </Chip>
  );
}

/** Where a node's own page is: the dependency, queries or routes view of what it stands for. */
function nodeLinks(
  node: PlacedNode,
  windowMinutes: number,
): { label: string; href: string }[] {
  const dependency = {
    label: "Open in Dependencies",
    href: `/dependencies?windowMinutes=${windowMinutes}&name=${encodeURIComponent(node.name)}`,
  };
  switch (node.kind) {
    case "app":
      return [
        { label: "Routes", href: `/routes?windowMinutes=${windowMinutes}` },
        { label: "Classes", href: `/classes?windowMinutes=${windowMinutes}` },
      ];
    case "database":
      return [
        dependency,
        { label: "Queries", href: `/queries?windowMinutes=${windowMinutes}` },
      ];
    default:
      return [dependency];
  }
}

function NodePanel({
  node,
  stats,
  edges,
  names,
  windowMinutes,
}: {
  node: PlacedNode | undefined;
  stats: NodeStats | undefined;
  edges: ReturnType<typeof edgesOf>;
  names: ReadonlyMap<string, string>;
  windowMinutes: number;
}) {
  if (!node || !stats)
    return (
      <p
        data-testid="map-panel-empty"
        className="py-6 text-center text-sm text-muted-foreground"
      >
        Select a node in the drawing or in the list to see its calls, errors and
        latency.
      </p>
    );
  const Icon = ICONS[node.kind] ?? Box;
  return (
    <div data-testid="map-panel" className="space-y-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted [&_svg]:size-5"
        >
          <Icon />
        </span>
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-semibold">
            {node.name}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Chip>{KIND_LABEL[node.kind] ?? node.kind}</Chip>
            <HealthChip health={stats.health} />
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">
            {stats.direction === "in" ? "Calls into it" : "Calls it makes"}
          </dt>
          <dd className="font-mono">{thousands(stats.calls)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Errors</dt>
          <dd className="font-mono">
            {thousands(stats.errors)}{" "}
            <span className="text-muted-foreground">
              ({formatRate(stats.errors, stats.calls)})
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">p50</dt>
          <dd className="font-mono">{formatDuration(stats.p50Ms)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">p95</dt>
          <dd className="font-mono">{formatDuration(stats.p95Ms)}</dd>
        </div>
      </dl>
      {edges.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
            Connections
          </h4>
          <ul className="space-y-1.5 text-sm">
            {edges.map((e) => {
              const outgoing = e.from === node.id;
              const other = names.get(outgoing ? e.to : e.from) ?? "";
              return (
                <li
                  key={`${e.from}>${e.to}`}
                  data-testid="map-panel-edge"
                  className="flex items-center gap-2"
                >
                  <ArrowRight
                    aria-label={outgoing ? "calls" : "called by"}
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground",
                      !outgoing && "rotate-180",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {other}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {thousands(e.calls)} · {formatDuration(e.p95Ms)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {nodeLinks(node, windowMinutes).map((l) => (
          <Link
            key={l.href}
            to={l.href as "/"}
            data-testid="map-panel-link"
            className="underline underline-offset-4"
          >
            {l.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function MapPage() {
  const [query, setQuery] = useQueryStates(parsers);
  const windowMinutes = query.windowMinutes ?? DEFAULT_WINDOW;
  const [paused] = usePaused();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [service] = useService();
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const standalone = meta.data?.mode === "standalone";

  const map = useQuery({
    queryKey: ["map", windowMinutes, service],
    queryFn: () => getMap({ windowMinutes, service }),
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
  const stats = useMemo(
    () =>
      new Map(layout.nodes.map((n) => [n.id, nodeStats(n.id, layout.edges)])),
    [layout],
  );
  const maxCalls = Math.max(1, ...layout.edges.map((e) => e.calls));
  const serviceCount = layout.nodes.filter((n) => n.kind === "app").length;
  const shownWindow = map.data?.windowMinutes ?? windowMinutes;
  const selected = layout.nodes.find((n) => n.id === selectedId);
  const toggle = (id: string) =>
    setSelectedId((current) => (current === id ? null : id));

  const totals = useMemo(() => {
    const calls = layout.edges.reduce((n, e) => n + e.calls, 0);
    const errors = layout.edges.reduce((n, e) => n + e.errors, 0);
    const slowest = [...layout.edges].sort((a, b) => b.p95Ms - a.p95Ms)[0];
    return { calls, errors, slowest };
  }, [layout]);
  const slowestParts = totals.slowest
    ? formatDuration(totals.slowest.p95Ms).split(" ")
    : null;
  const targets = layout.nodes.filter((n) => n.kind !== "app").length;

  return (
    <section className="space-y-6" aria-label="Map">
      <PageHeader
        title="Map"
        description="The app and everything it calls, by health"
        source="traces"
        controls={
          <>
            <SegmentedControl
              label="Time window"
              options={WINDOWS}
              value={windowMinutes}
              onChange={(minutes) =>
                void setQuery({
                  windowMinutes: minutes === DEFAULT_WINDOW ? null : minutes,
                })
              }
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label="Reload"
              onClick={() => void map.refetch()}
            >
              <RefreshCw />
              Reload
            </Button>
          </>
        }
      />
      <p
        data-testid="map-note"
        className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
      >
        The map is built from sampled traces: calls, error rates and percentiles
        describe the traces in the store, not every call.
        {standalone && ` ${STANDALONE_STATISTICS_NOTE}`}
      </p>

      {map.isPending && (
        <>
          <SkeletonKpiStrip />
          <SkeletonChart heightClass="h-72" />
          <DataTableSkeleton columnCount={7} />
        </>
      )}
      {map.isError && map.data === undefined && (
        <ErrorState
          title="Could not load the map."
          message={map.error?.message}
          onRetry={() => void map.refetch()}
        />
      )}

      {map.data !== undefined &&
        (layout.edges.length === 0 ? (
          <EmptyState
            testId="map-empty"
            title={`No calls to other services in the last ${shownWindow} minutes.`}
          >
            Calls to databases, caches, queues and other services appear here as
            the app makes them.
          </EmptyState>
        ) : (
          <>
            <KpiStrip>
              <StatTile
                testId="kpi-nodes"
                label={serviceCount > 1 ? "Services" : "Called by the app"}
                value={String(serviceCount > 1 ? serviceCount : targets)}
                unit={
                  serviceCount > 1
                    ? `and ${targets} they call`
                    : "databases, caches and services"
                }
                delta="—"
                deltaTitle={NO_PREVIOUS}
                source={SOURCE}
              />
              <StatTile
                testId="kpi-calls"
                label="Calls"
                value={thousands(totals.calls)}
                unit={`in ${shownWindow} min`}
                delta="—"
                deltaTitle={NO_PREVIOUS}
                source={SOURCE}
              />
              <StatTile
                testId="kpi-error-rate"
                label="Error rate"
                value={formatRate(totals.errors, totals.calls)}
                unit={`${thousands(totals.errors)} of ${thousands(totals.calls)}`}
                delta="—"
                deltaTitle={NO_PREVIOUS}
                source={SOURCE}
              />
              <StatTile
                testId="kpi-slowest-edge"
                label="Slowest call"
                value={slowestParts?.[0] ?? "—"}
                unit={slowestParts ? `p95 ${slowestParts[1]}` : undefined}
                footer={
                  totals.slowest ? (
                    <span
                      className="truncate font-mono text-xs"
                      title={`${names.get(totals.slowest.from)} to ${names.get(totals.slowest.to)}`}
                    >
                      {names.get(totals.slowest.to)}
                    </span>
                  ) : undefined
                }
                source={SOURCE}
              />
            </KpiStrip>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <Section
                testId="card-graph"
                title="Call graph"
                description="Line width is call volume; select a node for its numbers"
                source={SOURCE}
              >
                <div className="overflow-x-auto rounded-md border border-border/60">
                  <svg
                    data-testid="map"
                    viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
                    role="img"
                    aria-label={
                      serviceCount > 1
                        ? `Map of ${serviceCount} services and what they call; the same data is in the table below`
                        : `Map of the app and the ${layout.nodes.length - 1} services it calls; the same data is in the table below`
                    }
                    className="h-auto w-full min-w-[36rem]"
                  >
                    {layout.edges.map((e) => {
                      const level = errorLevel(e.errors, e.calls);
                      return (
                        <line
                          key={`${e.from}>${e.to}`}
                          data-testid="map-edge"
                          data-level={level}
                          data-service-edge={e.serviceToService}
                          data-calls={e.calls}
                          x1={e.x1}
                          y1={e.y1}
                          x2={e.x2}
                          y2={e.y2}
                          strokeWidth={edgeWidth(e.calls, maxCalls)}
                          strokeDasharray={
                            e.serviceToService ? "6 4" : undefined
                          }
                          strokeLinecap="round"
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
                      const s = stats.get(n.id);
                      const health = s?.health ?? "idle";
                      const isApp = n.kind === "app";
                      const active = n.id === selectedId;
                      return (
                        // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
                        <g
                          key={n.id}
                          role="button"
                          tabIndex={0}
                          aria-pressed={active}
                          data-testid="map-node"
                          data-kind={n.kind}
                          data-health={health}
                          data-selected={active}
                          transform={`translate(${n.x - NODE_W / 2} ${n.y - NODE_H / 2})`}
                          onClick={() => toggle(n.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggle(n.id);
                            }
                          }}
                          className="cursor-pointer"
                        >
                          <title>{`${n.name} (${KIND_LABEL[n.kind] ?? n.kind}, ${HEALTH_LABEL[health]})`}</title>
                          {active && (
                            <rect
                              x={-4}
                              y={-4}
                              width={NODE_W + 8}
                              height={NODE_H + 8}
                              rx={11}
                              strokeWidth={2}
                              strokeDasharray="4 3"
                              className="fill-none stroke-foreground"
                            />
                          )}
                          <rect
                            width={NODE_W}
                            height={NODE_H}
                            rx={8}
                            strokeWidth={2.5}
                            className={cn(
                              HEALTH_STROKE[health],
                              isApp ? "fill-primary" : "fill-background",
                            )}
                          />
                          <Icon
                            x={10}
                            y={NODE_H / 2 - 9}
                            width={18}
                            height={18}
                            className={
                              isApp
                                ? "stroke-primary-foreground"
                                : "stroke-foreground"
                            }
                            aria-hidden="true"
                          />
                          <text
                            x={36}
                            y={19}
                            dominantBaseline="central"
                            className={cn(
                              "font-mono text-[12px]",
                              isApp
                                ? "fill-primary-foreground"
                                : "fill-foreground",
                            )}
                          >
                            {truncate(n.name, 17)}
                          </text>
                          <text
                            x={36}
                            y={37}
                            dominantBaseline="central"
                            className={cn(
                              "text-[10px]",
                              isApp
                                ? "fill-primary-foreground"
                                : "fill-muted-foreground",
                            )}
                          >
                            {HEALTH_LABEL[health]}
                            {s &&
                              s.calls > 0 &&
                              ` · ${thousands(s.calls)} calls`}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>

                <div
                  data-testid="map-legend"
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"
                >
                  <span className="font-medium text-foreground">Health</span>
                  {(["ok", "degraded", "failing", "idle"] as const).map((h) => (
                    <span key={h} className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className={cn("size-2.5 rounded-full", HEALTH_DOT[h])}
                      />
                      {HEALTH_LABEL[h]}
                    </span>
                  ))}
                  <span>
                    failing from {HEALTH.failingErrorRate * 100}% errors or p95{" "}
                    {formatDuration(HEALTH.failingP95Ms)}; degraded on any error
                    or p95 {formatDuration(HEALTH.degradedP95Ms)}
                  </span>
                  <span>Dashed line: service to service</span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-xs font-medium">Inspect</span>
                  {layout.nodes.map((n) => {
                    const health = stats.get(n.id)?.health ?? "idle";
                    return (
                      <button
                        key={n.id}
                        type="button"
                        data-testid="map-node-button"
                        aria-pressed={n.id === selectedId}
                        onClick={() => toggle(n.id)}
                        className={cn(
                          "inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 font-mono text-xs transition-colors hover:bg-muted",
                          n.id === selectedId && "bg-muted",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "size-2 rounded-full",
                            HEALTH_DOT[health],
                          )}
                        />
                        {n.name}
                        <span className="sr-only">
                          {" "}
                          ({HEALTH_LABEL[health]})
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Section>

              <Section
                testId="card-node"
                title="Node details"
                description="The numbers of the selected node"
                source={SOURCE}
              >
                <NodePanel
                  node={selected}
                  stats={selected ? stats.get(selected.id) : undefined}
                  edges={selected ? edgesOf(selected.id, layout.edges) : []}
                  names={names}
                  windowMinutes={windowMinutes}
                />
              </Section>
            </div>

            <Section
              testId="card-edges"
              title="Calls between nodes"
              description="The same edges as the drawing, as numbers"
              source={SOURCE}
              flush
            >
              <Table
                data-testid="map-edges"
                containerClassName="max-h-[70vh]"
                className="min-w-[40rem]"
              >
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
                      <TableCell>
                        <BarCell
                          value={e.calls}
                          max={maxCalls}
                          label={String(e.calls)}
                        />
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono",
                          e.errors > 0 && "text-destructive-text",
                        )}
                      >
                        {e.errors}
                      </TableCell>
                      <TableCell className="text-right">
                        <Chip
                          tone={e.errors > 0 ? "worse" : "neutral"}
                          className="font-mono"
                        >
                          {formatRate(e.errors, e.calls)}
                        </Chip>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatDuration(e.p50Ms)}
                      </TableCell>
                      <TableCell>
                        <BarCell
                          value={e.p95Ms}
                          max={Math.max(1, ...layout.edges.map((x) => x.p95Ms))}
                          label={formatDuration(e.p95Ms)}
                          color="--chart-2"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
          </>
        ))}
    </section>
  );
}
