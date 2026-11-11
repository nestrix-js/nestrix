// Helpers for test/integrations/*.test.ts. Not a test file itself.
import { createConnection } from "node:net";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { inject } from "vitest";
import type { ContainerAddress, Containers } from "./containers.global.js";

export function containers(): Containers {
  return inject("containers");
}

/** The reason container tests skip, printed once per file; `undefined` when they run. */
export function skipReason(
  key: keyof Omit<Containers, "skip">,
): string | undefined {
  const c = containers();
  const reason =
    c.skip ?? (c[key] === undefined ? `no ${key} container` : undefined);
  if (reason !== undefined)
    console.log(`[nestrix integrations] skipped: ${reason}`);
  return reason;
}

export function address(key: keyof Omit<Containers, "skip">): ContainerAddress {
  const a = containers()[key];
  if (a === undefined) throw new Error(`no ${key} container`);
  return a;
}

/** Retries `attempt` until it resolves or `timeoutMs` passes; rethrows the last error. */
export async function waitUntil(
  attempt: () => Promise<unknown>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      await attempt();
      return;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(
        `${what} not ready after ${timeoutMs} ms: ${String(last)}`,
      );
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Resolves once something accepts TCP connections at `a`. */
export function tcpOpen(a: ContainerAddress): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(a.port, a.host);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

export function dbSpans(spans: readonly ReadableSpan[]): ReadableSpan[] {
  return spans.filter(
    (s) =>
      s.instrumentationScope.name === "@nestrix/nestjs" &&
      s.attributes["db.system.name"] !== undefined,
  );
}

export function parentId(span: ReadableSpan): string | undefined {
  return span.parentSpanContext?.spanId;
}

export function durationMs(span: ReadableSpan): number {
  return span.duration[0] * 1000 + span.duration[1] / 1e6;
}

export function startMs(span: ReadableSpan): number {
  return span.startTime[0] * 1000 + span.startTime[1] / 1e6;
}
