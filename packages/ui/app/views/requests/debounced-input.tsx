import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";

/**
 * A text input whose value is committed (to the URL, and from there to a request) after the
 * user stops typing. `value` is what the URL holds; a change from outside (Back, Reset)
 * replaces the draft.
 */
export function DebouncedInput({
  value,
  onCommit,
  delayMs = 300,
  ...props
}: {
  value: string;
  onCommit: (value: string) => void;
  delayMs?: number;
} & Omit<React.ComponentProps<"input">, "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commit = useRef(onCommit);
  commit.current = onCommit;

  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Input
      {...props}
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => commit.current(next), delayMs);
      }}
    />
  );
}
