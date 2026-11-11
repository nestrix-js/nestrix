import { describe, expect, it } from "vitest";
import { formatConfigErrors, loadConfig, MIB } from "../../src/config.js";

const DB = "postgres://localhost:5432/nestrix";
const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(40);
// Generated test values (repeated letters), so nothing here looks like a real credential.
const ADMIN = "q".repeat(20);
const ADMIN_SHORT = "w".repeat(8);
const SESSION = "s".repeat(32);
const SESSION_SHORT = "x".repeat(4);
const SHORT_KEY = "y".repeat(11);

function errors(env: Record<string, string>): string[] {
  const result = loadConfig(env);
  if (result.ok) throw new Error("expected invalid configuration");
  return result.errors;
}

describe("loadConfig", () => {
  it("applies the defaults", () => {
    const result = loadConfig({ DATABASE_URL: DB });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const c = result.config;
    expect(c.port).toBe(4318);
    expect(c.retentionDays).toBe(7);
    expect(c.ingest.auth).toBe("unconfigured");
    expect(c.ingest.keys).toEqual([]);
    expect(c.ingest.maxBodyBytes).toBe(20 * MIB);
    expect(c.ingest.maxSpans).toBe(100_000);
    expect(c.ingest.maxMessages).toBe(400_000);
    expect(c.ingest.inflightBudgetBytes).toBe(320 * MIB);
    expect(c.http).toEqual({
      maxConnections: 1024,
      requestTimeoutMs: 60_000,
      headersTimeoutMs: 20_000,
    });
    expect(c.adminPassword).toBeUndefined();
    expect(c.sessionSecret).toHaveLength(32);
    expect(c.sessionSecretGenerated).toBe(true);
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("reads every variable", () => {
    const result = loadConfig({
      DATABASE_URL: "postgresql://db.internal/nestrix",
      PORT: "8080",
      NESTRIX_INGEST_KEYS: ` ${KEY_A} ,${KEY_B},,`,
      NESTRIX_ADMIN_PASSWORD: ADMIN,
      NESTRIX_SESSION_SECRET: SESSION,
      NESTRIX_RETENTION_DAYS: "30",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.port).toBe(8080);
    expect(result.config.ingest.auth).toBe("keys");
    expect(result.config.ingest.keys).toEqual([KEY_A, KEY_B]);
    expect(result.config.adminPassword).toBe(ADMIN);
    expect(result.config.sessionSecret.toString()).toBe(SESSION);
    expect(result.config.sessionSecretGenerated).toBe(false);
    expect(result.config.retentionDays).toBe(30);
  });

  it("reads NESTRIX_MAX_CONNECTIONS", () => {
    const result = loadConfig({
      DATABASE_URL: DB,
      NESTRIX_MAX_CONNECTIONS: "50",
    });
    expect(result.ok && result.config.http.maxConnections).toBe(50);
    expect(
      errors({ DATABASE_URL: DB, NESTRIX_MAX_CONNECTIONS: "0" })[0],
    ).toMatch(/^NESTRIX_MAX_CONNECTIONS/);
  });

  it("accepts the explicit opt-out", () => {
    const result = loadConfig({
      DATABASE_URL: DB,
      NESTRIX_INGEST_AUTH: "none",
    });
    expect(result.ok && result.config.ingest.auth).toBe("none");
  });

  it("reports every problem at once, without echoing values that may be secret", () => {
    const list = errors({
      DATABASE_URL: "mysql://marker-host-value/x",
      PORT: "70000",
      NESTRIX_INGEST_KEYS: `${SHORT_KEY},${KEY_A}`,
      NESTRIX_INGEST_AUTH: "off",
      NESTRIX_ADMIN_PASSWORD: ADMIN_SHORT,
      NESTRIX_SESSION_SECRET: SESSION_SHORT,
      NESTRIX_RETENTION_DAYS: "0",
    });
    expect(list).toHaveLength(7);
    const text = formatConfigErrors(list);
    expect(text).toMatch(/^nestrix-server: invalid configuration/);
    for (const value of [
      "marker-host-value",
      SHORT_KEY,
      ADMIN_SHORT,
      SESSION_SHORT,
    ]) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain("DATABASE_URL must be a postgres://");
    expect(text).toContain("PORT must be a whole number from 1 to 65535");
    expect(text).toContain("key 1 has 11 characters");
    expect(text).toContain('NESTRIX_INGEST_AUTH accepts only "none"');
    expect(text).toContain("NESTRIX_ADMIN_PASSWORD needs at least 12");
    expect(text).toContain("NESTRIX_SESSION_SECRET needs at least 32");
    expect(text).toContain("NESTRIX_RETENTION_DAYS must be a whole number");
  });

  it("requires DATABASE_URL", () => {
    expect(errors({})).toEqual([
      "DATABASE_URL is required, e.g. postgres://localhost:5432/nestrix.",
    ]);
    expect(errors({ DATABASE_URL: "not a url" })[0]).toMatch(/postgres:\/\//);
  });

  it("refuses keys together with the opt-out", () => {
    expect(
      errors({
        DATABASE_URL: DB,
        NESTRIX_INGEST_KEYS: KEY_A,
        NESTRIX_INGEST_AUTH: "none",
      })[0],
    ).toMatch(/both set/);
  });

  it("refuses numbers that are not whole", () => {
    for (const port of ["4318.5", "-1", "0x10", "1e3"]) {
      expect(errors({ DATABASE_URL: DB, PORT: port })[0]).toMatch(/^PORT/);
    }
  });
});
