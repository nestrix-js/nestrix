// biome-ignore-all lint/a11y/useSemanticElements: flame graph bars are SVG elements, which cannot be <button>s; each is focusable and answers Enter and Space
import type { FlameNode, ProfileFunction } from "@nestrix-js/protocol";
import { Download, RotateCcw } from "lucide-react";
import { useState } from "react";

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
  type FrameKind,
  formatShare,
  frameKindLabel,
  frameLabel,
  layoutFlame,
  shortUrl,
} from "@/views/profiler/profile-format";

const ROW = 18;

const kindFill: Record<FrameKind, string> = {
  app: "fill-flame-app",
  deps: "fill-flame-deps",
  runtime: "fill-flame-runtime",
};
const kindSwatch: Record<FrameKind, string> = {
  app: "bg-flame-app",
  deps: "bg-flame-deps",
  runtime: "bg-flame-runtime",
};

const pct = (fraction: number) => `${(fraction * 100).toFixed(4)}%`;

/**
 * Top-down flame graph in SVG, computed from the server's pruned call tree. Positions are
 * percentage attributes (no inline styles: the page's CSP is `style-src 'self'`); each bar is a
 * nested `<svg>`, which clips its label. Click a bar to zoom into it.
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(Object.keys(frameKindLabel) as FrameKind[]).map((kind) => (
          <span key={kind} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn("size-2.5 rounded-sm", kindSwatch[kind])}
            />
            {frameKindLabel[kind]}
          </span>
        ))}
        {focus !== "" && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setFocus("")}
          >
            <RotateCcw />
            Reset zoom
          </Button>
        )}
      </div>
      <svg
        data-testid="flame-graph"
        role="img"
        aria-label="Flame graph: callers above, callees below; width is the share of samples"
        width="100%"
        height={depth * ROW}
        className="block"
      >
        {bars.map((bar) => (
          <svg
            key={bar.path}
            data-testid="flame-bar"
            data-name={bar.node.functionName}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: an SVG bar cannot be a <button>; it is focusable and answers Enter and Space
            role="button"
            tabIndex={0}
            x={pct(bar.x)}
            y={bar.depth * ROW}
            width={pct(bar.width)}
            height={ROW - 1}
            className="cursor-pointer focus:outline-none"
            onClick={() => setFocus(bar.path)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setFocus(bar.path);
              }
            }}
          >
            <title>
              {`${frameLabel(bar.node)}\n${formatShare(bar.node.totalSamples, total)} of samples (self ${formatShare(bar.node.selfSamples, total)})`}
            </title>
            <rect
              width="100%"
              height="100%"
              rx={2}
              className={cn(kindFill[bar.kind], "stroke-background")}
              strokeWidth={1}
            />
            <text x={4} y={12.5} className="fill-neutral-950 text-[11px]">
              {bar.node.functionName}
            </text>
          </svg>
        ))}
      </svg>
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
  return (
    <Table data-testid="top-functions">
      <TableHeader>
        <TableRow>
          <TableHead>Function</TableHead>
          <TableHead>Location</TableHead>
          <TableHead className="text-right">Self</TableHead>
          <TableHead className="text-right">Total</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {functions.slice(0, 25).map((f) => (
          <TableRow key={`${f.functionName}:${f.url}:${f.line}:${f.column}`}>
            <TableCell className="font-mono">{f.functionName}</TableCell>
            <TableCell
              className="font-mono text-xs text-muted-foreground"
              title={f.url}
            >
              {f.url ? `${shortUrl(f.url)}:${f.line}` : ""}
            </TableCell>
            <TableCell className="text-right font-mono">
              {formatShare(f.selfSamples, totalSamples)}
            </TableCell>
            <TableCell className="text-right font-mono">
              {formatShare(f.totalSamples, totalSamples)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The flame graph and the top-functions table of one capture, embedded or remote. */
export function ProfileBody({
  id,
  flame,
  topFunctions,
  samples,
}: {
  id: string;
  flame: FlameNode;
  topFunctions: ProfileFunction[];
  samples: number;
}) {
  return (
    <div className="space-y-4" data-testid="profile-view">
      <div className="space-y-1">
        <h3 className="font-semibold">Flame graph</h3>
        <FlameGraph key={id} root={flame} />
      </div>
      <div className="space-y-1">
        <h3 className="font-semibold">Top functions by self time</h3>
        <TopFunctions functions={topFunctions} totalSamples={samples} />
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
      className={buttonVariants({ variant: "ghost", size: "sm" })}
    >
      <Download />
      .cpuprofile
    </a>
  );
}

/** What a capture shows and what it does not. */
export function ProfilerCaveats() {
  return (
    <div
      data-testid="profiler-caveats"
      className="space-y-1 text-xs text-muted-foreground"
    >
      <p>
        What a capture shows: JavaScript on the main thread only (worker threads
        are not included), sampled about every millisecond.
      </p>
      <p>
        Lines are those of the JavaScript that ran; source maps are not applied.
        Open the downloaded file in Chrome DevTools or speedscope for a full
        view.
      </p>
      <p>
        A function V8 inlined can appear under its caller instead of on its own,
        more often after the first capture in a process.
      </p>
    </div>
  );
}
