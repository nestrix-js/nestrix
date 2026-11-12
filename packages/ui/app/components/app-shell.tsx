import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LogOut, Pause, Play } from "lucide-react";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { getMeta, signOut } from "@/lib/api";
import { readConfig } from "@/lib/config";
import { samplingNotice } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { useService } from "@/lib/service";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/", label: "Requests" },
  { to: "/errors", label: "Errors" },
  { to: "/routes", label: "Routes" },
  { to: "/classes", label: "Classes" },
  { to: "/map", label: "Map" },
] as const;
// Needs the standalone server's stored history.
const sloNav = { to: "/slos", label: "SLOs" } as const;
// The standalone server's settings (API tokens).
const settingsNav = { to: "/settings", label: "Settings" } as const;
// Embedded dashboard only, when `meta.profiler.available`.
const profilerNav = { to: "/profiler", label: "Profiler" } as const;

type Connection = "connecting" | "live" | "paused" | "disconnected";

const connectionLabel: Record<Connection, string> = {
  connecting: "Connecting",
  live: "Live",
  paused: "Paused",
  disconnected: "Disconnected",
};

/** Header (service, connection, sampling notice, live toggle), navigation, and the page. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [paused, setPaused] = usePaused();
  const meta = useQuery({
    queryKey: ["meta"],
    queryFn: getMeta,
    refetchInterval: pollInterval(paused),
    refetchIntervalInBackground: false,
  });
  const connection: Connection = meta.isError
    ? "disconnected"
    : meta.data === undefined
      ? "connecting"
      : paused
        ? "paused"
        : "live";
  const serviceName = meta.data?.service.name ?? readConfig().service;
  const notice = meta.data ? samplingNotice(meta.data.sampling) : null;
  const standalone = meta.data?.mode === "standalone";
  const profilerOn = meta.data?.profiler?.available === true;
  const services = meta.data?.services ?? [];
  const [selected, setSelected] = useService();
  // Links keep the chosen service: the hash holds it, and a plain link would drop it.
  const keep = selected ? `?service=${encodeURIComponent(selected)}` : "";

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <h1 className="text-base font-semibold">
            Nestrix{" "}
            <span className="font-mono font-normal text-muted-foreground">
              {serviceName ?? ""}
            </span>
          </h1>
          {standalone && (
            <span
              data-testid="mode"
              className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            >
              standalone server
            </span>
          )}
          {notice && (
            <span
              data-testid="sampling-notice"
              className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            >
              {notice}
            </span>
          )}
          <div className="ml-auto flex items-center gap-3">
            {services.length > 1 && (
              <select
                aria-label="Service"
                data-testid="service-select"
                value={selected ?? ""}
                onChange={(e) => void setSelected(e.target.value || undefined)}
                className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
              >
                <option value="">All services</option>
                {services.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <span
              data-testid="connection"
              data-state={connection}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 rounded-full",
                  connection === "live" && "bg-green-500",
                  connection === "connecting" && "bg-amber-500",
                  connection === "paused" && "bg-muted-foreground",
                  connection === "disconnected" && "bg-destructive",
                )}
              />
              {connectionLabel[connection]}
            </span>
            <Button
              variant="outline"
              size="sm"
              aria-pressed={paused}
              onClick={() => setPaused(!paused)}
            >
              {paused ? <Play /> : <Pause />}
              {paused ? "Resume live" : "Pause live"}
            </Button>
            {standalone && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void signOut()}
              >
                <LogOut />
                Sign out
              </Button>
            )}
          </div>
        </div>
        <nav
          aria-label="Sections"
          className="mx-auto flex max-w-6xl gap-1 px-4"
        >
          {[
            ...nav,
            ...(profilerOn ? [profilerNav] : []),
            ...(standalone ? [sloNav, settingsNav] : []),
          ].map((item) => (
            <Link
              key={item.to}
              to={`${item.to}${keep}` as typeof item.to}
              activeOptions={{ exact: item.to === "/" }}
              className="border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              activeProps={{
                className: "border-primary text-foreground font-medium",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl space-y-4 p-4">{children}</main>
    </div>
  );
}
