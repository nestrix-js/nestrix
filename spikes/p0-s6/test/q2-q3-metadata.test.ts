// Q2: wrap methods as own properties ("own") or through a per-class derived prototype ("proto"), and
// check method-level metadata features with different copy sets, on all three adapters.
// Q3: which function object Nest calls, for static and request-scoped controllers.
import "reflect-metadata";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AppModule,
  CALLS,
  HANDLER_NAMES,
  PROBES,
} from "../src/app/fixtures.ts";
import { ADAPTERS, type AdapterName, boot } from "../src/boot.ts";
import { ruleEverything, ruleMarkers } from "../src/rules.ts";
import { setupTracing } from "../src/tracing.ts";
import {
  type CopyOptions,
  createInstanceDecorator,
  isWrapper,
  type Strategy,
} from "../src/wrap.ts";

const exporter = setupTracing();

const set = (
  metadata: boolean,
  name: boolean,
  length: boolean,
  ownProps = false,
): CopyOptions => ({
  metadata,
  name,
  length,
  ownProps,
});
const COPY_SETS: Record<string, CopyOptions> = {
  none: set(false, false, false),
  "name+length": set(false, true, true),
  metadata: set(true, false, false),
  "metadata+name": set(true, true, false),
  "metadata+name+length": set(true, true, true),
  full: set(true, true, true, true),
};

interface Outcome {
  guarded: number;
  code: number;
  header: string | null;
  metaNoRole: number;
  metaRole: number;
  tag: unknown;
  pipeMetatype: boolean;
  teapot: string;
  rsGuarded: number;
  rsMeta: number;
  rsCode: string;
  explicitRsGuarded: number;
  handlerName: string;
  spans: number;
  internalErrors: number;
}

async function run(
  adapter: AdapterName,
  strategy: Strategy,
  copy: CopyOptions | null, // null: no instrument at all (the baseline)
): Promise<Outcome> {
  let internalErrors = 0;
  const decorator = copy
    ? createInstanceDecorator({
        strategy,
        copy,
        shouldWrapClass: ruleMarkers,
        onInternalError: () => internalErrors++,
      })
    : undefined;
  const b = await boot(adapter, AppModule, { instanceDecorator: decorator });
  try {
    CALLS.length = 0;
    HANDLER_NAMES.length = 0;
    exporter.reset();
    const guarded = (await b.get("/users/guarded")).status;
    const codeRes = await b.get("/users/code");
    const header = (await b.get("/users/header")).headers.get("x-s6");
    const metaNoRole = (await b.get("/users/meta")).status;
    const metaRole = (await b.get("/users/meta", { "x-role": "admin" })).status;
    const tag = (await b.get("/users/tag")).body;
    const one = await b.get("/users/1");
    const pipeMetatype =
      one.status === 200 && CALLS.includes("pipe:param:String");
    const t = await b.get("/users/teapot");
    const teapot = `${t.status}${(t.body as { filtered?: boolean })?.filtered ? " filtered" : ""}`;
    const rsGuarded = (await b.get("/rs/guarded")).status;
    const rsMeta = (await b.get("/rs/meta")).status;
    const rsc = await b.get("/rs/code");
    const rsCode = `${rsc.status} ${rsc.headers.get("x-s6") ?? "-"}`;
    const explicitRsGuarded = (await b.get("/explicit-rs/guarded")).status;
    return {
      guarded,
      code: codeRes.status,
      header,
      metaNoRole,
      metaRole,
      tag: (tag as { tag?: unknown })?.tag ?? tag,
      pipeMetatype,
      teapot,
      rsGuarded,
      rsMeta,
      rsCode,
      explicitRsGuarded,
      handlerName: HANDLER_NAMES[0] ?? "-",
      spans: exporter.getFinishedSpans().length,
      internalErrors,
    };
  } finally {
    await b.close();
  }
}

const EXPECTED: Omit<Outcome, "spans" | "internalErrors"> = {
  guarded: 403,
  code: 202,
  header: "yes",
  metaNoRole: 403,
  metaRole: 200,
  tag: "tag:hello",
  pipeMetatype: true,
  teapot: "418 filtered",
  rsGuarded: 403,
  rsMeta: 403,
  rsCode: "202 yes",
  explicitRsGuarded: 403,
  handlerName: "meta",
};

const matrix: string[] = [];

describe("Q2 copy matrix", () => {
  beforeEach(() => {
    exporter.reset();
  });

  // The undecorated app: the baseline every row is compared with, all 13 values, every adapter.
  for (const adapter of ADAPTERS) {
    it(`${adapter} baseline without instrument gives every expected value`, async () => {
      const { spans, internalErrors, ...observed } = await run(
        adapter,
        "own",
        null,
      );
      expect(observed).toEqual(EXPECTED);
      expect(spans).toBe(0);
      expect(internalErrors).toBe(0);
    });
  }

  for (const adapter of ADAPTERS) {
    for (const strategy of ["own", "proto"] as Strategy[]) {
      for (const [copyName, copy] of Object.entries(COPY_SETS)) {
        it(`${adapter} / ${strategy} / copy ${copyName}`, async () => {
          const o = await run(adapter, strategy, copy);
          const { spans, internalErrors, ...observed } = o;
          const diffs = Object.entries(EXPECTED)
            .filter(([k, v]) => (observed as Record<string, unknown>)[k] !== v)
            .map(
              ([k]) =>
                `${k}=${JSON.stringify((observed as Record<string, unknown>)[k])}`,
            );
          matrix.push(
            `| ${adapter} | ${strategy} | ${copyName} | ${o.guarded} | ${o.code} | ${o.header ?? "-"} | ${o.metaNoRole}/${o.metaRole} | ${o.tag} | ${o.pipeMetatype} | ${o.teapot} | ${o.rsGuarded} | ${o.rsMeta} | ${o.rsCode} | ${o.explicitRsGuarded} | ${o.handlerName} | ${spans} | ${diffs.length === 0 ? "all pass" : diffs.join(", ")} |`,
          );
          expect(internalErrors).toBe(0);
          expect(spans).toBeGreaterThan(0);
          if (copy.metadata && copy.name) {
            // metadata+name (no length), metadata+name+length, full: identical to the baseline.
            expect(observed).toEqual(EXPECTED);
          } else if (copy.metadata) {
            // Everything works except the handler's name.
            expect(observed).toEqual({ ...EXPECTED, handlerName: "wrapped" });
          } else if (strategy === "own") {
            // No metadata on "own": method-level guards fail open, static and request-scoped.
            expect(o.guarded).toBe(200);
            expect(o.metaNoRole).toBe(200);
            expect(o.rsGuarded).toBe(200);
            expect(o.rsMeta).toBe(200);
            expect(o.explicitRsGuarded).toBe(200);
            expect(o.code).toBe(200);
            expect(o.header).toBeNull();
          } else {
            // No metadata on "proto": static routes vanish, request-scoped guards fail open.
            expect(o.guarded).toBe(404);
            expect(o.code).toBe(404);
            expect(o.rsGuarded).toBe(200);
            expect(o.rsMeta).toBe(200);
            expect(o.explicitRsGuarded).toBe(200);
          }
        });
      }
    }
  }

  afterAll(() => {
    console.log(
      [
        "\n### Q2 matrix (expected: 403 | 202 | yes | 403/200 | tag:hello | true | 418 filtered | 403 | 403 | 202 yes | 403 | meta)\n",
        "| adapter | strategy | copy | method @UseGuards | @HttpCode | @Header | SetMetadata+Reflector (no role/role) | param decorator | pipe metatype | @UseFilters | RS @UseGuards | RS SetMetadata | RS @HttpCode+@Header | explicit RS @UseGuards | handler.name | spans | verdict |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
        ...matrix,
      ].join("\n"),
    );
  });
});

describe("Q2 spans are produced and nested", () => {
  for (const strategy of ["own", "proto"] as Strategy[]) {
    it(`${strategy}: controller span parents the service span; async method span ends after the await`, async () => {
      const decorator = createInstanceDecorator({
        strategy,
        shouldWrapClass: ruleMarkers,
      });
      const b = await boot("express", AppModule, {
        instanceDecorator: decorator,
      });
      try {
        exporter.reset();
        expect((await b.get("/users/7/async")).status).toBe(200);
        const spans = exporter.getFinishedSpans();
        const ctrl = spans.find((s) => s.name === "UsersController.findAsync");
        const svc = spans.find((s) => s.name === "UsersService.findAsync");
        const inner = spans.find((s) => s.name === "UsersService.find");
        expect(ctrl).toBeDefined();
        expect(svc?.parentSpanContext?.spanId).toBe(ctrl?.spanContext().spanId);
        expect(inner?.parentSpanContext?.spanId).toBe(
          svc?.spanContext().spanId,
        );
        // The async span covers the awaited 5 ms timer. Checked as the span's own duration with
        // slack: libuv timers run on a cached, millisecond-granular loop clock and can fire
        // early on the span clock (CI, Node 24: 0.38 ms for a 1 ms timer). Cross-span
        // timestamp comparisons are not used: each span anchors its own clock.
        const ms = (s: typeof svc) =>
          s ? s.duration[0] * 1e3 + s.duration[1] / 1e6 : 0;
        expect(ms(svc)).toBeGreaterThanOrEqual(3);
        console.log(
          `${strategy}: spans for GET /users/7/async: ${spans.map((s) => s.name).join(", ")}`,
        );
      } finally {
        await b.close();
      }
    });
  }
});

describe("Q2 wrapping every class instance (rule: everything)", () => {
  for (const strategy of ["own", "proto"] as Strategy[]) {
    it(`${strategy}: app still works, including TypeORM, Drizzle and the ClientProxy`, async () => {
      let internalErrors = 0;
      const decorator = createInstanceDecorator({
        strategy,
        shouldWrapClass: ruleEverything,
        onInternalError: (w, e) => {
          internalErrors++;
          console.log("internal error", w, e);
        },
      });
      const b = await boot("express", AppModule, {
        instanceDecorator: decorator,
      });
      try {
        exporter.reset();
        const db = await b.get("/users/db");
        expect(db.status).toBe(200);
        expect(db.body).toMatchObject({ raw: 1, drizzle: 1 });
        expect((await b.get("/users/guarded")).status).toBe(403);
        const names = [
          ...new Set(exporter.getFinishedSpans().map((s) => s.name)),
        ];
        console.log(
          `${strategy} everything: ${names.length} distinct span names for GET /users/db + /users/guarded:\n  ${names.join("\n  ")}`,
        );
        expect(internalErrors).toBe(0);
      } finally {
        await b.close();
      }
    });
  }
});

describe("Q3 which function Nest calls", () => {
  for (const adapter of ADAPTERS) {
    for (const strategy of ["own", "proto"] as Strategy[]) {
      it(`${adapter} / ${strategy}: static and request-scoped controllers both call instance[methodName]`, async () => {
        const decorator = createInstanceDecorator({
          strategy,
          shouldWrapClass: ruleMarkers,
        });
        const b = await boot(adapter, AppModule, {
          instanceDecorator: decorator,
        });
        try {
          PROBES.length = 0;
          await b.get("/users/code");
          await b.get("/rs/code");
          await b.get("/rs/code");
          await b.get("/explicit-rs/guarded");
          const seen = PROBES.map(
            (p) =>
              `${p.cls}.${p.handler.name}:${isWrapper(p.handler) ? "wrapper" : "original"}`,
          );
          console.log(`Q3 ${adapter}/${strategy}: ${seen.join(", ")}`);
          expect(PROBES).toHaveLength(4);
          for (const p of PROBES) expect(isWrapper(p.handler)).toBe(true);
        } finally {
          await b.close();
        }
      });
    }
  }

  it("own strategy: the static controller's prototype is untouched, so the call came from the instance", async () => {
    const { UsersController } = await import("../src/app/fixtures.ts");
    const decorator = createInstanceDecorator({
      strategy: "own",
      shouldWrapClass: ruleMarkers,
    });
    const b = await boot("express", AppModule, {
      instanceDecorator: decorator,
    });
    try {
      expect(isWrapper(UsersController.prototype.code)).toBe(false);
      const ctrl = b.app.get(UsersController);
      expect(Object.hasOwn(ctrl, "code")).toBe(true);
      expect(Object.keys(ctrl)).not.toContain("code"); // non-enumerable
      PROBES.length = 0;
      await b.get("/users/code");
      expect(isWrapper(PROBES[0]?.handler)).toBe(true);
    } finally {
      await b.close();
    }
  });
});

describe("Q2 route order", () => {
  // Nest registers routes in MetadataScanner.getAllMethodNames(Object.getPrototypeOf(instance)) order.
  // With "proto", wrapped methods sit on the derived prototype and are listed first; an unwrapped method
  // (excluded by the user, a generator, a failed copy) is listed after them. Express matches in order.
  for (const adapter of ADAPTERS) {
    for (const strategy of ["own", "proto"] as Strategy[]) {
      it(`${adapter} / ${strategy}: excluding one method from wrapping, is the route table unchanged?`, async () => {
        const decorator = createInstanceDecorator({
          strategy,
          shouldWrapClass: ruleMarkers,
          shouldWrapMethod: (name) => name !== "guarded",
        });
        const b = await boot(adapter, AppModule, {
          instanceDecorator: decorator,
        });
        try {
          const r = await b.get("/users/guarded");
          console.log(
            `Q2 route order ${adapter}/${strategy}: GET /users/guarded -> ${r.status} ${JSON.stringify(r.body)}`,
          );
          if (strategy === "proto" && adapter === "express") {
            expect(r.status).toBe(400); // matched by @Get(":id") with ParseIntPipe
          } else {
            expect(r.status).toBe(403);
          }
        } finally {
          await b.close();
        }
      });
    }
  }
});
