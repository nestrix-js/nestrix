import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiUrl,
  baseUrl,
  getInstances,
  getLogs,
  getMetricCatalog,
  getMetricSeries,
  getRemoteProfiles,
  setActiveEnvironment,
  shouldLogin,
  triageErrorGroup,
} from "@/lib/api";
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

describe("the selected environment (D-101)", () => {
  afterEach(() => {
    setActiveEnvironment(undefined);
    vi.unstubAllGlobals();
  });

  function recordFetch() {
    const calls: { url: URL; body: unknown }[] = [];
    vi.stubGlobal("document", {
      baseURI: "http://h/",
      getElementById: () => null,
    });
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      calls.push({
        url,
        body:
          init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response("{}", { status: 200 });
    });
    return calls;
  }

  it("narrows the log search and is sent with a triage action", async () => {
    const calls = recordFetch();
    setActiveEnvironment("staging");
    await getLogs({ text: "boom" });
    await triageErrorGroup("resolve", { key: "k", service: "shop" });
    await triageErrorGroup("ignore", { key: "k", environment: "unset" });
    expect(calls[0]?.url.pathname).toBe("/api/v1/logs");
    expect(calls[0]?.url.searchParams.get("environment")).toBe("staging");
    expect(calls[1]?.body).toEqual({
      key: "k",
      service: "shop",
      environment: "staging",
    });
    // A call that names one keeps it.
    expect(calls[2]?.body).toEqual({ key: "k", environment: "unset" });
  });

  it("sends the environment with the metric catalog and series", async () => {
    const calls = recordFetch();
    setActiveEnvironment("staging");
    await getMetricCatalog({ service: "shop" });
    await getMetricSeries({ metric: "process.cpu.time" });
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/api/v1/metrics/catalog",
      "/api/v1/metrics/series",
    ]);
    for (const c of calls) {
      expect(c.url.searchParams.get("environment")).toBe("staging");
    }
  });

  it("sends the environment with the profiler's instance and capture lists", async () => {
    const calls = recordFetch();
    setActiveEnvironment("staging");
    await getInstances("shop");
    await getRemoteProfiles("shop");
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/api/v1/instances",
      "/api/v1/remote-profiles",
    ]);
    for (const c of calls) {
      expect(c.url.searchParams.get("environment")).toBe("staging");
      expect(c.url.searchParams.get("service")).toBe("shop");
    }
  });

  it("sends nothing when every environment is selected", async () => {
    const calls = recordFetch();
    await getLogs({ text: "boom" });
    await triageErrorGroup("reopen", { key: "k" });
    expect(calls[0]?.url.searchParams.has("environment")).toBe(false);
    expect(calls[1]?.body).toEqual({ key: "k" });
  });
});
