// D-48: level 2 does not apply under @nestjs/testing (documented by this test); without
// `NestrixInstrument` there are no method spans and `methodsEnabled()` is false.
import "reflect-metadata";
import { Controller, Get, Inject, Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { NestrixInstrument } from "../../src/methods/instrument.js";
import {
  methodsEnabled,
  resetMethodsForTests,
} from "../../src/methods/registry.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import {
  BASE_OPTIONS,
  bootInstrumented,
  methodSpans,
  resetSpans,
  serverSpanOf,
  setupTracing,
  waitFor,
} from "./helpers.js";

setupTracing();

@Injectable()
class GreetService {
  greet(): string {
    return "hi";
  }
}

@Controller("greet")
class GreetController {
  constructor(@Inject(GreetService) private readonly greeter: GreetService) {}
  @Get()
  get(): string {
    return this.greeter.greet();
  }
}

@Module({
  imports: [NestrixModule.forRoot(BASE_OPTIONS)],
  controllers: [GreetController],
  providers: [GreetService],
})
class GreetApp {}

afterEach(() => {
  resetSpans();
  resetMethodsForTests();
});

describe("@nestjs/testing (D-48)", () => {
  it("static controllers and providers are never decorated, even with instrument passed to createNestApplication: HTTP spans only", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GreetApp],
    }).compile();
    const app = moduleRef.createNestApplication({
      instrument: NestrixInstrument,
    } as never);
    await app.listen(0, "127.0.0.1");
    try {
      const { port } = app.getHttpServer().address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/greet`);
      expect(await res.text()).toBe("hi");
      await waitFor(() => serverSpanOf("/greet") !== undefined);
      expect(methodSpans()).toEqual([]);
      expect(Object.getOwnPropertyNames(app.get(GreetService))).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("without NestrixInstrument", () => {
  it("no method spans and methodsEnabled() is false", async () => {
    const booted = await bootInstrumented("express", GreetApp);
    try {
      expect((await booted.get("/greet")).body).toBe("hi");
      await waitFor(() => serverSpanOf("/greet") !== undefined);
      expect(methodSpans()).toEqual([]);
      expect(methodsEnabled()).toBe(false);
    } finally {
      await booted.close();
    }
  });

  it("with it, methodsEnabled() is true while the app runs and false after close", async () => {
    const booted = await bootInstrumented(
      "express",
      GreetApp,
      NestrixInstrument,
    );
    expect(methodsEnabled()).toBe(true);
    await booted.close();
    expect(methodsEnabled()).toBe(false);
  });
});
