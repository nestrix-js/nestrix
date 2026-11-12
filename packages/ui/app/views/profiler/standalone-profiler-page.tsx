import type {
  InstanceSummary,
  RemoteProfileState,
  RemoteProfileSummary,
} from "@nestrix-js/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame } from "lucide-react";
import { useState } from "react";

import { Chip } from "@/components/kit/chip";
import type { ChipTone } from "@/components/kit/format";
import { PageHeader } from "@/components/kit/page-header";
import { Section } from "@/components/kit/section";
import { SkeletonList } from "@/components/kit/skeletons";
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
  ApiRequestError,
  getInstances,
  getRemoteProfile,
  getRemoteProfiles,
  remoteProfileDownloadUrl,
  startRemoteProfile,
} from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { POLL_INTERVAL_MS, pollInterval, usePaused } from "@/lib/live";
import { useService } from "@/lib/service";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import {
  formatBytes,
  startPauseWarning,
} from "@/views/profiler/profile-format";
import {
  CaptureProgress,
  DownloadLink,
  Problem,
  ProfileBody,
  ProfilerCaveats,
} from "@/views/profiler/profile-parts";
import {
  captureStatus,
  durationLabel,
  isActive,
  REMOTE_DEFAULT_SECONDS,
  REMOTE_DURATION_OPTIONS,
  shortInstanceId,
  stateLabel,
} from "@/views/profiler/remote-format";
import {
  remoteStartProblem,
  retryRemaining,
} from "@/views/profiler/start-problem";

const OPT_IN_SNIPPET = `NestrixModule.forRoot({
  export: {
    profiler: true,
    otlp: { endpoint, headers },
  },
});`;

const SOURCE_INSTANCES = "from instance check-ins";
const SOURCE_CAPTURES = "from this server's capture store";

const stateTone: Record<RemoteProfileState, ChipTone> = {
  pending: "neutral",
  running: "info",
  done: "better",
  failed: "worse",
  expired: "worse",
};

/** A refused start, kept with when it arrived so a `429`'s countdown can run. */
interface RefusedStart {
  error: Error;
  instanceId: string;
  atMs: number;
}

function RemoteProfileView({ summary }: { summary: RemoteProfileSummary }) {
  const now = useNow();
  const detail = useQuery({
    queryKey: ["remote-profile", summary.id],
    queryFn: () => getRemoteProfile(summary.id),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (detail.isError) return <Problem>{detail.error.message}</Problem>;
  const data = detail.data;
  if (!data) return <SkeletonList rows={5} />;
  if (!data.flame || !data.topFunctions) {
    return (
      <EmptyState
        title="This capture has no profile to show"
        icon={<Flame />}
      />
    );
  }
  const samples = data.samples ?? data.flame.totalSamples;
  return (
    <ProfileBody
      id={data.id}
      flame={data.flame}
      topFunctions={data.topFunctions}
      samples={samples}
      title={`Capture of ${shortInstanceId(data.instanceId)} from ${formatRelative(data.requestedAtUnixMs, now)}`}
      subtitle={`${samples.toLocaleString("en")} samples · ${data.bytes === null ? "" : `${formatBytes(data.bytes)} · `}${durationLabel(Math.round(data.durationMs / 1000))} · main thread JavaScript, no source maps`}
      actions={<DownloadLink href={remoteProfileDownloadUrl(data.id).href} />}
    />
  );
}

function InstanceRow({
  instance,
  now,
  starting,
  onCapture,
}: {
  instance: InstanceSummary;
  now: number;
  starting: boolean;
  onCapture: () => void;
}) {
  const capture = instance.capture;
  const active = capture !== null && isActive(capture);
  const status = active ? captureStatus(capture, now) : null;
  return (
    <TableRow
      data-testid="instance-row"
      data-instance={instance.instanceId}
      className="border-border"
    >
      <TableCell className="font-mono">{instance.service}</TableCell>
      <TableCell className="font-mono" title={instance.instanceId}>
        {shortInstanceId(instance.instanceId)}
      </TableCell>
      <TableCell className="font-mono text-xs">
        {instance.version ?? ""}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {instance.host ?? ""}
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {instance.pid ?? ""}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {formatRelative(instance.lastSeenUnixMs, now)}
      </TableCell>
      <TableCell className="min-w-52">
        <div className="flex items-center justify-end gap-3">
          {status && (
            <div className="flex min-w-0 flex-1 flex-col items-end gap-1">
              <span
                id={`status-${instance.instanceId}`}
                data-testid="instance-status"
                className="text-xs text-muted-foreground"
              >
                {status.label}
              </span>
              {capture && status.progress != null && (
                <CaptureProgress
                  value={status.progress}
                  max={capture.durationMs}
                  className="w-full"
                />
              )}
            </div>
          )}
          <Button
            size="sm"
            disabled={active || starting}
            aria-describedby={
              active ? `status-${instance.instanceId}` : undefined
            }
            onClick={onCapture}
          >
            <Flame />
            Capture
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * The standalone server's profiler (D-76): the instances that opted in with
 * `export.profiler: true`, a capture ordered on one of them (it picks the order up on its next
 * check-in), and the captured profiles.
 */
export function StandaloneProfilerPage() {
  const queryClient = useQueryClient();
  const now = useNow();
  const [paused] = usePaused();
  const [service] = useService();
  const [seconds, setSeconds] = useState<number>(REMOTE_DEFAULT_SECONDS);
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState<RefusedStart | null>(null);

  const instances = useQuery({
    queryKey: ["instances", service ?? null],
    queryFn: () => getInstances(service),
    refetchInterval: (q) =>
      q.state.data?.instances.some((i) => i.capture && isActive(i.capture))
        ? POLL_INTERVAL_MS
        : pollInterval(paused),
    refetchIntervalInBackground: false,
  });
  const anyActive =
    instances.data?.instances.some((i) => i.capture && isActive(i.capture)) ??
    false;
  const history = useQuery({
    queryKey: ["remote-profiles", service ?? null],
    queryFn: () => getRemoteProfiles(service),
    refetchInterval: anyActive ? POLL_INTERVAL_MS : pollInterval(paused),
    refetchIntervalInBackground: false,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["instances"] });
    await queryClient.invalidateQueries({ queryKey: ["remote-profiles"] });
  };
  const start = useMutation({
    mutationFn: (instance: InstanceSummary) =>
      startRemoteProfile({
        service: instance.service,
        instanceId: instance.instanceId,
        durationSeconds: seconds,
      }),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
    },
    onError: async (error, instance) => {
      setProblem({
        error,
        instanceId: instance.instanceId,
        atMs: Date.now(),
      });
      // A 409 or 404 means the list was stale: show the real state.
      await refresh();
    },
  });

  const list = instances.data?.instances;
  const profiles = history.data?.profiles;
  const shown =
    selected ?? profiles?.find((p) => p.state === "done")?.id ?? null;
  const shownProfile = profiles?.find((p) => p.id === shown);

  let problemText: string | null = null;
  if (problem) {
    const remaining =
      problem.error instanceof ApiRequestError &&
      problem.error.retryAfterSeconds !== undefined
        ? retryRemaining(problem.error.retryAfterSeconds, problem.atMs, now)
        : null;
    problemText = remoteStartProblem(
      problem.error,
      shortInstanceId(problem.instanceId),
      remaining,
    );
  }

  return (
    <section className="space-y-6" aria-label="Profiler">
      <PageHeader
        title="CPU profiler"
        description="Instances that opted in with export.profiler check in every 15 s; pick one and capture where its main thread spends its time"
        source="captured on demand, per instance"
        controls={
          <div className="flex items-center gap-2 text-sm">
            <label htmlFor="remote-duration" className="font-medium">
              Duration
            </label>
            <select
              id="remote-duration"
              value={seconds}
              onChange={(e) => setSeconds(Number(e.target.value))}
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            >
              {REMOTE_DURATION_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {durationLabel(s)}
                </option>
              ))}
            </select>
          </div>
        }
      />
      <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
        <p data-testid="start-pause-warning">{startPauseWarning(null)}</p>
        <p>
          Each instance picks the capture up on its next check-in, every 15 s.
        </p>
      </div>
      {problemText && <Problem>{problemText}</Problem>}

      {instances.isPending && <SkeletonList rows={3} />}
      {instances.isError && !list && (
        <Problem>Could not load instances: {instances.error.message}</Problem>
      )}

      {list && list.length === 0 && (
        <EmptyState
          testId="instances-empty"
          icon={<Flame />}
          title="No instance has checked in during the last 2 minutes"
          action={
            <>
              <pre className="max-w-full overflow-x-auto rounded-lg bg-muted p-3 text-left font-mono text-xs">
                <code>{OPT_IN_SNIPPET}</code>
              </pre>
              <p className="max-w-md text-sm text-muted-foreground">
                The application starts each capture by pausing its main thread
                briefly, as the note above says.
              </p>
            </>
          }
        >
          An application appears here once it opts in to remote profiling and
          sends its traces to this server:
        </EmptyState>
      )}

      {list && list.length > 0 && (
        <Section
          testId="instances-section"
          title="Instances"
          description="Seen in the last 2 minutes, newest check-in first"
          source={SOURCE_INSTANCES}
          flush
        >
          <Table data-testid="instances">
            <TableHeader>
              <TableRow className="border-border">
                <TableHead>Service</TableHead>
                <TableHead>Instance</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Host</TableHead>
                <TableHead className="text-right">PID</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="text-right">Capture</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((instance) => (
                <InstanceRow
                  key={`${instance.service}:${instance.instanceId}`}
                  instance={instance}
                  now={now}
                  starting={
                    start.isPending &&
                    start.variables?.instanceId === instance.instanceId
                  }
                  onCapture={() => {
                    setProblem(null);
                    start.mutate(instance);
                  }}
                />
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {history.isError && !profiles && (
        <Problem>Could not load captures: {history.error.message}</Problem>
      )}
      {profiles && profiles.length === 0 && (
        <EmptyState
          testId="profiles-empty"
          icon={<Flame />}
          title="No captures yet"
        >
          Capture an instance above; its profile shows up here.
        </EmptyState>
      )}
      {profiles && profiles.length > 0 && (
        <Section
          testId="captures-section"
          title="Recent captures"
          description="Newest first, at most 50"
          source={SOURCE_CAPTURES}
          flush
        >
          <Table data-testid="remote-profiles">
            <TableHeader>
              <TableRow className="border-border">
                <TableHead>State</TableHead>
                <TableHead>Instance</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Requested</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead className="text-right">Samples</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((p) => (
                <TableRow
                  key={p.id}
                  data-testid="remote-profile-row"
                  data-state={p.state}
                  data-selected={p.id === shown}
                  className={cn("border-border", p.id === shown && "bg-muted")}
                >
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <Chip
                        data-testid="state-badge"
                        tone={stateTone[p.state]}
                        title={p.error ?? undefined}
                      >
                        {stateLabel[p.state]}
                      </Chip>
                      {p.error && (
                        <span className="text-xs text-muted-foreground">
                          {p.error}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono" title={p.instanceId}>
                    {shortInstanceId(p.instanceId)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {p.version ?? ""}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatRelative(p.requestedAtUnixMs, now)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {durationLabel(Math.round(p.durationMs / 1000))}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {p.samples ?? ""}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {p.bytes === null ? "" : formatBytes(p.bytes)}
                  </TableCell>
                  <TableCell className="text-right">
                    {p.state === "done" && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-pressed={p.id === shown}
                        onClick={() => setSelected(p.id)}
                      >
                        View
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {shownProfile && shownProfile.state === "done" && (
        <RemoteProfileView key={shownProfile.id} summary={shownProfile} />
      )}

      <ProfilerCaveats />
    </section>
  );
}
