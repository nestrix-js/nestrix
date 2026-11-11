import { describe, expect, it } from "vitest";
import { type AdapterName, bootApp } from "../src/index.js";
import { expectRefused } from "./helpers.js";

const adapters: AdapterName[] = ["express", "fastify", "node"];

describe.each(adapters)("bootApp(%s)", (adapter) => {
  for (const testing of [false, true]) {
    it(`serves GET /hello, captures no spans, closes cleanly (testing: ${testing})`, async () => {
      const booted = await bootApp(adapter, { testing });
      const res = await fetch(`${booted.baseUrl}/hello`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello");
      expect(booted.spans()).toHaveLength(0);
      await booted.close();
      await expectRefused(booted.baseUrl);
    });
  }
});

describe("bootApp rules", () => {
  it("runs configure before listen (global prefix)", async () => {
    const booted = await bootApp("express", {
      configure: (app) => app.setGlobalPrefix("api"),
    });
    try {
      expect((await fetch(`${booted.baseUrl}/api/hello`)).status).toBe(200);
      expect((await fetch(`${booted.baseUrl}/hello`)).status).toBe(404);
    } finally {
      await booted.close();
    }
  });

  it("throws when a second app is booted while one is open", async () => {
    const first = await bootApp("express");
    try {
      await expect(bootApp("fastify")).rejects.toThrow(/still open/);
    } finally {
      await first.close();
    }
    const again = await bootApp("fastify");
    await again.close();
  });

  it("captures spans and waitForSpan reports what it saw on timeout", async () => {
    const { trace } = await import("@opentelemetry/api");
    const booted = await bootApp("express");
    try {
      trace.getTracer("test").startSpan("manual").end();
      expect(booted.spans().map((s) => s.name)).toEqual(["manual"]);
      await expect(booted.waitForSpan("manual")).resolves.toMatchObject({
        name: "manual",
      });
      await expect(
        booted.waitForSpan("missing", { timeoutMs: 50 }),
      ).rejects.toThrow(/"missing".*Captured spans: "manual"/);
    } finally {
      await booted.close();
    }
    const next = await bootApp("express");
    expect(next.spans()).toHaveLength(0);
    await next.close();
  });
});
