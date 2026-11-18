import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { ServerLogger } from "../../src/logging.js";

const DB = "postgres://localhost:5432/nestrix";

function logConfig(env: Record<string, string> = {}) {
  const result = loadConfig({ DATABASE_URL: DB, ...env });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.config.log;
}

function errors(env: Record<string, string>): string[] {
  const result = loadConfig({ DATABASE_URL: DB, ...env });
  if (result.ok) throw new Error("expected invalid configuration");
  return result.errors;
}

describe("log configuration (#47)", () => {
  it("defaults to text outside production and json under it", () => {
    expect(logConfig().json).toBe(false);
    expect(logConfig({ NODE_ENV: "development" }).json).toBe(false);
    expect(logConfig({ NODE_ENV: "production" }).json).toBe(true);
  });

  it("NESTRIX_LOG_FORMAT overrides NODE_ENV, case-insensitively", () => {
    expect(logConfig({ NESTRIX_LOG_FORMAT: "JSON" }).json).toBe(true);
    expect(
      logConfig({ NODE_ENV: "production", NESTRIX_LOG_FORMAT: "text" }).json,
    ).toBe(false);
    expect(errors({ NESTRIX_LOG_FORMAT: "xml" })).toEqual([
      'NESTRIX_LOG_FORMAT accepts "json" or "text" (got "xml").',
    ]);
  });

  it("maps NESTRIX_LOG_LEVEL to Nest levels, this one and everything more severe", () => {
    expect(logConfig().levels).toEqual(["log", "warn", "error", "fatal"]);
    expect(logConfig({ NESTRIX_LOG_LEVEL: "info" }).levels).toEqual(
      logConfig({ NESTRIX_LOG_LEVEL: "log" }).levels,
    );
    expect(logConfig({ NESTRIX_LOG_LEVEL: "WARN" }).levels).toEqual([
      "warn",
      "error",
      "fatal",
    ]);
    expect(logConfig({ NESTRIX_LOG_LEVEL: "verbose" }).levels).toEqual([
      "verbose",
      "debug",
      "log",
      "warn",
      "error",
      "fatal",
    ]);
    expect(logConfig({ NESTRIX_LOG_LEVEL: "fatal" }).levels).toEqual(["fatal"]);
  });

  it("rejects an unknown level", () => {
    expect(errors({ NESTRIX_LOG_LEVEL: "loud" })[0]).toMatch(
      /^NESTRIX_LOG_LEVEL accepts verbose, debug, info, warn, error, fatal \(got "loud"\)/,
    );
  });

  it("hides route mapping at info and above only", () => {
    expect(logConfig().hideRouteMapping).toBe(true);
    expect(logConfig({ NESTRIX_LOG_LEVEL: "error" }).hideRouteMapping).toBe(
      true,
    );
    expect(logConfig({ NESTRIX_LOG_LEVEL: "debug" }).hideRouteMapping).toBe(
      false,
    );
  });
});

describe("ServerLogger", () => {
  afterEach(() => vi.restoreAllMocks());

  function capture(): string[] {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    return chunks;
  }

  it("json mode writes one JSON object per line, without ANSI", () => {
    const chunks = capture();
    const logger = new ServerLogger(logConfig({ NESTRIX_LOG_FORMAT: "json" }));
    logger.log("hello world", "Ingest");
    logger.warn("careful", "Health");
    logger.error("broken", "stack line", "Storage");
    logger.debug("below the level", "Ingest");

    const out = chunks.join("");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escape sequence
    expect(out).not.toMatch(/\u001b/);
    const lines = out.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(3);
    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records[0]).toMatchObject({
      level: "log",
      message: "hello world",
      context: "Ingest",
    });
    expect(typeof records[0]?.timestamp).toBe("number");
    expect(records[1]).toMatchObject({ level: "warn", context: "Health" });
    expect(records[2]).toMatchObject({ level: "error", message: "broken" });
  });

  it("text mode is not JSON", () => {
    const chunks = capture();
    new ServerLogger(logConfig({ NESTRIX_LOG_FORMAT: "text" })).log(
      "hello world",
      "Ingest",
    );
    const out = chunks.join("");
    expect(out).toContain("hello world");
    expect(out).toContain("[Ingest]");
    expect(() => JSON.parse(out)).toThrow();
  });

  it("drops route-mapping lines at the default level, keeps them at debug", () => {
    const chunks = capture();
    const quiet = new ServerLogger(logConfig({ NESTRIX_LOG_FORMAT: "json" }));
    quiet.log("Mapped {/livez, GET} route", "RouterExplorer");
    quiet.log("HealthController {/}:", "RoutesResolver");
    quiet.log("kept", "Ingest");
    expect(chunks.join("")).not.toContain("Mapped");
    expect(chunks.join("")).not.toContain("RoutesResolver");
    expect(chunks.join("")).toContain("kept");

    chunks.length = 0;
    const loud = new ServerLogger(
      logConfig({ NESTRIX_LOG_FORMAT: "json", NESTRIX_LOG_LEVEL: "debug" }),
    );
    loud.log("Mapped {/livez, GET} route", "RouterExplorer");
    expect(chunks.join("")).toContain("Mapped");
  });

  it("honours the level", () => {
    const chunks = capture();
    const logger = new ServerLogger(
      logConfig({ NESTRIX_LOG_FORMAT: "json", NESTRIX_LOG_LEVEL: "warn" }),
    );
    logger.log("info line", "X");
    logger.warn("warn line", "X");
    const out = chunks.join("");
    expect(out).not.toContain("info line");
    expect(out).toContain("warn line");
  });
});
