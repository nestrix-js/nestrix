// biome-ignore-all lint/a11y/useSemanticElements: flame graph bars are SVG elements, which cannot be <button>s; each is focusable and answers Enter and Space
import type { FlameNode, ProfileDetail } from "@nestrix-js/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Flame, RotateCcw } from "lucide-react";
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
import {
  getMeta,
  getProfile,
  getProfiles,
  profileDownloadUrl,
  startProfile,
} from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import {
  DURATION_OPTIONS,
  type FrameKind,
  formatBytes,
  formatMs,
  formatShare,
  frameKindLabel,
  frameLabel,
  layoutFlame,
  shortUrl,
  startPauseWarning,
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
function FlameGraph({ root }: { root: FlameNode }) {
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

function TopFunctions({ detail }: { detail: ProfileDetail }) {
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
        {detail.topFunctions.slice(0, 25).map((f) => (
          <TableRow key={`${f.functionName}:${f.url}:${f.line}:${f.column}`}>
            <TableCell className="font-mono">{f.functionName}</TableCell>
            <TableCell
              className="font-mono text-xs text-muted-foreground"
              title={f.url}
            >
              {f.url ? `${shortUrl(f.url)}:${f.line}` : ""}
            </TableCell>
            <TableCell className="text-right font-mono">
              {formatShare(f.selfSamples, detail.samples)}
            </TableCell>
            <TableCell className="text-right font-mono">
              {formatShare(f.totalSamples, detail.samples)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ProfileView({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ["profile", id],
    queryFn: () => getProfile(id),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (detail.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {detail.error.message}
      </p>
    );
  }
  if (!detail.data)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-4" data-testid="profile-view">
      <div className="space-y-1">
        <h3 className="font-semibold">Flame graph</h3>
        <FlameGraph key={id} root={detail.data.flame} />
      </div>
      <div className="space-y-1">
        <h3 className="font-semibold">Top functions by self time</h3>
        <TopFunctions detail={detail.data} />
      </div>
    </div>
  );
}

/** The on-demand CPU profiler (P7-02): start a capture, list the last three, inspect one. */
export function ProfilerPage() {
  const queryClient = useQueryClient();
  const now = useNow();
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const available = meta.data?.profiler?.available === true;
  const profiles = useQuery({
    queryKey: ["profiles"],
    queryFn: getProfiles,
    enabled: available,
    refetchInterval: (q) => (q.state.data?.running ? 1000 : 10_000),
    refetchIntervalInBackground: false,
  });
  const [duration, setDuration] = useState<number>(30);
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => startProfile(duration),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
      await queryClient.invalidateQueries({ queryKey: ["meta"] });
    },
    onError: (error) => setProblem(error.message),
  });

  if (meta.data !== undefined && !available) {
    return (
      <section aria-label="Profiler" className="space-y-2">
        <h2 className="text-lg font-semibold">Profiler</h2>
        <p
          data-testid="profiler-unavailable"
          className="text-sm text-muted-foreground"
        >
          The CPU profiler is available in an application's embedded dashboard
          when it is authenticated (the startup link, or ui.auth) and
          ui.profiler is not false.
        </p>
      </section>
    );
  }

  const data = profiles.data;
  const running = data?.running ?? null;
  const shown = selected ?? data?.profiles[0]?.id ?? null;
  const elapsed = running
    ? Math.min(running.durationMs, Math.max(0, now - running.startedAtUnixMs))
    : 0;

  return (
    <section className="space-y-4" aria-label="Profiler">
      <h2 className="text-lg font-semibold">Profiler</h2>
      <div className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1 text-sm">
            <label htmlFor="profile-duration" className="block font-medium">
              Duration
            </label>
            <select
              id="profile-duration"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            >
              {DURATION_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s < 60
                    ? `${s} seconds`
                    : `${s / 60} minute${s > 60 ? "s" : ""}`}
                </option>
              ))}
            </select>
          </div>
          <Button
            disabled={running !== null || start.isPending || !data}
            onClick={() => {
              setProblem(null);
              start.mutate();
            }}
          >
            <Flame />
            Start capture
          </Button>
        </div>
        <p
          data-testid="start-pause-warning"
          className="text-sm text-muted-foreground"
        >
          {startPauseWarning(data?.lastStartPauseMs ?? null)}
        </p>
        {running && (
          <div className="space-y-1" data-testid="capture-running">
            <progress
              className="h-2 w-full accent-primary"
              max={running.durationMs}
              value={elapsed}
              aria-label="Capture progress"
            />
            <p className="text-xs text-muted-foreground">
              {`Capturing: ${formatMs(elapsed)} of ${formatMs(running.durationMs)}. Starting it paused the application for ${formatMs(running.startPauseMs)}.`}
            </p>
          </div>
        )}
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        {data?.lastError && (
          <p data-testid="last-error" className="text-sm text-destructive">
            A capture failed {formatRelative(data.lastError.atUnixMs, now)}:{" "}
            {data.lastError.message}
          </p>
        )}
      </div>

      {profiles.isError && !data && (
        <p role="alert" className="text-sm text-destructive">
          Could not load captures: {profiles.error.message}
        </p>
      )}

      {data && data.profiles.length === 0 && !running && (
        <p
          data-testid="profiles-empty"
          className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground"
        >
          No captures yet. The last {data.limits.kept} are kept in memory until
          the application restarts.
        </p>
      )}

      {data && data.profiles.length > 0 && (
        <Table data-testid="profiles">
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead className="text-right">Samples</TableHead>
              <TableHead className="text-right">Start pause</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.profiles.map((p) => (
              <TableRow
                key={p.id}
                data-testid="profile-row"
                data-selected={p.id === shown}
                className={cn(p.id === shown && "bg-muted")}
              >
                <TableCell>{formatRelative(p.startedAtUnixMs, now)}</TableCell>
                <TableCell className="text-right font-mono">
                  {formatMs(p.actualDurationMs)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {p.samples}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatMs(p.startPauseMs)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatBytes(p.bytes)}
                </TableCell>
                <TableCell className="space-x-2 text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelected(p.id)}
                  >
                    View
                  </Button>
                  <a
                    data-testid="profile-download"
                    href={profileDownloadUrl(p.id).href}
                    download
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                  >
                    <Download />
                    .cpuprofile
                  </a>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {shown && data?.profiles.some((p) => p.id === shown) && (
        <ProfileView id={shown} />
      )}

      <div
        data-testid="profiler-caveats"
        className="space-y-1 text-xs text-muted-foreground"
      >
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
    </section>
  );
}
