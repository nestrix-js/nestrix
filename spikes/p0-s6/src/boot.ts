// Boots an app with `instrument.instanceDecorator`, which @nestrix/testing's bootApp cannot pass.
import "reflect-metadata";
import type { AddressInfo } from "node:net";
import type { INestApplication, Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { NodeAdapter } from "@nestjs/platform-node";
import { Test } from "@nestjs/testing";

export type AdapterName = "express" | "fastify" | "node";
export const ADAPTERS: AdapterName[] = ["express", "fastify", "node"];

export interface Booted {
  app: INestApplication;
  baseUrl: string;
  get: (
    path: string,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; body: unknown; headers: Headers }>;
  close: () => Promise<void>;
}

function createAdapter(name: AdapterName) {
  if (name === "express") return new ExpressAdapter();
  if (name === "fastify") return new FastifyAdapter();
  return new NodeAdapter();
}

export interface BootOptions {
  instanceDecorator?: (instance: unknown) => unknown;
  /** Build through Test.createTestingModule(...).compile(), passing `instrument` to createNestApplication. */
  testing?: boolean;
  configure?: (app: INestApplication) => void;
  listen?: boolean;
}

export async function boot(
  adapter: AdapterName,
  module: Type,
  opts: BootOptions = {},
): Promise<Booted> {
  const instrument = opts.instanceDecorator
    ? { instanceDecorator: opts.instanceDecorator }
    : undefined;
  let app: INestApplication;
  if (opts.testing) {
    const ref = await Test.createTestingModule({ imports: [module] }).compile();
    app = ref.createNestApplication(createAdapter(adapter), {
      logger: false,
      abortOnError: false,
      instrument,
    });
  } else {
    app = await NestFactory.create(module, createAdapter(adapter), {
      logger: false,
      abortOnError: false,
      instrument,
    });
  }
  try {
    opts.configure?.(app);
    let baseUrl = "";
    if (opts.listen !== false) {
      await app.listen(0, "127.0.0.1");
      const address = app.getHttpServer().address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
    } else {
      await app.init();
    }
    return {
      app,
      baseUrl,
      async get(path, headers) {
        const res = await fetch(`${baseUrl}${path}`, { headers });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // not JSON
        }
        return { status: res.status, body, headers: res.headers };
      },
      close: () => app.close(),
    };
  } catch (e) {
    await app.close().catch(() => {});
    throw e;
  }
}
