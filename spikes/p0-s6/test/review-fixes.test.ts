// Checks added after the independent review of P0-S6 (reviewer probes probe.mts, probe2.mts,
// testing.mjs turned into tests). Each block names the review item it covers.
import "reflect-metadata";
import { Injectable, Module, Scope } from "@nestjs/common";
import { ModuleRef, NestFactory } from "@nestjs/core";
import { Interval, ScheduleModule } from "@nestjs/schedule";
import { Test } from "@nestjs/testing";
import {
  context as otelContext,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { lastValueFrom, throwError } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppModule, UsersService } from "../src/app/fixtures.ts";
import { boot } from "../src/boot.ts";
import { ruleMarkers } from "../src/rules.ts";
import { setupTracing } from "../src/tracing.ts";
import {
  createInstanceDecorator,
  type Fn,
  type Strategy,
} from "../src/wrap.ts";

const exporter = setupTracing();
const tracer = trace.getTracer("review");
const names = () => exporter.getFinishedSpans().map((s) => s.name);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
// Polls until the condition holds (the deadline is the only bound); see q5-schedule-bullmq.test.ts.
async function waitFor(condition: () => boolean, deadlineMs = 15_000) {
  const end = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error(`condition not met within ${deadlineMs} ms`);
    }
    await tick(10);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  exporter.reset();
});

describe("review 1: fast path keys on the SAMPLED flag, not isRecording()", () => {
  it("a fire-and-forget call after a sampled request span ended keeps its span", async () => {
    class Mailer {
      send() {
        return "sent";
      }
    }
    const result: Record<string, string[]> = {};
    for (const fast of [false, true]) {
      exporter.reset();
      const m = createInstanceDecorator({
        strategy: "own",
        skipUnderNonRecordingParent: fast,
      })(new Mailer()) as Mailer;
      let bg: Promise<string> | undefined;
      tracer.startActiveSpan("GET /orders", (req) => {
        bg = (async () => {
          await tick();
          return m.send();
        })();
        req.end(); // the response is sent; the background work continues
      });
      await bg;
      result[String(fast)] = names();
    }
    console.log(`review 1 fire-and-forget: ${JSON.stringify(result)}`);
    expect(result.false).toEqual(["GET /orders", "Mailer.send"]);
    expect(result.true).toEqual(["GET /orders", "Mailer.send"]);
  });

  it("an unsampled parent context still short-circuits; a sampled one does not", () => {
    class S {
      m() {
        return 1;
      }
    }
    const s = createInstanceDecorator({
      strategy: "own",
      skipUnderNonRecordingParent: true,
    })(new S()) as S;
    const ctx = (flags: number) =>
      trace.setSpan(
        otelContext.active(),
        trace.wrapSpanContext({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "b7ad6b7169203331",
          traceFlags: flags,
        }),
      );
    otelContext.with(ctx(TraceFlags.NONE), () => s.m());
    expect(names()).toEqual([]);
    otelContext.with(ctx(TraceFlags.SAMPLED), () => s.m());
    expect(names()).toEqual(["S.m"]);
  });
});

describe("review 2: entry methods start a new root span, linked to the active span", () => {
  @Injectable()
  class Ticker {
    static runs = 0;
    @Interval("review-tick", 10)
    tick() {
      Ticker.runs++;
    }
  }
  @Module({ imports: [ScheduleModule.forRoot()], providers: [Ticker] })
  class TickerModule {}

  const isEntryMethod = (_name: string, fn: Fn) =>
    Reflect.getMetadata("SCHEDULER_TYPE", fn) !== undefined;

  for (const entry of [false, true]) {
    it(`@Interval registered inside a bootstrap span: ${entry ? "entry -> root + link" : "not entry -> child of the ended bootstrap span"}`, async () => {
      const instanceDecorator = createInstanceDecorator({
        strategy: "own",
        // Only the job class: with the schedule internals wrapped too, setInterval runs inside a
        // `SchedulerOrchestrator.mountIntervals` span, which then becomes the parent / link instead.
        shouldWrapClass: (info) => info.ctor === Ticker,
        childOnly: true,
        skipUnderNonRecordingParent: true,
        isEntryMethod: entry ? isEntryMethod : undefined,
      });
      let bootstrapId = "";
      const app = await tracer.startActiveSpan("bootstrap", async (span) => {
        bootstrapId = span.spanContext().spanId;
        const a = await NestFactory.createApplicationContext(TickerModule, {
          logger: false,
          abortOnError: false,
          instrument: { instanceDecorator },
        });
        await a.init(); // the schedule explorer calls setInterval here, inside the span
        span.end();
        return a;
      });
      try {
        // Waits until the interval has fired more than twice, rather than for a fixed 60 ms
        // that a loaded machine can end before the third tick. The assertions below still
        // check every tick.
        await waitFor(
          () =>
            exporter.getFinishedSpans().filter((s) => s.name === "Ticker.tick")
              .length > 2,
        );
      } finally {
        await app.close();
      }
      const ticks = exporter
        .getFinishedSpans()
        .filter((s) => s.name === "Ticker.tick");
      const children = ticks.filter(
        (t) => t.parentSpanContext?.spanId === bootstrapId,
      ).length;
      const linkedRoots = ticks.filter(
        (t) =>
          t.parentSpanContext === undefined &&
          t.links.some((l) => l.context.spanId === bootstrapId),
      ).length;
      console.log(
        `review 2 entry=${entry}: ${ticks.length} tick spans, children of bootstrap=${children}, linked roots=${linkedRoots}`,
      );
      expect(ticks.length).toBeGreaterThan(2);
      if (entry) {
        expect(linkedRoots).toBe(ticks.length);
        // each tick is its own trace
        expect(new Set(ticks.map((t) => t.spanContext().traceId)).size).toBe(
          ticks.length,
        );
      } else {
        expect(children).toBe(ticks.length);
      }
    }, 20_000);
  }
});

describe("review 3: Promise subclasses are not then()-ed", () => {
  it("a lazy promise subclass keeps its identity, type and laziness", async () => {
    let started = 0;
    class LazyPromise<T> extends Promise<T> {
      #exec: (res: (v: T) => void) => void;
      #p: Promise<T> | undefined;
      constructor(exec: (res: (v: T) => void) => void) {
        super((r) => r(undefined as T));
        this.#exec = exec;
      }
      static override get [Symbol.species]() {
        return Promise;
      }
      // biome-ignore lint/suspicious/noThenProperty: a lazy promise
      override then<A = T, B = never>(
        a?: ((v: T) => A | PromiseLike<A>) | null,
        b?: ((e: unknown) => B | PromiseLike<B>) | null,
      ): Promise<A | B> {
        this.#p ??= new Promise<T>((r) => this.#exec(r));
        return this.#p.then(a, b);
      }
    }
    class Repo {
      lazy() {
        return new LazyPromise<number>((r) => {
          started++;
          r(1);
        });
      }
    }
    const repo = createInstanceDecorator({ strategy: "own" })(
      new Repo(),
    ) as Repo;
    const p = repo.lazy();
    await tick();
    expect(started).toBe(0); // not executed just because it was returned
    expect(p).toBeInstanceOf(LazyPromise);
    expect(await p).toBe(1);
    expect(started).toBe(1);
    expect(names()).toEqual(["Repo.lazy"]);
  });
});

describe("review 4: the method is resolved on the prototype at call time", () => {
  for (const strategy of ["own", "proto"] as Strategy[]) {
    it(`${strategy}: a prototype patch after decoration applies, and restoring it restores the original`, () => {
      class Svc {
        get1() {
          return "real";
        }
      }
      const s = createInstanceDecorator({ strategy })(new Svc()) as Svc;
      const spy = vi.spyOn(Svc.prototype, "get1").mockReturnValue("mocked");
      expect(new Svc().get1()).toBe("mocked");
      expect(s.get1()).toBe("mocked");
      expect(names()).toEqual(["Svc.get1"]); // still traced
      spy.mockRestore();
      expect(s.get1()).toBe("real");
    });
  }

  it("e2e: vi.spyOn on a service prototype after boot reaches the route", async () => {
    const instanceDecorator = createInstanceDecorator({
      strategy: "own",
      shouldWrapClass: ruleMarkers,
    });
    const b = await boot("express", AppModule, { instanceDecorator });
    try {
      vi.spyOn(UsersService.prototype, "find").mockReturnValue({
        id: -1,
        transient: 0,
        x: undefined,
      });
      const r = await b.get("/users/5");
      expect(r.body).toMatchObject({ id: -1 });
    } finally {
      await b.close();
    }
  });

  it("accepted behaviour change: a memoised native promise is returned as a new promise each call", async () => {
    class Cache {
      #p = Promise.resolve(1);
      get() {
        return this.#p;
      }
    }
    const raw = new Cache();
    const c = createInstanceDecorator({ strategy: "own" })(
      new Cache(),
    ) as Cache;
    expect(raw.get()).toBe(raw.get());
    expect(c.get()).not.toBe(c.get());
    expect(await c.get()).toBe(1);
  });
});

describe("review 7: Observable results", () => {
  it("the span ends before subscription and does not see the stream's error", async () => {
    class Streams {
      failing() {
        return throwError(() => new Error("stream error"));
      }
    }
    const s = createInstanceDecorator({ strategy: "own" })(
      new Streams(),
    ) as Streams;
    const obs = s.failing();
    const span = exporter
      .getFinishedSpans()
      .find((x) => x.name === "Streams.failing");
    expect(span).toBeDefined(); // already ended: nobody has subscribed yet
    await expect(lastValueFrom(obs)).rejects.toThrow("stream error");
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });
});

describe("review 10: @nestjs/testing with instrument passed as createTestingModule's untyped 2nd argument", () => {
  it("decorates value providers at compile and transients from ModuleRef.resolve, nothing else", async () => {
    @Injectable()
    class Svc {
      m() {}
    }
    @Injectable()
    class Made {
      m() {}
    }
    @Injectable({ scope: Scope.TRANSIENT })
    class Tr {
      m() {}
    }
    const seen: string[] = [];
    const instanceDecorator = (i: unknown) => {
      seen.push(
        (i as { constructor?: { name?: string } })?.constructor?.name ??
          typeof i,
      );
      return i;
    };
    const value = new Svc();
    const mod = await (
      Test.createTestingModule as unknown as (
        m: object,
        o: object,
      ) => ReturnType<typeof Test.createTestingModule>
    )(
      { providers: [Svc, Tr, { provide: "V", useValue: value }] },
      { instrument: { instanceDecorator } },
    ).compile();
    const atCompile = [...seen];
    const ref = mod.get(ModuleRef);
    await ref.create(Made);
    await ref.resolve(Tr);
    const later = seen.slice(atCompile.length);
    console.log(
      `review 10 testing: ${JSON.stringify({ atCompile, afterCreateAndResolve: later })}`,
    );
    expect(atCompile).toEqual(["Svc"]); // the value provider instance only, not the Svc class provider
    expect(later).toEqual(["Tr"]);
    await mod.close();
  });
});
