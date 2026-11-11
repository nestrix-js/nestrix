import "reflect-metadata";
import { Module } from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { type MicroserviceOptions, Transport } from "@nestjs/microservices";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { captureLogger, NEST_LABEL } from "../src/boot.js";
import {
  HooksModule,
  observations,
  resetHookConfig,
  resetObservations,
} from "../src/probe.js";

afterEach(() => {
  resetHookConfig();
  resetObservations();
});

@Module({ imports: [HooksModule] })
class NoHttpModule {}

function describeValue(value: unknown): string {
  return value === null
    ? "null"
    : value === undefined
      ? "undefined"
      : typeof value;
}

function steps() {
  return observations
    .filter((o) =>
      [
        "ctor",
        "init$",
        "installed",
        "onModuleInit",
        "install-error",
        "init$-error",
      ].includes(o.point),
    )
    .map((o) => `${o.point} ${JSON.stringify(o.data)}`);
}

/**
 * Both factories call `container.setHttpAdapter(null)`: `HttpAdapterHost.httpAdapter`
 * is `null` (not `undefined`) from before any provider is constructed, and `init$`
 * emits (with `null`). The spike's hooks service tolerates it: it installs nothing.
 */
const EXPECTED_STEPS = [
  'ctor {"adapter":"null"}',
  'init$ {"adapter":"null"}',
  'onModuleInit {"adapter":"null"}',
];

describe(`Q8 apps without an HTTP adapter [Nest ${NEST_LABEL}]`, () => {
  it("createApplicationContext: HttpAdapterHost resolves, httpAdapter is null, init$ emits null", async () => {
    const ctx = await NestFactory.createApplicationContext(NoHttpModule, {
      logger: captureLogger,
      abortOnError: false,
    });
    try {
      const host = ctx.get(HttpAdapterHost);
      await new Promise((r) => setTimeout(r, 50));
      const result = {
        hostIsInstance: host instanceof HttpAdapterHost,
        httpAdapter: describeValue(host.httpAdapter),
        listening: host.listening,
        steps: steps(),
      };
      console.log("createApplicationContext", JSON.stringify(result, null, 1));
      expect(result).toEqual({
        hostIsInstance: true,
        httpAdapter: "null",
        listening: false,
        steps: EXPECTED_STEPS,
      });
    } finally {
      await ctx.close();
    }
  });

  it("createMicroservice (TCP): the same, before and after listen", async () => {
    const app = await NestFactory.createMicroservice<MicroserviceOptions>(
      NoHttpModule,
      {
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port: 0 },
        logger: captureLogger,
        abortOnError: false,
      },
    );
    try {
      const before = describeValue(app.get(HttpAdapterHost).httpAdapter);
      await app.listen();
      await new Promise((r) => setTimeout(r, 50));
      const host = app.get(HttpAdapterHost);
      const result = {
        before,
        after: describeValue(host.httpAdapter),
        listening: host.listening,
        steps: steps(),
      };
      console.log("createMicroservice", JSON.stringify(result, null, 1));
      expect(result).toEqual({
        before: "null",
        after: "null",
        listening: false,
        steps: EXPECTED_STEPS,
      });
    } finally {
      await app.close();
    }
  });

  it("@nestjs/testing, compiled but never turned into an app: httpAdapter undefined, init$ never emits", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NoHttpModule],
    }).compile();
    try {
      await moduleRef.init();
      await new Promise((r) => setTimeout(r, 50));
      const result = {
        httpAdapter: describeValue(moduleRef.get(HttpAdapterHost).httpAdapter),
        steps: steps(),
      };
      console.log("testing, compile only", JSON.stringify(result, null, 1));
      expect(result).toEqual({
        httpAdapter: "undefined",
        steps: [
          'ctor {"adapter":"undefined"}',
          'onModuleInit {"adapter":"undefined"}',
        ],
      });
    } finally {
      await moduleRef.close();
    }
  });

  it("@nestjs/testing createNestMicroservice: httpAdapter undefined, init$ never emits", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NoHttpModule],
    }).compile();
    const app = moduleRef.createNestMicroservice<MicroserviceOptions>({
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port: 0 },
      logger: captureLogger,
    });
    try {
      await app.listen();
      await new Promise((r) => setTimeout(r, 50));
      const result = {
        httpAdapter: describeValue(app.get(HttpAdapterHost).httpAdapter),
        steps: steps(),
      };
      console.log(
        "testing, createNestMicroservice",
        JSON.stringify(result, null, 1),
      );
      expect(result).toEqual({
        httpAdapter: "undefined",
        steps: [
          'ctor {"adapter":"undefined"}',
          'onModuleInit {"adapter":"undefined"}',
        ],
      });
    } finally {
      await app.close();
    }
  });
});
