// Global state: host provider (bootApp), ALS context manager, W3C propagator.
// Pins how Nestrix's global interceptor behaves next to a host's global interceptor, on Express.
// Nest runs APP_INTERCEPTOR providers in module order: a host module imported before
// NestrixModule puts its interceptor first, so what it throws never reaches Nestrix's interceptor.
// Recommendation (architecture §4.2): import NestrixModule first.
import {
  Controller,
  Get,
  Injectable,
  Module,
  type NestInterceptor,
  NotFoundException,
  type Type,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { type BootedApp, bootApp } from "@nestrix-js/testing";
import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { NestrixModule } from "../src/nestrix.module.js";
import { registerHostContext, serverSpan } from "./http-fixture.js";

registerHostContext();

let throwing: () => never = () => {
  throw new NotFoundException("no such tenant");
};

@Injectable()
class HostInterceptor implements NestInterceptor {
  intercept(): never {
    throwing();
  }
}

@Controller()
class ItemsController {
  @Get("items/:id")
  item(): string {
    return "item";
  }
}

@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: HostInterceptor }],
})
class HostModule {}

function root(order: "nestrix-first" | "host-first"): Type {
  const nestrix = NestrixModule.forRoot({ export: { otlp: false } });
  @Module({
    imports:
      order === "host-first" ? [HostModule, nestrix] : [nestrix, HostModule],
    controllers: [ItemsController],
  })
  class Root {}
  return Root;
}

let booted: BootedApp | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const events = (names: { name: string }[]) =>
  names.filter((e) => e.name === "exception");

describe("Nestrix's interceptor next to a host global interceptor (express)", () => {
  it("NestrixModule imported first: a host interceptor's 404 keeps the route and is recorded", async () => {
    throwing = () => {
      throw new NotFoundException("no such tenant");
    };
    booted = await bootApp("express", { module: root("nestrix-first") });
    expect((await fetch(`${booted.baseUrl}/items/1`)).status).toBe(404);
    const span = await serverSpan(booted, "/items/1");
    expect(span.name).toBe("GET /items/:id");
    expect(span.attributes["code.function.name"]).toBe("ItemsController.item");
    expect(events(span.events)).toHaveLength(1);
  });

  it("host module imported first: its 404 drops the route and is not recorded", async () => {
    throwing = () => {
      throw new NotFoundException("no such tenant");
    };
    booted = await bootApp("express", { module: root("host-first") });
    expect((await fetch(`${booted.baseUrl}/items/1`)).status).toBe(404);
    const span = await serverSpan(booted, "/items/1");
    expect(span.name).toBe("GET");
    expect(span.attributes["http.route"]).toBeUndefined();
    expect(span.attributes["code.function.name"]).toBeUndefined();
    expect(events(span.events)).toHaveLength(0);
  });

  it("host module imported first: its 500 sets error status but records no exception event", async () => {
    throwing = () => {
      throw new Error("host interceptor failed");
    };
    booted = await bootApp("express", { module: root("host-first") });
    expect((await fetch(`${booted.baseUrl}/items/1`)).status).toBe(500);
    const span = await serverSpan(booted, "/items/1");
    expect(span.name).toBe("GET /items/:id");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["error.type"]).toBe("500");
    expect(events(span.events)).toHaveLength(0);
  });
});
