import {
  type MetricAggregation,
  type MetricCatalogResponse,
  type MetricDefinition,
  metricSeriesParams,
  STANDALONE_WINDOW_MINUTES,
} from "@nestrix-js/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { parseAsStringLiteral, useQueryStates } from "nuqs";
import { useEffect, useMemo, useState } from "react";

import { Chip } from "@/components/kit/chip";
import { Chart } from "@/components/kit/line-chart";
import { PageHeader } from "@/components/kit/page-header";
import { Section } from "@/components/kit/section";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { SkeletonChart } from "@/components/kit/skeletons";
import { EmptyState, ErrorState } from "@/components/kit/states";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { getMeta, getMetricCatalog, getMetricSeries } from "@/lib/api";
import { useEnvironment } from "@/lib/environment";
import { usePaused } from "@/lib/live";
import { numberParser, stringParser } from "@/lib/params";
import { useService } from "@/lib/service";
import { windowChoices, windowLabel } from "@/lib/windows";
import {
  AGGREGATIONS,
  aggregationLabel,
  axisFloor,
  decodeInstance,
  encodeInstance,
  metricTitle,
  orderMetrics,
  requestsHref,
  resolveInstance,
  selectedRange,
  shapeSeries,
  unitLabel,
  valueFormatter,
} from "@/views/metrics/metrics-format";
import { formatClock } from "@/views/requests/timeline-range";

const MINUTE_MS = 60_000;
const DEFAULT_WINDOW = 60;
/** Stored metrics have one point per minute: a faster refresh would only repeat the answer. */
const REFRESH_MS = 30_000;
const SOURCE = "stored runtime metrics, one point per minute";

const urlParsers = {
  windowMinutes: numberParser({
    min: 1,
    max: Math.max(...STANDALONE_WINDOW_MINUTES),
    integer: true,
    oneOf: STANDALONE_WINDOW_MINUTES,
  }),
  fromUnixMs: numberParser({ ...metricSeriesParams.fromUnixMs, integer: true }),
  toUnixMs: numberParser({ ...metricSeriesParams.toUnixMs, integer: true }),
  instance: stringParser(metricSeriesParams.instance),
  // The service of the chosen instance, so an id two services share is never mixed.
  instanceService: stringParser(metricSeriesParams.service),
  aggregation: parseAsStringLiteral(metricSeriesParams.aggregation.values),
  by: parseAsStringLiteral(metricSeriesParams.by.values),
};

const minuteNow = () => Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;

function formatRange(fromUnixMs: number, toUnixMs: number): string {
  const day = (ms: number) => new Date(ms).toLocaleDateString();
  return day(fromUnixMs) === day(toUnixMs)
    ? `${day(fromUnixMs)} ${formatClock(fromUnixMs)} to ${formatClock(toUnixMs)}`
    : `${new Date(fromUnixMs).toLocaleString()} to ${new Date(toUnixMs).toLocaleString()}`;
}

/**
 * Historical runtime metrics (issue #18, D-105), standalone server with `NESTRIX_METRICS=on` only.
 * One chart per metric of the catalog, over the chosen window or an exact range (`fromUnixMs` and
 * `toUnixMs`, which a trace links to). Clicking a chart or dragging across it opens the request
 * list for that time in the same service and environment.
 *
 * Markup for tests: `metrics-page`, `metrics-off`, `metrics-window` (the shared window control),
 * `metrics-range` and `metrics-reset-range` (an exact range), `metrics-instance`,
 * `metrics-aggregation`, `metrics-split`, `metrics-capped`, `metrics-no-data`, `metrics-hint`,
 * `metric-panel-<name>` with `metric-chart-<name>`, `metric-empty`, `metric-gaps`, `metric-stale`,
 * `metric-capped`, `metric-meaning`.
 */
export function MetricsPage() {
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const [service] = useService();
  const [environment] = useEnvironment();
  const [paused] = usePaused();
  const [url, setUrl] = useQueryStates(urlParsers);
  const available = meta.data?.metrics?.available === true;

  const custom =
    url.fromUnixMs !== null &&
    url.toUnixMs !== null &&
    url.toUnixMs > url.fromUnixMs;
  const windowMinutes = url.windowMinutes ?? DEFAULT_WINDOW;

  // A moving window ends at the next whole minute and is re-anchored while the page is open.
  const [anchor, setAnchor] = useState(minuteNow);
  useEffect(() => {
    if (custom || paused) return;
    const timer = setInterval(() => setAnchor(minuteNow()), REFRESH_MS);
    return () => clearInterval(timer);
  }, [custom, paused]);
  const range = custom
    ? { fromUnixMs: url.fromUnixMs as number, toUnixMs: url.toUnixMs as number }
    : {
        fromUnixMs: anchor + MINUTE_MS - windowMinutes * MINUTE_MS,
        toUnixMs: anchor + MINUTE_MS,
      };
  const refetchInterval = custom || paused ? false : REFRESH_MS;

  const catalog = useQuery({
    queryKey: ["metrics", "catalog", service, range],
    queryFn: () => getMetricCatalog({ service, ...range }),
    enabled: available,
    refetchInterval,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const navigate = useNavigate();

  if (meta.data !== undefined && !available) {
    return (
      <div data-testid="metrics-page" className="space-y-4">
        <PageHeader
          title="Metrics"
          description="CPU, memory and event-loop delay over time."
        />
        <EmptyState testId="metrics-off" title="Historical metrics are off">
          {meta.data.mode === "standalone"
            ? "Start the server with NESTRIX_METRICS=on to store and chart the runtime metrics your services export."
            : "The embedded dashboard has a Runtime page for this process. Stored metrics need the standalone server."}
        </EmptyState>
      </div>
    );
  }

  const data = catalog.data;
  const instances = (data?.instances ?? []).filter((i) => i.instanceId !== "");
  const chosen = resolveInstance(
    instances,
    url.instance,
    url.instanceService,
    service,
  );
  const instanceChosen = chosen?.instanceId;
  const splitByInstance = url.by === "instance" && instanceChosen === undefined;
  const aggregation = url.aggregation ?? undefined;
  const scope = { service, environment };
  const goToRequests = (selected: { fromUnixMs: number; toUnixMs: number }) =>
    void navigate({ to: requestsHref(scope, selected) as "/" });

  return (
    <div data-testid="metrics-page" className="space-y-4">
      <PageHeader
        title="Metrics"
        description="Runtime metrics over time, across replicas. Click a chart, or drag across it, to open the requests from that time."
        source={SOURCE}
        controls={
          custom ? (
            <>
              <Chip data-testid="metrics-range" tone="info">
                {formatRange(range.fromUnixMs, range.toUnixMs)}
              </Chip>
              <Button
                data-testid="metrics-reset-range"
                variant="outline"
                size="sm"
                onClick={() =>
                  void setUrl({ fromUnixMs: null, toUnixMs: null })
                }
              >
                Back to the last {windowLabel(windowMinutes)}
              </Button>
            </>
          ) : (
            <div data-testid="metrics-window">
              <SegmentedControl
                label="Time window"
                options={windowChoices(
                  meta.data?.statistics.windowMinutesOptions,
                )}
                value={windowMinutes}
                onChange={(minutes) =>
                  void setUrl({
                    windowMinutes: minutes === DEFAULT_WINDOW ? null : minutes,
                  })
                }
              />
            </div>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          data-testid="metrics-instance"
          aria-label="Instance"
          value={
            chosen ? encodeInstance(chosen.service, chosen.instanceId) : ""
          }
          onChange={(e) => {
            const pair = decodeInstance(e.target.value);
            void setUrl({
              instance: pair?.instanceId ?? null,
              instanceService: pair?.service ?? null,
            });
          }}
        >
          <option value="">All instances</option>
          {instances.map((i) => (
            <option
              key={`${i.service}/${i.instanceId}`}
              value={encodeInstance(i.service, i.instanceId)}
            >
              {service === undefined ? `${i.service} / ` : ""}
              {i.instanceId}
            </option>
          ))}
        </Select>
        <Select
          data-testid="metrics-aggregation"
          aria-label="Across replicas"
          value={aggregation ?? ""}
          disabled={splitByInstance || instanceChosen !== undefined}
          onChange={(e) =>
            void setUrl({
              aggregation: (e.target.value || null) as MetricAggregation | null,
            })
          }
        >
          <option value="">Default per metric</option>
          {AGGREGATIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input
            data-testid="metrics-split"
            type="checkbox"
            checked={splitByInstance}
            disabled={instanceChosen !== undefined}
            onChange={(e) =>
              void setUrl({ by: e.target.checked ? "instance" : null })
            }
          />
          One line per instance
        </label>
        <IngestNotes data={data} />
      </div>

      {catalog.isError && !data ? (
        <ErrorState
          title="Could not load the metrics."
          message={catalog.error.message}
          onRetry={() => void catalog.refetch()}
        />
      ) : data === undefined ? (
        <SkeletonChart heightClass="h-64" />
      ) : data.instances.length === 0 ? (
        <EmptyState
          testId="metrics-no-data"
          title={
            data.ingest.storedPoints === 0
              ? "No metrics stored yet"
              : "No metrics in this range"
          }
        >
          {data.ingest.storedPoints === 0
            ? "Services that send their OTLP export to this server deliver the runtime metrics about once a minute. Check that the app exports metrics (they are on by default) and that it sends them to this server's endpoint."
            : "No instance reported metrics between these times for this service and environment. Try a longer window."}
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {orderMetrics(data.metrics).map((definition) => (
            <MetricPanel
              key={definition.name}
              definition={definition}
              range={range}
              service={chosen?.service ?? service}
              instance={instanceChosen}
              aggregation={aggregation}
              splitByInstance={splitByInstance}
              refetchInterval={refetchInterval}
              onSelect={goToRequests}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Notes from the receiver that explain a missing line: points over the series cap, listing cut. */
function IngestNotes({ data }: { data: MetricCatalogResponse | undefined }) {
  if (data === undefined) return null;
  const over = data.ingest.overSeriesCap;
  return (
    <>
      {over > 0 && (
        <Chip data-testid="metrics-capped" tone="warn">
          {over.toLocaleString()} points dropped: series limit reached (
          {data.ingest.maxSeriesPerService.toLocaleString()} per service)
        </Chip>
      )}
      {data.instancesTruncated && (
        <Chip data-testid="metrics-instances-truncated" tone="neutral">
          instance list cut at 200
        </Chip>
      )}
    </>
  );
}

function MetricPanel({
  definition,
  range,
  service,
  instance,
  aggregation,
  splitByInstance,
  refetchInterval,
  onSelect,
}: {
  definition: MetricDefinition;
  range: { fromUnixMs: number; toUnixMs: number };
  service: string | undefined;
  instance: string | undefined;
  aggregation: MetricAggregation | undefined;
  splitByInstance: boolean;
  refetchInterval: number | false;
  onSelect: (range: { fromUnixMs: number; toUnixMs: number }) => void;
}) {
  const histogram = definition.kind === "histogram";
  const query = useQuery({
    queryKey: [
      "metrics",
      "series",
      definition.name,
      service,
      instance,
      histogram ? undefined : aggregation,
      splitByInstance && !histogram,
      range,
    ],
    queryFn: () =>
      getMetricSeries({
        metric: definition.name,
        service,
        instance,
        aggregation: histogram ? undefined : aggregation,
        by: splitByInstance && !histogram ? "instance" : undefined,
        ...range,
      }),
    refetchInterval,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const shaped = useMemo(() => (data ? shapeSeries(data) : null), [data]);
  const title = metricTitle(definition.name);
  const format = valueFormatter(data?.valueUnit ?? definition.valueUnit);

  return (
    <Section
      testId={`metric-panel-${definition.name}`}
      title={title}
      description={definition.description}
      source={SOURCE}
    >
      {query.isError && !data ? (
        <ErrorState
          testId="metric-error"
          title={`Could not load ${title}.`}
          message={query.error.message}
          onRetry={() => void query.refetch()}
        />
      ) : data === undefined || shaped === null ? (
        <SkeletonChart heightClass="h-40" />
      ) : !shaped.hasData ? (
        <EmptyState testId="metric-empty" title="No data in this range">
          No instance reported {title.toLowerCase()} between these times. Try a
          longer window, or another service or environment.
        </EmptyState>
      ) : (
        <div className="space-y-2">
          <Chart
            testId={`metric-chart-${definition.name}`}
            label={`${title} over time`}
            xs={shaped.xs}
            series={shaped.series}
            format={format}
            height={190}
            minMax={axisFloor(data.valueUnit)}
            onRange={(from, to) => {
              const selected = selectedRange(
                from,
                to,
                data.timestamps,
                data.stepMs,
              );
              if (selected !== null) onSelect(selected);
            }}
          />
          <p
            data-testid="metric-meaning"
            className="text-xs text-muted-foreground"
          >
            {unitLabel(data.valueUnit)} ·{" "}
            {aggregationLabel(
              data.kind,
              data.aggregation,
              splitByInstance,
              instance,
            )}{" "}
            · one point per {Math.round(data.stepMs / MINUTE_MS)} min
          </p>
          <div className="flex flex-wrap gap-2">
            {shaped.gapBuckets > 0 && (
              <Chip data-testid="metric-gaps" tone="neutral">
                {shaped.gapBuckets}{" "}
                {shaped.gapBuckets === 1 ? "point" : "points"} without data
              </Chip>
            )}
            {shaped.staleMinutes !== null && (
              <Chip data-testid="metric-stale" tone="warn">
                last data {shaped.staleMinutes} min before the end of the range
              </Chip>
            )}
            {shaped.cappedAt && (
              <Chip data-testid="metric-capped" tone="warn">
                showing {shaped.cappedAt.shown} of {shaped.cappedAt.total}{" "}
                instances (most data first)
              </Chip>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}
