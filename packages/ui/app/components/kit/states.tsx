import { Inbox, TriangleAlert } from "lucide-react";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Nothing to show yet. Say what is missing and how to get it ("Requests appear here as the app
 * handles them"); `action` is an optional button or link.
 */
export function EmptyState({
  title,
  children,
  icon,
  action,
  testId = "empty-state",
  className,
}: {
  title: string;
  children?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center",
        className,
      )}
    >
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5"
      >
        {icon ?? <Inbox />}
      </span>
      <p className="font-medium">{title}</p>
      {children && (
        <p className="max-w-md text-sm text-muted-foreground">{children}</p>
      )}
      {action}
    </div>
  );
}

/**
 * Something failed. `title` says what ("Could not load requests."), `message` says why (the
 * error's own text), `onRetry` adds a "Try again" button.
 */
export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel = "Try again",
  testId = "error-state",
  className,
}: {
  title: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-6 py-8 text-center",
        className,
      )}
    >
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive [&_svg]:size-5"
      >
        <TriangleAlert />
      </span>
      <p className="font-medium">{title}</p>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
