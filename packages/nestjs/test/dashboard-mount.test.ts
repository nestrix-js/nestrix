// Global state: no host SDK. Nestrix owns the OpenTelemetry provider (export off) with the
// dashboard on (`ui: { enabled: true, auth: { token } }`), one app at a time.
//
// P2-06 "Done when", on Express, Fastify and platform-node, through NestFactory and
// @nestjs/testing, with and without a global prefix and URI versioning, with
// `useSecurityHeaders()` and permissive host CORS (Fastify: `hook: 'preSerialization'`):
// index, a byte-exact asset with its content type, every API route; no `Access-Control-*` on any
// dashboard response, success or error; Nestrix's CSP and full header set everywhere.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uiPackage } from "../src/dashboard/assets.js";
import { resetDiagnosticsForTests } from "../src/diagnostics.js";
import {
  ADAPTERS,
  BEARER,
  bootDashboardApp,
  corsHeaders,
  type DashboardApp,
  type DashboardAppOptions,
  EVIL_ORIGIN,
  get,
  headerProblems,
  TOKEN,
} from "./dashboard-fixture.js";

const uiDir = uiPackage.resolveDirectory() as string;
const manifest = JSON.parse(
  readFileSync(join(uiDir, "manifest.json"), "utf8"),
) as { files: { path: string; contentType: string; sha256: string }[] };
const assetFiles = manifest.files.filter((f) => f.path.startsWith("assets/"));
const jsAsset = assetFiles.find((f) => f.path.endsWith(".js"));

let booted: DashboardApp | undefined;
beforeEach(() => resetDiagnosticsForTests());
afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const NESTRIX = {
  serviceName: "dash-test",
  export: { otlp: false as const },
  ui: { enabled: true, auth: { token: TOKEN } },
};

type Setup = Pick<
  DashboardAppOptions,
  "prefixAndVersioning" | "securityHeaders" | "cors" | "testing"
>;
const SETUPS: [string, Setup][] = [
  ["no prefix", {}],
  ["global prefix + URI versioning", { prefixAndVersioning: true }],
  [
    "useSecurityHeaders + permissive CORS",
    { securityHeaders: true, cors: true },
  ],
  [
    "@nestjs/testing, prefix, versioning, security headers, CORS",
    {
      testing: true,
      prefixAndVersioning: true,
      securityHeaders: true,
      cors: true,
    },
  ],
];

const ASK = { ...BEARER, origin: EVIL_ORIGIN };

describe.each(ADAPTERS)("dashboard on %s", (adapter) => {
  it.each(SETUPS)(
    "%s: index, asset, every API route, headers",
    async (_, setup) => {
      booted = await bootDashboardApp({ adapter, nestrix: NESTRIX, ...setup });
      const base = booted.baseUrl;
      const problems: Record<string, string[]> = {};
      const check = (
        label: string,
        r: Awaited<ReturnType<typeof get>>,
        cache?: string,
      ) => {
        const p = headerProblems(r, cache);
        if (p.length > 0) problems[label] = p;
      };

      // The host route works where the setup says, and host CORS is really active on it.
      const host = await get(
        `${base}${booted.hostOk.replace("/ok", "/json")}`,
        {
          origin: EVIL_ORIGIN,
        },
      );
      expect(host.json()).toEqual({ ok: true });
      if (setup.cors) {
        expect(host.headers.get("access-control-allow-origin")).toBe(
          EVIL_ORIGIN,
        );
      }

      for (const path of ["/_nestrix", "/_nestrix/"]) {
        const index = await get(`${base}${path}`, ASK);
        expect(index.status, path).toBe(200);
        expect(index.headers.get("content-type")).toBe(
          "text/html; charset=utf-8",
        );
        expect(index.text).toContain('<base href="/_nestrix/" />');
        expect(index.text).toContain(
          '{"apiBase":"/_nestrix/api/v1","path":"/_nestrix","protocolVersion":1}',
        );
        expect(index.text).not.toContain("__NESTRIX_");
        check(path, index);
      }

      // Every asset, byte-exact, with the manifest's content type and immutable caching.
      for (const file of assetFiles) {
        const r = await get(`${base}/_nestrix/${file.path}`, ASK);
        expect(r.status, file.path).toBe(200);
        expect(r.headers.get("content-type")).toBe(file.contentType);
        expect(createHash("sha256").update(r.body).digest("hex")).toBe(
          file.sha256,
        );
        expect(r.body.equals(readFileSync(join(uiDir, file.path)))).toBe(true);
        check(file.path, r, "public, max-age=31536000, immutable");
      }
      // Not served: the Node entry, its map, the notices, the manifest.
      for (const path of [
        "index.js",
        "index.d.ts",
        "manifest.json",
        "THIRD_PARTY_NOTICES.txt",
      ]) {
        const r = await get(`${base}/_nestrix/${path}`, ASK);
        expect(r.status, path).toBe(404);
        expect(r.headers.get("content-security-policy")).not.toBe(
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
        );
      }

      // Traffic for the lists: one ok, one 500.
      await get(`${base}${booted.hostOk}`);
      await get(`${base}${booted.hostOk.replace("/ok", "/boom")}`);

      const api = `${base}/_nestrix/api/v1`;
      const meta = await get(`${api}/meta`, ASK);
      expect(meta.status).toBe(200);
      expect(meta.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(meta.json()).toMatchObject({
        protocolVersion: 1,
        service: { name: "dash-test" },
        sampling: { owner: "nestrix", rate: 1 },
        statistics: { windowMinutesOptions: [15, 60] },
        warnings: [],
      });
      check("meta", meta);

      // The store drains on setImmediate; give it a moment.
      let traces = await get(`${api}/traces`, ASK);
      for (
        let i = 0;
        i < 50 && (traces.json() as { items: unknown[] }).items.length < 2;
        i++
      ) {
        await new Promise((r) => setTimeout(r, 20));
        traces = await get(`${api}/traces`, ASK);
      }
      expect(traces.status).toBe(200);
      const list = traces.json() as {
        items: { traceId: string; route?: string; statusCode?: number }[];
        head: string;
      };
      const routes = list.items.map((i) => `${i.route} ${i.statusCode}`);
      const prefix = setup.prefixAndVersioning ? "/api/v1" : "";
      expect(routes).toContain(`${prefix}/h/ok 200`);
      expect(routes).toContain(`${prefix}/h/boom 500`);
      // Dashboard requests are not traced.
      expect(list.items.every((i) => !i.route?.includes("_nestrix"))).toBe(
        true,
      );
      check("traces", traces);

      const first = list.items[0] as { traceId: string };
      const trace = await get(`${api}/trace?id=${first.traceId}`, ASK);
      expect(trace.status).toBe(200);
      expect(trace.json()).toMatchObject({ traceId: first.traceId });
      check("trace", trace);

      const errors = await get(`${api}/errors`, ASK);
      expect(errors.status).toBe(200);
      expect(
        (errors.json() as { items: { route?: string }[] }).items.map(
          (i) => i.route,
        ),
      ).toContain(`${prefix}/h/boom`);
      check("errors", errors);

      const stats = await get(`${api}/routes?windowMinutes=60`, ASK);
      expect(stats.status).toBe(200);
      const body = stats.json() as {
        windowMinutes: number;
        routes: {
          method: string;
          route: string;
          count: number;
          errors: number;
        }[];
      };
      expect(body.windowMinutes).toBe(60);
      expect(body.routes).toContainEqual(
        expect.objectContaining({
          method: "GET",
          route: `${prefix}/h/boom`,
          errors: 1,
        }),
      );
      // Dashboard requests are not counted.
      expect(body.routes.every((r) => !r.route.includes("_nestrix"))).toBe(
        true,
      );
      check("routes", stats);

      // Error paths carry the same headers and no CORS: 400, 404 API, denied 404.
      const bad = await get(`${api}/traces?nope=1`, ASK);
      expect(bad.status).toBe(400);
      expect(bad.json()).toEqual({
        error: {
          code: "bad_request",
          message: 'Unknown query parameter "nope".',
        },
      });
      check("400", bad);
      const missing = await get(`${api}/trace?id=${"0".repeat(32)}`, ASK);
      expect(missing.status).toBe(404);
      expect((missing.json() as { error: { code: string } }).error.code).toBe(
        "not_found",
      );
      check("404 not_found", missing);
      const denied = await get(`${api}/meta`, { origin: EVIL_ORIGIN });
      expect(denied.status).toBe(404);
      expect(denied.body.length).toBe(0);
      expect(denied.headers.get("cache-control")).toBe("no-store");
      expect(denied.headers.get("x-content-type-options")).toBe("nosniff");
      expect(corsHeaders(denied.headers)).toEqual([]);

      expect(problems).toEqual({});
    },
  );

  it("HEAD on index and an asset: headers, no body", async () => {
    booted = await bootDashboardApp({ adapter, nestrix: NESTRIX });
    const res = await fetch(`${booted.baseUrl}/_nestrix/`, {
      method: "HEAD",
      headers: BEARER,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    if (jsAsset) {
      const a = await fetch(`${booted.baseUrl}/_nestrix/${jsAsset.path}`, {
        method: "HEAD",
        headers: BEARER,
      });
      expect(a.status).toBe(200);
      expect(a.headers.get("content-type")).toBe(jsAsset.contentType);
      expect(a.headers.get("content-length")).toBe(
        String(statSync(join(uiDir, jsAsset.path)).size),
      );
      expect((await a.arrayBuffer()).byteLength).toBe(0);
    }
  });

  it("HEAD on an API route answers its headers without a body; HEAD /auth without a token is denied", async () => {
    booted = await bootDashboardApp({ adapter, nestrix: NESTRIX });
    const meta = await fetch(`${booted.baseUrl}/_nestrix/api/v1/meta`, {
      method: "HEAD",
      headers: BEARER,
    });
    expect(meta.status).toBe(200);
    expect(meta.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(Number(meta.headers.get("content-length"))).toBeGreaterThan(0);
    expect(meta.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(corsHeaders(meta.headers)).toEqual([]);
    expect((await meta.arrayBuffer()).byteLength).toBe(0);

    const auth = await fetch(`${booted.baseUrl}/_nestrix/auth`, {
      method: "HEAD",
      redirect: "manual",
    });
    expect(auth.status).toBe(404);
    expect(auth.headers.get("set-cookie")).toBeNull();
    expect((await auth.arrayBuffer()).byteLength).toBe(0);
  });

  it("a denied request is a bare 404: no-store and nosniff only", async () => {
    booted = await bootDashboardApp({ adapter, nestrix: NESTRIX });
    const denied = await get(`${booted.baseUrl}/_nestrix/api/v1/meta`, {
      origin: EVIL_ORIGIN,
    });
    expect(denied.status).toBe(404);
    expect(denied.body.length).toBe(0);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(denied.headers.get("x-content-type-options")).toBe("nosniff");
    for (const name of [
      "content-security-policy",
      "x-robots-tag",
      "x-frame-options",
      "referrer-policy",
      "content-type",
    ]) {
      expect(denied.headers.get(name), name).toBeNull();
    }
    expect(corsHeaders(denied.headers)).toEqual([]);
  });

  it("the host's preflight answer is not Nestrix's (documented limit)", async () => {
    booted = await bootDashboardApp({ adapter, nestrix: NESTRIX, cors: true });
    const res = await fetch(`${booted.baseUrl}/_nestrix/api/v1/meta`, {
      method: "OPTIONS",
      headers: {
        origin: EVIL_ORIGIN,
        "access-control-request-method": "GET",
      },
    });
    // Recorded, not asserted as desired: architecture §4.7 says the host's CORS layer answers.
    expect(res.status).toBe(204);
    expect(corsHeaders(res.headers).length).toBeGreaterThan(0);
  });
});
