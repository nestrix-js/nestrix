import { useSyncExternalStore } from "react";

export const POLL_INTERVAL_MS = 2000;
const STORAGE_KEY = "nestrix.pauseLive";

/** `false` stops TanStack Query's interval; it also stops by itself while the tab is hidden. */
export function pollInterval(paused: boolean): number | false {
  return paused ? false : POLL_INTERVAL_MS;
}

// localStorage is only for this toggle, and it may be absent or throw (private windows).
function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStored(paused: boolean): void {
  try {
    if (paused) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not persisted; the toggle still works for this page.
  }
}

let paused = readStored();
const listeners = new Set<() => void>();

export function setPaused(next: boolean): void {
  paused = next;
  writeStored(next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One shared "pause live" flag, so the header toggle and every polling hook agree. */
export function usePaused(): [boolean, (paused: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => paused,
    () => false,
  );
  return [value, setPaused];
}
