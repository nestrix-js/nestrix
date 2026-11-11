// Unit tests for the dashboard's pure pieces (P2-06): raw-response writing, asset loading and
// templating, query parameter parsing. No global state.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseQuery, traceListSpec } from "../src/dashboard/api.js";
import { escapeHtml, loadUi, renderIndex } from "../src/dashboard/assets.js";
import {
  type RawResponseLike,
  rawResponseOf,
  stripCors,
  takeOver,
  writeFailure,
  writeResponse,
} from "../src/dashboard/respond.js";

function fakeResponse(init: Record<string, string> = {}) {
  const headers = new Map(
    Object.entries(init).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    ended: undefined as unknown,
    destroyedWith: false,
    setHeader(n: string, v: string) {
      headers.set(n.toLowerCase(), v);
    },
    removeHeader(n: string) {
      headers.delete(n.toLowerCase());
    },
    getHeaderNames: () => [...headers.keys()],
    end(body?: unknown) {
      res.ended = body ?? "";
      res.writableEnded = true;
      res.headersSent = true;
    },
    destroy() {
      res.destroyedWith = true;
    },
  };
  return { res, headers };
}

describe("respond", () => {
  it("strips every Access-Control-* header, whatever its case", () => {
    const { res, headers } = fakeResponse({
      "access-control-allow-origin": "*",
      "Access-Control-Allow-Credentials": "true",
      vary: "Origin",
    });
    stripCors(res);
    expect([...headers.keys()]).toEqual(["vary"]);
  });

  it("writes the full header set, length and body; replaces a host CSP", () => {
    const { res, headers } = fakeResponse({
      "content-security-policy": "default-src *",
      "access-control-allow-origin": "*",
    });
    writeResponse(res, {
      status: 201,
      contentType: "text/plain",
      body: "héllo",
      headers: { location: "/x/" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.ended).toBe("héllo");
    expect(Object.fromEntries(headers)).toEqual({
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "cache-control": "no-store",
      "content-type": "text/plain",
      "content-length": "6",
      location: "/x/",
    });
  });

  it("does nothing on a response that already went out or was destroyed", () => {
    for (const state of [
      { headersSent: true },
      { writableEnded: true },
      { destroyed: true },
    ]) {
      const { res } = fakeResponse();
      Object.assign(res, state);
      writeResponse(res, { status: 200, body: "x" });
      expect(res.ended).toBeUndefined();
    }
  });

  it("writeFailure: a 500, or a destroyed socket when headers already went out; never throws", () => {
    const a = fakeResponse();
    writeFailure(a.res, { status: 500 });
    expect(a.res.statusCode).toBe(500);
    expect(a.res.ended).toBe("");

    const b = fakeResponse();
    b.res.headersSent = true;
    writeFailure(b.res, { status: 500 });
    expect(b.res.destroyedWith).toBe(true);

    const c = fakeResponse();
    c.res.setHeader = () => {
      throw new Error("setHeader fault");
    };
    expect(() => writeFailure(c.res, { status: 500 })).not.toThrow();
    expect(c.res.statusCode).toBe(500);
    expect(c.res.ended).toBe("");

    expect(() => writeFailure(undefined, { status: 500 })).not.toThrow();
  });

  it("takeOver hijacks a Fastify-like reply once; rawResponseOf prefers .raw", () => {
    let hijacked = 0;
    const { res } = fakeResponse();
    const reply = { raw: res, sent: false, hijack: () => hijacked++ };
    takeOver(reply);
    expect(hijacked).toBe(1);
    takeOver({ ...reply, sent: true });
    expect(hijacked).toBe(1);
    takeOver(res);
    takeOver(null);
    expect(rawResponseOf(reply)).toBe(res);
    expect(rawResponseOf(res)).toBe(res);
    expect(rawResponseOf({})).toBeUndefined();
    expect(rawResponseOf("x")).toBeUndefined();
  });
});

const sha = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");

function fakeUi(files: Record<string, string>, extra: object[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "nestrix-ui-unit-"));
  mkdirSync(join(dir, "assets"));
  const entries = Object.entries(files).map(([path, content]) => {
    writeFileSync(join(dir, path), content);
    return {
      path,
      size: Buffer.byteLength(content),
      sha256: sha(content),
      contentType: path.endsWith(".html")
        ? "text/html; charset=utf-8"
        : "text/javascript; charset=utf-8",
    };
  });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ files: [...entries, ...extra] }),
  );
  return dir;
}

const TEMPLATE =
  '<base href="__NESTRIX_BASE_HREF__" /><script type="application/json" id="nestrix-config">"__NESTRIX_CONFIG__"</script>';

describe("assets", () => {
  it("loads index.html and assets/*, and nothing else", () => {
    const dir = fakeUi({
      "index.html": TEMPLATE,
      "assets/a-1.js": "a",
      "index.js": "entry",
      "THIRD_PARTY_NOTICES.txt": "n",
    });
    const ui = loadUi(dir);
    expect([...ui.assets.keys()]).toEqual(["assets/a-1.js"]);
    expect(ui.assets.get("assets/a-1.js")?.body.toString()).toBe("a");
    expect(ui.indexTemplate).toBe(TEMPLATE);
  });

  it("refuses a file that does not match the manifest, a missing placeholder, odd paths", () => {
    const dir = fakeUi({ "index.html": TEMPLATE, "assets/a.js": "a" });
    writeFileSync(join(dir, "assets/a.js"), "b");
    expect(() => loadUi(dir)).toThrow(
      "assets/a.js does not match manifest.json (sha256)",
    );
    expect(() => loadUi(fakeUi({ "index.html": "<base>" }))).toThrow(
      "placeholders",
    );
    expect(() => loadUi(fakeUi({ "assets/a.js": "a" }))).toThrow(
      "index.html is missing",
    );
    // A path outside the served set is skipped, never read.
    const odd = fakeUi({ "index.html": TEMPLATE }, [
      {
        path: "assets/../../etc/passwd",
        size: 1,
        sha256: "x",
        contentType: "text/plain",
      },
      {
        path: "assets/sub/x.js",
        size: 1,
        sha256: "x",
        contentType: "text/plain",
      },
    ]);
    expect([...loadUi(odd).assets.keys()]).toEqual([]);
  });

  it("renders <base href> escaped and the config with < escaped; $ patterns stay literal", () => {
    const html = renderIndex(TEMPLATE, {
      apiBase: "/a$&b/api/v1",
      path: "/a$&b",
      protocolVersion: 1,
    });
    expect(html).toBe(
      '<base href="/a$&amp;b/" /><script type="application/json" id="nestrix-config">{"apiBase":"/a$&b/api/v1","path":"/a$&b","protocolVersion":1}</script>',
    );
    const evil = renderIndex(TEMPLATE, {
      apiBase: "</script><script>x</script>",
      path: "/p",
      protocolVersion: 1,
    });
    expect(evil).not.toContain("</script><script>");
    expect(evil).toContain("\\u003c/script>");
    expect(escapeHtml(`<"'&>`)).toBe("&lt;&quot;&#39;&amp;&gt;");
  });
});

describe("parseQuery", () => {
  it("applies defaults and parses each kind", () => {
    expect(parseQuery("/x", traceListSpec)).toEqual({
      ok: true,
      values: { limit: 50 },
    });
    expect(
      parseQuery(
        "/x?limit=10&status=5xx&minDurationMs=1.5&method=get&search=a+b&after=c#frag",
        traceListSpec,
      ),
    ).toEqual({
      ok: true,
      values: {
        limit: 10,
        status: "5xx",
        minDurationMs: 1.5,
        method: "get",
        search: "a b",
        after: "c",
      },
    });
  });

  it("rejects without echoing values, and caps the number of parameters", () => {
    const r = parseQuery("/x?limit=<script>", traceListSpec);
    expect(r).toEqual({
      ok: false,
      message: 'Query parameter "limit" must be an integer.',
    });
    const many = `/x?${Array.from({ length: 40 }, (_, i) => `limit=${i}`).join("&")}`;
    expect(parseQuery(many, traceListSpec).ok).toBe(false);
    expect(parseQuery(`/x?${"k".repeat(100)}=1`, traceListSpec)).toEqual({
      ok: false,
      message: `Unknown query parameter "${"k".repeat(64)}…".`,
    });
    expect(parseQuery("/x?limit=1e2", traceListSpec).ok).toBe(false);
    expect(parseQuery("/x?__proto__=1", traceListSpec).ok).toBe(false);
    expect(parseQuery(undefined, traceListSpec)).toEqual({
      ok: true,
      values: { limit: 50 },
    });
  });
});

// Type-level: RawResponseLike is satisfied by Node's ServerResponse.
type _ServerResponseFits =
  import("node:http").ServerResponse extends RawResponseLike ? true : never;
const _fits: _ServerResponseFits = true;
void _fits;
