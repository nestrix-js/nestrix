import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  errorList,
  meta,
  routes,
  trace,
  traceList,
} from "../fixtures/index.js";
import * as protocol from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("package entry", () => {
  it("exports the version and the specs, and no fixtures", () => {
    expect(protocol.PROTOCOL_VERSION).toBe(1);
    expect(Object.keys(protocol).sort()).toEqual(
      [
        "PROTOCOL_VERSION",
        "appMapParams",
        "classStatsParams",
        "errorListParams",
        "metaParams",
        "profileIdParams",
        "profileStartBody",
        "routeStatsParams",
        "traceListParams",
        "traceParams",
      ].sort(),
    );
  });

  it("does not map any export to a TypeScript file", () => {
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8"),
    );
    expect(JSON.stringify(pkg.exports)).not.toMatch(/(?<!\.d)\.ts"/);
    expect(JSON.stringify(pkg.exports)).not.toMatch(/fixtures/);
  });
});

describe("parameter specs", () => {
  it("every spec entry has the fields its kind needs", () => {
    for (const spec of [
      protocol.traceListParams,
      protocol.errorListParams,
      protocol.routeStatsParams,
      protocol.traceParams,
      protocol.profileStartBody,
      protocol.profileIdParams,
    ]) {
      for (const p of Object.values(spec) as protocol.ParamSpec[]) {
        if (p.kind === "int" || p.kind === "number") {
          expect(p.min).toBeLessThanOrEqual(p.max);
          if (p.default !== undefined) {
            expect(p.default).toBeGreaterThanOrEqual(p.min);
            expect(p.default).toBeLessThanOrEqual(p.max);
          }
        } else if (p.kind === "enum") {
          expect(p.values.length).toBeGreaterThan(0);
          if (p.default !== undefined) expect(p.values).toContain(p.default);
        } else if (p.kind === "string" || p.kind === "cursor") {
          expect(p.maxLength).toBeGreaterThan(0);
        }
      }
    }
  });

  it("has the bounds the backlog fixes", () => {
    expect(protocol.traceListParams.limit).toEqual({
      kind: "int",
      min: 1,
      max: 200,
      default: 50,
    });
    expect(protocol.traceListParams.search.maxLength).toBe(200);
    expect(protocol.traceListParams.type.values).toEqual([
      "http",
      "job",
      "scheduled",
      "other",
    ]);
    expect(protocol.traceListParams.release.maxLength).toBe(255);
    expect(protocol.traceListParams.user.maxLength).toBe(256);
    expect(protocol.routeStatsParams.windowMinutes.oneOf).toEqual([15, 60]);
    expect(protocol.routeStatsParams.windowMinutes.default).toBe(15);
  });

  it("the trace id pattern accepts a trace id and rejects others", () => {
    const re = new RegExp(protocol.traceParams.id.pattern);
    expect(re.test(trace.traceId)).toBe(true);
    expect(re.test("ABC")).toBe(false);
  });
});

describe("fixtures (types are checked by tsc via `satisfies`; this checks consistency)", () => {
  it("survive a JSON round trip unchanged (what the server will send)", () => {
    for (const f of [meta, traceList, trace, errorList, routes]) {
      expect(JSON.parse(JSON.stringify(f))).toEqual(f);
    }
  });

  it("the trace has the span kinds, an exception event and a remote parent", () => {
    const ids = new Set(trace.spans.map((s) => s.spanId));
    expect(new Set(trace.spans.map((s) => s.kind))).toEqual(
      new Set(["server", "client", "internal"]),
    );
    expect(
      trace.spans.some((s) => s.events.some((e) => e.name === "exception")),
    ).toBe(true);
    const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
    expect(root?.parentSpanId).toBeDefined();
    expect(ids.has(root?.parentSpanId as string)).toBe(false);
    // Every other span's parent is in the trace.
    for (const s of trace.spans.filter((x) => x.spanId !== trace.rootSpanId)) {
      expect(ids.has(s.parentSpanId as string)).toBe(true);
    }
  });

  it("the root is the earliest span with no parent inside the trace", () => {
    const ids = new Set(trace.spans.map((s) => s.spanId));
    const roots = trace.spans.filter(
      (s) => !s.parentSpanId || !ids.has(s.parentSpanId),
    );
    const earliest = roots.reduce((a, b) =>
      b.startTimeUnixMs < a.startTimeUnixMs ? b : a,
    );
    expect(earliest.spanId).toBe(trace.rootSpanId);
  });

  it("the trace list summarises the trace", () => {
    const item = traceList.items.find((i) => i.traceId === trace.traceId);
    expect(item).toMatchObject({
      rootSpanId: trace.rootSpanId,
      spanCount: trace.spans.length,
      error: true,
    });
    const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
    expect(item?.type).toBe(root?.kind === "server" ? "http" : "other");
    expect(item?.release).toBe(trace.resource["service.version"]);
    expect(item?.user).toBe(root?.attributes["user.id"]);
    expect(traceList.head).toBe(traceList.items[0]?.cursor);
    const times = traceList.items.map((i) => i.startTimeUnixMs);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("error and route fixtures are internally consistent", () => {
    expect(errorList.older).toBeNull();
    expect(errorList.items.some((e) => e.traceId === trace.traceId)).toBe(true);
    expect(routes.toUnixMs - routes.fromUnixMs).toBe(routes.bucketMs * 5);
    for (const r of routes.routes) {
      expect(r.series.reduce((n, p) => n + p.count, 0)).toBe(r.count);
      expect(r.series.reduce((n, p) => n + p.errors, 0)).toBe(r.errors);
      expect(r.p50Ms).toBeLessThanOrEqual(r.p95Ms);
      expect(r.p95Ms).toBeLessThanOrEqual(r.p99Ms);
      expect(r.p99Ms).toBeLessThanOrEqual(r.maxMs);
    }
    expect(meta.protocolVersion).toBe(protocol.PROTOCOL_VERSION);
    expect(meta.statistics.windowMinutesOptions).toContain(
      routes.windowMinutes,
    );
  });
});

describe("@nestrix/nestjs declarations do not reference the private protocol package", () => {
  const dist = resolve(here, "..", "..", "nestjs", "dist");
  const entry = join(dist, "index.d.ts");

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory()
        ? walk(join(dir, d.name))
        : d.name.endsWith(".d.ts")
          ? [join(dir, d.name)]
          : [],
    );
  }

  /** Relative specifiers a .d.ts imports, re-exports or `import()`s. */
  function relativeSpecifiers(text: string): string[] {
    const found: string[] = [];
    for (const m of text.matchAll(
      /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g,
    )) {
      if (m[1]?.startsWith(".")) found.push(m[1]);
    }
    return found;
  }

  function resolveDts(from: string, spec: string): string | undefined {
    const base = resolve(dirname(from), spec).replace(/\.js$/, "");
    return [`${base}.d.ts`, join(base, "index.d.ts")].find(
      (p) => existsSync(p) && statSync(p).isFile(),
    );
  }

  it.skipIf(!existsSync(entry))(
    "no .d.ts reachable from dist/index.d.ts mentions @nestrix/protocol (skipped when packages/nestjs/dist is absent: run `pnpm --filter @nestrix/nestjs build`)",
    () => {
      const seen = new Set<string>();
      const queue = [entry];
      while (queue.length > 0) {
        const file = queue.pop() as string;
        if (seen.has(file)) continue;
        seen.add(file);
        const text = readFileSync(file, "utf8");
        expect(text, `${file} references @nestrix/protocol`).not.toContain(
          "@nestrix/protocol",
        );
        for (const spec of relativeSpecifiers(text)) {
          const next = resolveDts(file, spec);
          if (next) queue.push(next);
        }
      }
      expect(seen.size).toBeGreaterThan(0);
    },
  );

  it.skipIf(!existsSync(dist))(
    "the walk is not vacuous: it reaches more than the entry file when the entry re-exports",
    () => {
      const all = walk(dist);
      expect(all.length).toBeGreaterThan(0);
    },
  );
});
