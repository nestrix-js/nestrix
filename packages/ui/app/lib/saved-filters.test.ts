import { describe, expect, it } from "vitest";

import {
  deleteSavedFilter,
  loadSavedFilters,
  MAX_SAVED_FILTERS,
  SAVED_FILTERS_KEY,
  saveFilter,
} from "@/lib/saved-filters";

const memory = (initial?: string) => {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SAVED_FILTERS_KEY, initial);
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};
const broken = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("saved filters", () => {
  it("round-trips save, list and delete", () => {
    const store = memory();
    expect(loadSavedFilters(store)).toEqual([]);
    saveFilter("errors", { status: "error" }, store);
    saveFilter("slow", { minDurationMs: "500", route: "/orders" }, store);
    expect(loadSavedFilters(store).map((f) => f.name)).toEqual([
      "errors",
      "slow",
    ]);
    expect(deleteSavedFilter("errors", store).map((f) => f.name)).toEqual([
      "slow",
    ]);
    expect(loadSavedFilters(store)[0]?.params).toEqual({
      minDurationMs: "500",
      route: "/orders",
    });
  });
  it("replaces a filter of the same name and ignores blank names", () => {
    const store = memory();
    saveFilter(" a ", { status: "ok" }, store);
    saveFilter("a", { status: "error" }, store);
    saveFilter("   ", { status: "ok" }, store);
    expect(loadSavedFilters(store)).toEqual([
      { name: "a", params: { status: "error" } },
    ]);
  });
  it("keeps at most the newest MAX_SAVED_FILTERS", () => {
    const store = memory();
    for (let i = 0; i < MAX_SAVED_FILTERS + 5; i++)
      saveFilter(`f${i}`, {}, store);
    const list = loadSavedFilters(store);
    expect(list).toHaveLength(MAX_SAVED_FILTERS);
    expect(list.at(-1)?.name).toBe(`f${MAX_SAVED_FILTERS + 4}`);
  });
  it("survives corrupt data and unusable storage without throwing", () => {
    expect(loadSavedFilters(memory("not json"))).toEqual([]);
    expect(
      loadSavedFilters(memory('[{"name":1},{"name":"ok","params":{"a":"b"}}]')),
    ).toEqual([{ name: "ok", params: { a: "b" } }]);
    expect(loadSavedFilters(broken)).toEqual([]);
    expect(saveFilter("x", {}, broken)).toEqual([]);
    expect(deleteSavedFilter("x", broken)).toEqual([]);
  });
});
