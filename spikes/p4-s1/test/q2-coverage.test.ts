// Q2: does a module-registered APP_INTERCEPTOR reach @MessagePattern / @EventPattern handlers?
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  type ClientProxy,
  ClientProxyFactory,
  Transport,
} from "@nestjs/microservices";
import { Test } from "@nestjs/testing";
import { firstValueFrom } from "rxjs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  freePort,
  HttpController,
  handled,
  ProbeModule,
  RpcController,
} from "./fixtures.ts";
import {
  probePreRequestHook,
  reset,
  seen,
  setupOtel,
  waitFor,
} from "./harness.ts";

beforeAll(setupOtel);

let closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
  reset();
  handled.length = 0;
});

async function client(port: number): Promise<ClientProxy> {
  const c = ClientProxyFactory.create({
    transport: Transport.TCP,
    options: { host: "127.0.0.1", port },
  });
  closers.push(async () => c.close());
  return c;
}

async function exercise(port: number) {
  const c = await client(port);
  const sum = await firstValueFrom(c.send("sum", [1, 2]));
  await firstValueFrom(c.emit("evt", { a: 1 }));
  await waitFor(() => handled.some((h) => h.pattern === "evt"));
  let guardedError: unknown;
  try {
    await firstValueFrom(c.send("guarded", 1));
  } catch (e) {
    guardedError = e;
  }
  return {
    sum,
    guardedError,
    rpcSeen: seen
      .filter((s) => s.type === "rpc")
      .map((s) => `${s.via}:${s.handler}`),
  };
}

@Module({ imports: [ProbeModule.forRoot()], controllers: [RpcController] })
class MsRoot {}

@Module({
  imports: [ProbeModule.forRoot()],
  controllers: [RpcController, HttpController],
  providers: [{ provide: "CLIENT", useValue: {} }],
})
class HybridRoot {}

describe("Q2 handler coverage (TCP)", () => {
  it("pure microservice: NestFactory.createMicroservice", async () => {
    const port = await freePort();
    const app = await NestFactory.createMicroservice(MsRoot, {
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port },
      logger: false,
    });
    await app.listen();
    closers.push(() => app.close());
    const r = await exercise(port);
    console.log("pure microservice", JSON.stringify(r));
    expect(r.sum).toBe(3);
    expect(r.rpcSeen).toEqual([
      "interceptor:RpcController.sum",
      "interceptor:RpcController.evt",
    ]);
  });

  it("pure microservice under @nestjs/testing createNestMicroservice", async () => {
    const port = await freePort();
    const ref = await Test.createTestingModule({ imports: [MsRoot] }).compile();
    const app = ref.createNestMicroservice({
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port },
      logger: false,
    });
    await app.listen();
    closers.push(() => app.close());
    const r = await exercise(port);
    console.log("testing microservice", JSON.stringify(r));
    expect(r.rpcSeen).toEqual([
      "interceptor:RpcController.sum",
      "interceptor:RpcController.evt",
    ]);
  });

  for (const variant of [
    "default",
    "inheritAppConfig",
    "deferInitialization+preRequestHook",
    "inheritAppConfig+deferInitialization+preRequestHook",
  ] as const) {
    it(`hybrid: connectMicroservice ${variant}`, async () => {
      const port = await freePort();
      const app = await NestFactory.create(HybridRoot, { logger: false });
      const ms = app.connectMicroservice(
        {
          transport: Transport.TCP,
          options: { host: "127.0.0.1", port },
        },
        {
          inheritAppConfig: variant.startsWith("inheritAppConfig"),
          deferInitialization: variant.includes("deferInitialization"),
        },
      );
      if (variant.includes("preRequestHook"))
        ms.registerPreRequestHook(probePreRequestHook as never);
      await app.startAllMicroservices();
      await app.listen(0, "127.0.0.1");
      closers.push(() => app.close());
      const r = await exercise(port);
      console.log(`hybrid ${variant}`, JSON.stringify(r));
      expect(r.sum).toBe(3);
    });
  }

  it("hybrid under @nestjs/testing createNestApplication + connectMicroservice default", async () => {
    const port = await freePort();
    const ref = await Test.createTestingModule({
      imports: [HybridRoot],
    }).compile();
    const app = ref.createNestApplication({ logger: false });
    app.connectMicroservice({
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port },
    });
    await app.startAllMicroservices();
    await app.init();
    closers.push(() => app.close());
    const r = await exercise(port);
    console.log("testing hybrid default", JSON.stringify(r));
  });
});
