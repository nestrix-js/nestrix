import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pause, Play } from "lucide-react";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { getMeta } from "@/lib/api";
import { readConfig } from "@/lib/config";
import { samplingNotice } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/", label: "Requests" },
  { to: "/errors", label: "Errors" },
  { to: "/routes", label: "Routes" },
] as const;

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
  const service = meta.data?.service.name ?? readConfig().service;
  const notice = meta.data ? samplingNotice(meta.data.sampling) : null;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <h1 className="text-base font-semibold">
            Nestrix{" "}
            <span className="font-mono font-normal text-muted-foreground">
              {service ?? ""}
            </span>
          </h1>
          {notice && (
            <span
              data-testid="sampling-notice"
              className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            >
              {notice}
            </span>
          )}
          <div className="ml-auto flex items-center gap-3">
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
          </div>
        </div>
        <nav
          aria-label="Sections"
          className="mx-auto flex max-w-6xl gap-1 px-4"
        >
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
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
