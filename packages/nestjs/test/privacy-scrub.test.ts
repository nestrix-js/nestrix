import { describe, expect, it } from "vitest";
import { buildRedactedQueryKeys, scrubSpanAttributes } from "../src/privacy.js";

const keys = buildRedactedQueryKeys(["custom"]);

describe("scrubSpanAttributes", () => {
  it("redacts url.query and url.full, drops fragment and userinfo", () => {
    const span = {
      attributes: {
        "url.query": "a=1&token=SECRET&custom=X",
        "url.full": "https://u:pw@h.example/p?api_key=K&b=2#frag",
        other: "kept",
      } as Record<string, unknown>,
    };
    scrubSpanAttributes(span, keys);
    expect(span.attributes["url.query"]).toBe(
      "a=1&token=REDACTED&custom=REDACTED",
    );
    expect(span.attributes["url.full"]).toBe(
      "https://REDACTED:REDACTED@h.example/p?api_key=REDACTED&b=2",
    );
    expect(span.attributes.other).toBe("kept");
  });

  it("forces always-redacted header attributes and deletes non-string url values", () => {
    const span = {
      attributes: {
        "http.request.header.authorization": ["Bearer x"],
        "http.response.header.set-cookie": ["a=b", "c=d"],
        "http.request.header.content-type": ["text/plain"],
        "url.query": 42,
      } as Record<string, unknown>,
    };
    scrubSpanAttributes(span, keys);
    expect(span.attributes["http.request.header.authorization"]).toEqual([
      "REDACTED",
    ]);
    expect(span.attributes["http.response.header.set-cookie"]).toEqual([
      "REDACTED",
    ]);
    expect(span.attributes["http.request.header.content-type"]).toEqual([
      "text/plain",
    ]);
    expect("url.query" in span.attributes).toBe(false);
  });
});

// D-111: event attribute maps get the same rule as the span's.
describe("scrubSpanAttributes on events", () => {
  it("masks protected headers and redacted query keys in every event, keeps the rest", () => {
    const span = {
      attributes: { other: "kept" } as Record<string, unknown>,
      events: [
        {
          name: "exception",
          attributes: {
            "exception.message": "boom",
            "http.request.header.authorization": ["Bearer SECRET"],
            "http.request.header.cookie": ["sid=SECRET"],
            "http.response.header.set-cookie": ["a=SECRET"],
            "http.request.header.content-type": ["text/plain"],
            "url.full": "https://u:pw@h.example/p?token=SECRET&b=2#frag",
            "url.query": "custom=SECRET&page=1",
          } as Record<string, unknown>,
        },
        {
          name: "second",
          attributes: {
            "http.request.header.Proxy-Authorization": ["Basic SECRET"],
          } as Record<string, unknown>,
        },
      ],
    };
    scrubSpanAttributes(span, keys);
    expect(span.events[0]?.attributes).toEqual({
      "exception.message": "boom",
      "http.request.header.authorization": ["REDACTED"],
      "http.request.header.cookie": ["REDACTED"],
      "http.response.header.set-cookie": ["REDACTED"],
      "http.request.header.content-type": ["text/plain"],
      "url.full": "https://REDACTED:REDACTED@h.example/p?token=REDACTED&b=2",
      "url.query": "custom=REDACTED&page=1",
    });
    expect(span.events[1]?.attributes).toEqual({
      "http.request.header.Proxy-Authorization": ["REDACTED"],
    });
    expect(span.attributes).toEqual({ other: "kept" });
  });

  it("fails closed: an unreadable attribute is deleted, an unwalkable event map is emptied", () => {
    const hostileValue: Record<string, unknown> = {
      "http.request.header.authorization": ["Bearer SECRET"],
    };
    Object.defineProperty(hostileValue, "url.full", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("getter");
      },
    });
    const unwalkable = new Proxy(
      { "http.request.header.cookie": ["sid=SECRET"] },
      {
        ownKeys() {
          throw new Error("ownKeys");
        },
      },
    ) as Record<string, unknown>;
    const span = {
      attributes: {} as Record<string, unknown>,
      events: [{ attributes: hostileValue }, { attributes: unwalkable }],
    };
    expect(() => scrubSpanAttributes(span, keys)).not.toThrow();
    expect(span.events[0]?.attributes).toEqual({
      "http.request.header.authorization": ["REDACTED"],
    });
    expect(span.events[1]?.attributes).toEqual({});
  });

  it("throws when an event map can neither be walked nor replaced, so the caller drops the span", () => {
    const event = {};
    Object.defineProperty(event, "attributes", {
      get() {
        throw new Error("attributes");
      },
    });
    const span = {
      attributes: {} as Record<string, unknown>,
      events: [event as { attributes: Record<string, unknown> }],
    };
    expect(() => scrubSpanAttributes(span, keys)).toThrow();
  });
});
