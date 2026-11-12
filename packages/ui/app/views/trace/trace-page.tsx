import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import {
  Chip,
  EmptyState,
  ErrorState,
  SkeletonChart,
  SkeletonKpiStrip,
  SourceLabel,
} from "@/components/kit";
import { ApiRequestError, getTrace, getTraceLogs } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { summarizeDropped } from "@/lib/trace-omitted";
import { routeDetailHref } from "@/views/route/route-detail";
import { CopyButton } from "@/views/trace/copy-button";
import { OmittedBanner } from "@/views/trace/omitted-banner";
import { summarizeTrace } from "@/views/trace/trace-summary";
import { Waterfall } from "@/views/trace/waterfall";

function BackLink() {
  return (
    <Link
      to="/requests"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" aria-hidden />
      Back to requests
    </Link>
  );
}

function TraceId({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="break-all font-mono text-sm" data-testid="trace-id">
        {id}
      </span>
      <CopyButton label="Copy trace id" text={id} />
    </span>
  );
}

/** One labelled fact of the summary header; the value is monospace when it is an id or a number. */
function Fact({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="break-words font-mono text-sm">
        {children}
      </dd>
    </div>
  );
}

export function TracePage({ traceId }: { traceId: string }) {
  const query = useQuery({
    queryKey: ["trace", traceId],
    queryFn: () => getTrace(traceId),
  });
  // P9-07: the trace's log lines. Optional: a failure (or an older backend without the route)
  // leaves the trace view as it was, without the Logs panel.
  const logs = useQuery({
    queryKey: ["trace-logs", traceId],
    queryFn: () => getTraceLogs(traceId),
    retry: false,
  });

  if (query.isPending)
    return (
      <div className="space-y-6" data-testid="trace-loading">
        <BackLink />
        <SkeletonKpiStrip count={4} />
        <SkeletonChart heightClass="h-64" />
      </div>
    );

  if (query.isError) {
    const evicted =
      query.error instanceof ApiRequestError && query.error.status === 404;
    return (
      <div className="space-y-6">
        <BackLink />
        {evicted ? (
          <EmptyState
            testId="trace-evicted"
            title="Trace not found"
            action={
              <p className="text-sm">
                <Link
                  to="/requests"
                  className="underline underline-offset-4"
                  data-testid="back-to-list"
                >
                  Back to the request list
                </Link>
              </p>
            }
          >
            This trace is no longer in memory. Nestrix keeps a bounded number of
            recent traces, and older ones are evicted.
          </EmptyState>
        ) : (
          <ErrorState
            testId="trace-error"
            title="Could not load the trace"
            message={query.error.message}
            onRetry={() => query.refetch()}
            retryLabel="Retry"
          />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <TraceId id={traceId} />
          {evicted ? null : (
            <Link
              to="/requests"
              className="text-sm underline underline-offset-4"
              data-testid="back-to-list"
            >
              Back to the request list
            </Link>
          )}
        </div>
      </div>
    );
  }

  const trace = query.data;
  const summary = summarizeTrace(trace);
  const omitted = summarizeDropped(trace.droppedSpans);
  return (
    <div className="space-y-6">
      <BackLink />
      <header data-testid="trace-header" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                className="break-all text-xl font-semibold tracking-tight"
                data-testid="trace-title"
              >
                {summary.title}
              </h2>
              {summary.statusCode !== undefined ? (
                <Chip
                  tone={summary.error ? "worse" : "better"}
                  data-testid="trace-status"
                >
                  {summary.statusCode}
                </Chip>
              ) : summary.error ? (
                <Chip tone="worse" data-testid="trace-status">
                  error
                </Chip>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              One request and everything it called <span aria-hidden>·</span>{" "}
              <SourceLabel kind="traces" className="text-sm" />
            </p>
          </div>
          {summary.route !== undefined && (
            <Link
              to={routeDetailHref(summary.method, summary.route) as "/"}
              data-testid="trace-route-link"
              className="text-sm underline underline-offset-4"
            >
              Route details
            </Link>
          )}
        </div>
        <div className="space-y-3 rounded-lg border border-border p-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="min-w-0 space-y-0.5">
              <dt className="text-xs text-muted-foreground">Duration</dt>
              <dd
                data-testid="trace-duration"
                className="font-mono text-2xl font-semibold leading-tight tabular-nums"
              >
                {formatDuration(summary.durationMs)}
              </dd>
            </div>
            <Fact label="Spans" testId="trace-span-count">
              {trace.spans.length} {trace.spans.length === 1 ? "span" : "spans"}
            </Fact>
            <Fact label="Started">
              <time
                dateTime={new Date(summary.startMs).toISOString()}
                title={new Date(summary.startMs).toISOString()}
              >
                {new Date(summary.startMs).toLocaleString()}
              </time>
            </Fact>
            <Fact label="Service" testId="trace-service">
              {summary.service ?? "—"}
            </Fact>
            <Fact label="Release" testId="trace-release">
              {summary.release ?? "—"}
            </Fact>
            <Fact label="User" testId="trace-user">
              {summary.user ?? "—"}
            </Fact>
          </dl>
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {omitted ? (
              <Chip tone="warn" data-testid="trace-omitted-chip">
                {omitted.total} omitted
              </Chip>
            ) : null}
            <TraceId id={trace.traceId} />
          </div>
        </div>
      </header>
      {omitted ? <OmittedBanner summary={omitted} /> : null}
      <Waterfall trace={trace} logs={logs.data} omitted={omitted?.total} />
    </div>
  );
}
