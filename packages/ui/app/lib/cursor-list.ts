/**
 * The state of one cursor-paged list (traces, errors) and the pure steps that change it.
 *
 * Lists are newest first. A poll asks for `after=<head>` and gets the items newer than the
 * last known head; "load older" asks for `before=<older>` and appends. Items are
 * identified by their `cursor`, so a page that overlaps what is already held (a retry, a
 * poll that raced "load older") never produces a duplicate.
 */
export interface CursorItem {
  cursor: string;
}

export interface CursorPage<T extends CursorItem> {
  items: T[];
  head: string | null;
  older: string | null;
  reset: boolean;
}

export interface CursorState<T extends CursorItem> {
  items: T[];
  /** Cursor for the next `after` poll; null until the first non-empty store answer. */
  head: string | null;
  /** Cursor for "load older"; null at the end of the store. */
  older: string | null;
  /** False until the first page has arrived. */
  loaded: boolean;
}

export function emptyCursorState<T extends CursorItem>(): CursorState<T> {
  return { items: [], head: null, older: null, loaded: false };
}

function replace<T extends CursorItem>(page: CursorPage<T>): CursorState<T> {
  return {
    items: dedupe(page.items),
    head: page.head,
    older: page.older,
    loaded: true,
  };
}

function dedupe<T extends CursorItem>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.cursor)) continue;
    seen.add(item.cursor);
    out.push(item);
  }
  return out;
}

/** The first page, or any page answered with `reset: true`: clear and start from the newest. */
export function applyInitial<T extends CursorItem>(
  page: CursorPage<T>,
): CursorState<T> {
  return replace(page);
}

/** An `after=head` poll: new items go in front; `reset` replaces everything. */
export function applyHead<T extends CursorItem>(
  state: CursorState<T>,
  page: CursorPage<T>,
): CursorState<T> {
  if (page.reset || !state.loaded) return replace(page);
  const known = new Set(state.items.map((item) => item.cursor));
  const fresh = dedupe(page.items).filter((item) => !known.has(item.cursor));
  return {
    ...state,
    items: fresh.length > 0 ? [...fresh, ...state.items] : state.items,
    head: page.head ?? state.head,
  };
}

/** A `before=older` page: items are appended; `reset` replaces everything. */
export function applyOlder<T extends CursorItem>(
  state: CursorState<T>,
  page: CursorPage<T>,
): CursorState<T> {
  if (page.reset || !state.loaded) return replace(page);
  const known = new Set(state.items.map((item) => item.cursor));
  const fresh = dedupe(page.items).filter((item) => !known.has(item.cursor));
  return {
    ...state,
    items: fresh.length > 0 ? [...state.items, ...fresh] : state.items,
    older: page.older,
  };
}
