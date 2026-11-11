import { describe, expect, it } from "vitest";
import {
  ALWAYS_REDACTED_HEADERS,
  buildHeaderAllowlist,
  buildRedactedQueryKeys,
  DEFAULT_REDACTED_QUERY_KEYS,
  DEFAULT_REQUEST_HEADERS,
  DEFAULT_RESPONSE_HEADERS,
  headerAttributes,
  REDACTED,
  REQUEST_HEADER_PREFIX,
  RESPONSE_HEADER_PREFIX,
  redactQuery,
  splitUrl,
} from "../src/privacy.js";

const keys = buildRedactedQueryKeys();
const reqAllow = buildHeaderAllowlist(DEFAULT_REQUEST_HEADERS);

describe("defaults", () => {
  it("match the documented lists", () => {
    expect(DEFAULT_REQUEST_HEADERS).toEqual([
      "content-type",
      "content-length",
      "x-request-id",
    ]);
    expect(DEFAULT_RESPONSE_HEADERS).toEqual([
      "content-type",
      "content-length",
    ]);
    expect([...ALWAYS_REDACTED_HEADERS].sort()).toEqual([
      "authorization",
      "cookie",
      "proxy-authorization",
      "set-cookie",
    ]);
    expect(DEFAULT_REDACTED_QUERY_KEYS).toHaveLength(21);
    expect(REQUEST_HEADER_PREFIX).toBe("http.request.header.");
    expect(RESPONSE_HEADER_PREFIX).toBe("http.response.header.");
  });
});

describe("buildHeaderAllowlist / buildRedactedQueryKeys", () => {
  it("adds to defaults, lowercases and trims, ignores junk", () => {
    const set = buildHeaderAllowlist(DEFAULT_REQUEST_HEADERS, [
      " X-Tenant ",
      "",
      42 as unknown as string,
    ]);
    expect(set.has("x-tenant")).toBe(true);
    expect(set.has("content-type")).toBe(true);
    expect(set.size).toBe(4);
  });
  it("keeps every default query key when extras are given", () => {
    const set = buildRedactedQueryKeys(["MyKey"]);
    expect(set.has("mykey")).toBe(true);
    for (const k of DEFAULT_REDACTED_QUERY_KEYS) expect(set.has(k)).toBe(true);
  });
});

describe("headerAttributes", () => {
  it("picks allowlisted headers from a Node object, as string arrays", () => {
    const out = headerAttributes(
      {
        "content-type": "application/json",
        "content-length": "12",
        "x-request-id": "abc",
        "x-other": "no",
      },
      reqAllow,
      REQUEST_HEADER_PREFIX,
    );
    expect(out).toEqual({
      "http.request.header.content-type": ["application/json"],
      "http.request.header.content-length": ["12"],
      "http.request.header.x-request-id": ["abc"],
    });
  });

  it("handles mixed-case outgoing headers, numbers and array values", () => {
    const allow = buildHeaderAllowlist([
      "content-type",
      "content-length",
      "x-multi",
    ]);
    const out = headerAttributes(
      {
        "Content-Type": "text/plain",
        "Content-Length": 5,
        "X-Multi": ["a", "b"],
      },
      allow,
      RESPONSE_HEADER_PREFIX,
    );
    expect(out).toEqual({
      "http.response.header.content-type": ["text/plain"],
      "http.response.header.content-length": ["5"],
      "http.response.header.x-multi": ["a", "b"],
    });
  });

  it("merges a header that appears under two cases", () => {
    const allow = buildHeaderAllowlist(["x-a"]);
    const out = headerAttributes(
      { "X-A": "1", "x-a": "2" },
      allow,
      REQUEST_HEADER_PREFIX,
    );
    expect(out).toEqual({ "http.request.header.x-a": ["1", "2"] });
  });

  it("reads undici's flat array, with Buffers and repeated names", () => {
    const allow = buildHeaderAllowlist(["content-type", "x-multi"]);
    const out = headerAttributes(
      [
        Buffer.from("Content-Type"),
        Buffer.from("text/html"),
        "x-multi",
        "1",
        "x-multi",
        ["2", "3"] as unknown as string,
        "x-ignored",
        "z",
        "dangling",
      ],
      allow,
      RESPONSE_HEADER_PREFIX,
    );
    expect(out).toEqual({
      "http.response.header.content-type": ["text/html"],
      "http.response.header.x-multi": ["1", "2", "3"],
    });
  });

  it("reads an array of pairs", () => {
    const out = headerAttributes(
      [
        ["Content-Type", "a/b"],
        ["x-other", "no"],
      ],
      reqAllow,
      REQUEST_HEADER_PREFIX,
    );
    expect(out).toEqual({ "http.request.header.content-type": ["a/b"] });
  });

  it("records the always-redacted headers as REDACTED even when listed", () => {
    const allow = buildHeaderAllowlist(DEFAULT_REQUEST_HEADERS, [
      "Authorization",
      "proxy-authorization",
      "Cookie",
      "set-cookie",
    ]);
    const out = headerAttributes(
      {
        authorization: "Bearer s3cret",
        "proxy-authorization": "Basic s3cret",
        cookie: "sid=s3cret",
        "set-cookie": ["a=s3cret", "b=s3cret"],
      },
      allow,
      REQUEST_HEADER_PREFIX,
    );
    expect(out).toEqual({
      "http.request.header.authorization": [REDACTED],
      "http.request.header.proxy-authorization": [REDACTED],
      "http.request.header.cookie": [REDACTED],
      "http.request.header.set-cookie": [REDACTED],
    });
    expect(JSON.stringify(out)).not.toContain("s3cret");
  });

  it("collapses an always-redacted header seen under two cases to one REDACTED", () => {
    const allow = buildHeaderAllowlist(["authorization"]);
    expect(
      headerAttributes(
        { Authorization: "a", authorization: "b" },
        allow,
        REQUEST_HEADER_PREFIX,
      ),
    ).toEqual({ "http.request.header.authorization": [REDACTED] });
  });

  it("omits always-redacted headers that are not listed", () => {
    expect(
      headerAttributes(
        { authorization: "x", cookie: "y" },
        reqAllow,
        REQUEST_HEADER_PREFIX,
      ),
    ).toEqual({});
  });

  it("drops headers instead of leaking when the allowlist was built by hand with capitals", () => {
    const out = headerAttributes(
      { "x-a": "1" },
      new Set(["X-A"]),
      REQUEST_HEADER_PREFIX,
    );
    expect(out).toEqual({});
  });

  it("never throws on odd input", () => {
    expect(
      headerAttributes(undefined, reqAllow, REQUEST_HEADER_PREFIX),
    ).toEqual({});
    expect(headerAttributes(null, reqAllow, REQUEST_HEADER_PREFIX)).toEqual({});
    expect(
      headerAttributes(
        { "content-type": undefined, "content-length": { x: 1 } as never },
        reqAllow,
        REQUEST_HEADER_PREFIX,
      ),
    ).toEqual({});
    expect(
      headerAttributes(
        [1, 2, null, [], [[]]] as never,
        reqAllow,
        REQUEST_HEADER_PREFIX,
      ),
    ).toEqual({});
  });

  it("does not let a header named __proto__ pollute the result", () => {
    const allow = new Set(["__proto__"]);
    const out = headerAttributes(
      JSON.parse('{"__proto__": "x"}'),
      allow,
      REQUEST_HEADER_PREFIX,
    );
    expect(Object.keys(out)).toEqual([]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe("redactQuery", () => {
  it.each(DEFAULT_REDACTED_QUERY_KEYS)("redacts the default key %s", (key) => {
    expect(redactQuery(`a=1&${key}=hunter2&b=2`, keys)).toBe(
      `a=1&${key}=${REDACTED}&b=2`,
    );
  });

  it("is case-insensitive for keys", () => {
    expect(
      redactQuery(
        "Token=a&API_KEY=b&AWSAccessKeyId=c&X-Goog-Signature=d",
        keys,
      ),
    ).toBe(
      `Token=${REDACTED}&API_KEY=${REDACTED}&AWSAccessKeyId=${REDACTED}&X-Goog-Signature=${REDACTED}`,
    );
  });

  it("matches the percent-decoded key", () => {
    expect(redactQuery("api%5Fkey=hunter2&%74oken=x&API%5fKEY=y", keys)).toBe(
      `api%5Fkey=${REDACTED}&%74oken=${REDACTED}&API%5fKEY=${REDACTED}`,
    );
  });

  it("catches double-encoded keys", () => {
    expect(redactQuery("api%255Fkey=hunter2", keys)).toBe(
      `api%255Fkey=${REDACTED}`,
    );
  });

  it("catches a listed key when another part of the string has bad encoding", () => {
    expect(redactQuery("%zz=1&api%5Fkey=hunter2&%E0%A4%A=3", keys)).toBe(
      `%zz=1&api%5Fkey=${REDACTED}&%E0%A4%A=3`,
    );
  });

  it("uses the lenient decoder when the key has a malformed escape", () => {
    const out = redactQuery(
      "%74oken[%zz]=S1&api%5Fkey%5B%E0%5D=S2&ok=fine",
      keys,
    );
    expect(out).not.toContain("S1");
    expect(out).not.toContain("S2");
    expect(out).toContain("ok=fine");
  });

  it("decodes at least three rounds", () => {
    expect(redactQuery("api%25255Fkey=x", keys)).toBe(
      `api%25255Fkey=${REDACTED}`,
    );
  });

  it("matches bracket notation, which Express parses into nested values", () => {
    expect(
      redactQuery(
        "user[password]=a&token[]=b&auth%5B0%5D=c&filter[name]=ok&codes[]=d",
        keys,
      ),
    ).toBe(
      `user[password]=${REDACTED}&token[]=${REDACTED}&auth%5B0%5D=${REDACTED}&filter[name]=ok&codes[]=d`,
    );
  });

  it("redacts every occurrence of a repeated key and keeps order", () => {
    expect(redactQuery("a=1&token=x&b=2&token=y&a=3&TOKEN=z", keys)).toBe(
      `a=1&token=${REDACTED}&b=2&token=${REDACTED}&a=3&TOKEN=${REDACTED}`,
    );
  });

  it("redacts empty values of listed keys and keeps empty values of others", () => {
    expect(redactQuery("token=&a=&b", keys)).toBe(
      `token=${REDACTED}&a=&${REDACTED}`,
    );
  });

  it("splits at the first = only, so a value containing = is fully redacted", () => {
    expect(redactQuery("token=a=b==c&k2=v=w", keys)).toBe(
      `token=${REDACTED}&k2=v=w`,
    );
  });

  it("does not let an encoded & or = inside a value expose anything", () => {
    expect(redactQuery("token=a%26password%3Db&x=1", keys)).toBe(
      `token=${REDACTED}&x=1`,
    );
  });

  it("redacts segments with no = (could be a bare secret) and keeps empty segments", () => {
    expect(redactQuery("token&eyJhbGciOi&&a=1&", keys)).toBe(
      `${REDACTED}&${REDACTED}&&a=1&`,
    );
  });

  it("leaves other pairs and their encoding alone", () => {
    expect(redactQuery("q=hello%20world&page=2&tags=a%2Cb", keys)).toBe(
      "q=hello%20world&page=2&tags=a%2Cb",
    );
  });

  it("drops a leading ? and any fragment, and returns '' for empty", () => {
    expect(redactQuery("?a=1&token=x#frag=token=y", keys)).toBe(
      `a=1&token=${REDACTED}`,
    );
    expect(redactQuery("#only-fragment", keys)).toBe("");
    expect(redactQuery("", keys)).toBe("");
    expect(redactQuery("?", keys)).toBe("");
  });

  it("applies user-added keys, and a hand-built set with capitals cannot fail open", () => {
    expect(
      redactQuery(
        "tenant_secret=a&x=1",
        buildRedactedQueryKeys(["Tenant_Secret"]),
      ),
    ).toBe(`tenant_secret=${REDACTED}&x=1`);
    expect(redactQuery("tenant_secret=a", new Set(["TENANT_SECRET"]))).toBe(
      `tenant_secret=${REDACTED}`,
    );
  });

  it("matches a user-added non-ASCII key through its UTF-8 encoding", () => {
    const set = buildRedactedQueryKeys(["pässword"]);
    expect(redactQuery("p%C3%A4ssword=x&a=1", set)).toBe(
      `p%C3%A4ssword=${REDACTED}&a=1`,
    );
  });

  it("treats + in a key as a space, not as the listed key's underscore", () => {
    expect(redactQuery("api+key=x", keys)).toBe("api+key=x");
    expect(redactQuery("to+ken=x&%20token=y", keys)).toBe(
      `to+ken=x&%20token=${REDACTED}`,
    );
  });

  it("never throws on non-string input", () => {
    expect(redactQuery(undefined as unknown as string, keys)).toBe("");
    expect(redactQuery(5 as unknown as string, keys)).toBe("");
  });
});

describe("splitUrl", () => {
  it("splits a request target", () => {
    expect(splitUrl("/users/1?token=abc&page=2", keys)).toEqual({
      path: "/users/1",
      query: `token=${REDACTED}&page=2`,
    });
  });

  it("has no query key when there is none or it is empty", () => {
    expect(splitUrl("/users", keys)).toEqual({ path: "/users" });
    expect(splitUrl("/users?", keys)).toEqual({ path: "/users" });
    expect(splitUrl("/users?#f", keys)).toEqual({ path: "/users" });
  });

  it("never emits the fragment", () => {
    expect(splitUrl("/a?x=1#token=abc", keys)).toEqual({
      path: "/a",
      query: "x=1",
    });
    expect(splitUrl("/a#frag?token=abc", keys)).toEqual({ path: "/a" });
    expect(JSON.stringify(splitUrl("/a?x=1#secret", keys))).not.toContain(
      "secret",
    );
  });

  it("drops scheme, credentials and host from an absolute URL", () => {
    expect(
      splitUrl("https://user:pw@api.example.com:8443/v1/x?sig=1&a=b#f", keys),
    ).toEqual({
      path: "/v1/x",
      query: `sig=${REDACTED}&a=b`,
    });
    expect(splitUrl("http://example.com", keys)).toEqual({ path: "/" });
    expect(splitUrl("http://example.com?token=x", keys)).toEqual({
      path: "/",
      query: `token=${REDACTED}`,
    });
  });

  it("drops userinfo in the odd shapes URL parsers accept", () => {
    expect(splitUrl("//user:pw@host/p?x=1", keys)).toEqual({
      path: "/p",
      query: "x=1",
    });
    expect(splitUrl(" http://u:pw@h/x", keys)).toEqual({ path: "/x" });
    expect(splitUrl("\t\n\u0001 //u:pw@h/x", keys)).toEqual({ path: "/x" });
    expect(splitUrl("http:\\\\u:pw@h\\x", keys)).toEqual({ path: "\\x" });
    expect(splitUrl("http:///u:pw@h/x", keys)).toEqual({ path: "/x" });
    expect(splitUrl("http:/\\u:pw@h/x", keys)).toEqual({ path: "/x" });
    expect(splitUrl("///u:pw@h/x", keys)).toEqual({ path: "/x" });
    expect(splitUrl("//u:pw@h", keys)).toEqual({ path: "/" });
    for (const input of [
      "//user:pw@host/p",
      " http://u:pw@h/x",
      "http:\\\\u:pw@h\\x",
    ]) {
      expect(JSON.stringify(splitUrl(input, keys))).not.toContain("pw");
    }
  });

  it("keeps backslashes in the path of an origin-form target", () => {
    expect(splitUrl("/a\\b?x=1", keys)).toEqual({
      path: "/a\\b",
      query: "x=1",
    });
  });

  it("never throws on non-string input", () => {
    expect(splitUrl(undefined as unknown as string, keys)).toEqual({
      path: "",
    });
  });
});

// Property-style: a seeded generator builds random query strings from a mix of listed and
// unlisted keys in random case and encoding, with values that include hostile characters and
// a unique marker. No marker that belongs to a listed key may survive; everything else is kept.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: no value of a listed key survives", () => {
  const listed = [...buildRedactedQueryKeys(["x-tenant-secret"])];
  const unlisted = [
    "q",
    "page",
    "sort",
    "filter",
    "tokens",
    "keys",
    "codec",
    "a b",
  ];
  const valueChars = [
    "a",
    "Z",
    "0",
    "%",
    "%zz",
    "%26",
    "%3D",
    "=",
    "==",
    "+",
    "/",
    ":",
    "%E0%A4",
    "?",
    ";",
    "[",
    "]",
    "%00",
    "é",
  ];

  function encodeKeyRandomly(key: string, rnd: () => number): string {
    let out = "";
    for (const ch of key) {
      const r = rnd();
      if (r < 0.3) out += `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
      else if (r < 0.4)
        out += `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
      else if (r < 0.7) out += ch.toUpperCase();
      else out += ch;
    }
    return out;
  }

  function randomValue(marker: string, rnd: () => number): string {
    let v = marker;
    const n = Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) {
      const piece = valueChars[Math.floor(rnd() * valueChars.length)] as string;
      v = rnd() < 0.5 ? piece + v : v + piece;
    }
    return v;
  }

  it("holds over 3000 random queries", () => {
    const rnd = mulberry32(0xc0ffee);
    for (let iter = 0; iter < 3000; iter++) {
      const segments: string[] = [];
      const secretMarkers: string[] = [];
      const keptSegments = new Map<number, string>();
      const count = 1 + Math.floor(rnd() * 8);
      for (let i = 0; i < count; i++) {
        const isListed = rnd() < 0.55;
        const marker = `MARK${iter}x${i}Q`;
        const key = isListed
          ? encodeKeyRandomly(
              listed[Math.floor(rnd() * listed.length)] as string,
              rnd,
            )
          : (unlisted[Math.floor(rnd() * unlisted.length)] as string);
        const bracket = isListed && rnd() < 0.15 ? `[${i}]` : "";
        const value = rnd() < 0.1 ? "" : randomValue(marker, rnd);
        const segment = `${key}${bracket}=${value}`;
        segments.push(segment);
        if (isListed) secretMarkers.push(marker);
        else keptSegments.set(i, segment);
      }
      const input = segments.join("&");
      const out = redactQuery(
        input,
        buildRedactedQueryKeys(["x-tenant-secret"]),
      );

      for (const marker of secretMarkers) {
        expect(out, `iteration ${iter}: ${input}`).not.toContain(marker);
      }
      // Order and count preserved; unlisted segments untouched; listed ones end in REDACTED.
      const outSegments = out.split("&");
      expect(outSegments).toHaveLength(segments.length);
      segments.forEach((original, i) => {
        const got = outSegments[i] as string;
        if (keptSegments.has(i)) expect(got).toBe(original);
        else {
          expect(
            got.endsWith(`=${REDACTED}`),
            `iteration ${iter}: ${got}`,
          ).toBe(true);
          expect(got.slice(0, got.indexOf("="))).toBe(
            original.slice(0, original.indexOf("=")),
          );
        }
      });
      // And through splitUrl with a fragment appended: still no marker, no fragment.
      const url = splitUrl(
        `/p?${input}#FRAG${iter}`,
        buildRedactedQueryKeys(["x-tenant-secret"]),
      );
      expect(JSON.stringify(url)).not.toContain(`FRAG${iter}`);
      for (const marker of secretMarkers)
        expect(JSON.stringify(url)).not.toContain(marker);
    }
  });
});
