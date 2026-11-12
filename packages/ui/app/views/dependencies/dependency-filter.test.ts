import { describe, expect, it } from "vitest";

import { filterByName } from "@/views/dependencies/dependency-filter";

const rows = [{ name: "api.stripe.com" }, { name: "postgresql orders-db" }];

describe("filterByName", () => {
  it("keeps the dependency with exactly that name", () => {
    expect(filterByName(rows, "postgresql orders-db")).toEqual([rows[1]]);
    expect(filterByName(rows, "stripe")).toEqual([]);
  });
  it("keeps every dependency without a name", () => {
    expect(filterByName(rows, null)).toHaveLength(2);
  });
});
