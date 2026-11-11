// P3-02 acceptance: with `NestrixInstrument` on, a method-level guard still denies (403) on all
// three adapters, for static and request-scoped controllers, and `Reflector`-read metadata still
// applies; spans nest controller -> service -> repository under the server span; every call is
// reported to the sink, sampled or not.
import "reflect-metadata";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Scope,
  SetMetadata,
  UseGuards,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestrixInstrument } from "../../src/methods/instrument.js";
import { isWrapper } from "../../src/methods/wrap.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import {
  ADAPTERS,
  BASE_OPTIONS,
  bootInstrumented,
  type Instrumented,
  methodSpans,
  recordingSink,
  resetSpans,
  serverSpanOf,
  setupTracing,
  spans,
  waitFor,
} from "./helpers.js";

setupTracing();

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Injectable()
class RoleGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    return this.reflector.get("role", ctx.getHandler()) !== "admin";
  }
}

@Injectable()
class UsersRepository {
  async find(id: string): Promise<{ id: string }> {
    await sleep(10);
    return { id };
  }
  fail(): never {
    throw new Error("repository failed");
  }
}

@Injectable()
class UsersService {
  constructor(
    @Inject(UsersRepository) private readonly repo: UsersRepository,
  ) {}
  async find(id: string): Promise<{ id: string }> {
    return this.repo.find(id);
  }
  fail(): never {
    return this.repo.fail();
  }
}

@Controller("users")
class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get("guarded")
  @UseGuards(DenyGuard)
  guarded(): string {
    return "reached";
  }

  @Get("meta")
  @SetMetadata("role", "admin")
  @UseGuards(RoleGuard)
  meta(): string {
    return "reached";
  }

  @Get("code")
  @HttpCode(202)
  code(): string {
    return "accepted";
  }

  @Get("fail")
  fail(): never {
    return this.users.fail();
  }

  @Get(":id")
  find(@Param("id") id: string): Promise<{ id: string }> {
    return this.users.find(id);
  }
}

@Controller({ path: "rs", scope: Scope.REQUEST })
class RequestScopedController {
  @Get("guarded")
  @UseGuards(DenyGuard)
  guarded(): string {
    return "reached";
  }

  @Get("ok")
  ok(): string {
    return "ok";
  }
}

@Module({
  controllers: [UsersController, RequestScopedController],
  providers: [UsersService, UsersRepository],
})
class UsersModule {}

@Module({ imports: [UsersModule, NestrixModule.forRoot(BASE_OPTIONS)] })
class AppModule {}

@Module({
  imports: [
    UsersModule,
    NestrixModule.forRoot({ ...BASE_OPTIONS, sampleRate: 0 }),
  ],
})
class UnsampledAppModule {}

for (const adapter of ADAPTERS) {
  describe(`level 2 over HTTP (${adapter})`, () => {
    let booted: Instrumented;
    let baseline: Record<string, number>;

    beforeAll(async () => {
      // Baseline without instrumentation, then the instrumented app.
      const plain = await bootInstrumented(adapter, AppModule);
      baseline = {};
      for (const p of [
        "/users/guarded",
        "/users/meta",
        "/rs/guarded",
        "/users/code",
      ]) {
        baseline[p] = (await plain.get(p)).status;
      }
      await plain.close();
      booted = await bootInstrumented(adapter, AppModule, NestrixInstrument);
    });
    afterAll(async () => {
      await booted.close();
    });

    it("a method-level guard still returns 403 (static controller)", async () => {
      expect(baseline["/users/guarded"]).toBe(403);
      const r = await booted.get("/users/guarded");
      expect(r.status).toBe(403);
      expect(r.body).not.toContain("reached");
      // The handler really is our wrapper, so the 403 is not an accident of nothing being wrapped.
      expect(isWrapper(booted.app.get(UsersController).guarded)).toBe(true);
    });

    it("metadata read through Reflector from the handler still applies", async () => {
      expect(baseline["/users/meta"]).toBe(403);
      expect((await booted.get("/users/meta")).status).toBe(403);
    });

    it("a method-level guard still returns 403 (request-scoped controller)", async () => {
      expect(baseline["/rs/guarded"]).toBe(403);
      expect((await booted.get("/rs/guarded")).status).toBe(403);
      expect((await booted.get("/rs/ok")).status).toBe(200);
    });

    it("@HttpCode still applies", async () => {
      expect(baseline["/users/code"]).toBe(202);
      expect((await booted.get("/users/code")).status).toBe(202);
    });

    it("spans nest controller -> service -> repository under the server span", async () => {
      resetSpans();
      const r = await booted.get("/users/7");
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ id: "7" });
      await waitFor(() => serverSpanOf("/users/7") !== undefined);
      const server = serverSpanOf("/users/7");
      const byName = (n: string) => methodSpans().find((s) => s.name === n);
      const ctrl = byName("UsersController.find");
      const svc = byName("UsersService.find");
      const repo = byName("UsersRepository.find");
      expect(server && ctrl && svc && repo).toBeTruthy();
      if (!server || !ctrl || !svc || !repo) return;
      const traceId = server.spanContext().traceId;
      for (const s of [ctrl, svc, repo]) {
        expect(s.spanContext().traceId).toBe(traceId);
        expect(s.kind).toBe(SpanKind.INTERNAL);
      }
      expect(ctrl.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
      expect(svc.parentSpanContext?.spanId).toBe(ctrl.spanContext().spanId);
      expect(repo.parentSpanContext?.spanId).toBe(svc.spanContext().spanId);
      expect(ctrl.attributes).toEqual({
        "code.function.name": "UsersController.find",
        "nestrix.class": "UsersController",
        "nestrix.method": "find",
        "nestrix.component": "controller",
      });
      expect(svc.attributes["nestrix.component"]).toBe("service");
      expect(repo.attributes["nestrix.component"]).toBe("repository");
      // The async spans cover the awaited 10 ms. Durations, not end times across spans: separately
      // anchored span clocks can disagree by up to a millisecond (seen once in ten runs).
      const ms = (d: [number, number]) => d[0] * 1e3 + d[1] / 1e6;
      for (const s of [repo, svc, ctrl]) {
        expect(ms(s.duration)).toBeGreaterThanOrEqual(5);
      }
      // The handler name the server span reports is unchanged (the wrapper carries `name`).
      expect(server.attributes["code.function.name"]).toBe(
        "UsersController.find",
      );
      // Guards are enhancers: no span by default.
      expect(spans().some((s) => s.name.startsWith("DenyGuard"))).toBe(false);
    });

    it("an exception is recorded on each method span and rethrown unchanged", async () => {
      resetSpans();
      const r = await booted.get("/users/fail");
      expect(r.status).toBe(500);
      await waitFor(() => serverSpanOf("/users/fail") !== undefined);
      for (const name of [
        "UsersController.fail",
        "UsersService.fail",
        "UsersRepository.fail",
      ]) {
        const s = methodSpans().find((x) => x.name === name);
        expect(s?.status.code).toBe(SpanStatusCode.ERROR);
        const ev = s?.events.find((e) => e.name === "exception");
        expect(ev?.attributes?.["exception.message"]).toBe("repository failed");
      }
    });

    it("every call is reported to the sink, with its duration and error flag", async () => {
      const { calls, dispose } = recordingSink();
      try {
        await booted.get("/users/8");
        await booted.get("/users/fail");
        await waitFor(() => calls.length >= 6);
      } finally {
        dispose();
      }
      const find = calls.filter((c) => c.method === "find");
      expect(find.map((c) => `${c.className}:${c.kind}`).sort()).toEqual([
        "UsersController:controller",
        "UsersRepository:repository",
        "UsersService:service",
      ]);
      // The repository awaits 10 ms; the reported duration follows the promise.
      const repo = find.find((c) => c.className === "UsersRepository");
      expect(repo?.durationMs).toBeGreaterThanOrEqual(5);
      expect(repo?.error).toBe(false);
      const fail = calls.filter((c) => c.method === "fail");
      expect(fail).toHaveLength(3);
      expect(fail.every((c) => c.error)).toBe(true);
    });
  });
}

describe("unsampled requests (sampleRate 0): no method spans, every call still reported", () => {
  it("express", async () => {
    // A host-owned provider ignores `sampleRate`; an unsampled incoming traceparent gives the same
    // shape: the server span and its children are not sampled, and the fast path skips the spans.
    const booted = await bootInstrumented(
      "express",
      UnsampledAppModule,
      NestrixInstrument,
    );
    const { calls, dispose } = recordingSink();
    try {
      resetSpans();
      const res = await fetch(`${booted.baseUrl}/users/9`, {
        headers: {
          traceparent:
            "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00",
        },
      });
      expect(res.status).toBe(200);
      await waitFor(() => calls.length >= 3);
      expect(methodSpans()).toEqual([]);
      expect(calls.map((c) => c.className).sort()).toEqual([
        "UsersController",
        "UsersRepository",
        "UsersService",
      ]);
    } finally {
      dispose();
      await booted.close();
    }
  });
});
