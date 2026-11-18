/**
 * `LogSearchService` without a database: the per-process concurrency cap (503 with `Retry-After`)
 * and the statement timeout answer (57014 is a 503, the connection is returned).
 */
import "reflect-metadata";
import type { ArgumentsHost } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/config.js";
import { QueryExceptionFilter } from "../../src/query/exception.filter.js";
import {
  LogSearchBusyException,
  LogSearchService,
} from "../../src/query/log-search.service.js";

interface FakeClient {
  query(sql: string): Promise<{ rows: unknown[] }>;
  release(): void;
}

function service(opts: {
  concurrency: number;
  select: (sql: string) => Promise<{ rows: unknown[] }>;
}) {
  const log: string[] = [];
  let released = 0;
  const client: FakeClient = {
    async query(sql) {
      log.push(sql.split(/\s/)[0] ?? "");
      if (/^\s*SELECT l\.trace_id/.test(sql)) return opts.select(sql);
      return { rows: [] };
    },
    release() {
      released++;
    },
  };
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [] }),
  };
  const config = {
    logStore: { mode: "all", searchConcurrency: opts.concurrency },
  } as unknown as ServerConfig;
  return {
    svc: new LogSearchService(pool as never, config),
    log,
    released: () => released,
  };
}

describe("log search concurrency cap", () => {
  it("runs at most the configured searches at once and answers 503 with Retry-After beyond", async () => {
    const gates: Array<() => void> = [];
    const { svc } = service({
      concurrency: 2,
      select: () =>
        new Promise((resolve) => {
          gates.push(() => resolve({ rows: [] }));
        }),
    });
    const a = svc.search({});
    const b = svc.search({});
    // Let both reach the database.
    await new Promise((r) => setTimeout(r, 10));
    expect(gates).toHaveLength(2);
    const third = svc.search({});
    const error = await third.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LogSearchBusyException);
    expect((error as HttpException).getStatus()).toBe(503);
    expect(gates).toHaveLength(2);

    // The filter turns it into an ApiError with the header.
    const headers: Record<string, string> = {};
    let status = 0;
    new QueryExceptionFilter().catch(error, {
      switchToHttp: () => ({
        getResponse: () => ({
          setHeader: (k: string, v: string) => {
            headers[k] = v;
          },
          status: (s: number) => {
            status = s;
            return { json() {} };
          },
        }),
      }),
    } as unknown as ArgumentsHost);
    expect(status).toBe(503);
    expect(headers["Retry-After"]).toBe("1");

    // A finished search frees its place.
    gates[0]?.();
    await a;
    const d = svc.search({});
    await new Promise((r) => setTimeout(r, 10));
    expect(gates).toHaveLength(3);
    for (const g of gates) g();
    await Promise.all([b, d]);
  });

  it("frees the place when a search fails", async () => {
    const { svc } = service({
      concurrency: 1,
      select: async () => {
        throw new Error("boom");
      },
    });
    await expect(svc.search({})).rejects.toThrow("boom");
    await expect(svc.search({})).rejects.toThrow("boom"); // not a busy 503
  });
});

describe("log search statement timeout", () => {
  it("answers 503 on a 57014, rolls back and returns the connection", async () => {
    const { svc, log, released } = service({
      concurrency: 2,
      select: async () => {
        throw Object.assign(new Error("canceling statement"), {
          code: "57014",
        });
      },
    });
    const error = (await svc
      .search({})
      .catch((e: unknown) => e)) as HttpException;
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(503);
    expect(JSON.stringify(error.getResponse())).toContain("took too long");
    expect(log).toContain("ROLLBACK");
    expect(log).not.toContain("COMMIT");
    expect(released()).toBe(1);
  });
});
