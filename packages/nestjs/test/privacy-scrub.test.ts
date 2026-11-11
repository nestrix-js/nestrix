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
