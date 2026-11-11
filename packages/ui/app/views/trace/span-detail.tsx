import type {
  Attributes,
  AttributeValue,
  SpanEvent,
  SpanLink,
  SpanRecord,
} from "@nestrix-js/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getTrace } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { CopyButton } from "@/views/trace/copy-button";

export const attributeText = (value: AttributeValue): string =>
  Array.isArray(value) ? JSON.stringify(value) : String(value);

/** Attributes as `[key, text]` pairs, sorted by key. */
export function sortedAttributes(attributes: Attributes): [string, string][] {
  return Object.keys(attributes)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => [key, attributeText(attributes[key] as AttributeValue)]);
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
        {action}
      </div>
      {children}
    </section>
  );
}

function AttributeList({ pairs }: { pairs: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1 text-xs">
      {pairs.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="break-all font-mono text-muted-foreground">{key}</dt>
          <dd className="break-all font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EventItem({
  event,
  spanStartMs,
}: {
  event: SpanEvent;
  spanStartMs: number;
}) {
  const attrs = event.attributes;
  const type = attrs["exception.type"];
  const message = attrs["exception.message"];
  const stack = attrs["exception.stacktrace"];
  const isException = event.name === "exception";
  const rest = sortedAttributes(attrs).filter(
    ([key]) => !(isException && key.startsWith("exception.")),
  );
  return (
    <li
      data-testid="span-event"
      className="space-y-1 rounded-md border p-2 text-xs"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">
          {isException && type !== undefined ? attributeText(type) : event.name}
        </span>
        <span className="tabular-nums text-muted-foreground">
          +{formatDuration(event.timeUnixMs - spanStartMs)}
        </span>
      </div>
      {isException && message !== undefined ? (
        <p className="break-words font-mono">{attributeText(message)}</p>
      ) : null}
      {isException && stack !== undefined ? (
        <pre
          data-testid="exception-stack"
          className="max-h-60 overflow-auto whitespace-pre rounded bg-muted p-2 font-mono text-[11px] leading-snug"
        >
          {attributeText(stack)}
        </pre>
      ) : null}
      {rest.length > 0 ? <AttributeList pairs={rest} /> : null}
    </li>
  );
}

/**
 * One link of a span. The linked trace is fetched (it shares the trace page's cache entry):
 * a trace in the store is a link that opens it; one that is missing or cannot be read is
 * shown as text.
 */
function LinkItem({ link }: { link: SpanLink }) {
  const query = useQuery({
    queryKey: ["trace", link.traceId],
    queryFn: () => getTrace(link.traceId),
    staleTime: 30_000,
  });
  return (
    <li
      data-testid="span-link"
      data-in-store={query.isSuccess ? "true" : "false"}
      className="break-all font-mono"
    >
      {query.isSuccess ? (
        <Link
          to="/traces/$traceId"
          params={{ traceId: link.traceId }}
          className="underline"
        >
          {link.traceId}
        </Link>
      ) : (
        <span>{link.traceId}</span>
      )}{" "}
      / {link.spanId}
      {query.isError ? (
        <span className="ml-1 font-sans text-muted-foreground">
          (not in the store)
        </span>
      ) : null}
    </li>
  );
}

/** The detail panel of one span. */
export function SpanDetail({
  span,
  traceStartMs,
  orphan,
  onClose,
}: {
  span: SpanRecord;
  traceStartMs: number;
  orphan: boolean;
  onClose: () => void;
}) {
  const attributes = sortedAttributes(span.attributes);
  const error = span.status.code === "error";
  return (
    <aside
      data-testid="span-detail"
      aria-label="Span detail"
      className="w-full shrink-0 space-y-4 rounded-lg border p-4 lg:w-96"
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          data-testid="detail-name"
          className="break-words text-sm font-semibold"
        >
          {span.name}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close detail"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline">{span.kind}</Badge>
        <Badge variant={error ? "destructive" : "secondary"}>
          {span.status.code}
        </Badge>
        {orphan ? <Badge variant="outline">parent not in trace</Badge> : null}
      </div>
      {span.status.message ? (
        <p className="break-words text-xs">{span.status.message}</p>
      ) : null}

      <Section title="Timing">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Start</dt>
          <dd className="tabular-nums">
            +{formatDuration(span.startTimeUnixMs - traceStartMs)} (
            {new Date(span.startTimeUnixMs).toISOString()})
          </dd>
          <dt className="text-muted-foreground">Duration</dt>
          <dd className="tabular-nums">{formatDuration(span.durationMs)}</dd>
          <dt className="text-muted-foreground">Span id</dt>
          <dd className="break-all font-mono">{span.spanId}</dd>
          {span.parentSpanId ? (
            <>
              <dt className="text-muted-foreground">Parent</dt>
              <dd className="break-all font-mono">{span.parentSpanId}</dd>
            </>
          ) : null}
          {span.service ? (
            <>
              <dt className="text-muted-foreground">Service</dt>
              <dd className="break-all font-mono" data-testid="span-service">
                {span.service}
              </dd>
            </>
          ) : null}
          {span.scope ? (
            <>
              <dt className="text-muted-foreground">Scope</dt>
              <dd className="break-all font-mono">{span.scope}</dd>
            </>
          ) : null}
        </dl>
      </Section>

      <Section
        title={`Attributes (${attributes.length})`}
        action={
          attributes.length > 0 ? (
            <CopyButton
              label="Copy attributes"
              text={JSON.stringify(
                Object.fromEntries(
                  attributes.map(([k]) => [k, span.attributes[k]]),
                ),
                null,
                2,
              )}
            />
          ) : undefined
        }
      >
        {attributes.length > 0 ? (
          <div data-testid="span-attributes">
            <AttributeList pairs={attributes} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">None</p>
        )}
      </Section>

      <Section title={`Events (${span.events.length})`}>
        {span.events.length > 0 ? (
          <ul className="space-y-2">
            {span.events.map((event, i) => (
              <EventItem
                // biome-ignore lint/suspicious/noArrayIndexKey: events have no id and the list is static
                key={i}
                event={event}
                spanStartMs={span.startTimeUnixMs}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">None</p>
        )}
      </Section>

      <Section title={`Links (${span.links.length})`}>
        {span.links.length > 0 ? (
          <ul className="space-y-1 text-xs" data-testid="span-links">
            {span.links.map((link) => (
              <LinkItem key={`${link.traceId}/${link.spanId}`} link={link} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">None</p>
        )}
      </Section>
    </aside>
  );
}
