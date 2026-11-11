// A Nestrix fault never changes what the host's handlers and clients do (AGENTS.md rule 1).
// Faults are injected at each guarded site, and separately the tracer itself throws.
// Global state: a host provider that delegates to helpers.ts's SDK provider unless `broken`.
import "reflect-metadata";
import type { ExecutionContext, INestMicroservice } from "@nestjs/common";
import type { ClientProxy } from "@nestjs/microservices";
import type { Tracer, TracerProvider } from "@opentelemetry/api";
import { of } from "rxjs";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import { NestrixInterceptor } from "../../src/http/interceptor.js";
import {
  instrumentClient,
  nestrixPreRequestHook,
} from "../../src/microservices/index.js";
import { setMicroservicesFaultForTests } from "../../src/microservices/shared.js";
import {
  calls,
  firstValueFrom,
  freePort,
  inCaller,
  lastValueFrom,
  resetCaptured,
  sdkProvider,
  setupOtel,
  startMicroservice,
  tcpClient,
  toArray,
  wait,
  waitFor,
} from "./helpers.js";

let broken = false;
const brokenTracer = {
  startSpan() {
    throw new Error("tracer broken");
  },
  startActiveSpan() {
    throw new Error("tracer broken");
  },
} as unknown as Tracer;
const provider: TracerProvider = {
  getTracer(name, version, options) {
    return broken && name === "@nestrix-js/nestjs"
      ? brokenTracer
      : sdkProvider.getTracer(name, version, options);
  },
};
setupOtel(provider);

let port: number;
let app: INestMicroservice;
let client: ClientProxy;
const uncaught = vi.fn();

beforeAll(async () => {
  process.on("uncaughtException", uncaught);
  process.on("unhandledRejection", uncaught);
  port = await freePort();
  app = await startMicroservice(port);
  client = instrumentClient(tcpClient(port));
});
afterAll(async () => {
  process.off("uncaughtException", uncaught);
  process.off("unhandledRejection", uncaught);
  await client.close();
  await app.close();
});
afterEach(() => {
  setMicroservicesFaultForTests(undefined);
  broken = false;
  resetCaptured();
  resetDiagnosticsForTests();
});

/** Everything the host can observe, for one round of calls through `c`. */
async function observe(c: ClientProxy) {
  const { result } = await inCaller(async () => {
    const sum = await firstValueFrom(c.send<number>("sum", [1, 2]));
    const stream = await lastValueFrom(c.send("stream", {}).pipe(toArray()));
    const fail = await firstValueFrom(c.send("fail", {})).catch(
      (e: unknown) => e,
    );
    const relay = await firstValueFrom(c.send<number>("relay", {}));
    c.emit("evt", { n: 1 });
    await waitFor(() => calls.some((x) => x.pattern === "evt"));
    await wait(20);
    return { sum, stream, fail, relay };
  });
  return { ...result, handlerCalls: calls.map((x) => x.pattern).sort() };
}

const SITES = [
  "server.start",
  "record-error",
  "client.dispatch",
  "client.send",
  "client.emit",
  "client.emit-result",
] as const;

describe("faults inside Nestrix", () => {
  let baseline: Awaited<ReturnType<typeof observe>>;
  beforeAll(async () => {
    baseline = await observe(client);
    resetCaptured();
    expect(baseline).toEqual({
      sum: 3,
      stream: [1, 2, 3],
      fail: { status: "error", message: "Internal server error" },
      relay: 10,
      handlerCalls: ["evt", "fail", "relay", "stream", "sum", "sum"],
    });
  });

  for (const site of SITES) {
    it(`a throw at ${site} leaves results unchanged and is counted`, async () => {
      setMicroservicesFaultForTests((at) => {
        if (at === site) throw new Error(`fault at ${at}`);
      });
      expect(await observe(client)).toEqual(baseline);
      expect(
        [...getFailureCounts().values()].reduce((a, b) => a + b, 0),
      ).toBeGreaterThan(0);
      expect(uncaught).not.toHaveBeenCalled();
    });
  }

  it("a throw at every site at once leaves results unchanged", async () => {
    setMicroservicesFaultForTests(() => {
      throw new Error("fault everywhere");
    });
    expect(await observe(client)).toEqual(baseline);
    expect([...getFailureCounts().keys()].sort()).toEqual([
      "microservices.client",
      "microservices.dispatch",
      "microservices.server",
    ]);
    expect(uncaught).not.toHaveBeenCalled();
  });

  it("instrumentClient that faults returns the client, which still works", async () => {
    setMicroservicesFaultForTests((at) => {
      if (at === "client.instrument") throw new Error("fault");
    });
    const c = tcpClient(port);
    expect(instrumentClient(c)).toBe(c);
    expect(getFailureCounts().get("microservices.instrument")).toBe(1);
    setMicroservicesFaultForTests(undefined);
    try {
      expect(await firstValueFrom(c.send("sum", [2, 2]))).toBe(4);
    } finally {
      await c.close();
    }
  });

  it("a tracer that throws leaves results unchanged", async () => {
    broken = true;
    expect(await observe(client)).toEqual(baseline);
    expect(uncaught).not.toHaveBeenCalled();
  });
});

describe("hostile execution contexts", () => {
  const throwing = new Proxy(
    {},
    {
      get() {
        throw new Error("context broken");
      },
    },
  ) as ExecutionContext;

  it("the pre-request hook calls next once and returns its stream as it is", () => {
    const stream = of(1);
    const next = vi.fn(() => stream);
    expect(nestrixPreRequestHook(throwing, next)).toBe(stream);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("the global interceptor calls next.handle once and returns its stream", () => {
    const stream = of(1);
    const handle = vi.fn(() => stream);
    expect(new NestrixInterceptor().intercept(throwing, { handle })).toBe(
      stream,
    );
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("a pre-request hook whose next throws: the same error reaches the caller once", () => {
    const error = new Error("next threw");
    const next = vi.fn(() => {
      throw error;
    });
    const execution = {
      getType: () => "rpc",
      getHandler: () => function handler() {},
      getClass: () => class Handlers {},
      getArgByIndex: () => ({ getMetadata: () => ({}) }),
    } as unknown as ExecutionContext;
    expect(() => nestrixPreRequestHook(execution, next)).toThrow(error);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
