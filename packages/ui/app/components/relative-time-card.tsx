// Modelled on Dice UI's relative-time-card (https://github.com/sadmann7/diceui, MIT,
// (c) sadmann7): relative text in the cell, exact times in a card on hover or focus.
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { formatRelative } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const local = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "medium",
});
const utc = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});

export function RelativeTimeCard({ timeUnixMs }: { timeUnixMs: number }) {
  const now = useNow();
  const date = new Date(timeUnixMs);
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={200}
        render={
          <time
            dateTime={date.toISOString()}
            className="cursor-default underline decoration-dotted underline-offset-4"
          />
        }
      >
        {formatRelative(timeUnixMs, now)}
      </HoverCardTrigger>
      <HoverCardContent>
        <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Local</dt>
          <dd className="font-mono">{local.format(date)}</dd>
          <dt className="text-muted-foreground">UTC</dt>
          <dd className="font-mono">{utc.format(date)}</dd>
          <dt className="text-muted-foreground">ISO</dt>
          <dd className="font-mono">{date.toISOString()}</dd>
        </dl>
      </HoverCardContent>
    </HoverCard>
  );
}
