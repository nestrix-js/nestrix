// No global state needed: the interceptor is called directly with fake execution contexts.
// It must return exactly the stream `next.handle()` gave it whenever it has nothing to record.
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { of } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import { NestrixInterceptor } from "../src/http/interceptor.js";

beforeEach(() => resetDiagnosticsForTests());

function contextOf(type: string): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => ({}) }),
    getClass: () => class C {},
    getHandler: () => function h() {},
  } as unknown as ExecutionContext;
}

function handler() {
  const stream = of("value");
  const next: CallHandler = { handle: vi.fn(() => stream) };
  return { stream, next };
}

describe("NestrixInterceptor passes streams through untouched", () => {
  it.each(["rpc", "ws", "graphql"])(
    "returns the same stream for a %s context",
    (type) => {
      const { stream, next } = handler();
      expect(new NestrixInterceptor().intercept(contextOf(type), next)).toBe(
        stream,
      );
      expect(next.handle).toHaveBeenCalledTimes(1);
      expect(getFailureCounts().size).toBe(0);
    },
  );

  it("returns the same stream for an http request Nestrix has no span for", () => {
    const { stream, next } = handler();
    expect(new NestrixInterceptor().intercept(contextOf("http"), next)).toBe(
      stream,
    );
  });

  it("survives a throwing getType(): same stream, handle() once, failure counted", () => {
    const { stream, next } = handler();
    const broken = {
      getType: () => {
        throw new Error("getType broke");
      },
    } as unknown as ExecutionContext;
    expect(new NestrixInterceptor().intercept(broken, next)).toBe(stream);
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(getFailureCounts().get("http.interceptor")).toBe(1);
  });
});
