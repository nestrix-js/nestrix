// Issue #48 / D-97: the pure helpers behind `http.redactPathParams`, `http.redactOutgoingPath`
// and `http.recordPath`, and their option validation.
import { describe, expect, it } from "vitest";
import {
  buildOutboundConfig,
  requestAttributes,
} from "../src/outbound/rules.js";
import {
  buildRedactedPathParams,
  compileOutgoingPathRedactors,
  DEFAULT_REDACTED_PATH_PARAMS,
  type OutgoingPathRedactor,
  redactOutgoingPath,
  redactPathParams,
  routeHasListedParam,
} from "../src/privacy.js";
import { resolveOptions } from "../src/resolve-options.js";
import { recordingDiagnostics } from "./otel-helpers.js";

const listed = buildRedactedPathParams(["inviteCode"]);

describe("redactPathParams", () => {
  it.each([
    ["/invitations/abc123", "/invitations/:token", "/invitations/REDACTED"],
    ["/invitations/abc123/", "/invitations/:token", "/invitations/REDACTED/"],
    ["/api/v1/x/abc/y", "/api/v1/x/:token/y", "/api/v1/x/REDACTED/y"],
    ["/i/abc/p", "/i/:inviteCode/p", "/i/REDACTED/p"],
    ["/u/7/s/abc", "/u/:id/s/:session", "/u/7/s/REDACTED"],
    // Several parameters in one segment: the whole segment goes.
    ["/f/abc.pdf", "/f/:token.:ext", "/f/REDACTED"],
    // Repeated slashes in the reported route (Nest reports it before normalising).
    ["/a/abc", "/a//:token/", "/a/REDACTED"],
    // Static segments compare after percent-decoding and lowercasing.
    ["/Caf%C3%A9/abc", "/café/:token", "/Caf%C3%A9/REDACTED"],
    ["/A/abc", "/a/:token", "/A/REDACTED"],
  ])("%s on %s gives %s", (path, route, expected) => {
    expect(redactPathParams(path, route, listed)).toBe(expected);
  });

  it.each([
    ["no listed parameter", "/items/42", "/items/:id", "/items/42"],
    ["no route", "/invitations/abc", undefined, "/invitations/abc"],
  ])("%s: path unchanged", (_label, path, route, expected) => {
    expect(redactPathParams(path, route, listed)).toBe(expected);
  });

  it.each([
    ["fewer segments", "/invitations", "/invitations/:token"],
    ["more segments", "/invitations/a/b", "/invitations/:token"],
    ["a static segment differs", "/other/abc", "/invitations/:token"],
    ["an empty segment", "/invitations//abc", "/invitations/x/:token"],
    ["a wildcard", "/files/a/abc", "/files/*rest/:token"],
    ["an optional group", "/u/abc", "/u{/:token}"],
    ["a regular-expression parameter", "/r/abc", "/r/:token(\\w+)"],
    ["an optional parameter", "/o/abc", "/o/:token?"],
    ["a quoted parameter name", "/q/abc", '/q/:"token"'],
    ["a path that is not origin-form", "*", "/x/:token"],
  ])(
    "cannot be lined up (%s): the template, never the raw value",
    (_l, path, route) => {
      expect(redactPathParams(path, route, listed)).toBe(route);
    },
  );

  it("is case-insensitive on parameter names, and the defaults include token", () => {
    expect(DEFAULT_REDACTED_PATH_PARAMS).toContain("token");
    expect(redactPathParams("/r/abc", "/r/:Token", listed)).toBe("/r/REDACTED");
    expect(routeHasListedParam("/r/:TOKEN", listed)).toBe(true);
    expect(routeHasListedParam("/r/:id", listed)).toBe(false);
    expect(routeHasListedParam(undefined, listed)).toBe(false);
  });

  it("never throws on odd input", () => {
    expect(() =>
      redactPathParams(undefined as never, "/x/:token", listed),
    ).not.toThrow();
    expect(redactPathParams(undefined as never, "/x/:token", listed)).toBe(
      "/x/:token",
    );
    expect(redactPathParams("/x/a", "/x/:token", new Set())).toBe("/x/a");
  });
});

function compiled(entries: unknown[]): OutgoingPathRedactor[] {
  const r = compileOutgoingPathRedactors(entries);
  if ("error" in r) throw new Error(r.error);
  return r;
}

describe("redactOutgoingPath", () => {
  const base = "https://api.example.com:8443";

  it.each<[string, unknown[], string]>([
    [
      "/v1/invitations/abc?x=1",
      ["/v1/invitations/:token"],
      "/v1/invitations/REDACTED?x=1",
    ],
    [
      "/v1/invitations/abc/accept",
      ["/v1/invitations/:token"],
      "/v1/invitations/REDACTED/accept",
    ],
    ["/v1/invitations", ["/v1/invitations/:token"], "/v1/invitations"],
    ["/v1/other/abc", ["/v1/invitations/:token"], "/v1/other/abc"],
    ["/u/7/reset/abc", ["/u/*/reset/:token"], "/u/7/reset/REDACTED"],
    [
      "/v1/invitations/abc",
      [`${base.toUpperCase()}/v1/invitations/:token`],
      "/v1/invitations/REDACTED",
    ],
    [
      "/v1/invitations/abc",
      ["https://other.example.com/v1/invitations/:token"],
      "/v1/invitations/abc",
    ],
    ["/reset/abc/x", [/^\/reset\/([^/]+)/], "/reset/REDACTED/x"],
    ["/a/k1/b/k2", [/\/(k\d)/], "/a/REDACTED/b/k2"],
    ["/a/k1/b/k2", [/\/(k\d)/g], "/a/REDACTED/b/REDACTED"],
    ["/a/secret-x/b", [/secret-\w+/], "/a/REDACTED/b"],
    ["/a/b", [/(?:)/g], "/a/b"],
  ])("%s with %o", (path, entries, expected) => {
    expect(redactOutgoingPath(`${base}${path}`, compiled(entries))).toBe(
      `${base}${expected}`,
    );
  });

  it.each([
    [
      "https://h.example:443/v1/:t",
      "https://h.example/v1/abc",
      "https://h.example/v1/REDACTED",
    ],
    [
      "http://h.example:80/v1/:t",
      "http://h.example/v1/abc",
      "http://h.example/v1/REDACTED",
    ],
    [
      "http://h.example:443/v1/:t",
      "http://h.example:443/v1/abc",
      "http://h.example:443/v1/REDACTED",
    ],
    [
      "https://h.example:8443/v1/:t",
      "https://h.example/v1/abc",
      "https://h.example/v1/abc",
    ],
  ])(
    "pattern origin %s: default ports are normalised (%s)",
    (pattern, full, expected) => {
      expect(redactOutgoingPath(full, compiled([pattern]))).toBe(expected);
    },
  );

  it("a redactor that throws fails closed: the whole path is REDACTED and the error reported", () => {
    const broken = {
      kind: "regexp",
      re: {
        exec() {
          throw new Error("boom");
        },
      },
      global: false,
    } as unknown as OutgoingPathRedactor;
    const errors: unknown[] = [];
    expect(
      redactOutgoingPath(`${base}/v1/x/abc?q=1`, [broken], (e) =>
        errors.push(e),
      ),
    ).toBe(`${base}/REDACTED?q=1`);
    expect(errors).toHaveLength(1);
    // An `onError` that throws changes nothing.
    expect(
      redactOutgoingPath(`${base}/v1/x/abc`, [broken], () => {
        throw new Error("counter");
      }),
    ).toBe(`${base}/REDACTED`);
  });

  it.each([
    [42, "must be a string or a RegExp"],
    ["v1/:token", 'must start with "/"'],
    ["/v1/invitations", 'at least one ":name"'],
    ["/v1/:token?x=1", "must not hold a query"],
    ["/v1//x/:t", "must not hold an empty segment"],
    ["https://h.example/a//:t", "must not hold an empty segment"],
  ])("rejects %o", (entry, message) => {
    const r = compileOutgoingPathRedactors([entry]);
    expect("error" in r && r.error).toContain(message);
  });

  it("is applied to url.full by requestAttributes; the target used for ignore.outgoing is unchanged", () => {
    const diagnostics = recordingDiagnostics();
    const config = buildOutboundConfig(
      resolveOptions(
        { http: { redactOutgoingPath: ["/v1/invitations/:token"] } },
        {},
      ),
      diagnostics,
    );
    const target = {
      full: "http://h/v1/invitations/abc",
      address: "h",
      port: 80,
    };
    const attributes = requestAttributes("GET", target, undefined, config);
    expect(attributes["url.full"]).toBe("http://h/v1/invitations/REDACTED");
    expect(target.full).toBe("http://h/v1/invitations/abc");
  });
});

describe("http options (D-97)", () => {
  it("defaults: recordPath 'raw', no additions, no outgoing patterns", () => {
    const r = resolveOptions({}, {});
    expect(r.http.recordPath).toBe("raw");
    expect(r.http.redactPathParams).toEqual([]);
    expect(r.http.redactOutgoingPath).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["http.recordPath must be 'raw' or 'template'", { recordPath: "full" }],
    [
      "http.redactPathParams must be an array of strings",
      { redactPathParams: "token" },
    ],
    [
      "http.redactPathParams must be an array of strings",
      { redactPathParams: [1] },
    ],
    [
      "http.redactOutgoingPath must be an array",
      { redactOutgoingPath: "/x/:t" },
    ],
    [
      'http.redactOutgoingPath[1] must hold at least one ":name" segment',
      { redactOutgoingPath: ["/x/:t", "/y"] },
    ],
    ["http must be an object", 42],
  ])("throws %s", (message, http) => {
    expect(() => resolveOptions({ http: http as never }, {})).toThrow(message);
  });

  it("http: null is treated like no http option", () => {
    const r = resolveOptions({ http: null as never }, {});
    expect(r.http.recordPath).toBe("raw");
    expect(r.http.redactOutgoingPath).toEqual([]);
  });
});
