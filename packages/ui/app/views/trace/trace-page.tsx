import type { SpanRecord, TraceResponse } from "@nestrix-js/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiRequestError, getTrace, getTraceLogs } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { buildTree, isErrorSpan } from "@/lib/trace-tree";
import { routeDetailHref } from "@/views/route/route-detail";
import { CopyButton } from "@/views/trace/copy-button";
import { Waterfall } from "@/views/trace/waterfall";

function BackLink() {
  return (
    <Link to="/requests" className="text-sm underline">
      Back to requests
    </Link>
  );
}

function TraceId({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono text-sm" data-testid="trace-id">
        {id}
      </span>
      <CopyButton label="Copy trace id" text={id} />
    </span>
  );
}

/** Route, status and root duration come from the trace's local root span. */
function summarize(trace: TraceResponse) {
  const root: SpanRecord | undefined =
    trace.spans.find((s) => s.spanId === trace.rootSpanId) ?? trace.spans[0];
  const attrs = root?.attributes ?? {};
  const method = attrs["http.request.method"];
  const route = attrs["http.route"];
  const code = attrs["http.response.status_code"];
  const { totalMs } = buildTree(trace.spans, trace.rootSpanId);
  return {
    // The root's route (and method), for the link to the route detail page.
    route: typeof route === "string" ? route : undefined,
    method: typeof method === "string" ? method : undefined,
    title:
      typeof route === "string"
        ? `${typeof method === "string" ? `${method} ` : ""}${route}`
        : (root?.name ?? "Trace"),
    statusCode: typeof code === "number" ? code : undefined,
    error: root
      ? isErrorSpan(root) || (typeof code === "number" && code >= 500)
      : false,
    durationMs: root?.durationMs ?? totalMs,
  };
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
      <div className="space-y-4" data-testid="trace-loading">
        <BackLink />
        <Skeleton className="h-6 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );

  if (query.isError) {
    const evicted =
      query.error instanceof ApiRequestError && query.error.status === 404;
    return (
      <div className="space-y-4">
        <BackLink />
        <div
          role="alert"
          data-testid={evicted ? "trace-evicted" : "trace-error"}
          className="space-y-2 rounded-lg border p-4"
        >
          <h2 className="text-lg font-semibold">
            {evicted ? "Trace not found" : "Could not load the trace"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {evicted
              ? "This trace is no longer in memory. Nestrix keeps a bounded number of recent traces, and older ones are evicted."
              : query.error.message}
          </p>
          <div className="flex items-center gap-3">
            <TraceId id={traceId} />
          </div>
          {evicted ? null : (
            <Button
              type="button"
              variant="outline"
              onClick={() => query.refetch()}
            >
              Retry
            </Button>
          )}
          <p className="text-sm">
            <Link
              to="/requests"
              className="underline"
              data-testid="back-to-list"
            >
              Back to the request list
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const trace = query.data;
  const summary = summarize(trace);
  return (
    <div className="space-y-4">
      <BackLink />
      <header data-testid="trace-header" className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold" data-testid="trace-title">
            {summary.title}
          </h2>
          {summary.route !== undefined && (
            <Link
              to={routeDetailHref(summary.method, summary.route) as "/"}
              data-testid="trace-route-link"
              className="text-sm underline underline-offset-4"
            >
              Route details
            </Link>
          )}
          {summary.statusCode !== undefined ? (
            <Badge
              variant={summary.error ? "destructive" : "secondary"}
              data-testid="trace-status"
            >
              {summary.statusCode}
            </Badge>
          ) : summary.error ? (
            <Badge variant="destructive" data-testid="trace-status">
              error
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span data-testid="trace-duration">
            {formatDuration(summary.durationMs)}
          </span>
          <span data-testid="trace-span-count">
            {trace.spans.length} {trace.spans.length === 1 ? "span" : "spans"}
          </span>
          <TraceId id={trace.traceId} />
        </div>
      </header>
      <Waterfall trace={trace} logs={logs.data} />
    </div>
  );
}
