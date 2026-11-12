import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { parseAsStringLiteral, useQueryStates } from "nuqs";
import { useEffect, useMemo, useState } from "react";
import { Delta } from "@/components/kit/delta";
import { Section } from "@/components/kit/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getRouteCompare, getRouteExplain, getRoutes } from "@/lib/api";
import { pollInterval, usePaused } from "@/lib/live";
import { routeWindowParser, stringParser } from "@/lib/params";
import { useService } from "@/lib/service";
import { useNow } from "@/lib/use-now";
import {
  explainParams,
  noTraces,
  releaseKpis,
  resolveCompare,
  sideNames,
  tooFewTraces,
  windowKpis,
} from "@/views/route/route-detail";
import {
  DependenciesCard,
  ErrorsCard,
  KindsCard,
  MethodsCard,
  SlowestCard,
  StatementsCard,
  WhatChangedCard,
} from "@/views/route/route-detail-parts";
import { RouteHistogram } from "@/views/routes/route-histogram";
import { describeRoute, routeKey } from "@/views/routes/route-stats";

const DEFAULT_WINDOW = 15;

// The route and the comparison are in the URL: a link or a reload keeps them.
const parsers = {
  method: stringParser({ maxLength: 16 }),
  route: stringParser({ maxLength: 512 }),
  windowMinutes: routeWindowParser,
  compare: parseAsStringLiteral(["window", "release"] as const),
  releaseA: stringParser({ maxLength: 255 }),
  releaseB: stringParser({ maxLength: 255 }),
};

const selectClass =
  "h-8 rounded-lg border border-border bg-background px-2 text-sm";

function Breadcrumb({ label }: { label: string }) {
  return (
    <nav
      aria-label="Breadcrumb"
      data-testid="breadcrumb"
      className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
    >
      <Link to="/" className="underline-offset-4 hover:underline">
        Overview
      </Link>
      <span aria-hidden>/</span>
      <Link to="/routes" className="underline-offset-4 hover:underline">
        Routes
      </Link>
      <span aria-hidden>/</span>
      <span aria-current="page" className="font-mono text-foreground">
        {label}
      </span>
    </nav>
  );
}

export function RouteDetailPage() {
  const [query, setQuery] = useQueryStates(parsers);
  const [service] = useService();
  const [paused] = usePaused();
  const now = useNow();
  const route = query.route;
  const windowMinutes = query.windowMinutes ?? DEFAULT_WINDOW;
  const label = route === null ? "" : `${query.method ?? "any"} ${route}`;

  // Releases come with the answer (and stay while the next one loads); until one is picked,
  // release mode compares the two newest. The first request is a window one, to learn them.
  const [seen, setSeen] = useState<string[]>([]);
  const picked = resolveCompare(
    query.compare,
    query.releaseA,
    query.releaseB,
    seen,
  );

  const explain = useQuery({
    queryKey: [
      "routes",
      "explain",
      route,
      query.method,
      picked.mode === "release" ? picked.releaseA : windowMinutes,
      picked.releaseB,
      service,
    ],
    queryFn: () =>
      getRouteExplain(
        explainParams({
          method: query.method,
          route: route ?? "",
          windowMinutes,
          releaseA: picked.releaseA,
          releaseB: picked.releaseB,
          service,
        }),
      ),
    enabled: route !== null,
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const data = explain.data;
  const latestReleases = data?.releases;
  useEffect(() => {
    if (latestReleases) setSeen(latestReleases);
  }, [latestReleases]);

  // The same keys and functions as the Overview and the Routes page: usually the cached answer.
  const stats = useQuery({
    queryKey: ["routes", "stats", windowMinutes, service],
    queryFn: () => getRoutes({ windowMinutes, service }),
    enabled: route !== null && data?.mode !== "release",
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const compare = useQuery({
    queryKey: ["routes", "compare", "window", windowMinutes, service],
    queryFn: () => getRouteCompare({ windowMinutes, previous: 1, service }),
    enabled: route !== null && data?.mode !== "release",
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });

  const kpis = useMemo(() => {
    if (!data) return [];
    if (data.mode === "release") return releaseKpis(data);
    const matches = (r: { method: string; route: string }) =>
      r.route === route && (query.method === null || r.method === query.method);
    // Without a method, the busiest method of the route stands for it.
    const stat = [...(stats.data?.routes ?? [])]
      .filter(matches)
      .sort((a, b) => b.count - a.count)[0];
    const win = compare.data?.mode === "window" ? compare.data : undefined;
    const row = win?.routes.find(
      (r) => matches(r) && r.method === (stat?.method ?? r.method),
    );
    return windowKpis(
      stat,
      row,
      win?.previousCovered ?? false,
      windowMinutes,
      data,
    );
  }, [data, stats.data, compare.data, route, query.method, windowMinutes]);

  if (route === null)
    return (
      <section className="space-y-4" aria-label="Route">
        <Breadcrumb label="no route" />
        <div
          data-testid="no-route"
          className="space-y-2 rounded-lg border border-border p-6 text-center"
        >
          <p className="font-medium">No route selected.</p>
          <p className="text-sm text-muted-foreground">
            Pick one on the{" "}
            <Link to="/routes" className="underline">
              Routes page
            </Link>{" "}
            or follow a finding from the Overview.
          </p>
        </div>
      </section>
    );

  const described = describeRoute({ method: query.method ?? "*", route });
  const names = data ? sideNames(data) : { before: "Before", after: "After" };
  const tooFew = data ? tooFewTraces(data) : false;
  const releases = data?.releases ?? seen;
  const errorKpi = kpis.find((k) => k.id === "errors");
  const selection =
    picked.mode === "release" ? "release" : `window-${windowMinutes}`;

  return (
    <section className="space-y-4" aria-label="Route detail">
      <Breadcrumb label={label} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2
            className="font-mono text-2xl font-medium"
            data-testid="route-title"
            title={routeKey({ method: query.method ?? "*", route })}
          >
            {query.method !== null && (
              <span className="mr-2 text-success">{query.method}</span>
            )}
            {described.label}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {described.note && (
              <span className="text-xs text-muted-foreground">
                {described.note}
              </span>
            )}
            {errorKpi && errorKpi.value !== "—" && errorKpi.value !== "0%" && (
              <Badge variant="destructive" data-testid="error-chip">
                Errors {errorKpi.value}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="route-compare" className="text-muted-foreground">
            Compare
          </label>
          <select
            id="route-compare"
            data-testid="compare-picker"
            className={selectClass}
            value={selection}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "release") void setQuery({ compare: "release" });
              else
                void setQuery({
                  compare: null,
                  releaseA: null,
                  releaseB: null,
                  windowMinutes: v === "window-60" ? 60 : null,
                });
            }}
          >
            <option value="window-15">Previous window, 15 min</option>
            <option value="window-60">Previous window, 60 min</option>
            <option value="release" disabled={releases.length < 2}>
              Release against release
            </option>
          </select>
          {picked.mode === "release" &&
            releases.length >= 2 &&
            (
              [
                ["Before", "before-release", picked.releaseA, "releaseA"],
                ["After", "after-release", picked.releaseB, "releaseB"],
              ] as const
            ).map(([name, testId, value, key]) => (
              <label key={key} className="flex items-center gap-1">
                {name}
                <select
                  data-testid={testId}
                  className={selectClass}
                  value={value ?? ""}
                  onChange={(e) =>
                    void setQuery({
                      compare: "release",
                      releaseA: picked.releaseA,
                      releaseB: picked.releaseB,
                      [key]: e.target.value,
                    })
                  }
                >
                  {releases.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
            ))}
        </div>
      </div>

      {explain.isPending && (
        <div className="space-y-4" data-testid="route-loading">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}
      {explain.isError && data === undefined && (
        <div
          role="alert"
          data-testid="route-error"
          className="space-y-3 rounded-lg border border-border p-6 text-center"
        >
          <p className="font-medium">Could not explain this route.</p>
          <p className="text-sm text-muted-foreground">
            {explain.error?.message}
          </p>
          <Button variant="outline" onClick={() => void explain.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {data !== undefined && noTraces(data) && (
        <div
          data-testid="no-traces"
          className="space-y-2 rounded-lg border border-border p-6 text-center"
        >
          <p className="font-medium">No traces for this route.</p>
          <p className="text-sm text-muted-foreground">
            Nestrix has no sampled trace of {label} in{" "}
            {data.mode === "release"
              ? "these releases"
              : `the last ${windowMinutes * 2} minutes`}
            . The route may not exist, may be named differently, or may not have
            been called since the traces were kept.{" "}
            <Link to="/routes" className="underline">
              Back to Routes
            </Link>
          </p>
        </div>
      )}

      {data !== undefined && !noTraces(data) && (
        <>
          <section
            aria-label="Key figures"
            className="space-y-1"
            data-testid="kpis"
          >
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
              {kpis.map((k) => (
                <div
                  key={k.id}
                  data-testid="kpi"
                  data-kpi={k.id}
                  data-source={k.source}
                  className="rounded-lg border border-border p-3"
                >
                  <div className="text-xs text-muted-foreground">{k.label}</div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span
                      data-testid="kpi-value"
                      className="text-2xl font-semibold"
                    >
                      {k.value}
                    </span>
                    <Delta text={k.delta} tone={k.tone} />
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    was {k.was}
                  </div>
                </div>
              ))}
            </div>
            <p
              data-testid="kpi-source"
              className="text-xs text-muted-foreground"
            >
              {data.mode === "release"
                ? "Every figure is from sampled traces of the two releases."
                : "Requests, p95, p99 and error rate: route statistics, counted before sampling. Queries per request: sampled traces."}
            </p>
          </section>

          <WhatChangedCard
            data={data}
            windowMinutes={windowMinutes}
            tooFew={tooFew}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            <Section
              title="Latency distribution"
              testId="card-histogram"
              source={`Last ${windowMinutes} minutes, counted before sampling${
                data.mode === "release" ? " (the window, not the releases)" : ""
              }`}
            >
              <RouteHistogram
                stats={{ method: query.method ?? "*", route }}
                windowMinutes={windowMinutes}
                service={service}
                label={label}
                showTitle={false}
              />
            </Section>
            <KindsCard data={data} names={names} />
          </div>

          <StatementsCard rows={data.statements} />
          <MethodsCard rows={data.methods} />
          <DependenciesCard rows={data.dependencies} />
          <div className="grid gap-4 lg:grid-cols-2">
            <ErrorsCard
              rows={data.errors}
              errorsHref={`/errors?view=all&route=${encodeURIComponent(route)}`}
            />
            <SlowestCard
              traces={data.slowest}
              afterName={names.after}
              now={now}
            />
          </div>
        </>
      )}
    </section>
  );
}
