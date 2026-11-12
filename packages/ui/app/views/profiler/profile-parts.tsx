// biome-ignore-all lint/a11y/useSemanticElements: flame graph bars are SVG elements, which cannot be <button>s; each is focusable and answers Enter and Space
import type { FlameNode, ProfileFunction } from "@nestrix-js/protocol";
import { Download, Info, RotateCcw } from "lucide-react";
import type * as React from "react";
import { useMemo, useState } from "react";

import { BarCell } from "@/components/kit/bar-cell";
import {
  DONUT_RADIUS,
  Donut,
  DonutLegend,
  Swatch,
} from "@/components/kit/donut";
import { donutSlices } from "@/components/kit/format";
import { Section } from "@/components/kit/section";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  cpuByOrigin,
  FRAME_KINDS,
  type FrameKind,
  formatShare,
  frameKind,
  frameKindColor,
  frameKindLabel,
  frameLabel,
  layoutFlame,
  shortUrl,
} from "@/views/profiler/profile-format";

const ROW = 22;
const SOURCE_CAPTURE = "from this capture";

const kindFill: Record<FrameKind, string> = {
  app: "fill-flame-app",
  deps: "fill-flame-deps",
  node: "fill-flame-runtime",
  v8: "fill-flame-v8",
};

const pct = (fraction: number) => `${(fraction * 100).toFixed(4)}%`;

/** The origins as coloured squares with their names: the key to the flame graph's colours. */
function FlameLegend() {
  return (
    <ul
      data-testid="flame-legend"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
    >
      {FRAME_KINDS.map((kind) => (
        <li key={kind} className="flex items-center gap-1.5">
          <Swatch color={frameKindColor[kind]} />
          {frameKindLabel[kind]}
        </li>
      ))}
    </ul>
  );
}

/**
 * Top-down flame graph in SVG, computed from the server's pruned call tree. Positions are
 * percentage attributes (no inline styles: the page's CSP is `style-src 'self'`); each bar is a
 * nested `<svg>`, which clips its label. Colour is the frame's origin (see `frameKind`). Click a
 * bar to zoom into it.
 */
export function FlameGraph({ root }: { root: FlameNode }) {
  const [focus, setFocus] = useState("");
  const { bars, depth } = layoutFlame(root, focus);
  const total = root.totalSamples;
  if (bars.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No JavaScript ran on the main thread during this capture.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FlameLegend />
        {focus !== "" && (
          <Button variant="outline" size="sm" onClick={() => setFocus("")}>
            <RotateCcw />
            Reset zoom
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-muted/40 p-1">
        <svg
          data-testid="flame-graph"
          role="img"
          aria-label="Flame graph: callers above, callees below; width is the share of samples; colour is where the code lives"
          width="100%"
          height={depth * ROW}
          className="block"
        >
          {bars.map((bar) => (
            <svg
              key={bar.path}
              data-testid="flame-bar"
              data-name={bar.node.functionName}
              data-origin={bar.kind}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: an SVG bar cannot be a <button>; it is focusable and answers Enter and Space
              role="button"
              aria-label={frameLabel(bar.node)}
              tabIndex={0}
              x={pct(bar.x)}
              y={bar.depth * ROW}
              width={pct(bar.width)}
              height={ROW - 1}
              className="group cursor-pointer outline-none"
              onClick={() => setFocus(bar.path)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setFocus(bar.path);
                }
              }}
            >
              <title>
                {`${frameLabel(bar.node)}\n${frameKindLabel[bar.kind]}\n${formatShare(bar.node.totalSamples, total)} of samples (self ${formatShare(bar.node.selfSamples, total)})`}
              </title>
              <rect
                width="100%"
                height="100%"
                rx={3}
                className={cn(
                  kindFill[bar.kind],
                  "stroke-background group-hover:opacity-80 group-focus-visible:stroke-foreground",
                )}
                strokeWidth={1}
              />
              <text
                x={6}
                y={14.5}
                className="fill-neutral-950 font-mono text-[11px] font-medium"
              >
                {bar.node.functionName}
              </text>
            </svg>
          ))}
        </svg>
      </div>
    </div>
  );
}

/**
 * Where the capture's CPU went, by the origin of the code: your code, `node_modules`, Node's
 * built-ins, V8. Computed from the flame tree's own samples; what the server pruned from the
 * tree is its own grey slice.
 */
export function OriginDonut({ root }: { root: FlameNode }) {
  const shares = useMemo(() => cpuByOrigin(root), [root]);
  const items = shares.map((s) => ({
    key: s.kind,
    value: s.samples,
    color: s.kind === "pruned" ? "--muted-foreground" : frameKindColor[s.kind],
  }));
  const app = shares.find((s) => s.kind === "app");
  const top = [...shares].sort((a, b) => b.samples - a.samples)[0];
  const label = top
    ? `CPU by origin: ${(top.fraction * 100).toFixed(0)}% ${top.kind === "pruned" ? "in small frames" : frameKindLabel[top.kind]}`
    : "CPU by origin: no samples";
  if (shares.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No samples to split by origin.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-6">
      <Donut
        testId="origin-donut"
        label={label}
        slices={donutSlices(items, DONUT_RADIUS)}
      >
        <span className="text-xl font-semibold">
          {formatShare(app?.samples ?? 0, root.totalSamples)}
        </span>
        <span className="text-xs text-muted-foreground">your code</span>
      </Donut>
      <DonutLegend
        testId="origin-legend"
        rowTestId="origin-row"
        items={shares.map((s) => ({
          key: s.kind,
          label:
            s.kind === "pruned"
              ? "Small frames (pruned)"
              : frameKindLabel[s.kind],
          color:
            s.kind === "pruned" ? "--muted-foreground" : frameKindColor[s.kind],
          value: formatShare(s.samples, root.totalSamples),
        }))}
      />
    </div>
  );
}

export function TopFunctions({
  functions,
  totalSamples,
}: {
  functions: ProfileFunction[];
  totalSamples: number;
}) {
  const shown = functions.slice(0, 25);
  const maxSelf = Math.max(1, ...shown.map((f) => f.selfSamples));
  return (
    <Table data-testid="top-functions" containerClassName="max-h-96">
      <TableHeader>
        <TableRow className="border-border">
          <TableHead>Function</TableHead>
          <TableHead>Location</TableHead>
          <TableHead className="text-right">Self</TableHead>
          <TableHead className="text-right">Total</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shown.map((f) => {
          const kind = frameKind(f.url, f.functionName);
          return (
            <TableRow
              key={`${f.functionName}:${f.url}:${f.line}:${f.column}`}
              className="border-border"
            >
              <TableCell className="font-mono">
                <span className="flex items-center gap-2">
                  <span
                    title={frameKindLabel[kind]}
                    className="inline-flex shrink-0"
                  >
                    <Swatch color={frameKindColor[kind]} />
                  </span>
                  {f.functionName}
                </span>
              </TableCell>
              <TableCell
                className="max-w-56 truncate font-mono text-xs text-muted-foreground"
                title={f.url}
              >
                {f.url ? `${shortUrl(f.url)}:${f.line}` : ""}
              </TableCell>
              <TableCell>
                <BarCell
                  value={f.selfSamples}
                  max={maxSelf}
                  label={formatShare(f.selfSamples, totalSamples)}
                  color={frameKindColor[kind]}
                />
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {formatShare(f.totalSamples, totalSamples)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * One capture, embedded or remote: a heading with what it is (`title`, `subtitle`, and `actions`
 * such as the download), the flame graph, the top functions and the CPU by origin.
 */
export function ProfileBody({
  id,
  flame,
  topFunctions,
  samples,
  title,
  subtitle,
  actions,
}: {
  id: string;
  flame: FlameNode;
  topFunctions: ProfileFunction[];
  samples: number;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="space-y-4" data-testid="profile-view">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {actions}
      </div>
      <Section
        testId="flame-section"
        title="Flame graph"
        description="Width is the share of samples; click a frame to zoom"
        source={SOURCE_CAPTURE}
      >
        <FlameGraph key={id} root={flame} />
      </Section>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Section
          testId="top-functions-section"
          title="Top functions by self time"
          description="Merged over every call path"
          source={SOURCE_CAPTURE}
          flush
        >
          <TopFunctions functions={topFunctions} totalSamples={samples} />
        </Section>
        <Section
          testId="origin-section"
          title="CPU by origin"
          description="Own time of each frame, by where its code lives; idle time excluded"
          source={SOURCE_CAPTURE}
        >
          <OriginDonut root={flame} />
        </Section>
      </div>
    </div>
  );
}

/** The `.cpuprofile` download link; `href` differs between the embedded and remote APIs. */
export function DownloadLink({ href }: { href: string }) {
  return (
    <a
      data-testid="profile-download"
      href={href}
      download
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      <Download />
      Download .cpuprofile
    </a>
  );
}

/** A refused start or a failed load: one alert, in the destructive text colour. */
export function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive-text"
    >
      {children}
    </p>
  );
}

/** A thin progress bar for a running capture; `value` and `max` in the same unit. */
export function CaptureProgress({
  value,
  max,
  label = "Capture progress",
  className,
}: {
  value: number;
  max: number;
  label?: string;
  className?: string;
}) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className="h-full rounded-full bg-info"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** What a capture shows and what it does not. */
export function ProfilerCaveats() {
  return (
    <aside
      data-testid="profiler-caveats"
      className="flex gap-3 rounded-lg border border-border bg-muted/40 p-4 text-xs text-muted-foreground"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p>
          What a capture shows: JavaScript on the main thread only (worker
          threads are not included), sampled about every millisecond.
        </p>
        <p>
          Lines are those of the JavaScript that ran; source maps are not
          applied. Open the downloaded file in Chrome DevTools or speedscope for
          a full view.
        </p>
        <p>
          A function V8 inlined can appear under its caller instead of on its
          own, more often after the first capture in a process.
        </p>
      </div>
    </aside>
  );
}
