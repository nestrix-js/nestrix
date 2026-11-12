import type { TraceResponse } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import { summarizeTrace } from "@/views/trace/trace-summary";

const trace = (): TraceResponse => ({
  traceId: "t",
  rootSpanId: "a",
  resource: { "service.name": "orders", "service.version": "1.4.0" },
  spans: [
    {
      spanId: "a",
      name: "GET /orders/:id",
      kind: "server",
      startTimeUnixMs: 1000,
      durationMs: 182,
      attributes: {
        "http.request.method": "GET",
        "http.route": "/orders/:id",
        "http.response.status_code": 500,
        "user.id": "u-7",
      },
      events: [],
      links: [],
      status: { code: "error" },
    },
  ],
});

describe("summarizeTrace", () => {
  it("reads route, status, timing, release and user from the root", () => {
    expect(summarizeTrace(trace())).toMatchObject({
      title: "GET /orders/:id",
      route: "/orders/:id",
      method: "GET",
      statusCode: 500,
      error: true,
      durationMs: 182,
      startMs: 1000,
      service: "orders",
      release: "1.4.0",
      user: "u-7",
    });
  });

  it("prefers the root span's own service and leaves absent fields undefined", () => {
    const t = trace();
    t.resource = {};
    const [root] = t.spans;
    if (root) {
      root.service = "billing";
      root.attributes = { "http.route": "/pay" };
      root.status = { code: "ok" };
    }
    const s = summarizeTrace(t);
    expect(s).toMatchObject({
      title: "/pay",
      service: "billing",
      error: false,
    });
    expect(s.release).toBeUndefined();
    expect(s.user).toBeUndefined();
    expect(s.statusCode).toBeUndefined();
  });

  it("names a trace without a route by its root span", () => {
    const t = trace();
    const [root] = t.spans;
    if (root) root.attributes = {};
    expect(summarizeTrace(t).title).toBe("GET /orders/:id");
  });
});
