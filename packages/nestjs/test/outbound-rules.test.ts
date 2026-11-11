// Unit tests for the shared outbound rules. Global state: a W3C propagator only (for injectContext).
import {
  INVALID_SPAN_CONTEXT,
  propagation,
  ROOT_CONTEXT,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { describe, expect, it } from "vitest";
import {
  buildOutboundConfig,
  clientSpanName,
  clientTarget,
  errorType,
  injectContext,
  isIgnored,
  parentContext,
} from "../src/outbound/rules.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { resolved, suppressed } from "./outbound-helpers.js";

propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const keys = buildOutboundConfig(resolved(), recordingDiagnostics()).queryKeys;
const sampled = trace.setSpanContext(ROOT_CONTEXT, {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: TraceFlags.SAMPLED,
});

describe("parentContext", () => {
  it("is the context when an active span with a valid context exists", () => {
    expect(parentContext(sampled)).toBe(sampled);
  });
  it("is the context for an unsampled but valid parent", () => {
    const ctx = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.NONE,
    });
    expect(parentContext(ctx)).toBe(ctx);
  });
  it("is undefined without an active span", () => {
    expect(parentContext(ROOT_CONTEXT)).toBeUndefined();
  });
  it("is undefined for an invalid span context", () => {
    expect(
      parentContext(trace.setSpanContext(ROOT_CONTEXT, INVALID_SPAN_CONTEXT)),
    ).toBeUndefined();
  });
  it("is undefined when the suppress-tracing key is set, even with a valid parent", () => {
    expect(parentContext(suppressed(sampled))).toBeUndefined();
  });
  it("reads the same key as @opentelemetry/core's suppressTracing", async () => {
    const { suppressTracing } = await import("@opentelemetry/core");
    expect(parentContext(suppressTracing(sampled))).toBeUndefined();
  });
});

describe("clientTarget", () => {
  it("omits the default port and keeps others", () => {
    expect(clientTarget("http:", "a.test", 80, "/x", keys).full).toBe(
      "http://a.test/x",
    );
    expect(clientTarget("https:", "a.test", 443, "/x", keys).full).toBe(
      "https://a.test/x",
    );
    expect(clientTarget("http:", "a.test", 8080, "/x", keys)).toEqual({
      full: "http://a.test:8080/x",
      address: "a.test",
      port: 8080,
    });
  });
  it("brackets an IPv6 host", () => {
    expect(clientTarget("http:", "::1", 3000, "/x", keys).full).toBe(
      "http://[::1]:3000/x",
    );
  });
  it("redacts listed query values, drops the fragment, keeps the rest", () => {
    expect(
      clientTarget("http:", "h", 80, "/p?a=1&token=s&Code=c#frag", keys).full,
    ).toBe("http://h/p?a=1&token=REDACTED&Code=REDACTED");
  });
  it("keeps a path starting with // as a path (no authority guessing)", () => {
    expect(clientTarget("http:", "h", 80, "//x/y", keys).full).toBe(
      "http://h//x/y",
    );
  });
  it("lowercases the host", () => {
    expect(clientTarget("http:", "LocalHost", 3000, "/x", keys)).toEqual({
      full: "http://localhost:3000/x",
      address: "localhost",
      port: 3000,
    });
  });
  it.each([
    // `new URL()` rejects the port: the fallback keeps the path only.
    ["http://alice:hunter2@api.example.com:99999/v1", "http://proxy:3128/v1"],
    // `#` inside the password must not cut the userinfo short.
    [
      "http://user:s3cr#t@api.example.com/x?token=1",
      "http://api.example.com/x?token=REDACTED",
    ],
    ["http://user:p@ss@api.example.com/x", "http://api.example.com/x"],
    ["http://user:pw@[bad/x", "http://proxy:3128/x"],
    ["http://user:pw@api.example.com:99999/x", "http://proxy:3128/x"],
  ])(
    "absolute-form target %s never records userinfo (%s)",
    (target, expected) => {
      const full = clientTarget("http:", "proxy", 3128, target, keys).full;
      expect(full).toBe(expected);
      expect(full).not.toMatch(/alice|hunter2|user|s3cr|ss@|pw/);
    },
  );
  it("uses an absolute-form target (forward proxy) as the URL, without userinfo", () => {
    expect(
      clientTarget(
        "http:",
        "proxy",
        3128,
        "http://user:pw@target.test/a?key=k#f",
        keys,
      ),
    ).toEqual({
      full: "http://target.test/a?key=REDACTED",
      address: "proxy",
      port: 3128,
    });
  });
  it("handles empty, bare and asterisk targets", () => {
    expect(clientTarget("http:", "h", 80, "", keys).full).toBe("http://h/");
    expect(clientTarget("http:", "h", 80, "x", keys).full).toBe("http://h/x");
    expect(clientTarget("http:", "h", 80, "*", keys).full).toBe("http://h*");
    expect(clientTarget("http:", "h", undefined, "/", keys)).toEqual({
      full: "http://h/",
      address: "h",
      port: undefined,
    });
  });
});

describe("isIgnored", () => {
  const cfg = (ignore: Parameters<typeof resolved>[0]) => {
    const diagnostics = recordingDiagnostics();
    return {
      diagnostics,
      config: buildOutboundConfig(resolved(ignore), diagnostics),
    };
  };
  it("string matchers are URL prefixes; an empty string matches nothing", () => {
    const { config } = cfg({
      ignore: { outgoing: ["", "https://o1.ingest.sentry.io/"] },
    });
    expect(
      isIgnored("https://o1.ingest.sentry.io/api/1/envelope/?k=v", config),
    ).toBe(true);
    expect(isIgnored("https://example.test/", config)).toBe(false);
  });
  it("a global RegExp matches on every call (lastIndex reset)", () => {
    const { config } = cfg({ ignore: { outgoing: [/sentry/g] } });
    expect(isIgnored("https://sentry.test/a", config)).toBe(true);
    expect(isIgnored("https://sentry.test/a", config)).toBe(true);
  });
  it("a function matcher must return true exactly", () => {
    const { config } = cfg({
      ignore: { outgoing: [(() => 1) as unknown as (u: string) => boolean] },
    });
    expect(isIgnored("http://x/", config)).toBe(false);
  });
  it("a throwing matcher counts as a match and is counted", () => {
    const { config, diagnostics } = cfg({
      ignore: {
        outgoing: [
          () => {
            throw new Error("bad");
          },
        ],
      },
    });
    expect(isIgnored("http://x/", config)).toBe(true);
    expect(diagnostics.failures.map((f) => f.where)).toEqual([
      "outbound.ignore-matcher",
    ]);
  });
});

describe("injectContext", () => {
  const span = trace.wrapSpanContext({
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "00f067aa0ba902b7",
    traceFlags: TraceFlags.SAMPLED,
  });
  const carrier = (initial: Record<string, string> = {}) => {
    const headers = new Map(
      Object.entries(initial).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      headers,
      has: (n: string) => headers.has(n.toLowerCase()),
      add: (n: string, v: string) => {
        headers.set(n.toLowerCase(), v);
      },
    };
  };
  it("adds traceparent when absent", () => {
    const c = carrier();
    injectContext(ROOT_CONTEXT, span, c.has, c.add);
    expect(c.headers.get("traceparent")).toBe(
      "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01",
    );
  });
  it("adds nothing when traceparent is present", () => {
    const c = carrier({ TraceParent: "caller" });
    injectContext(ROOT_CONTEXT, span, c.has, c.add);
    expect([...c.headers]).toEqual([["traceparent", "caller"]]);
  });
  it("swallows a throwing add (node:http array headers)", () => {
    expect(() =>
      injectContext(
        ROOT_CONTEXT,
        span,
        () => false,
        () => {
          throw new Error("ERR_HTTP_HEADERS_SENT");
        },
      ),
    ).not.toThrow();
  });
});

describe("names and error types", () => {
  it("names known methods by method, others HTTP", () => {
    expect(clientSpanName("GET")).toBe("GET");
    expect(clientSpanName("get")).toBe("HTTP");
    expect(clientSpanName("PURGE")).toBe("HTTP");
  });
  it("QUERY is a known method (stable in semantic conventions 1.45.0)", () => {
    expect(clientSpanName("QUERY")).toBe("QUERY");
  });
  it("error.type is a string code, else the name, else _OTHER", () => {
    expect(
      errorType(Object.assign(new Error("x"), { code: "ECONNRESET" })),
    ).toBe("ECONNRESET");
    expect(errorType(new DOMException("aborted", "AbortError"))).toBe(
      "AbortError",
    );
    expect(errorType("a string")).toBe("_OTHER");
    expect(errorType(null)).toBe("_OTHER");
  });
});
