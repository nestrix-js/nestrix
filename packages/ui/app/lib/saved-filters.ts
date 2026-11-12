// Named request-list filters, kept in this browser's localStorage. Storage can be missing,
// full or blocked, so every access is wrapped; the feature then simply holds nothing.

export interface SavedFilter {
  name: string;
  /** The URL parameters of the filters (`route`, `status`, ...), as strings. */
  params: Record<string, string>;
}

export const SAVED_FILTERS_KEY = "nestrix.savedFilters";
export const MAX_SAVED_FILTERS = 50;
export const MAX_NAME_LENGTH = 60;

type Store = Pick<Storage, "getItem" | "setItem">;

const defaultStore = (): Store | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

const isSaved = (value: unknown): value is SavedFilter => {
  if (typeof value !== "object" || value === null) return false;
  const { name, params } = value as Record<string, unknown>;
  if (typeof name !== "string" || name === "") return false;
  if (typeof params !== "object" || params === null) return false;
  return Object.values(params).every((v) => typeof v === "string");
};

export function loadSavedFilters(
  store: Store | undefined = defaultStore(),
): SavedFilter[] {
  try {
    const raw = store?.getItem(SAVED_FILTERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSaved) : [];
  } catch {
    return [];
  }
}

function write(list: SavedFilter[], store: Store | undefined): boolean {
  try {
    if (!store) return false;
    store.setItem(SAVED_FILTERS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Adds or replaces (by name) a saved filter; returns the new list, or the old one if it could not be saved. */
export function saveFilter(
  name: string,
  params: Record<string, string>,
  store: Store | undefined = defaultStore(),
): SavedFilter[] {
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
  const current = loadSavedFilters(store);
  if (trimmed === "") return current;
  const next = [
    ...current.filter((f) => f.name !== trimmed),
    { name: trimmed, params },
  ].slice(-MAX_SAVED_FILTERS);
  return write(next, store) ? next : current;
}

export function deleteSavedFilter(
  name: string,
  store: Store | undefined = defaultStore(),
): SavedFilter[] {
  const current = loadSavedFilters(store);
  const next = current.filter((f) => f.name !== name);
  return write(next, store) ? next : current;
}
