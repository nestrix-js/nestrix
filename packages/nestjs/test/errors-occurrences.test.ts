// Global state: no host SDK; Nestrix owns the provider (export off) with the dashboard on, one app
// at a time. Issues #22 to #25 (D-93, D-94) end to end in the embedded store, on all three adapters,
// with method spans on (NestrixInstrument) and off:
// - one thrown error in one request is one occurrence in `errors` and `errors/groups`; two errors
//   in one trace stay two;
// - a trace whose root succeeded but a span inside failed is found with `hasErrors=true`;
// - `recordError` from a global `@Catch()` filter records a guard's error once, with its type;
//   from a job (a BullMQ `process` called as the worker would), under the job's trace;
// - a thrown 4xx is recorded as expected and left out of the error lists; `errors.expected`
//   turns that off or marks a custom class.
import "reflect-metadata";
import { Processor } from "@nestjs/bullmq";
import {
  type ArgumentsHost,
  BadRequestException,
  type CanActivate,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  UseGuards,
} from "@nestjs/common";
import { APP_FILTER, HttpAdapterHost } from "@nestjs/core";
import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { exceptionStatus } from "../src/errors/exception.js";
import { recordError } from "../src/errors/record-error.js";
import { NestrixInstrument } from "../src/methods/instrument.js";
import { NestrixModule } from "../src/nestrix.module.js";
import type { NestrixModuleOptions } from "../src/options.js";
import { withSpan } from "../src/span.js";
import { resetStoreForTests } from "../src/store/store.js";
import { BEARER, get, TOKEN } from "./dashboard-fixture.js";
import {
  ADAPTERS,
  bootInstrumented,
  type Instrumented,
} from "./methods/helpers.js";

class BoomError extends Error {}

@Injectable()
class OrderService {
  fail(): never {
    throw new BoomError("order service broke");
  }

  /** The documented "report, then rethrow" pattern (docs-site/guide/errors.md). */
  reportAndRethrow(): never {
    try {
      throw new Error("reported then rethrown");
    } catch (error) {
      recordError(error);
      throw error;
    }
  }
}

@Injectable()
class FailingGuard implements CanActivate {
  canActivate(): boolean {
    throw new Error("guard broke");
  }
}

/** The documented pattern: a host filter reports 5xx through `recordError`, then answers. */
@Catch()
class ReportingFilter implements ExceptionFilter {
  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
  ) {}
  catch(exception: unknown, args: ArgumentsHost): void {
    const status = exceptionStatus(exception);
    if (status >= 500) recordError(exception, { "app.filter": "reporting" });
    this.host.httpAdapter.reply(
      args.switchToHttp().getResponse(),
      { status },
      status,
    );
  }
}

@Controller("e")
class ErrorsController {
  constructor(@Inject(OrderService) private readonly orders: OrderService) {}

  @Get("boom")
  boom(): string {
    throw new Error("boom from handler");
  }

  /** Thrown in a service, through the controller, to the server span. */
  @Get("deep")
  deep(): string {
    return this.orders.fail();
  }

  /** Two different errors in one trace: one fails a child span and is caught, one escapes. */
  @Get("two")
  two(): string {
    try {
      withSpan("first-step", () => {
        throw new Error("first of two");
      });
    } catch {
      // handled
    }
    throw new Error("second of two");
  }

  @Get("rethrow")
  rethrow(): string {
    return this.orders.reportAndRethrow();
  }

  @Get("notfound")
  notFound(): string {
    throw new NotFoundException("nope");
  }

  @Get("bad")
  bad(): string {
    throw new BadRequestException("bad input");
  }

  /** #23: an error recorded on a child span; the request answers 200. */
  @Get("child")
  child(): string {
    withSpan("handled-step", (span) => {
      span.recordException(new Error("handled below the root"));
      span.setStatus({ code: SpanStatusCode.ERROR });
    });
    return "ok";
  }

  @Get("guarded")
  @UseGuards(FailingGuard)
  guarded(): string {
    return "never";
  }
}

@Processor("orders")
class OrdersProcessor {
  constructor(@Inject(OrderService) private readonly orders: OrderService) {}
  async process(job: { id: string }): Promise<string> {
    try {
      this.orders.fail();
    } catch (error) {
      recordError(error, { "job.id": job.id });
    }
    return "retried later";
  }
}

const UI = { enabled: true, auth: { token: TOKEN } } as const;

function appModule(nestrix: NestrixModuleOptions) {
  @Module({
    imports: [NestrixModule.forRoot(nestrix)],
    controllers: [ErrorsController],
    providers: [
      OrderService,
      FailingGuard,
      OrdersProcessor,
      { provide: APP_FILTER, useClass: ReportingFilter },
    ],
  })
  class ErrorsApp {}
  return ErrorsApp;
}

interface ErrorItem {
  traceId: string;
  spanName: string;
  route?: string;
  errorType?: string;
  message?: string;
}
interface Group {
  errorType?: string;
  pattern: string;
  count: number;
}
interface Summary {
  traceId: string;
  route?: string;
  name: string;
  error: boolean;
  hasErrors?: boolean;
}

let booted: Instrumented | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
  resetStoreForTests();
});

async function api<T>(path: string): Promise<T> {
  const r = await get(`${booted?.baseUrl}/_nestrix/api/v1/${path}`, BEARER);
  expect(r.status).toBe(200);
  return r.json() as T;
}

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  let value = await read();
  for (let i = 0; i < 100 && !done(value); i++) {
    await new Promise((r) => setTimeout(r, 20));
    value = await read();
  }
  return value;
}

async function hit(paths: string[]): Promise<void> {
  for (const path of paths) await booted?.get(path);
}

const ROUTES = [
  "/e/rethrow",
  "/e/boom",
  "/e/deep",
  "/e/two",
  "/e/notfound",
  "/e/bad",
  "/e/child",
  "/e/guarded",
];

describe.each(ADAPTERS)("error occurrences on %s", (adapter) => {
  for (const methods of [true, false]) {
    it(`one thrown error is one occurrence; 4xx expected; hasErrors (method spans ${methods ? "on" : "off"})`, async () => {
      booted = await bootInstrumented(
        adapter,
        appModule({ export: { otlp: false }, ui: UI }),
        methods ? NestrixInstrument : undefined,
      );
      await hit(ROUTES);
      const traces = await eventually(
        () => api<{ items: Summary[] }>("traces?limit=200"),
        (t) => ROUTES.every((route) => t.items.some((i) => i.route === route)),
      );
      const traceOf = (route: string) =>
        traces.items.find((i) => i.route === route)?.traceId;
      const errors = await api<{ items: ErrorItem[] }>("errors?limit=200");
      const of = (route: string) =>
        errors.items.filter((e) => e.traceId === traceOf(route));

      // #22: one per thrown error, on the deepest span that recorded it.
      expect(of("/e/boom")).toHaveLength(1);
      expect(of("/e/boom")[0]).toMatchObject({
        errorType: "Error",
        message: "boom from handler",
        spanName: methods ? "ErrorsController.boom" : "GET /e/boom",
      });
      expect(of("/e/deep")).toHaveLength(1);
      expect(of("/e/deep")[0]).toMatchObject({
        errorType: "Error",
        message: "order service broke",
        spanName: methods ? "OrderService.fail" : "GET /e/deep",
      });
      // recordError, then a rethrow through the method spans: one occurrence.
      expect(of("/e/rethrow").map((e) => e.message)).toEqual([
        "reported then rethrown",
      ]);
      // Two different errors in one trace stay two.
      expect(
        of("/e/two")
          .map((e) => e.message)
          .sort(),
      ).toEqual(["first of two", "second of two"]);
      // #25: thrown 4xx are not error occurrences.
      expect(of("/e/notfound")).toEqual([]);
      expect(of("/e/bad")).toEqual([]);
      // #24: a guard's error, reported by the host's filter, once and with its type.
      expect(of("/e/guarded")).toHaveLength(1);
      expect(of("/e/guarded")[0]).toMatchObject({
        errorType: "Error",
        message: "guard broke",
      });

      const groups = await api<{ groups: Group[] }>("errors/groups");
      const group = (pattern: string) =>
        groups.groups.find((g) => g.pattern === pattern);
      expect(group("boom from handler")?.count).toBe(1);
      expect(group("order service broke")?.count).toBe(1);
      expect(group("guard broke")).toMatchObject({
        errorType: "Error",
        count: 1,
      });
      expect(group("nope")).toBeUndefined();
      expect(group("bad input")).toBeUndefined();

      // The expected exception is still in the trace view, marked.
      const notFound = await api<{
        spans: {
          events: { name: string; attributes: Record<string, unknown> }[];
        }[];
      }>(`trace?id=${traceOf("/e/notfound")}`);
      const events = notFound.spans.flatMap((s) =>
        s.events.filter((e) => e.name === "exception"),
      );
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.attributes["exception.message"]).toBe("nope");
        expect(e.attributes["nestrix.exception.expected"]).toBe(true);
      }

      // #23: the child span failed while the request answered 200.
      const child = traces.items.find((i) => i.route === "/e/child");
      expect(child).toMatchObject({ error: false, hasErrors: true });
      const withErrors = await api<{ items: Summary[] }>(
        "traces?limit=200&hasErrors=true",
      );
      const routes = new Set(withErrors.items.map((i) => i.route));
      expect(routes.has("/e/child")).toBe(true);
      expect(routes.has("/e/boom")).toBe(true);
      expect(routes.has("/e/notfound")).toBe(false);
      const statusError = await api<{ items: Summary[] }>(
        "traces?limit=200&status=error",
      );
      expect(statusError.items.some((i) => i.route === "/e/child")).toBe(false);
      const without = await api<{ items: Summary[] }>(
        "traces?limit=200&hasErrors=false",
      );
      expect(without.items.some((i) => i.route === "/e/notfound")).toBe(true);
      expect(without.items.some((i) => i.route === "/e/child")).toBe(false);
      expect(
        (
          await get(
            `${booted.baseUrl}/_nestrix/api/v1/traces?hasErrors=yes`,
            BEARER,
          )
        ).status,
      ).toBe(400);
    });
  }
});

describe("recordError from a job (express)", () => {
  it("lands in the job's trace, once, on its deepest span", async () => {
    booted = await bootInstrumented(
      "express",
      appModule({ export: { otlp: false }, ui: UI }),
      NestrixInstrument,
    );
    // As the worker would call it, outside any request: the job's `process` span is the root.
    await booted.app.get(OrdersProcessor).process({ id: "7" });
    const groups = await eventually(
      () =>
        api<{ groups: (Group & { exampleTraceId: string })[] }>(
          "errors/groups",
        ),
      (g) => g.groups.some((x) => x.pattern === "order service broke"),
    );
    const group = groups.groups.find(
      (g) => g.pattern === "order service broke",
    );
    // `exception.type` is the error's `name` (the SDK's rule): "Error" for a plain subclass.
    expect(group).toMatchObject({ errorType: "Error", count: 1 });
    const trace = await api<{
      spans: {
        name: string;
        status: { code: string };
        events: { name: string; attributes: Record<string, unknown> }[];
      }[];
    }>(`trace?id=${group?.exampleTraceId}`);
    const root = trace.spans.find((s) => s.name === "OrdersProcessor.process");
    // The job's root carries the report (not counted again) and is marked failed.
    expect(root?.status.code).toBe("error");
    const reported = root?.events.find((e) => e.name === "exception");
    expect(reported?.attributes).toMatchObject({
      "exception.message": "order service broke",
      "exception.escaped": false,
      "nestrix.exception.propagated": true,
      "job.id": "7",
    });
    const list = await api<{ items: Summary[] }>(
      "traces?hasErrors=true&type=job",
    );
    expect(list.items.map((i) => i.traceId)).toContain(group?.exampleTraceId);
  });

  it("without method spans, the job's own report is the occurrence", async () => {
    booted = await bootInstrumented(
      "express",
      appModule({ export: { otlp: false }, ui: UI }),
    );
    // No method spans and no active span: `recordError` starts a short span of its own.
    await booted.app.get(OrdersProcessor).process({ id: "8" });
    const groups = await eventually(
      () => api<{ groups: Group[] }>("errors/groups"),
      (g) => g.groups.some((x) => x.pattern === "order service broke"),
    );
    expect(
      groups.groups.find((g) => g.pattern === "order service broke"),
    ).toMatchObject({ errorType: "Error", count: 1 });
    const traces = await api<{ items: Summary[] }>("traces?hasErrors=true");
    expect(traces.items.some((i) => i.name === "recordError")).toBe(true);
  });
});

describe("errors.expected (express, method spans on)", () => {
  it("false: a thrown 4xx is an error occurrence again", async () => {
    booted = await bootInstrumented(
      "express",
      appModule({
        export: { otlp: false },
        ui: UI,
        errors: { expected: false },
      }),
      NestrixInstrument,
    );
    await hit(["/e/notfound"]);
    const groups = await eventually(
      () => api<{ groups: Group[] }>("errors/groups"),
      (g) => g.groups.length > 0,
    );
    expect(groups.groups.find((g) => g.pattern === "nope")).toMatchObject({
      errorType: "NotFoundException",
      count: 1,
    });
  });

  it("a custom class is expected: no group, and the route still answers 500", async () => {
    booted = await bootInstrumented(
      "express",
      appModule({
        export: { otlp: false },
        ui: UI,
        errors: { expected: [BoomError] },
      }),
      NestrixInstrument,
    );
    expect((await booted.get("/e/deep")).status).toBe(500);
    await hit(["/e/boom"]);
    const groups = await eventually(
      () => api<{ groups: Group[] }>("errors/groups"),
      (g) => g.groups.some((x) => x.pattern === "boom from handler"),
    );
    expect(
      groups.groups.find((g) => g.pattern === "order service broke"),
    ).toBeUndefined();
    const routes = await api<{ routes: { route: string; errors: number }[] }>(
      "routes",
    );
    // Route error rates follow the response status, not the expected mark.
    expect(routes.routes.find((r) => r.route === "/e/deep")?.errors).toBe(1);
  });
});
