import { cn } from "@/lib/utils";

/** A bordered card with a title and the line saying where its figures come from (every card says). */
export function Card({
  title,
  source,
  testId,
  className,
  children,
  aside,
}: {
  title: string;
  /** Where the figures come from; every card says. */
  source: string;
  testId: string;
  className?: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      aria-label={title}
      className={cn(
        "min-w-0 space-y-3 rounded-lg border border-border p-4",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p data-testid="source" className="text-xs text-muted-foreground">
            {source}
          </p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}
