import type { ProfileSummary } from "@nestrix-js/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame } from "lucide-react";
import { useState } from "react";

import { Chip } from "@/components/kit/chip";
import { PageHeader } from "@/components/kit/page-header";
import { Section } from "@/components/kit/section";
import { SkeletonChart, SkeletonList } from "@/components/kit/skeletons";
import { EmptyState } from "@/components/kit/states";
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
  CaptureProgress,
  DownloadLink,
  Problem,
  ProfileBody,
  ProfilerCaveats,
} from "@/views/profiler/profile-parts";
import { StandaloneProfilerPage } from "@/views/profiler/standalone-profiler-page";
import { startProblem } from "@/views/profiler/start-problem";

const SOURCE_PROCESS = "this process, captured on demand";
const DESCRIPTION = "Where the main thread spends its time";

function ProfileView({ summary }: { summary: ProfileSummary }) {
  const now = useNow();
  const detail = useQuery({
    queryKey: ["profile", summary.id],
    queryFn: () => getProfile(summary.id),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (detail.isError) return <Problem>{detail.error.message}</Problem>;
  if (!detail.data) {
    return (
      <div className="space-y-4" aria-busy="true">
        <SkeletonChart heightClass="h-32" />
        <SkeletonList rows={5} />
      </div>
    );
  }
  return (
    <ProfileBody
      id={summary.id}
      flame={detail.data.flame}
      topFunctions={detail.data.topFunctions}
      samples={detail.data.samples}
      title={`Capture from ${formatRelative(summary.startedAtUnixMs, now)}`}
      subtitle={`${summary.samples.toLocaleString("en")} samples · ${formatMs(summary.actualDurationMs)} · ${formatBytes(summary.bytes)} · main thread JavaScript, no source maps`}
      actions={<DownloadLink href={profileDownloadUrl(summary.id).href} />}
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
      <section aria-label="Profiler" className="space-y-6">
        <PageHeader
          title="CPU profiler"
          description={DESCRIPTION}
          source={SOURCE_PROCESS}
        />
        <EmptyState
          testId="profiler-unavailable"
          icon={<Flame />}
          title="The CPU profiler is not available here"
        >
          The CPU profiler is available in an application's embedded dashboard
          when it is authenticated (the startup link, or ui.auth) and
          ui.profiler is not false.
        </EmptyState>
      </section>
    );
  }

  const data = profiles.data;
  const running = data?.running ?? null;
  const shown = selected ?? data?.profiles[0]?.id ?? null;
  const shownSummary = data?.profiles.find((p) => p.id === shown);
  const elapsed = running
    ? Math.min(running.durationMs, Math.max(0, now - running.startedAtUnixMs))
    : 0;

  return (
    <section className="space-y-6" aria-label="Profiler">
      <PageHeader
        title="CPU profiler"
        description={DESCRIPTION}
        source={SOURCE_PROCESS}
      />
      <Section
        testId="capture-controls"
        title="Start a capture"
        description="Samples the main thread's JavaScript for the chosen time"
        source={SOURCE_PROCESS}
      >
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
          <div className="space-y-1.5" data-testid="capture-running">
            <CaptureProgress value={elapsed} max={running.durationMs} />
            <p className="text-xs text-muted-foreground">
              {`Capturing: ${formatMs(elapsed)} of ${formatMs(running.durationMs)}. Starting it paused the application for ${formatMs(running.startPauseMs)}.`}
            </p>
          </div>
        )}
        {problem && <Problem>{problem}</Problem>}
        {data?.lastError && (
          <p
            data-testid="last-error"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive-text"
          >
            A capture failed {formatRelative(data.lastError.atUnixMs, now)}:{" "}
            {data.lastError.message}
          </p>
        )}
      </Section>

      {profiles.isError && !data && (
        <Problem>Could not load captures: {profiles.error.message}</Problem>
      )}

      {data && data.profiles.length === 0 && !running && (
        <EmptyState
          testId="profiles-empty"
          icon={<Flame />}
          title="No captures yet"
        >
          {`Start one above. The last ${data.limits.kept} are kept in memory until the application restarts.`}
        </EmptyState>
      )}

      {data && data.profiles.length > 0 && (
        <Section
          testId="recent-captures"
          title="Recent captures"
          description={`The last ${data.limits.kept} are kept in memory until the application restarts`}
          source={SOURCE_PROCESS}
          flush
        >
          <Table data-testid="profiles">
            <TableHeader>
              <TableRow className="border-border">
                <TableHead>Started</TableHead>
                <TableHead>State</TableHead>
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
                  className={cn("border-border", p.id === shown && "bg-muted")}
                >
                  <TableCell>
                    {formatRelative(p.startedAtUnixMs, now)}
                  </TableCell>
                  <TableCell>
                    <Chip tone="better">Done</Chip>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatMs(p.actualDurationMs)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {p.samples}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatMs(p.startPauseMs)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatBytes(p.bytes)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-pressed={p.id === shown}
                      onClick={() => setSelected(p.id)}
                    >
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {shownSummary && (
        <ProfileView key={shownSummary.id} summary={shownSummary} />
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
