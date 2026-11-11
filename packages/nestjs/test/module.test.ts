import { Controller, Get, Inject, Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { bootApp } from "@nestrix/testing";
import { trace } from "@opentelemetry/api";
import { AppModule } from "express-esm/app.module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NestrixCore } from "../src/core.js";
import { NestrixModule } from "../src/nestrix.module.js";
import type { ResolvedOptions } from "../src/resolve-options.js";
import { NESTRIX_OPTIONS } from "../src/tokens.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

@Injectable()
class Probe {
  constructor(@Inject(NESTRIX_OPTIONS) readonly options: ResolvedOptions) {}
}

@Controller("probe")
class ProbeController {
  constructor(private readonly probe: Probe) {}
  @Get()
  get() {
    return { service: this.probe.options.serviceName };
  }
}

// Imports the fixture app and the Nestrix module; the Probe is in another module and only
// sees the options because the Nestrix module is global.
@Module({ providers: [Probe], controllers: [ProbeController] })
class ProbeModule {}

function rootWith(nestrix: ReturnType<typeof NestrixModule.forRoot>) {
  @Module({ imports: [nestrix, AppModule, ProbeModule] })
  class Root {}
  return Root;
}

describe("NestrixModule.forRoot", () => {
  it("boots the fixture app on Express and provides the resolved options globally", async () => {
    const booted = await bootApp("express", {
      module: rootWith(
        NestrixModule.forRoot({ serviceName: "svc", sampleRate: 0.5 }),
      ),
    });
    try {
      expect((await fetch(`${booted.baseUrl}/hello`)).status).toBe(200);
      expect(await (await fetch(`${booted.baseUrl}/probe`)).json()).toEqual({
        service: "svc",
      });
      const options = booted.app.get<ResolvedOptions>(NESTRIX_OPTIONS, {
        strict: false,
      });
      expect(options.sampleRate).toBe(0.5);
      expect(options.export.queue.maxQueueSize).toBe(2048);
      expect(Object.isFrozen(options)).toBe(true);
      const core = booted.app.get(NestrixCore, { strict: false });
      expect(core.options).toBe(options);
    } finally {
      await booted.close();
    }
  });

  it("boots under @nestjs/testing on Fastify", async () => {
    const booted = await bootApp("fastify", {
      testing: true,
      module: rootWith(NestrixModule.forRoot({ serviceName: "fast" })),
    });
    try {
      expect(await (await fetch(`${booted.baseUrl}/probe`)).json()).toEqual({
        service: "fast",
      });
    } finally {
      await booted.close();
    }
  });

  it("reads the environment when forRoot is called", () => {
    vi.stubEnv("OTEL_SERVICE_NAME", "env-svc");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
    const mod = NestrixModule.forRoot();
    const provider = mod.providers?.find(
      (p) => typeof p === "object" && "provide" in p,
    ) as { useValue: ResolvedOptions };
    expect(provider.useValue.serviceName).toBe("env-svc");
    expect(provider.useValue.export.otlp).toMatchObject({
      url: "http://collector:4318/v1/traces",
    });
  });

  it("throws at module creation for invalid options", () => {
    expect(() => NestrixModule.forRoot({ sampleRate: 2 })).toThrow(
      /Invalid Nestrix options: sampleRate/,
    );
  });

  it("is global: a module that does not import it can inject the options (covered by Probe above) and the module is flagged global", () => {
    const mod = NestrixModule.forRoot();
    expect(mod.global).toBe(true);
    expect(mod.exports).toEqual(
      expect.arrayContaining([NESTRIX_OPTIONS, NestrixCore]),
    );
  });

  it("registers no OpenTelemetry global (the placeholder constructor sets none)", async () => {
    const before = trace.getTracerProvider();
    const moduleRef = await Test.createTestingModule({
      imports: [NestrixModule.forRoot()],
    }).compile();
    try {
      expect(trace.getTracerProvider()).toBe(before);
    } finally {
      await moduleRef.close();
    }
  });
});

describe("NestrixModule.forRootAsync", () => {
  it("resolves an async factory before NestrixCore is constructed", async () => {
    const order: string[] = [];
    const booted = await bootApp("express", {
      module: rootWith(
        NestrixModule.forRootAsync({
          useFactory: async () => {
            order.push("factory start");
            await new Promise((r) => setTimeout(r, 50));
            order.push("factory end");
            return { serviceName: "async-svc", sampleRate: 0.25 };
          },
        }),
      ),
    });
    try {
      const core = booted.app.get(NestrixCore, { strict: false });
      // Had Nest injected the pending promise, `core.options` would not be resolved options.
      expect(core.options.serviceName).toBe("async-svc");
      expect(core.options.sampleRate).toBe(0.25);
      expect(Object.isFrozen(core.options)).toBe(true);
      expect(order).toEqual(["factory start", "factory end"]);
      expect(await (await fetch(`${booted.baseUrl}/probe`)).json()).toEqual({
        service: "async-svc",
      });
    } finally {
      await booted.close();
    }
  });

  it("injects other providers into the factory", async () => {
    @Injectable()
    class Config {
      name = "from-config";
    }
    @Module({ providers: [Config], exports: [Config] })
    class ConfigModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        NestrixModule.forRootAsync({
          imports: [ConfigModule],
          inject: [Config],
          useFactory: (config: Config) => ({ serviceName: config.name }),
        }),
      ],
    }).compile();
    try {
      expect(moduleRef.get(NestrixCore).options.serviceName).toBe(
        "from-config",
      );
    } finally {
      await moduleRef.close();
    }
  });

  it("fails startup when the factory returns invalid options", async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          NestrixModule.forRootAsync({
            useFactory: () => ({ sampleRate: -1 }),
          }),
        ],
      }).compile(),
    ).rejects.toThrow(/sampleRate/);
  });

  it("an async factory that returns enabled: false gives an inert core", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        NestrixModule.forRootAsync({
          useFactory: async () => ({ enabled: false }),
        }),
      ],
    }).compile();
    try {
      expect(moduleRef.get(NestrixCore).options.enabled).toBe(false);
    } finally {
      await moduleRef.close();
    }
  });
});

describe("enabled: false", () => {
  async function expectNoProviders(
    mod: ReturnType<typeof NestrixModule.forRoot>,
  ) {
    expect(mod.providers ?? []).toHaveLength(0);
    expect(mod.exports ?? []).toHaveLength(0);
    expect(mod.controllers ?? []).toHaveLength(0);
    expect(mod.imports ?? []).toHaveLength(0);
    const moduleRef = await Test.createTestingModule({
      imports: [mod],
    }).compile();
    try {
      expect(() => moduleRef.get(NestrixCore, { strict: false })).toThrow();
      expect(() => moduleRef.get(NESTRIX_OPTIONS, { strict: false })).toThrow();
    } finally {
      await moduleRef.close();
    }
  }

  it("forRoot({ enabled: false }) returns a module with no providers", async () => {
    await expectNoProviders(NestrixModule.forRoot({ enabled: false }));
  });

  it("NESTRIX_ENABLED=false makes forRoot return a module with no providers", async () => {
    vi.stubEnv("NESTRIX_ENABLED", "false");
    await expectNoProviders(NestrixModule.forRoot({ serviceName: "ignored" }));
  });

  it("NESTRIX_ENABLED=false makes forRootAsync return a module with no providers and never calls the factory", async () => {
    vi.stubEnv("NESTRIX_ENABLED", "false");
    const useFactory = vi.fn(() => ({}));
    await expectNoProviders(NestrixModule.forRootAsync({ useFactory }));
    expect(useFactory).not.toHaveBeenCalled();
  });

  it("the host app still boots and serves", async () => {
    @Module({
      imports: [NestrixModule.forRoot({ enabled: false }), AppModule],
    })
    class Root {}
    const booted = await bootApp("express", { module: Root });
    try {
      expect((await fetch(`${booted.baseUrl}/hello`)).status).toBe(200);
    } finally {
      await booted.close();
    }
  });
});
