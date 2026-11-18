import { describe, expect, it } from "vitest";

import { environmentQueryHash } from "@/lib/query-key";

describe("environmentQueryHash", () => {
  it("gives the same query a different cache entry per environment", () => {
    const key = ["routes", "stats", 15, undefined];
    const hashes = new Set([
      environmentQueryHash(key, "production"),
      environmentQueryHash(key, "staging"),
      environmentQueryHash(key, "unset"),
      environmentQueryHash(key, undefined),
    ]);
    expect(hashes.size).toBe(4);
  });

  it("is stable for one environment, whatever the order of an object's keys", () => {
    expect(environmentQueryHash(["x", { a: 1, b: 2 }], "staging")).toBe(
      environmentQueryHash(["x", { b: 2, a: 1 }], "staging"),
    );
  });

  it("leaves meta alone: it lists the environments and does not depend on one", () => {
    expect(environmentQueryHash(["meta"], "staging")).toBe(
      environmentQueryHash(["meta"], undefined),
    );
  });
});
