import { describe, expect, it } from "vitest";

import { apiUrl, baseUrl, shouldLogin } from "@/lib/api";
import { POLL_INTERVAL_MS, pollInterval } from "@/lib/live";

describe("apiUrl", () => {
  it("resolves apiBase against the base href, whatever the mount path", () => {
    expect(
      apiUrl("traces", {}, "api/v1/", "http://h/some/deep/_nestrix/").href,
    ).toBe("http://h/some/deep/_nestrix/api/v1/traces");
    expect(apiUrl("meta", {}, "api/v1/", "http://h/_nestrix/").pathname).toBe(
      "/_nestrix/api/v1/meta",
    );
  });

  it("sends only the parameters that are set", () => {
    const url = apiUrl(
      "traces",
      {
        route: "/a b",
        method: undefined,
        search: "",
        minDurationMs: 0,
        after: "c.1",
      },
      "api/v1/",
      "http://h/x/",
    );
    expect([...url.searchParams.keys()].sort()).toEqual([
      "after",
      "minDurationMs",
      "route",
    ]);
    expect(url.searchParams.get("route")).toBe("/a b");
    expect(url.searchParams.get("minDurationMs")).toBe("0");
  });
});

describe("login redirect", () => {
  it("sends a 401 to login unless the API is known to be embedded", () => {
    expect(shouldLogin(401, "standalone")).toBe(true);
    expect(shouldLogin(401, undefined)).toBe(true);
    expect(shouldLogin(401, "embedded")).toBe(false);
    expect(shouldLogin(403, "standalone")).toBe(false);
    expect(shouldLogin(500, "standalone")).toBe(false);
  });

  it("finds login and logout next to the base href, whatever the mount path", () => {
    expect(baseUrl("login", "http://h/").href).toBe("http://h/login");
    expect(baseUrl("logout", "http://h/some/_nestrix/").href).toBe(
      "http://h/some/_nestrix/logout",
    );
  });
});

describe("pollInterval", () => {
  it("polls every two seconds, and not at all while paused", () => {
    expect(POLL_INTERVAL_MS).toBe(2000);
    expect(pollInterval(false)).toBe(2000);
    expect(pollInterval(true)).toBe(false);
  });
});
