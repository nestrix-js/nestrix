import "reflect-metadata";
import {
  type CanActivate,
  Controller,
  Get,
  Injectable,
  Module,
  SetMetadata,
  UseGuards,
} from "@nestjs/common";
import { bootApp } from "@nestrix-js/testing";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Span } from "../src/span.js";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Controller("spans")
class SpanController {
  @Span("above.get")
  @Get("above")
  above(): string {
    return "above";
  }

  @Get("below")
  @Span("below.get")
  below(): string {
    return "below";
  }

  @Span("guarded.below")
  @Get("guarded-below")
  @UseGuards(DenyGuard)
  guardedBelow(): string {
    return "reached";
  }

  @Get("guarded-above")
  @UseGuards(DenyGuard)
  @Span("guarded.above")
  guardedAbove(): string {
    return "reached";
  }

  @Get("guarded-between")
  @UseGuards(DenyGuard)
  @Span("guarded.between")
  @SetMetadata("roles", ["admin"])
  guardedBetween(): string {
    return "reached";
  }

  @Get("async")
  @Span()
  async asyncRoute(): Promise<string> {
    await Promise.resolve();
    return "async";
  }
}

@Module({ controllers: [SpanController], providers: [DenyGuard] })
class SpanModule {}

describe("@Span on a real Nest controller (express)", () => {
  let app: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => {
    app = await bootApp("express", { module: SpanModule });
  });
  afterAll(async () => {
    await app.close();
  });

  it("routes with @Span above @Get and records the span", async () => {
    const res = await fetch(`${app.baseUrl}/spans/above`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("above");
    expect((await app.waitForSpan("above.get")).name).toBe("above.get");
  });

  it("routes with @Span below @Get and records the span", async () => {
    const res = await fetch(`${app.baseUrl}/spans/below`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("below");
    await app.waitForSpan("below.get");
  });

  it("uses the default Class.method name on an async route", async () => {
    const res = await fetch(`${app.baseUrl}/spans/async`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("async");
    await app.waitForSpan("SpanController.asyncRoute");
  });

  for (const route of ["guarded-below", "guarded-above", "guarded-between"]) {
    it(`still routes and still answers 403 for ${route} (method-level guard intact)`, async () => {
      const before = app.spans().length;
      const res = await fetch(`${app.baseUrl}/spans/${route}`);
      expect(res.status).toBe(403);
      // The guard rejects before the handler runs, so the handler span never exists.
      await new Promise((r) => setTimeout(r, 50));
      expect(
        app
          .spans()
          .slice(before)
          .some((s) => s.name.startsWith("guarded.")),
      ).toBe(false);
    });
  }

  it("exposes metadata from decorators on both sides of @Span", () => {
    const fn = SpanController.prototype.guardedBetween;
    expect(Reflect.getMetadataKeys(fn)).toEqual(
      expect.arrayContaining(["path", "method", "__guards__", "roles"]),
    );
  });
});
