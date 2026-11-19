import { useLayoutEffect, useSyncExternalStore } from "react";

/** What the figures of a page are, as far as the sampling caveat goes. */
export type SourceKind = "stats" | "traces";

/** Standard wordings of each kind; a card that says one of these only repeats its page. */
const PHRASES: Record<SourceKind, readonly string[]> = {
  stats: ["counted before sampling", "before sampling"],
  traces: ["from sampled traces"],
};

/** The kind a source text stands for, or null for any other wording. */
export function sourceKindOf(text: string | undefined): SourceKind | null {
  const t = text?.trim().toLowerCase();
  if (t === undefined || t === "") return null;
  if (t === "stats" || t === "traces") return t;
  for (const kind of ["stats", "traces"] as const)
    if (PHRASES[kind].includes(t)) return kind;
  return null;
}

/**
 * A card's source line without what its page already says. "from sampled traces" on a page
 * whose header says so is dropped, and so is that part of "5xx or thrown · from sampled traces";
 * a card that differs ("estimated from sampled traces" on a counted page) keeps its text.
 * Returns "" when nothing is left.
 */
export function withoutPageSource(
  text: string,
  page: SourceKind | null,
): string {
  if (page === null) return text;
  return text
    .split(" · ")
    .filter((part) => sourceKindOf(part) !== page)
    .join(" · ");
}

let current: SourceKind | null = null;
const listeners = new Set<() => void>();

function setPageSource(kind: SourceKind | null) {
  if (current === kind) return;
  current = kind;
  for (const listener of listeners) listener();
}

/** The source the current page's header states; null when it states none or a mix. */
export function usePageSourceKind(): SourceKind | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}

/**
 * Registers what the page's figures are while the calling component is mounted, so cards below
 * the header can leave out the same words (the caveat is said once, in the header).
 */
export function useRegisterPageSource(source: string | undefined) {
  const kind = sourceKindOf(source);
  useLayoutEffect(() => {
    setPageSource(kind);
    return () => setPageSource(null);
  }, [kind]);
}
