import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
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
  formatBytes,
  formatMs,
  startPauseWarning,
} from "@/views/profiler/profile-format";
import {
  DownloadLink,
  ProfileBody,
  ProfilerCaveats,
} from "@/views/profiler/profile-parts";
import { StandaloneProfilerPage } from "@/views/profiler/standalone-profiler-page";
import { startProblem } from "@/views/profiler/start-problem";

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
    <ProfileBody
      id={id}
      flame={detail.data.flame}
      topFunctions={detail.data.topFunctions}
      samples={detail.data.samples}
    />
  );
}

/** The on-demand CPU profiler (P7-02): start a capture, list the last three, inspect one. */
function EmbeddedProfilerPage() {
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
    onError: (error) => setProblem(startProblem(error)),
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
                  <DownloadLink href={profileDownloadUrl(p.id).href} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {shown && data?.profiles.some((p) => p.id === shown) && (
        <ProfileView id={shown} />
      )}

      <ProfilerCaveats />
    </section>
  );
}

/**
 * The profiler route: the standalone server's page (instances, remote captures) when its meta
 * says `profiler.remote`, otherwise the embedded dashboard's own.
 */
export function ProfilerPage() {
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  return meta.data?.mode === "standalone" && meta.data.profiler?.remote ? (
    <StandaloneProfilerPage />
  ) : (
    <EmbeddedProfilerPage />
  );
}
