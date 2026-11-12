import type {
  ExplainDependencyRow,
  ExplainErrorRow,
  ExplainFinding,
  ExplainMethodRow,
  ExplainStatementRow,
  ExplainTrace,
  RouteExplainResponse,
} from "@nestrix-js/protocol";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { Delta } from "@/components/kit/delta";
import { Section } from "@/components/kit/section";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDuration, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TIME_KINDS } from "@/views/overview/overview-format";
import {
  barWidth,
  callsTone,
  FINDING_LINK_LABEL,
  findingHref,
  formatCalls,
  formatCallsDelta,
  formatMsDelta,
  formatRateDelta,
  formatRateOrDash,
  formatShareOfChange,
  kindSegments,
  msTone,
  rateTone,
} from "@/views/route/route-detail";

const SAMPLED = "from sampled traces";
const SAMPLED_CAP = "from up to 2,000 sampled traces per side";

/** `before` to `after`, with the change under it. */
function Pair({
  before,
  after,
  delta,
  tone,
  testId,
}: {
  before: string;
  after: string;
  delta: string;
  tone: Parameters<typeof Delta>[0]["tone"];
  testId?: string;
}) {
  return (
    <div className="text-right font-mono" data-testid={testId}>
      <div>
        <span className="text-muted-foreground">{before} →</span> {after}
      </div>
      <Delta text={delta} tone={tone} />
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p data-testid="empty" className="text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export function WhatChangedCard({
  data,
  windowMinutes,
  tooFew,
}: {
  data: RouteExplainResponse;
  windowMinutes: number;
  tooFew: boolean;
}) {
  return (
    <Section
      title="What changed"
      testId="card-what-changed"
      source={SAMPLED_CAP}
      className="bg-secondary/40"
    >
      <p
        data-testid="summary"
        className="text-base font-medium leading-relaxed"
      >
        {data.summary}
      </p>
      {tooFew ? (
        <p data-testid="too-few" className="text-sm text-muted-foreground">
          Findings need at least 5 sampled traces on each side. The tables below
          still show what was kept.
        </p>
      ) : data.findings.length === 0 ? (
        <p data-testid="no-findings" className="text-sm text-muted-foreground">
          No single statement, method, dependency or error stands out between
          the two sides.
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {data.findings.map((f, i) => (
            <FindingRow
              key={`${f.kind}:${f.title}`}
              finding={f}
              rank={i + 1}
              windowMinutes={windowMinutes}
            />
          ))}
        </ol>
      )}
    </Section>
  );
}

function FindingRow({
  finding: f,
  rank,
  windowMinutes,
}: {
  finding: ExplainFinding;
  rank: number;
  windowMinutes: number;
}) {
  const worse = f.direction === "worse";
  const href = findingHref(f, windowMinutes);
  const share = formatShareOfChange(f.shareOfChange);
  return (
    <li
      data-testid="finding"
      data-kind={f.kind}
      data-direction={f.direction}
      className="flex flex-wrap items-start gap-3 py-3"
    >
      <span className="w-4 pt-0.5 text-xs text-muted-foreground">{rank}</span>
      <span
        data-testid="finding-direction"
        className={cn(
          "inline-flex h-5 w-16 shrink-0 items-center justify-center gap-0.5 rounded-full text-xs font-medium text-foreground",
          worse ? "bg-destructive/20" : "bg-success/20",
        )}
      >
        {worse ? (
          <ArrowUp className="size-3" aria-hidden />
        ) : (
          <ArrowDown className="size-3" aria-hidden />
        )}
        {worse ? "Worse" : "Better"}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm" data-testid="finding-title">
          {f.title}
        </p>
        {f.shareOfChange !== null && (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-40 rounded-full bg-muted" aria-hidden>
              <div
                data-testid="finding-share-bar"
                className="h-1.5 rounded-full"
                style={{
                  width: `${Math.max(2, Math.min(1, f.shareOfChange) * 100)}%`,
                  background: `var(${worse ? "--destructive" : "--success"})`,
                }}
              />
            </div>
            <span
              data-testid="finding-share"
              className="text-xs text-muted-foreground"
            >
              {share}
            </span>
          </div>
        )}
      </div>
      {href !== null && f.link !== null && (
        <Link
          to={href as "/"}
          data-testid="finding-link"
          className="shrink-0 text-sm underline underline-offset-4"
        >
          {FINDING_LINK_LABEL[f.link.view]}
        </Link>
      )}
    </li>
  );
}

export function KindsCard({
  data,
  names,
}: {
  data: RouteExplainResponse;
  names: { before: string; after: string };
}) {
  const sides = [
    ["before", names.before],
    ["after", names.after],
  ] as const;
  const bars = sides.map(([side, name]) => ({
    side,
    name,
    ...kindSegments(data.kinds, side),
  }));
  const max = Math.max(...bars.map((b) => b.total));
  return (
    <Section
      title="Where the time goes, per side"
      testId="card-kinds"
      source={`Mean time per request by span kind · ${SAMPLED}`}
    >
      {max <= 0 ? (
        <Empty>No time was recorded on either side.</Empty>
      ) : (
        <div className="space-y-4">
          {bars.map((b) => (
            <div key={b.side} data-testid="kind-bar" data-side={b.side}>
              <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                <span className="font-medium">{b.name}</span>
                <span className="font-mono">{formatDuration(b.total)}</span>
              </div>
              <div
                role="img"
                aria-label={`${b.name}: ${
                  b.segments
                    .map((s) => `${s.label} ${formatDuration(s.ms)}`)
                    .join(", ") || "no time"
                }`}
                className="flex h-6 overflow-hidden rounded-md bg-muted"
                style={{ width: `${barWidth(b.total, max)}%` }}
              >
                {b.segments.map((s) => (
                  <div
                    key={s.key}
                    data-kind={s.key}
                    title={`${s.label}: ${formatDuration(s.ms)}`}
                    style={{
                      width: `${s.fraction * 100}%`,
                      background: `var(${s.color})`,
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
          <ul data-testid="kind-legend" className="space-y-1 text-sm">
            {data.kinds.map((k) => (
              <li
                key={k.key}
                data-kind={k.key}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex items-center gap-2">
                  <span
                    className="size-2.5 rounded-sm"
                    style={{ background: `var(${TIME_KINDS[k.key].color})` }}
                    aria-hidden
                  />
                  {TIME_KINDS[k.key].label}
                </span>
                <span className="flex items-center gap-2 font-mono text-xs">
                  <span className="text-muted-foreground">
                    {formatDuration(k.beforeMs)} → {formatDuration(k.afterMs)}
                  </span>
                  <Delta
                    text={formatMsDelta(k.beforeMs, k.afterMs)}
                    tone={msTone(k.beforeMs, k.afterMs)}
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function HeadRow({ cols }: { cols: { label: string; right?: boolean }[] }) {
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        {cols.map((c) => (
          <TableHead key={c.label} className={cn(c.right && "text-right")}>
            {c.label}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

export function StatementsCard({ rows }: { rows: ExplainStatementRow[] }) {
  return (
    <Section
      title="Statements"
      testId="card-statements"
      source={`Database statements per request, without bind values · ${SAMPLED}`}
    >
      {rows.length === 0 ? (
        <Empty>No database statements in the traces of this route.</Empty>
      ) : (
        <Table data-testid="statements">
          <HeadRow
            cols={[
              { label: "Statement" },
              { label: "Calls per request", right: true },
              { label: "Time per request", right: true },
              { label: "Each (after)", right: true },
            ]}
          />
          <TableBody>
            {rows.map((r) => (
              <TableRow
                key={`${r.system}\u0000${r.statement}`}
                data-testid="statement-row"
              >
                <TableCell className="max-w-[28rem]">
                  <div
                    className="truncate font-mono text-xs"
                    title={r.statement}
                  >
                    {r.statement}
                  </div>
                  <Badge variant="outline" className="mt-1">
                    {r.system}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Pair
                    before={formatCalls(r.beforeCalls)}
                    after={formatCalls(r.afterCalls)}
                    delta={formatCallsDelta(r.beforeCalls, r.afterCalls)}
                    tone={callsTone(r.beforeCalls, r.afterCalls)}
                  />
                </TableCell>
                <TableCell>
                  <Pair
                    before={formatDuration(r.beforeMs)}
                    after={formatDuration(r.afterMs)}
                    delta={formatMsDelta(r.beforeMs, r.afterMs)}
                    tone={msTone(r.beforeMs, r.afterMs)}
                  />
                </TableCell>
                <TableCell className="text-right font-mono">
                  {r.afterEachMs === null ? "—" : formatDuration(r.afterEachMs)}
                  {r.beforeEachMs !== null && (
                    <div className="text-xs text-muted-foreground">
                      was {formatDuration(r.beforeEachMs)}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

export function MethodsCard({ rows }: { rows: ExplainMethodRow[] }) {
  return (
    <Section
      title="Methods"
      testId="card-methods"
      source={`Own time per request, children excluded · ${SAMPLED}`}
    >
      {rows.length === 0 ? (
        <Empty>No class methods were recorded for this route.</Empty>
      ) : (
        <Table data-testid="methods">
          <HeadRow
            cols={[
              { label: "Method" },
              { label: "Calls per request", right: true },
              { label: "Own time per request", right: true },
            ]}
          />
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.name} data-testid="method-row">
                <TableCell className="font-mono text-xs">{r.name}</TableCell>
                <TableCell>
                  <Pair
                    before={formatCalls(r.beforeCalls)}
                    after={formatCalls(r.afterCalls)}
                    delta={formatCallsDelta(r.beforeCalls, r.afterCalls)}
                    tone={callsTone(r.beforeCalls, r.afterCalls)}
                  />
                </TableCell>
                <TableCell>
                  <Pair
                    before={formatDuration(r.beforeMs)}
                    after={formatDuration(r.afterMs)}
                    delta={formatMsDelta(r.beforeMs, r.afterMs)}
                    tone={msTone(r.beforeMs, r.afterMs)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

export function DependenciesCard({ rows }: { rows: ExplainDependencyRow[] }) {
  return (
    <Section
      title="Dependencies"
      testId="card-dependencies"
      source={`Outgoing calls per request · ${SAMPLED}`}
    >
      {rows.length === 0 ? (
        <Empty>This route made no outgoing calls in the traces kept.</Empty>
      ) : (
        <Table data-testid="dependencies">
          <HeadRow
            cols={[
              { label: "Dependency" },
              { label: "Calls per request", right: true },
              { label: "Time per request", right: true },
              { label: "Failed calls", right: true },
            ]}
          />
          <TableBody>
            {rows.map((r) => (
              <TableRow
                key={`${r.kind}:${r.name}`}
                data-testid="dependency-row"
              >
                <TableCell>
                  <span className="font-mono text-xs">{r.name}</span>
                  <Badge variant="outline" className="ml-2">
                    {r.kind}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Pair
                    before={formatCalls(r.beforeCalls)}
                    after={formatCalls(r.afterCalls)}
                    delta={formatCallsDelta(r.beforeCalls, r.afterCalls)}
                    tone={callsTone(r.beforeCalls, r.afterCalls)}
                  />
                </TableCell>
                <TableCell>
                  <Pair
                    before={formatDuration(r.beforeMs)}
                    after={formatDuration(r.afterMs)}
                    delta={formatMsDelta(r.beforeMs, r.afterMs)}
                    tone={msTone(r.beforeMs, r.afterMs)}
                  />
                </TableCell>
                <TableCell>
                  <Pair
                    before={formatRateOrDash(r.beforeErrorRate)}
                    after={formatRateOrDash(r.afterErrorRate)}
                    delta={formatRateDelta(r.beforeErrorRate, r.afterErrorRate)}
                    tone={rateTone(r.beforeErrorRate, r.afterErrorRate)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

export function ErrorsCard({
  rows,
  errorsHref,
}: {
  rows: ExplainErrorRow[];
  errorsHref: string;
}) {
  return (
    <Section
      title="Errors by type"
      testId="card-errors"
      source={`Traces with the exception type on any span · ${SAMPLED}`}
      actions={
        <Link
          to={errorsHref as "/"}
          data-testid="errors-link"
          className="text-xs underline"
        >
          All errors of this route
        </Link>
      }
    >
      {rows.length === 0 ? (
        <Empty>No exceptions in the traces of this route.</Empty>
      ) : (
        <Table data-testid="errors">
          <HeadRow
            cols={[
              { label: "Type" },
              { label: "Example message" },
              { label: "Traces", right: true },
            ]}
          />
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.type} data-testid="error-row">
                <TableCell className="font-mono text-xs">{r.type}</TableCell>
                <TableCell className="max-w-[24rem]">
                  <div className="truncate text-xs" title={r.message}>
                    {r.message}
                  </div>
                </TableCell>
                <TableCell>
                  <Pair
                    before={String(r.beforeTraces)}
                    after={String(r.afterTraces)}
                    delta={formatCallsDelta(r.beforeTraces, r.afterTraces)}
                    tone={callsTone(r.beforeTraces, r.afterTraces)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

export function SlowestCard({
  traces,
  afterName,
  now,
}: {
  traces: ExplainTrace[];
  afterName: string;
  now: number;
}) {
  const max = Math.max(1, ...traces.map((t) => t.durationMs));
  return (
    <Section
      title="Slowest traces"
      testId="card-slowest"
      source={`${afterName}: the slowest sampled traces, each bar shows its time by kind`}
    >
      {traces.length === 0 ? (
        <Empty>No traces on the later side.</Empty>
      ) : (
        <ul className="-mx-4 divide-y divide-border border-t border-border">
          {traces.map((t) => {
            const total = t.byKind.reduce((s, k) => s + Math.max(0, k.ms), 0);
            return (
              <li key={t.traceId} data-testid="slow-trace">
                <Link
                  to={`/traces/${t.traceId}` as "/"}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50"
                >
                  <span className="w-20 font-mono text-sm">
                    {formatDuration(t.durationMs)}
                  </span>
                  <span
                    role="img"
                    aria-label={`Time by kind: ${
                      t.byKind
                        .filter((k) => k.ms > 0)
                        .map(
                          (k) =>
                            `${TIME_KINDS[k.key].label} ${formatDuration(k.ms)}`,
                        )
                        .join(", ") || "none"
                    }`}
                    className="flex h-2.5 flex-1 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className="flex"
                      style={{ width: `${barWidth(t.durationMs, max)}%` }}
                    >
                      {t.byKind
                        .filter((k) => k.ms > 0)
                        .map((k) => (
                          <span
                            key={k.key}
                            data-kind={k.key}
                            style={{
                              width: `${total > 0 ? (k.ms / total) * 100 : 0}%`,
                              background: `var(${TIME_KINDS[k.key].color})`,
                            }}
                          />
                        ))}
                    </span>
                  </span>
                  <Badge
                    variant={t.error ? "destructive" : "secondary"}
                    className="w-12"
                  >
                    {t.status ?? (t.error ? "err" : "—")}
                  </Badge>
                  <span className="w-20 text-right text-xs text-muted-foreground">
                    {formatRelative(t.startUnixMs, now)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
