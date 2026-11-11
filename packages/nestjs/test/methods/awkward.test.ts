// P3-02 acceptance: the awkward-class corpus behaves exactly as without instrumentation (ported
// from P0-S6 Q4 and its review fixes), with the classes in the app's own set so they are wrapped.
import "reflect-metadata";
import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import {
  Controller,
  forwardRef,
  Get,
  Headers,
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  Scope,
} from "@nestjs/common";
import { ContextIdFactory, ModuleRef } from "@nestjs/core";
import { SpanStatusCode } from "@opentelemetry/api";
import { lastValueFrom, type Observable, of, throwError } from "rxjs";
import { describe, expect, it } from "vitest";
import { getFailureCounts } from "../../src/diagnostics.js";
import { NestrixInstrument } from "../../src/methods/instrument.js";
import { isWrapper } from "../../src/methods/wrap.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import {
  ADAPTERS,
  BASE_OPTIONS,
  bootInstrumented,
  contextInstrumented,
  methodSpans,
  resetSpans,
  setupTracing,
  waitFor,
} from "./helpers.js";

setupTracing();

@Injectable()
class PrivateService {
  #count = 0;
  #bump(): number {
    this.#count++;
    return this.#count;
  }
  increment(): number {
    return this.#bump();
  }
  peek(): number {
    return this.#count;
  }
  static isBranded(o: unknown): boolean {
    return typeof o === "object" && o !== null && #count in o;
  }
}

@Injectable()
class MapService extends Map<string, number> {
  remember(k: string, v: number): number | undefined {
    this.set(k, v);
    return this.get(k);
  }
}

@Injectable()
class EmitterService extends EventEmitter {
  fire(payload: string): boolean {
    return this.emit("evt", payload);
  }
}

/** Holds callable objects in fields, like a Mongoose model or an Axios instance. */
@Injectable()
class CallableHolderService {
  readonly double = Object.assign((x: number) => x * 2, {
    tag: "callable",
    get: (k: string) => `get:${k}`,
  });
  readonly handler = () => "arrow-field";
  useDouble(x: number): number {
    return this.double(x) + this.double.get("k").length;
  }
}

class QueryLike {
  constructor(private readonly v: number) {}
  where(n: number): QueryLike {
    return new QueryLike(this.v + n);
  }
  // biome-ignore lint/suspicious/noThenProperty: deliberately a thenable
  then(resolve: (v: number) => unknown): Promise<unknown> {
    return Promise.resolve(this.v).then(resolve);
  }
}

class LazyPromise<T> extends Promise<T> {
  static started = 0;
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

@Injectable()
class OddReturnsService {
  #memo = Promise.resolve(1);
  memo(): Promise<number> {
    return this.#memo;
  }
  stream(): Observable<number> {
    return of(1, 2, 3);
  }
  failingStream(): Observable<never> {
    return throwError(() => new Error("stream error"));
  }
  query(): QueryLike {
    return new QueryLike(1);
  }
  lazy(): LazyPromise<number> {
    return new LazyPromise<number>((r) => {
      LazyPromise.started++;
      r(1);
    });
  }
  get computed(): string {
    return "computed";
  }
  *numbers(): Generator<number> {
    yield 1;
    yield 2;
  }
  async *agen(): AsyncGenerator<string> {
    yield "a";
  }
  async rejectLater(): Promise<never> {
    await Promise.resolve();
    throw new Error("rejected on purpose");
  }
  throwSync(): never {
    throw new Error("thrown on purpose");
  }
}

@Injectable()
class ShadowService {
  m = () => "field";
  m2(): string {
    return "proto";
  }
}
(ShadowService.prototype as unknown as { m: () => string }).m = () => "proto-m";

@Injectable()
class FrozenService {
  constructor() {
    Object.freeze(this);
  }
  m(): string {
    return "m";
  }
}

@Injectable()
class CircA {
  constructor(
    @Inject(forwardRef(() => CircB)) readonly b: { pong(): string },
  ) {}
  ping(): string {
    return `ping:${this.b.pong()}`;
  }
}
@Injectable()
class CircB {
  constructor(@Inject(forwardRef(() => CircA)) readonly a: CircA) {}
  pong(): string {
    return "pong";
  }
  viaA(): string {
    return this.a.ping();
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedService {
  static created = 0;
  readonly id = ++RequestScopedService.created;
  who(): number {
    return this.id;
  }
}

@Module({
  providers: [
    PrivateService,
    MapService,
    EmitterService,
    CallableHolderService,
    OddReturnsService,
    ShadowService,
    FrozenService,
    CircA,
    CircB,
    RequestScopedService,
    { provide: "VALUE", useValue: { plain: true } },
    { provide: "FN", useValue: (a: number, b: number) => a + b },
  ],
})
class AwkwardModule {}

@Module({ imports: [AwkwardModule, NestrixModule.forRoot(BASE_OPTIONS)] })
class AwkwardApp {}

/** Runs the corpus against an app context and returns everything observable, for comparison. */
async function observe(
  instrumented: boolean,
): Promise<Record<string, unknown>> {
  const app = await contextInstrumented(
    AwkwardApp,
    instrumented ? NestrixInstrument : undefined,
  );
  const out: Record<string, unknown> = {};
  try {
    const priv = app.get(PrivateService);
    out.private = [
      priv.increment(),
      priv.increment(),
      priv.peek(),
      PrivateService.isBranded(priv),
    ];
    out.privateKeys = [Object.keys(priv), JSON.stringify(priv), inspect(priv)];

    const map = app.get(MapService);
    out.map = [
      map.remember("a", 1),
      map.size,
      Map.prototype.get.call(map, "a"),
      [...map.entries()],
      map instanceof Map,
    ];

    const em = app.get(EmitterService);
    const got: string[] = [];
    em.on("evt", (p: string) => got.push(p));
    out.emitter = [
      em.fire("x"),
      got,
      em.listenerCount("evt"),
      em instanceof EventEmitter,
    ];

    const holder = app.get(CallableHolderService);
    out.callable = [
      holder.double(3),
      holder.double.tag,
      holder.double.get("k"),
      holder.handler(),
      holder.useDouble(2),
    ];

    const odd = app.get(OddReturnsService);
    out.memo = [await odd.memo()];
    out.stream = [await lastValueFrom(odd.stream())];
    out.failingStream = await lastValueFrom(odd.failingStream()).catch(
      (e: Error) => e.message,
    );
    const q = odd.query();
    out.query = [q instanceof QueryLike, await q.where(2)];
    LazyPromise.started = 0;
    const lazy = odd.lazy();
    await new Promise((r) => setTimeout(r, 5));
    out.lazy = [
      LazyPromise.started,
      lazy instanceof LazyPromise,
      await lazy,
      LazyPromise.started,
    ];
    out.getter = odd.computed;
    out.generators = [
      [...odd.numbers()],
      await (async () => {
        const v: string[] = [];
        for await (const x of odd.agen()) v.push(x);
        return v;
      })(),
    ];
    out.reject = await odd.rejectLater().catch((e: Error) => e.message);
    try {
      odd.throwSync();
    } catch (e) {
      out.throwSync = [
        (e as Error).message,
        (e as Error).stack?.includes("throwSync"),
      ];
    }

    out.shadow = [app.get(ShadowService).m(), app.get(ShadowService).m2()];
    out.frozen = [
      app.get(FrozenService).m(),
      Object.isFrozen(app.get(FrozenService)),
    ];
    const b = app.get(CircB);
    out.circular = [b.viaA(), b.a === app.get(CircA)];

    const ref = app.get(ModuleRef);
    const ctxA = ContextIdFactory.create();
    const r1 = await ref.resolve(RequestScopedService, ctxA, { strict: false });
    const r2 = await ref.resolve(RequestScopedService, ctxA, { strict: false });
    const r3 = await ref.resolve(
      RequestScopedService,
      ContextIdFactory.create(),
      {
        strict: false,
      },
    );
    out.requestScoped = [r1 === r2, r1 === r3, r1.who() !== r3.who()];
    out.value = app.get("VALUE");
    const fn = app.get<(a: number, b: number) => number>("FN");
    out.fn = [fn(1, 2), fn.length, isWrapper(fn)];
  } finally {
    await app.close();
  }
  return out;
}

describe("awkward-class corpus", () => {
  it("behaves exactly as without instrumentation", async () => {
    const plain = await observe(false);
    resetSpans();
    const before = getFailureCounts();
    const traced = await observe(true);
    expect(traced).toEqual(plain);
    // Nestrix itself did not fail anywhere along the way.
    expect(getFailureCounts()).toEqual(before);
    // ...and the classes really were wrapped and traced.
    const names = methodSpans().map((s) => s.name);
    for (const n of [
      "PrivateService.increment",
      "MapService.remember",
      "EmitterService.fire",
      "CallableHolderService.useDouble",
      "OddReturnsService.memo",
      "OddReturnsService.stream",
      "OddReturnsService.query",
      "OddReturnsService.lazy",
      "ShadowService.m2",
      "CircA.ping",
      "CircB.pong",
      "RequestScopedService.who",
    ]) {
      expect(names).toContain(n);
    }
    // Not wrapped: Map's and EventEmitter's own methods, callable fields, the getter, generators,
    // a class field shadowing a method, the frozen instance.
    for (const n of [
      "MapService.get",
      "MapService.set",
      "EmitterService.emit",
      "EmitterService.on",
      "OddReturnsService.computed",
      "OddReturnsService.numbers",
      "OddReturnsService.agen",
      "ShadowService.m",
      "FrozenService.m",
    ]) {
      expect(names).not.toContain(n);
    }
    const status = (n: string) =>
      methodSpans().find((s) => s.name === n)?.status.code;
    expect(status("OddReturnsService.rejectLater")).toBe(SpanStatusCode.ERROR);
    expect(status("OddReturnsService.throwSync")).toBe(SpanStatusCode.ERROR);
    // An Observable's span ends when the method returns and does not see the stream's error.
    expect(status("OddReturnsService.failingStream")).toBe(
      SpanStatusCode.UNSET,
    );
  });

  it("documented differences: wrapped method names are own (non-enumerable) properties; a memoised promise is a new object per call", async () => {
    const app = await contextInstrumented(AwkwardApp, NestrixInstrument);
    try {
      const priv = app.get(PrivateService);
      expect(Object.getOwnPropertyNames(priv)).toContain("increment");
      expect(Object.keys(priv)).not.toContain("increment");
      expect(Object.getPrototypeOf(priv)).toBe(PrivateService.prototype);
      const odd = app.get(OddReturnsService);
      expect(odd.memo()).not.toBe(odd.memo());
      expect(await odd.memo()).toBe(1);
    } finally {
      await app.close();
    }
  });
});

// Plain function middleware (consumer.apply and app.use) and request-scoped providers over HTTP.
function fnMiddleware(
  req: { headers: Record<string, unknown> },
  _res: unknown,
  next: () => void,
) {
  req.headers["x-fn-mw"] = "1";
  next();
}

@Controller("awk")
class AwkController {
  constructor(
    @Inject(RequestScopedService) private readonly scoped: RequestScopedService,
  ) {}
  @Get()
  get(@Headers("x-fn-mw") mw: string | undefined): {
    id: number;
    mw: string | undefined;
  } {
    return { id: this.scoped.who(), mw };
  }
}

@Module({
  imports: [NestrixModule.forRoot(BASE_OPTIONS)],
  controllers: [AwkController],
  providers: [RequestScopedService],
})
class HttpAwkwardApp implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(fnMiddleware).forRoutes("*path");
  }
}

for (const adapter of ADAPTERS) {
  it(`request-scoped providers and function middleware (${adapter})`, async () => {
    const booted = await bootInstrumented(
      adapter,
      HttpAwkwardApp,
      NestrixInstrument,
    );
    try {
      resetSpans();
      const a = JSON.parse((await booted.get("/awk")).body) as {
        id: number;
        mw?: string;
      };
      const b = JSON.parse((await booted.get("/awk")).body) as {
        id: number;
        mw?: string;
      };
      // A new request-scoped instance per request, and the function middleware still ran.
      expect(b.id).toBe(a.id + 1);
      expect([a.mw, b.mw]).toEqual(["1", "1"]);
      await waitFor(
        () =>
          methodSpans().filter((s) => s.name === "RequestScopedService.who")
            .length >= 2,
      );
      // A plain function (what `app.use(fn)` hands the decorator) passes through untouched.
      const mw = (_req: unknown, _res: unknown, next: () => void) => next();
      expect(NestrixInstrument.instanceDecorator(mw)).toBe(mw);
      expect(mw.length).toBe(3);
      expect(Object.getOwnPropertyNames(mw).sort()).toEqual(["length", "name"]);
    } finally {
      await booted.close();
    }
  });
}
