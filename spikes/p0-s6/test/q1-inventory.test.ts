// Q1: what passes through instrument.instanceDecorator in a realistic app, on each adapter and under
// @nestjs/testing. The decorator here only records; it returns every value unchanged.
import "reflect-metadata";
import { type INestApplication, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  APP_CLASSES,
  AppModule,
  appUseMiddleware,
  functionMiddleware,
  ScheduleFixtureModule,
  UserConstructedGuard,
  UsersService,
} from "../src/app/fixtures.ts";
import { ADAPTERS, type AdapterName, boot } from "../src/boot.ts";
import { type Classified, classify } from "../src/rules.ts";

interface Row extends Classified {
  origin: "app" | "library";
  boot: number;
  request: number;
}

function recorder() {
  const rows = new Map<string, Row>();
  let phase: "boot" | "request" = "boot";
  const decorator = (instance: unknown) => {
    const c = classify(instance);
    const ctor =
      typeof instance === "function"
        ? instance
        : instance && typeof instance === "object"
          ? Object.getPrototypeOf(instance)?.constructor
          : undefined;
    const origin =
      APP_CLASSES.has(ctor) ||
      instance === functionMiddleware ||
      instance === appUseMiddleware
        ? "app"
        : "library";
    const key = `${c.ctorName}|${c.kind}|${c.role}`;
    const row = rows.get(key) ?? { ...c, origin, boot: 0, request: 0 };
    row[phase]++;
    rows.set(key, row);
    return instance;
  };
  return { decorator, rows, setPhase: (p: "boot" | "request") => (phase = p) };
}

const configure = (app: INestApplication) => {
  app.use(appUseMiddleware);
  app.useGlobalGuards(new UserConstructedGuard());
};

async function inventory(adapter: AdapterName, testing = false) {
  const rec = recorder();
  const b = await boot(adapter, AppModule, {
    instanceDecorator: rec.decorator,
    configure,
    testing,
  });
  rec.setPhase("request");
  try {
    for (const p of [
      "/users/1",
      "/users/guarded",
      "/users/transient",
      "/users/db",
      "/rs/which",
      "/rs/which",
      "/explicit-rs/guarded",
    ]) {
      const r = await b.get(p);
      expect(r.status, p).toBeLessThan(500);
    }
  } finally {
    await b.close();
  }
  return rec.rows;
}

function table(rows: Map<string, Row>): string {
  const lines = [
    "| Constructor | typeof | @Controller | @Injectable | @Catch | duck role | origin | at boot | per request (7 requests) |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  const sorted = [...rows.values()].sort((a, b) =>
    a.origin === b.origin
      ? a.ctorName.localeCompare(b.ctorName)
      : a.origin === "app"
        ? -1
        : 1,
  );
  for (const r of sorted) {
    const yn = (v: boolean) => (v ? "yes" : "");
    lines.push(
      `| ${r.ctorName} | ${r.kind} | ${yn(r.controller)} | ${yn(r.injectable)} | ${yn(r.catch)} | ${r.role} | ${r.origin} | ${r.boot} | ${r.request} |`,
    );
  }
  return lines.join("\n");
}

const results = new Map<string, Map<string, Row>>();

describe("Q1 inventory", () => {
  for (const adapter of ADAPTERS) {
    it(`NestFactory.create on ${adapter}`, async () => {
      const rows = await inventory(adapter);
      results.set(adapter, rows);
      const byName = (n: string) =>
        [...rows.values()].find((r) => r.ctorName === n);
      // Things the docs claim, checked:
      expect(byName("UsersController")?.controller).toBe(true);
      expect(byName("UsersService")?.injectable).toBe(true);
      expect(byName("ConfigService")?.injectable).toBe(true);
      expect(byName("Reflector")).toBeDefined();
      expect(byName("ClassMiddleware")?.boot).toBeGreaterThan(0);
      expect(byName("UserConstructedGuard")?.boot).toBe(1); // app.useGlobalGuards(new X())
      expect(byName("appUseMiddleware")?.kind).toBe("function"); // app.use(fn)
      // Request-scoped and transient instances: once per creation.
      expect(byName("RequestScopedService")?.request).toBeGreaterThanOrEqual(2);
      expect(byName("RequestScopedController")?.request).toBeGreaterThanOrEqual(
        2,
      );
      expect(byName("TransientService")?.boot).toBeGreaterThanOrEqual(2);
      // Factory results, whatever they are.
      expect(byName("PlainHelper")?.boot).toBeGreaterThanOrEqual(3); // factory, value provider, useClass
      expect([...rows.values()].some((r) => r.role === "primitive")).toBe(true); // FACTORY_PRIMITIVE = 42
    });
  }

  it("@nestjs/testing: compile() takes no instrument option; createNestApplication({ instrument })", async () => {
    const rows = await inventory("express", true);
    results.set("testing", rows);
    const byName = (n: string) =>
      [...rows.values()].find((r) => r.ctorName === n);
    // Static DI instances are created in compile(), which has no instrument option: never decorated.
    expect(byName("UsersController")).toBeUndefined();
    expect(byName("UsersService")).toBeUndefined();
    // What createNestApplication's own injector creates later is decorated: request-scoped instances,
    // global enhancers passed to useGlobal*(), and app.use() functions.
    expect(byName("RequestScopedController")?.request).toBeGreaterThanOrEqual(
      2,
    );
    expect(byName("UserConstructedGuard")?.boot).toBe(1);
    expect(byName("appUseMiddleware")?.boot).toBe(1);
  });

  it("value providers pass through; useExisting passes the same instance a second time", async () => {
    const marker = { iAmTheValue: true };
    const seen = new Map<unknown, number>();
    const b = await boot("express", AppModule, {
      instanceDecorator: (i) => {
        seen.set(i, (seen.get(i) ?? 0) + 1);
        return i;
      },
      configure: () => {},
      listen: false,
    });
    try {
      const users = b.app.get(UsersService);
      expect(b.app.get("EXISTING")).toBe(users);
      const twice = [...seen.entries()]
        .filter(([, n]) => n > 1)
        .map(([v, n]) => `${(v as object)?.constructor?.name}x${n}`);
      console.log(
        `Q1 same object decorated more than once: ${twice.join(", ")}`,
      );
      expect(seen.get(users)).toBe(2);
      expect(seen.has(b.app.get("VALUE_OBJ"))).toBe(true);
      expect(seen.has(b.app.get("VALUE_INSTANCE"))).toBe(true);
    } finally {
      await b.close();
    }
    // A value provider in a module of its own, checked by identity.
    @Module({ providers: [{ provide: "V", useValue: marker }] })
    class ValueModule {}
    const seen2 = new Set<unknown>();
    const b2 = await boot("express", ValueModule, {
      instanceDecorator: (i) => {
        seen2.add(i);
        return i;
      },
      listen: false,
    });
    await b2.close();
    expect(seen2.has(marker)).toBe(true);
  });

  it("schedule module internals", async () => {
    const rec = recorder();
    const b = await boot("express", ScheduleFixtureModule, {
      instanceDecorator: rec.decorator,
      listen: false,
    });
    await b.close();
    results.set("schedule", rec.rows);
    expect(
      [...rec.rows.values()].some((r) => r.ctorName === "TickService"),
    ).toBe(true);
  });

  it("framework classes carrying @Injectable are identifiable by constructor identity", () => {
    // Exported framework classes can go on a denylist by identity, without Nest internals.
    expect(Reflect.getMetadata("__injectable__", ConfigService)).toBe(true);
    expect(typeof Reflector).toBe("function");
  });

  afterAll(() => {
    for (const [name, rows] of results) {
      console.log(`\n### Q1 inventory: ${name}\n\n${table(rows)}\n`);
    }
    const express = results.get("express");
    if (!express) return;
    for (const other of ["fastify", "node"]) {
      const o = results.get(other);
      if (!o) continue;
      const a = new Set([...express.keys()]);
      const b = new Set([...o.keys()]);
      const onlyExpress = [...a].filter((k) => !b.has(k));
      const onlyOther = [...b].filter((k) => !a.has(k));
      console.log(
        `Q1 diff express vs ${other}: only express=${JSON.stringify(onlyExpress)} only ${other}=${JSON.stringify(onlyOther)}`,
      );
    }
  });
});
