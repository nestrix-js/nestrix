import type {
  ErrorGroup,
  ErrorGroupsResponse,
  ErrorInsightsResponse,
} from "@nestrix-js/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type * as React from "react";
import { useMemo, useState } from "react";

import { DataTableSkeleton } from "@/components/data-table/data-table-skeleton";
import { AreaChart } from "@/components/kit/area-chart";
import { BarCell } from "@/components/kit/bar-cell";
import { BarChart } from "@/components/kit/bar-chart";
import { Chip } from "@/components/kit/chip";
import {
  DONUT_RADIUS,
  Donut,
  DonutLegend,
  Swatch,
} from "@/components/kit/donut";
import { donutSlices } from "@/components/kit/format";
import { Heatmap } from "@/components/kit/heatmap";
import { PageHeader } from "@/components/kit/page-header";
import { Section } from "@/components/kit/section";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { SkeletonChart, SkeletonKpiStrip } from "@/components/kit/skeletons";
import { Sparkline } from "@/components/kit/sparkline";
import { KpiStrip, StatTile } from "@/components/kit/stat-tile";
import { EmptyState, ErrorState } from "@/components/kit/states";
import { RelativeTimeCard } from "@/components/relative-time-card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getErrorGroups, getErrorInsights } from "@/lib/api";
import { pollInterval, usePaused } from "@/lib/live";
import { useService } from "@/lib/service";
import {
  bucketTotals,
  type GroupState,
  groupState,
  HOURS,
  NO_TYPE,
  OTHER_COLOR,
  peakCell,
  percentOf,
  releaseBars,
  releaseText,
  routeBreakdown,
  STATE_LABEL,
  STATE_ORDER,
  STATE_TITLE,
  totalEvents,
  typeBreakdown,
  WEEKDAYS,
} from "@/views/errors/errors-stats";

const WINDOWS = [
  { value: 15, label: "15 min" },
  { value: 60, label: "60 min" },
] as const;
const COLUMNS = 8;
const SOURCE = "from sampled traces";
const NO_PREVIOUS =
  "The error groups API does not compare with a previous window.";
// The API returns at most 100 groups; a full list may hide the tail.
const GROUP_CAP = 100;

const STATE_TONE = {
  new: "worse",
  regressed: "warn",
  ongoing: "info",
  quiet: "neutral",
} as const;

const countText = (n: number) => n.toLocaleString("en");

function GroupRow({
  group,
  state,
  color,
  max,
  windowMinutes,
}: {
  group: ErrorGroup;
  state: GroupState;
  color: string;
  max: number;
  windowMinutes: number;
}) {
  const [open, setOpen] = useState(false);
  const detailId = `error-group-${group.exampleTraceId}`;
  const shown = group.pattern || group.latestMessage || "-";
  const release = releaseText(group);
  return (
    <>
      <TableRow
        data-testid="error-group-row"
        className="cursor-pointer"
        onClick={(event) => {
          // A click on the button or a link belongs to that control.
          if ((event.target as Element).closest("a, button")) return;
          setOpen(!open);
        }}
      >
        <TableCell className="max-w-md">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            title={open ? "Hide the occurrences" : "Show the occurrences"}
            onClick={() => setOpen(!open)}
            className="flex w-full items-start gap-1 text-left"
          >
            {open ? (
              <ChevronDown
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
            ) : (
              <ChevronRight
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
            )}
            <span className="min-w-0">
              <span className="flex items-center gap-2 font-mono">
                <Swatch color={color} />
                <span className="truncate">{group.errorType ?? "-"}</span>
              </span>
              <span
                className="block truncate text-xs text-muted-foreground"
                data-testid="group-pattern"
              >
                {shown}
              </span>
            </span>
          </button>
        </TableCell>
        <TableCell>
          <Chip tone={STATE_TONE[state]} title={STATE_TITLE[state]}>
            {STATE_LABEL[state]}
          </Chip>
        </TableCell>
        <TableCell data-testid="group-count">
          <BarCell
            value={group.count}
            max={max}
            label={countText(group.count)}
            color="--destructive"
          />
        </TableCell>
        <TableCell>
          <Sparkline
            values={group.series}
            label={`${group.count} in the last ${windowMinutes} minutes`}
          />
        </TableCell>
        <TableCell>
          {group.route ? (
            <span className="font-mono text-xs">{group.route}</span>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </TableCell>
        <TableCell>
          <RelativeTimeCard timeUnixMs={group.firstSeenUnixMs} />
        </TableCell>
        <TableCell>
          <RelativeTimeCard timeUnixMs={group.lastSeenUnixMs} />
        </TableCell>
        <TableCell data-testid="group-release">
          {release === undefined ? (
            <span className="text-muted-foreground">-</span>
          ) : (
            <span className="font-mono text-xs" title={releasesTitle(group)}>
              {release}
            </span>
          )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow
          className="hover:bg-transparent"
          data-testid="error-group-detail"
        >
          <TableCell id={detailId} colSpan={COLUMNS} className="bg-muted/30">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {group.services.length > 0 &&
                  `Services: ${group.services.join(", ")}`}
              </span>
              {group.errorType !== undefined && (
                <Link
                  to={
                    `/errors?view=all&type=${encodeURIComponent(group.errorType)}` as "/"
                  }
                  className="underline-offset-4 hover:underline"
                >
                  Every event of this type
                </Link>
              )}
            </div>
            <p className="mb-1 text-xs text-muted-foreground">
              Recent occurrences (latest {group.recent.length} of {group.count})
            </p>
            <ul className="space-y-1">
              {group.recent.map((o) => (
                <li
                  key={`${o.traceId}-${o.spanId}`}
                  data-testid="group-occurrence"
                  className="flex flex-wrap items-baseline gap-x-3 text-sm"
                >
                  <RelativeTimeCard timeUnixMs={o.timeUnixMs} />
                  {o.service && (
                    <span className="text-xs text-muted-foreground">
                      {o.service}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {o.message ?? "-"}
                  </span>
                  <Link
                    to="/traces/$traceId"
                    params={{ traceId: o.traceId }}
                    title={o.traceId}
                    className="underline-offset-4 hover:underline"
                  >
                    View trace
                  </Link>
                </li>
              ))}
            </ul>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function Charts({ data }: { data: ErrorGroupsResponse }) {
  const types = useMemo(() => typeBreakdown(data.groups), [data.groups]);
  const routes = useMemo(() => routeBreakdown(data.groups), [data.groups]);
  const total = totalEvents(data.groups);
  const buckets = bucketTotals(data.groups);
  const peak = Math.max(0, ...buckets);
  const lead = types[0];
  const slices = donutSlices(
    types.map((t) => ({ key: t.label, value: t.count, color: t.color })),
    DONUT_RADIUS,
  );
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <Section
          title="Errors over time, by type"
          description={`Per ${data.bucketMs / 60_000} min, last ${data.windowMinutes} min`}
          source={SOURCE}
          testId="card-errors-time"
          className="lg:col-span-2"
        >
          <AreaChart
            testId="errors-chart"
            series={types.map((t) => ({
              id: t.label,
              label: t.label,
              color: t.color,
              values: t.series,
            }))}
            stacked
            fromUnixMs={data.fromUnixMs}
            toUnixMs={data.toUnixMs}
            heightClass="h-48"
            label={`Errors per ${data.bucketMs / 60_000} minutes stacked by exception type, peak ${peak} in one bucket${lead ? `, most from ${lead.label}` : ""}`}
          />
        </Section>
        <Section
          title="By exception type"
          description={`Last ${data.windowMinutes} min`}
          source={SOURCE}
          testId="card-errors-types"
        >
          <div className="flex flex-wrap items-center gap-6">
            <Donut
              slices={slices}
              testId="donut-types"
              label={`Errors by exception type: ${types.map((t) => `${t.label} ${percentOf(t.count, total)}`).join(", ")}`}
            >
              <span className="text-xl font-semibold">{countText(total)}</span>
              <span className="text-xs text-muted-foreground">events</span>
            </Donut>
            <DonutLegend
              rowTestId="type-row"
              items={types.map((t) => ({
                key: t.label,
                label: t.label,
                color: t.color,
                value: percentOf(t.count, total),
              }))}
            />
          </div>
        </Section>
      </div>
      <Section
        title="Where it happens"
        description="Events per route"
        source={SOURCE}
        testId="card-errors-routes"
      >
        <BarChart
          orientation="horizontal"
          testId="routes-chart"
          label={`Error events by route, most from ${routes[0]?.label ?? "none"}`}
          labelWidthClass="w-48"
          items={routes.map((r) => ({
            key: r.label,
            label: r.label,
            segments: [{ value: r.count, color: "--destructive" }],
            valueLabel: countText(r.count),
            title: `${r.label}: ${r.count} events`,
          }))}
        />
      </Section>
    </>
  );
}

const COVERED_DAY = 24 * 3_600_000;

/** The release counts of a group in the window, for a tooltip. */
function releasesTitle(group: ErrorGroup): string | undefined {
  if (group.releases === undefined) return undefined;
  const list = group.releases.map((r) => `${r.release} (${r.count})`);
  return `In this window: ${list.join(", ")}`;
}

/** "7 days", "5 hours": how much stored history the insights cover. */
function coveredText(insights: ErrorInsightsResponse): string {
  const span = insights.toUnixMs - insights.coveredFromUnixMs;
  if (span >= COVERED_DAY) return `${Math.round(span / COVERED_DAY)} days`;
  const hours = Math.max(1, Math.round(span / 3_600_000));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** The weekday x hour grid and errors per release, over the last 7 days or what the backend holds. */
function Insights({ service }: { service: string | undefined }) {
  const [paused] = usePaused();
  const insights = useQuery({
    queryKey: ["errors", "insights", service],
    queryFn: () => getErrorInsights({ service }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const data = insights.data;
  const releases = useMemo(
    () => releaseBars(data?.releases ?? []),
    [data?.releases],
  );
  // An older backend has no such endpoint: the page simply has no extra cards.
  if (data === undefined) return null;
  const peak = peakCell(data.heatmap);
  const covered = coveredText(data);
  const maxRelease = Math.max(0, ...releases.bars.map((b) => b.value));
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="errors-insights">
      <Section
        title="When errors happen"
        description={`Error events by weekday and hour (UTC), last ${covered}`}
        source={SOURCE}
        testId="card-errors-heatmap"
      >
        {peak === undefined ? (
          <p className="text-sm text-muted-foreground">
            No error events in the last {covered} of stored traces.
          </p>
        ) : (
          <>
            <Heatmap
              testId="errors-heatmap"
              rows={WEEKDAYS}
              columns={HOURS}
              values={data.heatmap}
              color="--destructive"
              columnLabelEvery={3}
              format={(n) => `${n} error event${n === 1 ? "" : "s"}`}
              label={`Error events by weekday and hour in UTC, busiest ${peak.weekday} ${peak.hour}:00 with ${peak.count}`}
            />
            <p
              data-testid="heatmap-note"
              className="mt-2 text-xs text-muted-foreground"
            >
              {countText(data.total)} events in the last {covered} of stored
              traces, hours in UTC. Busiest: {peak.weekday} {peak.hour}:00 (
              {peak.count}).
            </p>
          </>
        )}
      </Section>
      <Section
        title="Errors per release"
        description={
          releases.metric === "per1000"
            ? "Error events per 1,000 requests, oldest release first"
            : "Error events, oldest release first (no request counts to compare against)"
        }
        source={SOURCE}
        testId="card-errors-releases"
      >
        {releases.bars.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No release is known: set service.version on the resource to see
            errors per release.
          </p>
        ) : (
          <BarChart
            orientation="horizontal"
            testId="releases-chart"
            max={maxRelease}
            label={`Errors per release${releases.metric === "per1000" ? " per 1,000 requests" : ""}, ${releases.bars.length} releases`}
            labelWidthClass="w-32"
            items={releases.bars.map((b) => ({
              key: b.release,
              label: b.release,
              segments: [{ value: b.value, color: "--destructive" }],
              valueLabel: b.valueLabel,
              title: b.title,
            }))}
          />
        )}
      </Section>
    </div>
  );
}

/** The errors of the last 15 or 60 minutes grouped by type, normalised message and route. */
export function ErrorGroups({ viewToggle }: { viewToggle: React.ReactNode }) {
  const [windowMinutes, setWindowMinutes] = useState<number>(WINDOWS[0].value);
  const [service] = useService();
  const [paused] = usePaused();
  const groups = useQuery({
    queryKey: ["errors", "groups", windowMinutes, service],
    queryFn: () => getErrorGroups({ windowMinutes, service }),
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const data = groups.data;
  const shownWindow = data?.windowMinutes ?? windowMinutes;

  const derived = useMemo(() => {
    if (data === undefined) return null;
    const types = typeBreakdown(data.groups);
    const colorOf = new Map(types.map((t) => [t.label, t.color]));
    const states = data.groups.map((g) => groupState(g, data));
    return {
      total: totalEvents(data.groups),
      buckets: bucketTotals(data.groups),
      states,
      added: states.filter((s) => s === "new").length,
      regressed: states.filter((s) => s === "regressed").length,
      quiet: states.filter((s) => s === "quiet").length,
      max: Math.max(1, ...data.groups.map((g) => g.count)),
      colorOf: (g: ErrorGroup) =>
        colorOf.get(g.errorType ?? NO_TYPE) ?? OTHER_COLOR,
    };
  }, [data]);

  return (
    <div className="space-y-6" data-testid="errors-grouped">
      <PageHeader
        title="Errors"
        description="What is failing, grouped by exception type, message and route"
        source="traces"
        controls={
          <>
            {viewToggle}
            <SegmentedControl
              label="Time window"
              options={WINDOWS}
              value={windowMinutes}
              onChange={setWindowMinutes}
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label="Reload"
              onClick={() => void groups.refetch()}
            >
              <RefreshCw />
              Reload
            </Button>
          </>
        }
      />
      <p
        data-testid="groups-note"
        className="-mt-3 text-xs text-muted-foreground"
      >
        Grouped from the stored traces, which are sampled: counts cover the
        errors in stored traces, last {shownWindow} minutes, not every error
        that happened.
      </p>

      {groups.isPending && (
        <>
          <SkeletonKpiStrip />
          <SkeletonChart />
          <DataTableSkeleton columnCount={COLUMNS} />
        </>
      )}
      {groups.isError && data === undefined && (
        <ErrorState
          title="Could not load error groups."
          message={groups.error?.message}
          onRetry={() => void groups.refetch()}
        />
      )}
      {data !== undefined && derived !== null && (
        <>
          {data.groups.length > 0 && (
            <KpiStrip columns={5}>
              <StatTile
                testId="kpi-events"
                label="Error events"
                value={`${data.groups.length >= GROUP_CAP ? "≥ " : ""}${countText(derived.total)}`}
                unit={`in ${shownWindow} min`}
                delta="—"
                deltaTitle={NO_PREVIOUS}
                series={derived.buckets}
                seriesColor="--destructive"
                source={SOURCE}
              />
              <StatTile
                testId="kpi-groups"
                label="Error groups"
                value={countText(data.groups.length)}
                unit={
                  data.groups.length >= GROUP_CAP
                    ? "(the most frequent)"
                    : "distinct"
                }
                delta="—"
                deltaTitle={NO_PREVIOUS}
                source="type + message + route"
              />
              <StatTile
                testId="kpi-new"
                label="New groups"
                value={String(derived.added)}
                unit="in this window"
                delta="—"
                deltaTitle={STATE_TITLE.new}
                source="nothing stored before the window"
              />
              <StatTile
                testId="kpi-regressed"
                label="Regressed"
                value={String(derived.regressed)}
                unit="back after a day or a release"
                delta="—"
                deltaTitle={STATE_TITLE.regressed}
                source="from the stored history"
              />
              <StatTile
                testId="kpi-quiet"
                label="Gone quiet"
                value={String(derived.quiet)}
                unit="groups"
                delta="—"
                deltaTitle={STATE_TITLE.quiet}
                source="nothing in the last two buckets"
              />
            </KpiStrip>
          )}
          {data.groups.length > 0 && <Charts data={data} />}
          {data.groups.length > 0 && <Insights service={service} />}
          {data.groups.length > 0 ? (
            <Section
              title="Error groups"
              description="Type + message + route, most events first"
              source={SOURCE}
              testId="card-error-groups"
              flush
              actions={
                <span className="flex flex-wrap gap-1.5">
                  {STATE_ORDER.map((s) => (
                    <Chip key={s} tone={STATE_TONE[s]} title={STATE_TITLE[s]}>
                      {STATE_LABEL[s]}{" "}
                      {derived.states.filter((x) => x === s).length}
                    </Chip>
                  ))}
                </span>
              }
            >
              <Table
                data-testid="error-groups"
                containerClassName="max-h-[70vh]"
              >
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Error</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className="text-right">Events</TableHead>
                    <TableHead>Trend</TableHead>
                    <TableHead>Route</TableHead>
                    <TableHead>First seen</TableHead>
                    <TableHead>Last seen</TableHead>
                    <TableHead>Release</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.groups.map((g, i) => (
                    <GroupRow
                      key={g.key}
                      group={g}
                      state={derived.states[i] ?? "ongoing"}
                      color={derived.colorOf(g)}
                      max={derived.max}
                      windowMinutes={shownWindow}
                    />
                  ))}
                </TableBody>
              </Table>
            </Section>
          ) : (
            <EmptyState
              title={`No errors in the last ${shownWindow} minutes.`}
              testId="error-groups"
            >
              Failed requests and thrown spans in stored traces appear here. Try
              the 60 minute window, or send a failing request to your app.
            </EmptyState>
          )}
        </>
      )}
    </div>
  );
}
