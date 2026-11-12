import type {
  DependencyStats,
  Insight,
  OverviewResponse,
  RouteStats,
  RuntimeSample,
  Slo,
} from "@nestrix-js/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CircleX,
  TriangleAlert,
} from "lucide-react";
import { useQueryStates } from "nuqs";
import { useMemo } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  getDependencies,
  getMeta,
  getOverview,
  getRouteCompare,
  getRoutes,
  getRuntime,
  getSlos,
} from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { routeWindowParser } from "@/lib/params";
import { useService } from "@/lib/service";
import { cn } from "@/lib/utils";
import {
  DONUT_RADIUS,
  Donut,
  LatencyChart,
  ScoreRing,
  ThroughputBars,
  TrendLine,
} from "@/views/overview/overview-charts";
import {
  apdexShares,
  buildKpis,
  donutSlices,
  formatChange,
  formatShare,
  formatShareChange,
  hasTraffic,
  insightChange,
  insightHref,
  type Kpi,
  rankRoutes,
  SEVERITY_LABEL,
  SOURCE_LABEL,
  STATUS_PARTS,
  TIME_KINDS,
  type Tone,
  toneOf,
} from "@/views/overview/overview-format";
import {
  describeMethod,
  describeRoute,
  formatErrorRate,
  routeKey,
} from "@/views/routes/route-stats";
import {
  formatPercent as formatCpuPercent,
  formatMemory,
  formatUptime,
} from "@/views/runtime/runtime-format";
import {
  budgetBarPercent,
  budgetState,
  formatPercent,
} from "@/views/slos/slo-format";

const WINDOWS = [15, 60] as const;
const DEFAULT_WINDOW = 15;

const SOURCE_STATS = "before sampling";
const SOURCE_TRACES = "from sampled traces";
const NOT_COVERED_HINT =
  "Comparisons start once a full previous window is kept.";

const levelStyle = {
  healthy: { label: "Healthy", color: "--success", Icon: CircleCheck },
  degraded: { label: "Degraded", color: "--warning", Icon: TriangleAlert },
  critical: { label: "Critical", color: "--destructive", Icon: CircleX },
} as const;

const toneText: Record<Tone, string> = {
  worse: "text-destructive",
  better: "text-success",
  neutral: "text-muted-foreground",
};
const toneColor: Record<Tone, string> = {
  worse: "--destructive",
  better: "--success",
  neutral: "--chart-1",
};

function Card({
  title,
  source,
  testId,
  className,
  children,
  aside,
}: {
  title: string;
  /** Where the figures come from; every card says. */
  source: string;
  testId: string;
  className?: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      aria-label={title}
      className={cn("space-y-3 rounded-lg border border-border p-4", className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p data-testid="source" className="text-xs text-muted-foreground">
            {source}
          </p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Delta({
  text,
  tone,
  title,
}: {
  text: string;
  tone: Tone;
  title?: string;
}) {
  const unknown = text === "—";
  return (
    <span
      data-testid="delta"
      data-tone={unknown ? "unknown" : tone}
      title={title}
      className={cn(
        "inline-flex items-center gap-0.5 whitespace-nowrap font-mono text-xs",
        unknown ? "text-muted-foreground" : toneText[tone],
      )}
    >
      {!unknown && tone === "worse" && (
        <ArrowUp className="size-3" aria-hidden />
      )}
      {!unknown && tone === "better" && (
        <ArrowDown className="size-3" aria-hidden />
      )}
      {text}
    </span>
  );
}

function HealthCard({ data }: { data: OverviewResponse }) {
  const { health } = data;
  const level = levelStyle[health.level];
  const top = data.attention[0];
  return (
    <section
      data-testid="health"
      data-level={health.level}
      aria-label="Health"
      className="flex flex-wrap items-center gap-6 rounded-lg border border-border p-5"
    >
      <ScoreRing
        score={health.score}
        color={level.color}
        label={`Health score ${health.score} of 100, ${level.label}`}
      />
      <div className="min-w-0 flex-1 basis-80 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-testid="health-level"
            className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium"
          >
            <level.Icon
              className="size-3.5"
              style={{ color: `var(${level.color})` }}
              aria-hidden
            />
            {level.label}
          </span>
          <span className="text-xs text-muted-foreground">
            compared with the previous {data.windowMinutes} minutes
          </span>
        </div>
        <p
          data-testid="health-summary"
          className="text-xl font-semibold leading-snug"
        >
          {health.summary}
        </p>
        <p className="text-xs text-muted-foreground">
          Score from route statistics ({SOURCE_STATS}) and what changed in
          sampled traces.
        </p>
      </div>
      {top && (
        <Link
          data-testid="investigate"
          to={insightHref(top.link) as "/"}
          className={buttonVariants({ size: "lg" })}
        >
          Investigate top issue
        </Link>
      )}
    </section>
  );
}

function InsightRow({
  insight,
  showSource,
}: {
  insight: Insight;
  showSource: boolean;
}) {
  const worse = insight.direction === "worse";
  const tone: Tone = worse ? "worse" : "better";
  return (
    <li data-testid="insight" data-kind={insight.kind}>
      <Link
        to={insightHref(insight.link) as "/"}
        className="flex items-center gap-3 border-t border-border py-3 hover:bg-muted/50"
      >
        <span
          data-testid="severity"
          data-severity={insight.severity}
          className={cn(
            "inline-flex h-5 w-16 shrink-0 items-center justify-center gap-0.5 rounded-full text-xs font-medium",
            // Words and an arrow carry the severity; the tint only adds to it.
            "text-foreground",
            insight.severity === "high" && "bg-destructive/20",
            insight.severity === "medium" && "bg-warning/25",
            insight.severity === "low" && "bg-success/20",
          )}
        >
          {worse ? (
            <ArrowUp className="size-3" aria-hidden />
          ) : (
            <ArrowDown className="size-3" aria-hidden />
          )}
          {SEVERITY_LABEL[insight.severity]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{insight.title}</span>
          <span className="block text-xs text-muted-foreground">
            {insight.detail}
            {showSource && ` · ${SOURCE_LABEL[insight.source]}`}
          </span>
        </span>
        <TrendLine
          values={insight.series}
          color={toneColor[tone]}
          label={`${insight.title}, trend over the window`}
        />
        <span
          data-testid="insight-change"
          className={cn(
            "w-16 shrink-0 text-right font-mono text-sm",
            toneText[tone],
          )}
        >
          {insightChange(insight)}
        </span>
      </Link>
    </li>
  );
}

function InsightsCard({
  title,
  testId,
  items,
  covered,
  note,
  emptyText,
}: {
  title: string;
  testId: string;
  items: Insight[];
  covered: boolean;
  note: string | null;
  emptyText: string;
}) {
  const sources = new Set(items.map((i) => i.source));
  const source =
    sources.size === 0
      ? `${SOURCE_STATS} and ${SOURCE_TRACES}`
      : sources.size === 2
        ? `${SOURCE_STATS} and ${SOURCE_TRACES}, labelled per row`
        : SOURCE_LABEL[[...sources][0] as Insight["source"]];
  return (
    <Card
      title={title}
      testId={testId}
      source={source}
      aside={
        <span
          data-testid="count"
          className="inline-flex h-5 items-center rounded-full bg-secondary px-2 text-xs font-medium"
        >
          {items.length}
        </span>
      }
    >
      {items.length === 0 ? (
        <p data-testid="empty" className="py-2 text-sm text-muted-foreground">
          {covered ? emptyText : NOT_COVERED_HINT}
          {!covered && note ? ` ${note}` : ""}
        </p>
      ) : (
        <ul>
          {items.map((insight) => (
            <InsightRow
              key={insight.id}
              insight={insight}
              showSource={sources.size === 2}
            />
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Compared with the previous window. Ranked by impact: requests affected
        times size of change.
      </p>
    </Card>
  );
}

function KpiTile({
  kpi,
  hint,
}: {
  kpi: Kpi;
  /** Shown as the tooltip of an unknown change. */
  hint: string | null;
}) {
  return (
    <div
      data-testid={`kpi-${kpi.id}`}
      className="flex flex-col gap-1 rounded-lg border border-border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{kpi.label}</span>
        <Delta text={kpi.delta} tone={kpi.tone} title={hint ?? undefined} />
      </div>
      <div className="flex items-baseline gap-1.5">
        <span data-testid="kpi-value" className="text-2xl font-semibold">
          {kpi.value}
        </span>
        <span className="text-xs text-muted-foreground">{kpi.unit}</span>
      </div>
      <TrendLine
        values={kpi.series}
        color={toneColor[kpi.tone]}
        label={`${kpi.label} over the window`}
        width={200}
        height={32}
        area
        stretch
      />
      <span className="text-xs text-muted-foreground">
        {kpi.source === "stats" ? SOURCE_STATS : SOURCE_TRACES}
      </span>
    </div>
  );
}

function slowestDependency(
  dependencies: readonly DependencyStats[],
): DependencyStats | null {
  let slowest: DependencyStats | null = null;
  for (const d of dependencies)
    if (d.calls > 0 && (slowest === null || d.p95Ms > slowest.p95Ms))
      slowest = d;
  return slowest;
}

function DependencyTile({ windowMinutes }: { windowMinutes: number }) {
  const [service] = useService();
  const [paused] = usePaused();
  const deps = useQuery({
    queryKey: ["overview", "dependencies", windowMinutes, service],
    queryFn: () => getDependencies({ windowMinutes, service }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const slowest = slowestDependency(deps.data?.dependencies ?? []);
  return (
    <div
      data-testid="kpi-dependency"
      className="flex flex-col gap-1 rounded-lg border border-border p-4"
    >
      <span className="text-xs text-muted-foreground">Slowest dependency</span>
      <div className="flex items-baseline gap-1.5">
        <span data-testid="kpi-value" className="text-2xl font-semibold">
          {slowest ? formatDuration(slowest.p95Ms).split(" ")[0] : "—"}
        </span>
        <span className="text-xs text-muted-foreground">
          {slowest ? `${formatDuration(slowest.p95Ms).split(" ")[1]} p95` : ""}
        </span>
      </div>
      <TrendLine
        values={slowest?.series.map((p) => p.p95Ms) ?? []}
        color="--chart-4"
        label={`${slowest?.name ?? "Dependency"} p95 over the window`}
        width={200}
        height={32}
        area
        stretch
      />
      <span className="truncate text-xs text-muted-foreground">
        {slowest ? slowest.name : "No outgoing calls"} · {SOURCE_TRACES}
      </span>
    </div>
  );
}

function LatencyCard({ data }: { data: OverviewResponse }) {
  return (
    <Card
      title="Latency percentiles"
      testId="card-latency"
      source={`All routes · route statistics (${SOURCE_STATS})`}
      className="lg:col-span-2"
      aside={
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <Legend
            color="--chart-1"
            text={`p50 ${formatDuration(data.totals.p50Ms)}`}
          />
          <Legend
            color="--warning"
            text={`p95 ${formatDuration(data.totals.p95Ms)}`}
          />
          <Legend
            color="--destructive"
            dashed
            text={`p99 ${formatDuration(data.totals.p99Ms)}`}
          />
          {data.previousCovered && (
            <Legend color="--muted-foreground" text="p95 previous window" />
          )}
        </div>
      }
    >
      <LatencyChart
        series={data.series}
        previousSeries={data.previousSeries}
        releases={data.releases}
        current={data.current}
      />
    </Card>
  );
}

function Legend({
  color,
  text,
  dashed = false,
}: {
  color: string;
  text: string;
  dashed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block w-3.5"
        style={{
          borderTop: `2px ${dashed ? "dashed" : "solid"} var(${color})`,
        }}
      />
      {text}
    </span>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-sm"
      style={{ background: `var(${color})` }}
    />
  );
}

function StatusCard({ data }: { data: OverviewResponse }) {
  const total = Object.values(data.status).reduce((a, b) => a + b, 0);
  const slices = donutSlices(
    STATUS_PARTS.map((p) => ({
      key: p.key,
      value: data.status[p.key],
      color: p.color,
    })),
    DONUT_RADIUS,
  );
  return (
    <Card
      title="Responses by status"
      testId="card-status"
      source={`${total.toLocaleString("en")} traced requests · ${SOURCE_TRACES}`}
    >
      <div className="flex flex-wrap items-center gap-6">
        <Donut
          slices={slices}
          testId="donut-status"
          label={`Responses by status class: ${STATUS_PARTS.map((p) => `${p.label} ${data.status[p.key]}`).join(", ")}`}
        >
          <span className="text-xl font-semibold">
            {total > 0 ? formatShare(data.status.ok / total) : "—"}
          </span>
          <span className="text-xs text-muted-foreground">success</span>
        </Donut>
        <ul className="min-w-36 flex-1 space-y-2 text-sm">
          {STATUS_PARTS.map((p) => (
            <li
              key={p.key}
              data-testid="status-row"
              data-key={p.key}
              className="flex items-center gap-2"
            >
              <Swatch color={p.color} />
              <span className="flex-1">{p.label}</span>
              <span className="font-mono">
                {total > 0 ? formatShare(data.status[p.key] / total) : "—"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function TimeCard({
  data,
  covered,
  note,
}: {
  data: OverviewResponse;
  covered: boolean;
  note: string | null;
}) {
  const parts = data.timeByKind.filter((t) => t.ms > 0);
  const slices = donutSlices(
    parts.map((t) => ({
      key: t.key,
      value: t.ms,
      color: TIME_KINDS[t.key].color,
    })),
    DONUT_RADIUS,
  );
  const biggest = [...parts].sort((a, b) => b.share - a.share)[0];
  return (
    <Card
      title="Where request time goes"
      testId="card-time"
      source={`Share of time in spans · ${SOURCE_TRACES}`}
    >
      {parts.length === 0 ? (
        <p data-testid="empty" className="text-sm text-muted-foreground">
          No sampled traces in this window.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          <Donut
            slices={slices}
            testId="donut-time"
            label={`Share of time by kind: ${parts.map((t) => `${TIME_KINDS[t.key].label} ${formatShare(t.share)}`).join(", ")}`}
          >
            <span className="text-xl font-semibold">
              {biggest ? formatShare(biggest.share) : "—"}
            </span>
            <span className="text-xs text-muted-foreground">
              {biggest
                ? `in ${TIME_KINDS[biggest.key].label.toLowerCase()}`
                : ""}
            </span>
          </Donut>
          <ul className="min-w-44 flex-1 space-y-2 text-sm">
            {parts.map((t) => {
              const change =
                t.previousShare === null ? null : t.share - t.previousShare;
              return (
                <li
                  key={t.key}
                  data-testid="time-row"
                  data-key={t.key}
                  className="flex items-center gap-2"
                >
                  <Swatch color={TIME_KINDS[t.key].color} />
                  <span className="flex-1">{TIME_KINDS[t.key].label}</span>
                  <span className="font-mono">{formatShare(t.share)}</span>
                  <span className="w-20 text-right">
                    <Delta
                      text={
                        covered
                          ? formatShareChange(t.share, t.previousShare)
                          : "—"
                      }
                      tone={toneOf(change, "up", 0.005)}
                      title={covered ? undefined : (note ?? undefined)}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

function ThroughputCard({ data }: { data: OverviewResponse }) {
  return (
    <Card
      title="Throughput and errors"
      testId="card-throughput"
      source={`Requests per ${Math.round(data.bucketMs / 60_000)} min · ${SOURCE_STATS}`}
    >
      <ThroughputBars series={data.series} />
      <div className="flex gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2.5 rounded-sm"
            style={{ background: "var(--chart-1)", opacity: 0.55 }}
          />
          Requests
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Swatch color="--destructive" />
          5xx and exceptions
        </span>
      </div>
    </Card>
  );
}

function ApdexCard({
  data,
  kpi,
}: {
  data: OverviewResponse;
  kpi: Kpi | undefined;
}) {
  const shares = apdexShares(data.totals);
  const t = data.apdexMs;
  const parts = [
    {
      key: "satisfied",
      label: "Satisfied",
      color: "--success",
      value: shares.satisfied,
    },
    {
      key: "tolerating",
      label: "Tolerating",
      color: "--warning",
      value: shares.tolerating,
    },
    {
      key: "frustrated",
      label: "Frustrated",
      color: "--destructive",
      value: shares.frustrated,
    },
  ] as const;
  return (
    <Card
      title="User experience (Apdex)"
      testId="card-apdex"
      source={`Target ${formatDuration(t)} · satisfied up to ${formatDuration(t)}, tolerating up to ${formatDuration(4 * t)} · ${SOURCE_STATS}`}
    >
      <div className="flex items-baseline gap-3">
        <span data-testid="apdex-value" className="text-4xl font-semibold">
          {data.totals.apdex === null ? "—" : data.totals.apdex.toFixed(2)}
        </span>
        {kpi && <Delta text={kpi.delta} tone={kpi.tone} />}
      </div>
      <div
        role="img"
        aria-label={parts
          .map((p) => `${formatShare(p.value)} ${p.label.toLowerCase()}`)
          .join(", ")}
        data-testid="apdex-bar"
        className="flex h-3.5 overflow-hidden rounded-full bg-muted"
      >
        {parts.map((p) => (
          <div
            key={p.key}
            data-part={p.key}
            style={{
              width: `${p.value * 100}%`,
              background: `var(${p.color})`,
            }}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {parts.map((p) => (
          <div key={p.key} data-testid={`apdex-${p.key}`}>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Swatch color={p.color} />
              {p.label}
            </div>
            <div className="font-mono text-lg">{formatShare(p.value)}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RoutesCard({
  windowMinutes,
  covered,
}: {
  windowMinutes: number;
  covered: boolean;
}) {
  const [service] = useService();
  const [paused] = usePaused();
  const compare = useQuery({
    queryKey: ["routes", "compare", "window", windowMinutes, service],
    queryFn: () => getRouteCompare({ windowMinutes, previous: 1, service }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const stats = useQuery({
    queryKey: ["routes", "stats", windowMinutes, service],
    queryFn: () => getRoutes({ windowMinutes, service }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const series = useMemo(() => {
    const map = new Map<string, RouteStats>();
    for (const r of stats.data?.routes ?? []) map.set(routeKey(r), r);
    return map;
  }, [stats.data]);
  const ranked = useMemo(
    () =>
      compare.data?.mode === "window"
        ? rankRoutes(compare.data.routes).slice(0, 7)
        : [],
    [compare.data],
  );
  const maxP95 = Math.max(1, ...ranked.map((r) => r.row.after.p95Ms));
  return (
    <Card
      title="Routes"
      testId="card-routes"
      source={`Sorted by impact: requests times change in p95 · ${SOURCE_STATS}`}
      aside={
        <Link
          to="/routes"
          className="text-xs underline"
          data-testid="all-routes"
        >
          All routes
        </Link>
      }
    >
      {ranked.length === 0 ? (
        <p data-testid="empty" className="text-sm text-muted-foreground">
          No routes with requests in this window.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-2 pr-2 font-medium">Route</th>
                <th className="px-2 font-medium">Req/min</th>
                <th className="px-2 font-medium">p95</th>
                <th className="px-2 font-medium">Errors</th>
                <th className="px-2 font-medium">Trend</th>
                <th className="pl-2 text-right font-medium">vs previous</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map(({ row, change }) => {
                const key = routeKey(row);
                const { label } = describeRoute(row);
                const tone = toneOf(covered ? change : null, "up", 0.02);
                const errTone = toneOf(
                  covered && row.before.count > 0 ? row.delta.errorRate : null,
                  "up",
                  0.001,
                );
                return (
                  <tr
                    key={key}
                    data-testid="overview-route"
                    className="border-t border-border"
                  >
                    <td className="py-2 pr-2 font-mono">
                      <Link
                        to={
                          `/routes?method=${encodeURIComponent(row.method)}&route=${encodeURIComponent(row.route)}` as "/"
                        }
                        className="hover:underline"
                      >
                        <span className="mr-2 text-muted-foreground">
                          {describeMethod(row.method)}
                        </span>
                        {label}
                      </Link>
                    </td>
                    <td className="px-2 font-mono">
                      {(row.after.count / windowMinutes).toFixed(1)}
                    </td>
                    <td className="px-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-muted">
                          <div
                            data-testid="p95-bar"
                            className="h-1.5 rounded-full"
                            style={{
                              width: `${Math.max(2, (row.after.p95Ms / maxP95) * 100)}%`,
                              background: `var(${toneColor[tone === "neutral" ? "neutral" : tone]})`,
                            }}
                          />
                        </div>
                        <span className="w-16 text-right font-mono">
                          {formatDuration(row.after.p95Ms)}
                        </span>
                      </div>
                    </td>
                    <td className="px-2">
                      <span
                        className={cn(
                          "font-mono text-xs",
                          errTone === "worse" && "text-destructive",
                        )}
                      >
                        {formatErrorRate(row.after.errors, row.after.count)}
                      </span>
                    </td>
                    <td className="px-2">
                      <TrendLine
                        values={(series.get(key)?.series ?? []).map(
                          (p) => p.p95Ms ?? 0,
                        )}
                        color={toneColor[tone]}
                        label={`${key} p95 over the window`}
                        width={96}
                        height={24}
                      />
                    </td>
                    <td className="pl-2 text-right">
                      <Delta
                        text={covered ? formatChange(change) : "—"}
                        tone={tone}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function SlosCard() {
  const [paused] = usePaused();
  const slos = useQuery({
    queryKey: ["overview", "slos"],
    queryFn: getSlos,
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
  });
  const list: Slo[] = (slos.data?.slos ?? []).slice(0, 3);
  if (!slos.data || list.length === 0) return null;
  const r = 38;
  const circumference = 2 * Math.PI * r;
  return (
    <Card
      title="Error budgets"
      testId="card-slos"
      source={`SLOs of the standalone server · ${SOURCE_TRACES}`}
      aside={
        <Link to="/slos" className="text-xs underline">
          All SLOs
        </Link>
      }
    >
      <div className="grid grid-cols-3 gap-3">
        {list.map((slo) => {
          const left = slo.status.errorBudget.remainingFraction;
          const state = budgetState(left);
          const color =
            state === "spent"
              ? "--destructive"
              : state === "low"
                ? "--warning"
                : "--success";
          const filled = (budgetBarPercent(left) / 100) * circumference;
          return (
            <div
              key={slo.id}
              data-testid="slo-ring"
              data-state={state}
              className="flex flex-col items-center gap-1 text-center"
            >
              <div className="relative size-24">
                <svg
                  viewBox="0 0 96 96"
                  className="size-24 -rotate-90"
                  role="img"
                  aria-label={`${slo.name}: ${left === null ? "no requests" : `${formatPercent(Math.max(0, left))} of the error budget left`}`}
                >
                  <circle
                    cx="48"
                    cy="48"
                    r={r}
                    fill="none"
                    stroke="var(--muted)"
                    strokeWidth="9"
                  />
                  <circle
                    cx="48"
                    cy="48"
                    r={r}
                    fill="none"
                    stroke={`var(${color})`}
                    strokeWidth="9"
                    strokeLinecap="round"
                    strokeDasharray={`${filled.toFixed(2)} ${(circumference - filled).toFixed(2)}`}
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold">
                  {left === null ? "—" : formatPercent(Math.max(0, left))}
                </span>
              </div>
              <span className="text-xs font-medium">{slo.name}</span>
              <span className="text-xs text-muted-foreground">
                {state === "spent"
                  ? "budget spent"
                  : state === "none"
                    ? "no requests"
                    : "budget left"}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function RuntimeCard() {
  const [paused] = usePaused();
  const runtime = useQuery({
    queryKey: ["overview", "runtime"],
    queryFn: getRuntime,
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
  });
  const current: RuntimeSample | null = runtime.data?.current ?? null;
  if (!runtime.data) return null;
  const cpu = current
    ? current.cpuUserPercent + current.cpuSystemPercent
    : null;
  const rows: { id: string; label: string; value: string; fraction: number }[] =
    current
      ? [
          {
            id: "cpu",
            label: "CPU",
            value: formatCpuPercent(cpu ?? 0),
            fraction: Math.min(1, (cpu ?? 0) / 100),
          },
          {
            id: "heap",
            label: "Heap",
            value: formatMemory(current.heapUsedBytes),
            fraction:
              current.heapTotalBytes > 0
                ? current.heapUsedBytes / current.heapTotalBytes
                : 0,
          },
          {
            id: "loop",
            label: "Loop p99",
            value:
              current.eventLoopP99Ms === null
                ? "—"
                : formatDuration(current.eventLoopP99Ms),
            fraction: Math.min(1, (current.eventLoopP99Ms ?? 0) / 100),
          },
        ]
      : [];
  return (
    <Card
      title="Runtime"
      testId="card-runtime"
      source={`This process, latest sample · up ${formatUptime(runtime.data.process.uptimeSeconds)}`}
      aside={
        <Link to="/runtime" className="text-xs underline">
          Runtime
        </Link>
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sample yet.</p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {rows.map((row) => (
            <div key={row.id} data-testid={`runtime-${row.id}`}>
              <div className="text-xs text-muted-foreground">
                {row.label} {row.value}
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-muted">
                <div
                  className="h-1.5 rounded-full"
                  style={{
                    width: `${Math.max(2, row.fraction * 100)}%`,
                    background: `var(${row.fraction > 0.8 ? "--warning" : "--chart-1"})`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function EmptyState({ windowMinutes }: { windowMinutes: number }) {
  return (
    <section
      data-testid="overview-empty"
      aria-label="No requests"
      className="space-y-2 rounded-lg border border-dashed border-border p-10 text-center"
    >
      <p className="text-lg font-semibold">
        No requests in the last {windowMinutes} minutes
      </p>
      <p className="text-sm text-muted-foreground">
        Send some traffic to the application and the health score, what changed
        and the charts appear here. Try the 60 minute window if it was quiet
        just now.
      </p>
    </section>
  );
}

export function OverviewPage() {
  const [query, setQuery] = useQueryStates({
    windowMinutes: routeWindowParser,
  });
  const windowMinutes = query.windowMinutes ?? DEFAULT_WINDOW;
  const [service] = useService();
  const [paused] = usePaused();
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const overview = useQuery({
    queryKey: ["overview", windowMinutes, service],
    queryFn: () => getOverview({ windowMinutes, service }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const data = overview.data;
  const kpis = useMemo(() => (data ? buildKpis(data) : []), [data]);
  const standalone = meta.data?.mode === "standalone";
  const runtimeOn = meta.data?.runtime?.available === true;

  return (
    <section className="space-y-4" aria-label="Overview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Overview</h2>
        <fieldset className="flex items-center gap-1" aria-label="Time window">
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
      </div>

      {overview.isError && !data && (
        <div
          role="alert"
          data-testid="overview-error"
          className="space-y-2 rounded-lg border border-destructive/40 p-4 text-sm"
        >
          <p>The overview could not be loaded.</p>
          <Button variant="outline" onClick={() => void overview.refetch()}>
            Retry
          </Button>
        </div>
      )}

      {!data && overview.isPending && (
        <p
          data-testid="overview-loading"
          className="py-8 text-center text-sm text-muted-foreground"
        >
          Loading the overview...
        </p>
      )}

      {data && !hasTraffic(data) && (
        <EmptyState windowMinutes={data.windowMinutes} />
      )}

      {data && hasTraffic(data) && (
        <>
          {!data.previousCovered && (
            <p
              data-testid="uncovered-note"
              className="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground"
            >
              {NOT_COVERED_HINT}
              {data.note ? ` ${data.note}` : ""}
            </p>
          )}
          <HealthCard data={data} />
          <div className="grid gap-4 lg:grid-cols-2">
            <InsightsCard
              title="Needs attention"
              testId="card-attention"
              items={data.attention}
              covered={data.previousCovered}
              note={data.note}
              emptyText="Nothing needs attention."
            />
            <InsightsCard
              title="Getting better"
              testId="card-better"
              items={data.better}
              covered={data.previousCovered}
              note={data.note}
              emptyText="Nothing got noticeably better."
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {kpis.map((kpi) => (
              <KpiTile
                key={kpi.id}
                kpi={kpi}
                hint={data.previousCovered ? null : data.note}
              />
            ))}
            <DependencyTile windowMinutes={windowMinutes} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <LatencyCard data={data} />
            <StatusCard data={data} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <TimeCard
              data={data}
              covered={data.previousCovered}
              note={data.note}
            />
            <ThroughputCard data={data} />
            <ApdexCard data={data} kpi={kpis.find((k) => k.id === "apdex")} />
          </div>
          <RoutesCard
            windowMinutes={windowMinutes}
            covered={data.previousCovered}
          />
          {(standalone || runtimeOn) && (
            <div className="grid gap-4 lg:grid-cols-2">
              {standalone && <SlosCard />}
              {!standalone && runtimeOn && <RuntimeCard />}
            </div>
          )}
        </>
      )}
    </section>
  );
}
