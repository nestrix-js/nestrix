// Global state: none registered before Nestrix (each app owns, then releases, the provider).
// Apps without an HTTP adapter: Nestrix boots and installs nothing HTTP-related (nest-hooks §1).
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { Transport } from "@nestjs/microservices";
import { Test } from "@nestjs/testing";
import { ReplaySubject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NestrixCore } from "../src/core.js";
import {
  diagnostics,
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import {
  HttpServerInstrumentation,
  installHttpInstrumentation,
} from "../src/http/server.js";
import { NestrixModule } from "../src/nestrix.module.js";
import { resolveOptions } from "../src/resolve-options.js";

@Module({ imports: [NestrixModule.forRoot({ export: { otlp: false } })] })
class Root {}

const resolved = resolveOptions({ export: { otlp: false } }, {});

let routeHookBuilt: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetDiagnosticsForTests();
  routeHookBuilt = vi.spyOn(HttpServerInstrumentation.prototype, "routeHook");
});
afterEach(() => vi.restoreAllMocks());

function expectNothingInstalled(): void {
  expect(routeHookBuilt).not.toHaveBeenCalled();
  expect([...getFailureCounts().keys()]).toEqual([]);
}

describe("apps without an HTTP adapter", () => {
  it("NestFactory.createApplicationContext", async () => {
    const app = await NestFactory.createApplicationContext(Root, {
      logger: false,
    });
    expect(app.get(HttpAdapterHost).httpAdapter).toBeNull();
    expect(app.get(NestrixCore).telemetry?.ownsProvider).toBe(true);
    expectNothingInstalled();
    await app.close();
  });

  it("NestFactory.createMicroservice", async () => {
    const app = await NestFactory.createMicroservice(Root, {
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port: 0 },
      logger: false,
    });
    await app.init();
    expect(app.get(HttpAdapterHost).httpAdapter).toBeNull();
    expect(app.get(NestrixCore).telemetry?.ownsProvider).toBe(true);
    expectNothingInstalled();
    await app.close();
  });

  it("@nestjs/testing, compiled and initialised but never an app", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [Root],
    }).compile();
    await moduleRef.init();
    expect(moduleRef.get(HttpAdapterHost).httpAdapter).toBeUndefined();
    expectNothingInstalled();
    await moduleRef.close();
  });

  it("@nestjs/testing createNestMicroservice", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [Root],
    }).compile();
    const app = moduleRef.createNestMicroservice({
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port: 0 },
      logger: false,
    });
    await app.init();
    expectNothingInstalled();
    await app.close();
  });
});

describe("installHttpInstrumentation (unit)", () => {
  function fakeAdapter() {
    return {
      setOnRequestHook: vi.fn(),
      setOnRouteTriggered: vi.fn(),
      getOnRouteTriggered: vi.fn(() => undefined),
    };
  }

  it("installs nothing when init$ emits with a null adapter, and drops the subscription on dispose", () => {
    const init$ = new ReplaySubject<void>();
    const dispose = installHttpInstrumentation(
      { httpAdapter: null, init$ },
      resolved,
      diagnostics,
    );
    init$.next();
    expect(init$.observed).toBe(true);
    dispose();
    expect(init$.observed).toBe(false);
    expectNothingInstalled();
  });

  it("installs once from init$ (which emits no value), however many times it emits", () => {
    const init$ = new ReplaySubject<void>();
    const adapter = fakeAdapter();
    const host: { httpAdapter: unknown; init$: ReplaySubject<void> } = {
      httpAdapter: undefined,
      init$,
    };
    installHttpInstrumentation(host, resolved, diagnostics);
    expect(adapter.setOnRequestHook).not.toHaveBeenCalled();
    host.httpAdapter = adapter; // as Nest's setter does, before `_init$.next()`
    init$.next();
    init$.next();
    expect(adapter.setOnRequestHook).toHaveBeenCalledTimes(1);
    expect(adapter.setOnRouteTriggered).toHaveBeenCalledTimes(1);
  });

  it("installs directly when the adapter is there, chaining the previous route hook", () => {
    const adapter = fakeAdapter();
    const previous = vi.fn();
    adapter.getOnRouteTriggered.mockReturnValue(previous as never);
    installHttpInstrumentation({ httpAdapter: adapter }, resolved, diagnostics);
    const hook = adapter.setOnRouteTriggered.mock.calls[0]?.[0] as (
      m: number,
      p: string,
    ) => void;
    hook(0, "/x");
    expect(previous).toHaveBeenCalledWith(0, "/x");
  });

  it("logs once when another tool already set the route hook (D-33)", () => {
    const logged: string[] = [];
    const adapter = fakeAdapter();
    adapter.getOnRouteTriggered.mockReturnValue(
      function otherApm() {} as never,
    );
    installHttpInstrumentation({ httpAdapter: adapter }, resolved, {
      logOnce: (key) => logged.push(key),
      countFailure: () => undefined,
    });
    expect(logged).toEqual(["http.foreign-route-hook"]);
  });

  it.each([
    [
      "an adapter whose setter throws",
      {
        httpAdapter: {
          setOnRequestHook: () => {
            throw new Error("x");
          },
        },
      },
    ],
    [
      "an init$ whose subscribe throws",
      {
        httpAdapter: undefined,
        init$: {
          subscribe: () => {
            throw new Error("x");
          },
        },
      },
    ],
    [
      "a host whose getter throws",
      Object.defineProperty({}, "httpAdapter", {
        get() {
          throw new Error("x");
        },
      }),
    ],
  ])("never throws with %s", (_label, host) => {
    expect(() =>
      installHttpInstrumentation(host as never, resolved, diagnostics),
    ).not.toThrow();
    expect(getFailureCounts().get("http.install")).toBe(1);
  });
});
