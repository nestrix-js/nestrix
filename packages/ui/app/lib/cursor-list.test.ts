import { describe, expect, it } from "vitest";

import {
  applyHead,
  applyInitial,
  applyOlder,
  type CursorPage,
  type CursorState,
  emptyCursorState,
} from "@/lib/cursor-list";

interface Item {
  cursor: string;
}
const item = (n: number): Item => ({ cursor: `c.${n}` });
const page = (
  nums: number[],
  extra: Partial<CursorPage<Item>> = {},
): CursorPage<Item> => ({
  items: nums.map(item),
  head: nums.length ? `c.${nums[0]}` : null,
  older: nums.length ? `c.${nums.at(-1)}` : null,
  reset: false,
  ...extra,
});
const cursors = (s: CursorState<Item>) => s.items.map((i) => i.cursor);

describe("cursor list", () => {
  it("starts empty and not loaded", () => {
    expect(emptyCursorState()).toEqual({
      items: [],
      head: null,
      older: null,
      loaded: false,
    });
  });

  it("the first page sets items, head and older", () => {
    const s = applyInitial(page([5, 4, 3]));
    expect(cursors(s)).toEqual(["c.5", "c.4", "c.3"]);
    expect(s).toMatchObject({ head: "c.5", older: "c.3", loaded: true });
  });

  it("a poll puts newer items in front and moves the head", () => {
    const s = applyHead(applyInitial(page([5, 4, 3])), page([7, 6]));
    expect(cursors(s)).toEqual(["c.7", "c.6", "c.5", "c.4", "c.3"]);
    expect(s.head).toBe("c.7");
    expect(s.older).toBe("c.3");
  });

  it("a poll that overlaps what is held adds nothing twice", () => {
    const start = applyInitial(page([5, 4, 3]));
    const s = applyHead(start, page([6, 5]));
    expect(cursors(s)).toEqual(["c.6", "c.5", "c.4", "c.3"]);
    // Same page again: the very same state object comes back, nothing is rebuilt.
    expect(applyHead(s, page([6, 5])).items).toBe(s.items);
  });

  it("an empty poll keeps items and head", () => {
    const start = applyInitial(page([5, 4]));
    const s = applyHead(start, {
      items: [],
      head: "c.5",
      older: null,
      reset: false,
    });
    expect(s).toEqual(start);
    // A store that reports no head does not erase the one we hold.
    expect(
      applyHead(start, { items: [], head: null, older: null, reset: false })
        .head,
    ).toBe("c.5");
  });

  it("load older appends and moves older, and ends at null", () => {
    const start = applyInitial(page([5, 4, 3]));
    const more = applyOlder(start, page([2, 1], { older: null }));
    expect(cursors(more)).toEqual(["c.5", "c.4", "c.3", "c.2", "c.1"]);
    expect(more.older).toBeNull();
    expect(more.head).toBe("c.5");
  });

  it("load older never duplicates an item a poll already brought in", () => {
    const start = applyInitial(page([5, 4, 3]));
    const s = applyOlder(start, page([3, 2]));
    expect(cursors(s)).toEqual(["c.5", "c.4", "c.3", "c.2"]);
  });

  it("duplicates inside one page are collapsed", () => {
    expect(cursors(applyInitial(page([2, 2, 1])))).toEqual(["c.2", "c.1"]);
  });

  it("reset on a poll clears what was held", () => {
    const start = applyInitial(page([5, 4, 3]));
    const s = applyHead(start, page([9, 8], { reset: true }));
    expect(cursors(s)).toEqual(["c.9", "c.8"]);
    expect(s).toMatchObject({ head: "c.9", older: "c.8", loaded: true });
  });

  it("reset on load older clears what was held", () => {
    const start = applyInitial(page([5, 4, 3]));
    const s = applyOlder(start, page([9], { reset: true, older: null }));
    expect(cursors(s)).toEqual(["c.9"]);
    expect(s.older).toBeNull();
  });

  it("a poll before any first page acts as the first page", () => {
    expect(cursors(applyHead(emptyCursorState(), page([2, 1])))).toEqual([
      "c.2",
      "c.1",
    ]);
  });

  it("reset with an empty store leaves an empty, loaded list", () => {
    const start = applyInitial(page([5]));
    const s = applyHead(start, page([], { reset: true }));
    expect(s).toEqual({ items: [], head: null, older: null, loaded: true });
  });
});
