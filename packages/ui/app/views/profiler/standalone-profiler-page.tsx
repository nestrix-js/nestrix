import type {
  InstanceSummary,
  RemoteProfileSummary,
} from "@nestrix-js/protocol";
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
  DownloadLink,
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

/** A refused start, kept with when it arrived so a `429`'s countdown can run. */
interface Problem {
  error: Error;
  instanceId: string;
  atMs: number;
}

function RemoteProfileView({ summary }: { summary: RemoteProfileSummary }) {
  const detail = useQuery({
    queryKey: ["remote-profile", summary.id],
    queryFn: () => getRemoteProfile(summary.id),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (detail.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {detail.error.message}
      </p>
    );
  }
  const data = detail.data;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data.flame || !data.topFunctions) {
    return (
      <p className="text-sm text-muted-foreground">
        This capture has no profile to show.
      </p>
    );
  }
  return (
    <ProfileBody
      id={data.id}
      flame={data.flame}
      topFunctions={data.topFunctions}
      samples={data.samples ?? data.flame.totalSamples}
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
    <TableRow data-testid="instance-row" data-instance={instance.instanceId}>
      <TableCell className="font-mono">{instance.service}</TableCell>
      <TableCell className="font-mono" title={instance.instanceId}>
        {shortInstanceId(instance.instanceId)}
      </TableCell>
      <TableCell>{instance.version ?? ""}</TableCell>
      <TableCell>{instance.host ?? ""}</TableCell>
      <TableCell className="text-right font-mono">
        {instance.pid ?? ""}
      </TableCell>
      <TableCell>{formatRelative(instance.lastSeenUnixMs, now)}</TableCell>
      <TableCell className="space-y-1">
        <div className="flex items-center gap-2">
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
          {status && (
            <span
              id={`status-${instance.instanceId}`}
              data-testid="instance-status"
              className="text-xs text-muted-foreground"
            >
              {status.label}
            </span>
          )}
        </div>
        {capture && status?.progress != null && (
          <progress
            className="h-1.5 w-full accent-primary"
            max={capture.durationMs}
            value={status.progress}
            aria-label="Capture progress"
          />
        )}
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
  const [problem, setProblem] = useState<Problem | null>(null);

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
    <section className="space-y-4" aria-label="Profiler">
      <h2 className="text-lg font-semibold">Profiler</h2>

      <div className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1 text-sm">
            <label htmlFor="remote-duration" className="block font-medium">
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
          <p className="text-sm text-muted-foreground">
            Each instance picks the capture up on its next check-in, every 15 s.
          </p>
        </div>
        <p
          data-testid="start-pause-warning"
          className="text-sm text-muted-foreground"
        >
          {startPauseWarning(null)}
        </p>
        {problemText && (
          <p role="alert" className="text-sm text-destructive">
            {problemText}
          </p>
        )}
      </div>

      {instances.isError && !list && (
        <p role="alert" className="text-sm text-destructive">
          Could not load instances: {instances.error.message}
        </p>
      )}

      {list && list.length === 0 && (
        <div
          data-testid="instances-empty"
          className="space-y-2 rounded-lg border border-border p-6 text-sm text-muted-foreground"
        >
          <p>
            No instance has checked in during the last 2 minutes. An application
            appears here once it opts in to remote profiling and sends its
            traces to this server:
          </p>
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs text-foreground">
            <code>{OPT_IN_SNIPPET}</code>
          </pre>
          <p>
            The application starts each capture by pausing its main thread
            briefly, as the note above says.
          </p>
        </div>
      )}

      {list && list.length > 0 && (
        <Table data-testid="instances">
          <TableHeader>
            <TableRow>
              <TableHead>Service</TableHead>
              <TableHead>Instance</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Host</TableHead>
              <TableHead className="text-right">PID</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead />
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
      )}

      <h3 className="font-semibold">Captures</h3>
      {history.isError && !profiles && (
        <p role="alert" className="text-sm text-destructive">
          Could not load captures: {history.error.message}
        </p>
      )}
      {profiles && profiles.length === 0 && (
        <p
          data-testid="profiles-empty"
          className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground"
        >
          No captures yet.
        </p>
      )}
      {profiles && profiles.length > 0 && (
        <Table data-testid="remote-profiles">
          <TableHeader>
            <TableRow>
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
                className={cn(p.id === shown && "bg-muted")}
              >
                <TableCell>
                  <span
                    data-testid="state-badge"
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs",
                      p.state === "done"
                        ? "bg-secondary text-secondary-foreground"
                        : p.state === "failed" || p.state === "expired"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-muted text-muted-foreground",
                    )}
                    title={p.error ?? undefined}
                  >
                    {stateLabel[p.state]}
                  </span>
                  {p.error && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {p.error}
                    </span>
                  )}
                </TableCell>
                <TableCell className="font-mono" title={p.instanceId}>
                  {shortInstanceId(p.instanceId)}
                </TableCell>
                <TableCell>{p.version ?? ""}</TableCell>
                <TableCell>
                  {formatRelative(p.requestedAtUnixMs, now)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {durationLabel(Math.round(p.durationMs / 1000))}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {p.samples ?? ""}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {p.bytes === null ? "" : formatBytes(p.bytes)}
                </TableCell>
                <TableCell className="space-x-2 text-right">
                  {p.state === "done" && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelected(p.id)}
                      >
                        View
                      </Button>
                      <DownloadLink
                        href={remoteProfileDownloadUrl(p.id).href}
                      />
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {shownProfile && shownProfile.state === "done" && (
        <RemoteProfileView summary={shownProfile} />
      )}

      <ProfilerCaveats />
    </section>
  );
}
