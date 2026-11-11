// OTLP JSON mapping rules and the safety of mapped values, without HTTP.
import { describe, expect, it } from "vitest";
import { presentedKey } from "../../src/ingest/auth.js";
import { decodeRequest } from "../../src/ingest/decode.js";
import { safe, toIngestBatch } from "../../src/ingest/map.js";
import { RateLimiter } from "../../src/ingest/rate-limit.js";

const LIMITS = {
  maxSpans: 100_000,
  maxMessages: 400_000,
  maxJsonTokens: 1_200_000,
  maxDepth: 64,
};

const TRACE = "5B8EFFF798038103D269B633813FC60C";
const SPAN = "EEE19B7EC3C1B174";

function decodeJson(span: Record<string, unknown>, resource: unknown[] = []) {
  const body = {
    resourceSpans: [
      {
        resource: { attributes: resource },
        scopeSpans: [
          {
            scope: { name: "s" },
            spans: [
              {
                traceId: TRACE,
                spanId: SPAN,
                name: "n",
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000000000000001",
                ...span,
              },
            ],
          },
        ],
      },
    ],
  };
  return toIngestBatch(
    decodeRequest(Buffer.from(JSON.stringify(body)), "json", LIMITS),
  );
}

function only(batch: ReturnType<typeof decodeJson>) {
  expect(batch.rejectedSpans).toBe(0);
  return batch.resourceSpans[0].spans[0];
}

describe("OTLP JSON", () => {
  it("reads hex ids case-insensitively and lowercases them", () => {
    const span = only(decodeJson({ parentSpanId: "00F067AA0BA902B7" }));
    expect(span.traceId).toBe(TRACE.toLowerCase());
    expect(span.spanId).toBe(SPAN.toLowerCase());
    expect(span.parentSpanId).toBe("00f067aa0ba902b7");
  });

  it("treats an empty or all-zero parent id as a root", () => {
    expect(only(decodeJson({ parentSpanId: "" })).parentSpanId).toBeUndefined();
    expect(
      only(decodeJson({ parentSpanId: "0000000000000000" })).parentSpanId,
    ).toBeUndefined();
  });

  it("reads 64-bit times as strings or numbers", () => {
    const span = only(
      decodeJson({
        startTimeUnixNano: 1700000000000000000,
        endTimeUnixNano: "1700000000000000005",
      }),
    );
    expect(span.startTimeUnixNano).toBe(1700000000000000000n);
    expect(span.endTimeUnixNano).toBe(1700000000000000005n);
  });

  it("reads enums as numbers or names, mapping unknown kinds to internal", () => {
    expect(only(decodeJson({ kind: 2 })).kind).toBe("server");
    expect(only(decodeJson({ kind: "SPAN_KIND_CONSUMER" })).kind).toBe(
      "consumer",
    );
    expect(only(decodeJson({ kind: 0 })).kind).toBe("internal");
    expect(only(decodeJson({ kind: 99 })).kind).toBe("internal");
    expect(
      only(decodeJson({ status: { code: 2, message: "x" } })).status,
    ).toEqual({
      code: "error",
      message: "x",
    });
  });

  it("ignores unknown fields", () => {
    const span = only(decodeJson({ futureField: { a: 1 }, flags: 257 }));
    expect(span.name).toBe("n");
  });

  it("maps attribute values", () => {
    const span = only(
      decodeJson({
        attributes: [
          { key: "s", value: { stringValue: "v" } },
          { key: "b", value: { boolValue: true } },
          { key: "i", value: { intValue: "42" } },
          { key: "inum", value: { intValue: 7 } },
          { key: "big", value: { intValue: "9223372036854775807" } },
          { key: "d", value: { doubleValue: 1.5 } },
          { key: "nan", value: { doubleValue: "NaN" } },
          { key: "inf", value: { doubleValue: "-Infinity" } },
          {
            key: "arr",
            value: {
              arrayValue: {
                values: [{ stringValue: "a" }, { stringValue: "b" }],
              },
            },
          },
          {
            key: "mixed",
            value: {
              arrayValue: { values: [{ stringValue: "a" }, { intValue: "1" }] },
            },
          },
          {
            key: "bigarr",
            value: {
              arrayValue: {
                values: [
                  { intValue: "1" },
                  { intValue: "9223372036854775807" },
                ],
              },
            },
          },
          {
            key: "kv",
            value: {
              kvlistValue: { values: [{ key: "x", value: { intValue: "1" } }] },
            },
          },
          { key: "bytes", value: { bytesValue: "AQID" } },
          { key: "empty", value: {} },
          { key: "dup", value: { stringValue: "first" } },
          { key: "dup", value: { stringValue: "last" } },
        ],
      }),
    );
    expect({ ...span.attributes }).toEqual({
      s: "v",
      b: true,
      i: 42,
      inum: 7,
      big: "9223372036854775807",
      d: 1.5,
      nan: "NaN",
      inf: "-Infinity",
      arr: ["a", "b"],
      mixed: '["a",1]',
      bigarr: '[1,"9223372036854775807"]',
      kv: '{"x":1}',
      bytes: '"AQID"',
      dup: "last",
    });
  });

  it("keeps a __proto__ key as data, in a null-prototype map", () => {
    const span = only(
      decodeJson({
        attributes: [
          { key: "__proto__", value: { stringValue: "polluted" } },
          { key: "constructor", value: { stringValue: "c" } },
        ],
      }),
    );
    expect(Object.getPrototypeOf(span.attributes)).toBeNull();
    expect(Object.keys(span.attributes)).toEqual(["__proto__", "constructor"]);
    expect(
      Object.getOwnPropertyDescriptor(span.attributes, "__proto__")?.value,
    ).toBe("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(span.attributes)).toBe(
      '{"__proto__":"polluted","constructor":"c"}',
    );
  });

  it("replaces NUL, which PostgreSQL text and jsonb reject", () => {
    const span = only(
      decodeJson({
        name: "a\u0000b",
        attributes: [{ key: "k\u0000", value: { stringValue: "\u0000x" } }],
      }),
    );
    expect(span.name).toBe("a�b");
    expect({ ...span.attributes }).toEqual({ "k�": "�x" });
    expect(safe("plain")).toBe("plain");
    expect(safe("a\ud800b")).toBe("a�b");
  });

  it("refuses a lone surrogate in a JSON string, like invalid UTF-8 in protobuf", () => {
    expect(() => decodeJson({ name: "a\ud800b" })).toThrow(/invalid UTF8/);
  });

  it("rejects ids of the wrong length or that are not hex, span by span", () => {
    for (const span of [
      { traceId: "abc" },
      { traceId: `${TRACE}00` },
      { spanId: "xyzxyzxyzxyzxyzx" },
      { spanId: "" },
      { parentSpanId: "0102" },
    ]) {
      const batch = decodeJson(span);
      expect(batch.rejectedSpans, JSON.stringify(span)).toBe(1);
      expect(batch.resourceSpans).toEqual([]);
    }
  });

  it("caps nesting inside an attribute's JSON text", () => {
    let value: unknown = { stringValue: "deep" };
    for (let i = 0; i < 30; i++) value = { arrayValue: { values: [value] } };
    const span = only(decodeJson({ attributes: [{ key: "deep", value }] }));
    const text = span.attributes.deep as string;
    expect(text).not.toContain("deep");
    expect(text).toContain("null");
  });
});

describe("presentedKey", () => {
  it("reads Bearer case-insensitively or x-nestrix-key", () => {
    expect(presentedKey({ authorization: "Bearer abc" })).toBe("abc");
    expect(presentedKey({ authorization: "  bearer   abc  " })).toBe("abc");
    expect(presentedKey({ "x-nestrix-key": " abc " })).toBe("abc");
    expect(presentedKey({ authorization: "Basic abc" })).toBeUndefined();
    expect(presentedKey({ authorization: "Bearer a b" })).toBeUndefined();
    expect(presentedKey({})).toBeUndefined();
  });
});

describe("RateLimiter", () => {
  it("refills over time and computes Retry-After", () => {
    let now = 0;
    const limiter = new RateLimiter(
      { requestsPerSecond: 2, burst: 3 },
      () => now,
    );
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(limiter.take("b")).toEqual({ ok: true });
    now += 500; // one token back
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a").ok).toBe(false);
    now += 60_000; // capped at burst
    for (let i = 0; i < 3; i++) expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
  });

  it("keeps a bounded number of buckets", () => {
    const limiter = new RateLimiter(
      { requestsPerSecond: 1, burst: 1 },
      () => 0,
    );
    for (let i = 0; i < RateLimiter.MAX_BUCKETS + 50; i++)
      limiter.take(`ip:${i}`);
    const size = (limiter as unknown as { buckets: Map<string, unknown> })
      .buckets.size;
    expect(size).toBe(RateLimiter.MAX_BUCKETS);
  });
});
