import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, LogOut, Pause, Play } from "lucide-react";
import type * as React from "react";
import { useEffect, useRef } from "react";

import { Chip } from "@/components/kit/chip";
import { Button } from "@/components/ui/button";
import { getMeta, signOut } from "@/lib/api";
import { readConfig } from "@/lib/config";
import { samplingNotice } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { useService } from "@/lib/service";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/", label: "Overview" },
  { to: "/requests", label: "Requests" },
  { to: "/errors", label: "Errors" },
  { to: "/routes", label: "Routes" },
  { to: "/classes", label: "Classes" },
  { to: "/map", label: "Map" },
  { to: "/queries", label: "Queries" },
  { to: "/dependencies", label: "Dependencies" },
] as const;
// Needs the standalone server's stored history.
const sloNav = { to: "/slos", label: "SLOs" } as const;
// The standalone server's settings (API tokens).
const settingsNav = { to: "/settings", label: "Settings" } as const;
// Embedded dashboard when `meta.profiler.available`; standalone server when `meta.profiler.remote`.
const profilerNav = { to: "/profiler", label: "Profiler" } as const;

// Embedded dashboard only, when `meta.runtime.available`.
const runtimeNav = { to: "/runtime", label: "Runtime" } as const;

type Connection = "connecting" | "live" | "paused" | "disconnected";

const connectionLabel: Record<Connection, string> = {
  connecting: "Connecting",
  live: "Live",
  paused: "Paused",
  disconnected: "Disconnected",
};

/** The page column every page shares: header, navigation and content line up on it. */
export const PAGE_COLUMN = "mx-auto w-full max-w-7xl px-4 sm:px-6";

/**
 * Header (brand and service, connection, sampling notice, live toggle), the section menu, and
 * the page. The menu scrolls sideways inside its own box on a narrow screen and keeps the
 * current section in view.
 */
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
  const profilerOn =
    meta.data?.profiler?.available === true ||
    (standalone && meta.data?.profiler?.remote === true);
  const runtimeOn = meta.data?.runtime?.available === true;
  const services = meta.data?.services ?? [];
  const [selected, setSelected] = useService();
  // Links keep the chosen service: the hash holds it, and a plain link would drop it.
  // The route detail page belongs to Routes: that tab stays marked while it is open.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onRouteDetail = pathname === "/route";
  const keep = selected ? `?service=${encodeURIComponent(selected)}` : "";

  // On a narrow screen the menu scrolls; bring the current section into view when it changes.
  const navRef = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the path is the trigger; the element is found through the ref
  useEffect(() => {
    try {
      const current = navRef.current?.querySelector('[aria-current="page"]');
      current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      // No scrolling: the menu is still usable.
    }
  }, [pathname]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-background">
        <div
          className={cn(
            PAGE_COLUMN,
            "flex flex-wrap items-center gap-x-4 gap-y-2 py-3",
          )}
        >
          <h1 className="flex min-w-0 items-center gap-2 text-base font-semibold">
            <Activity className="size-5 shrink-0 text-info" aria-hidden />
            Nestrix
            {serviceName && (
              <span className="truncate rounded-md border border-border px-2 py-0.5 font-mono text-sm font-normal text-muted-foreground">
                {serviceName}
              </span>
            )}
          </h1>
          {standalone && (
            <Chip data-testid="mode" tone="info">
              standalone server
            </Chip>
          )}
          {notice && (
            <Chip data-testid="sampling-notice" tone="neutral">
              {notice}
            </Chip>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2 sm:gap-3">
            {services.length > 1 && (
              <select
                aria-label="Service"
                data-testid="service-select"
                value={selected ?? ""}
                onChange={(e) => void setSelected(e.target.value || undefined)}
                className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
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
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium",
                connection === "live" && "bg-success/10 text-success",
                connection === "connecting" &&
                  "bg-warning/15 text-warning-text",
                connection === "paused" && "bg-secondary text-muted-foreground",
                connection === "disconnected" &&
                  "bg-destructive/10 text-destructive",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full bg-current",
                  connection === "live" && "animate-pulse",
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
          ref={navRef}
          aria-label="Sections"
          data-testid="section-menu"
          className={cn(
            PAGE_COLUMN,
            "flex gap-1 overflow-x-auto overscroll-x-contain pb-px",
          )}
        >
          {[
            ...nav,
            ...(profilerOn ? [profilerNav] : []),
            ...(runtimeOn ? [runtimeNav] : []),
            ...(standalone ? [sloNav, settingsNav] : []),
          ].map((item) => (
            <Link
              key={item.to}
              to={`${item.to}${keep}` as typeof item.to}
              activeOptions={{ exact: item.to === "/" }}
              className={cn(
                "shrink-0 border-b-2 border-transparent px-3 py-2.5 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground",
                item.to === "/routes" &&
                  onRouteDetail &&
                  "border-primary font-medium text-foreground",
              )}
              activeProps={{
                className: "border-primary text-foreground font-medium",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className={cn(PAGE_COLUMN, "space-y-6 py-6")}>{children}</main>
    </div>
  );
}
