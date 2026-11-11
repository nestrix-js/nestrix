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

describe("NestrixInterceptor reads the request without switchToHttp when it can", () => {
  it("finds the request state through getArgByIndex(0)", async () => {
    const { getStateForRequest, setStateForRequest } = await import(
      "../src/http/request-state.js"
    );
    const request = {};
    const calls: string[] = [];
    const span = { setAttribute: (k: string) => calls.push(k) };
    const state = {
      span,
      method: "GET",
      baseName: "GET",
      route: undefined,
      reached: false,
      exception: undefined,
      ended: false,
    };
    setStateForRequest(request, state as never);
    expect(getStateForRequest(request)).toBe(state);
    const context = {
      getType: () => "http",
      getArgByIndex: (i: number) => (i === 0 ? request : undefined),
      switchToHttp: () => {
        throw new Error("switchToHttp must not be needed");
      },
      getClass: () => class Cats {},
      getHandler: () => function list() {},
    } as unknown as ExecutionContext;
    const { next } = handler();
    new NestrixInterceptor().intercept(context, next);
    expect(state.reached).toBe(true);
    expect(calls).toEqual(["code.function.name"]);
    expect(getFailureCounts().size).toBe(0);
  });

  it("falls back to switchToHttp().getRequest() when the context has no getArgByIndex", async () => {
    const { getStateForRequest, setStateForRequest } = await import(
      "../src/http/request-state.js"
    );
    const request = {};
    const calls: string[] = [];
    const span = { setAttribute: (k: string) => calls.push(k) };
    const state = {
      span,
      method: "GET",
      baseName: "GET",
      route: undefined,
      reached: false,
      exception: undefined,
      ended: false,
    };
    setStateForRequest(request, state as never);
    expect(getStateForRequest(request)).toBe(state);
    const context = {
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => request }),
      getClass: () => class Cats {},
      getHandler: () => function list() {},
    } as unknown as ExecutionContext;
    expect(context).not.toHaveProperty("getArgByIndex");
    const { next } = handler();
    new NestrixInterceptor().intercept(context, next);
    expect(state.reached).toBe(true);
    expect(calls).toEqual(["code.function.name"]);
    expect(getFailureCounts().size).toBe(0);
  });
});
