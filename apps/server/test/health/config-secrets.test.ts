import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig, trimOneNewline } from "../../src/config.js";

// Generated test values (repeated letters), so nothing here looks like a real credential.
const KEY = "k".repeat(40);
const ADMIN = "q".repeat(20);
const SESSION = "s".repeat(40);
const URL_NO_PW = "postgres://nestrix@db.internal:5432/nestrix";

const dir = mkdtempSync(join(tmpdir(), "nestrix-secrets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function errors(env: Record<string, string>): string[] {
  const result = loadConfig(env);
  if (result.ok) throw new Error("expected invalid configuration");
  return result.errors;
}

describe("*_FILE secrets (#33)", () => {
  it("starts with only the four _FILE variables", () => {
    const result = loadConfig({
      DATABASE_URL_FILE: file("url", `${URL_NO_PW}\n`),
      NESTRIX_INGEST_KEYS_FILE: file("keys", `${KEY}\r\n`),
      NESTRIX_ADMIN_PASSWORD_FILE: file("admin", `${ADMIN}\n`),
      NESTRIX_SESSION_SECRET_FILE: file("session", SESSION),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.databaseUrl).toBe(URL_NO_PW);
    expect(result.config.ingest.keys).toEqual([KEY]);
    expect(result.config.adminPassword).toBe(ADMIN);
    expect(result.config.sessionSecret.toString()).toBe(SESSION);
    expect(result.config.sessionSecretGenerated).toBe(false);
  });

  it("removes exactly one trailing line break", () => {
    expect(trimOneNewline("a\n")).toBe("a");
    expect(trimOneNewline("a\r\n")).toBe("a");
    expect(trimOneNewline("a\n\n")).toBe("a\n");
    expect(trimOneNewline("a\r")).toBe("a\r");
    const result = loadConfig({
      DATABASE_URL: URL_NO_PW,
      NESTRIX_ADMIN_PASSWORD_FILE: file("admin2", `${ADMIN} \n`),
    });
    // Only the one newline goes; a space before it is part of the password.
    expect(result.ok && result.config.adminPassword).toBe(`${ADMIN} `);
  });

  it("reports a missing file by variable and path, with the system's code", () => {
    const path = join(dir, "does-not-exist");
    const [message] = errors({
      DATABASE_URL: URL_NO_PW,
      NESTRIX_ADMIN_PASSWORD_FILE: path,
    });
    expect(message).toContain("NESTRIX_ADMIN_PASSWORD_FILE");
    expect(message).toContain(path);
    expect(message).toContain("ENOENT");
  });

  it("reports an empty file, and one that is only a line break", () => {
    for (const content of ["", "\n", "\r\n"]) {
      const [message] = errors({
        DATABASE_URL: URL_NO_PW,
        NESTRIX_SESSION_SECRET_FILE: file("empty", content),
      });
      expect(message).toMatch(/^NESTRIX_SESSION_SECRET_FILE: .* is empty\.$/);
    }
  });

  it("refuses both the variable and its _FILE", () => {
    for (const name of [
      "NESTRIX_INGEST_KEYS",
      "NESTRIX_ADMIN_PASSWORD",
      "NESTRIX_SESSION_SECRET",
      "DATABASE_URL",
    ]) {
      const env: Record<string, string> = {
        DATABASE_URL_FILE: file("u", URL_NO_PW),
        [name]: name === "DATABASE_URL" ? URL_NO_PW : "x".repeat(40),
        [`${name}_FILE`]: file("v", "y".repeat(40)),
      };
      if (name === "DATABASE_URL") env.DATABASE_URL_FILE = file("v", URL_NO_PW);
      expect(errors(env)).toContain(
        `${name} and ${name}_FILE are both set; set only one of them.`,
      );
    }
  });

  it("never puts the file's content in an error", () => {
    const secretText = "z".repeat(5);
    const all = errors({
      DATABASE_URL: URL_NO_PW,
      // Too short for a session secret: the length error must not quote the value either.
      NESTRIX_SESSION_SECRET_FILE: file("short", secretText),
      NESTRIX_INGEST_KEYS_FILE: file("shortkey", `${"w".repeat(7)}\n`),
      NESTRIX_ADMIN_PASSWORD_FILE: file("shortadmin", "v".repeat(6)),
    }).join("\n");
    expect(all).toContain("NESTRIX_SESSION_SECRET");
    for (const text of [secretText, "w".repeat(7), "v".repeat(6)]) {
      expect(all).not.toContain(text);
    }
  });

  it("applies the same checks to a value from a file", () => {
    const [message] = errors({
      DATABASE_URL: URL_NO_PW,
      NESTRIX_INGEST_KEYS_FILE: file("shortkey2", "tooshort\n"),
    });
    expect(message).toMatch(/^NESTRIX_INGEST_KEYS: key 1 has 8 characters/);
  });

  it("an unreadable DATABASE_URL_FILE is the only DATABASE_URL error", () => {
    const messages = errors({
      DATABASE_URL_FILE: join(dir, "nope"),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("DATABASE_URL_FILE");
  });

  it("still requires a database URL", () => {
    expect(errors({})[0]).toMatch(/^DATABASE_URL \(or DATABASE_URL_FILE\)/);
  });

  describe("DATABASE_PASSWORD_FILE", () => {
    it("puts the password into the URL, percent-encoded", () => {
      const result = loadConfig({
        DATABASE_URL: URL_NO_PW,
        DATABASE_PASSWORD_FILE: file("pw", "p@ss/word:1\n"),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const url = new URL(result.config.databaseUrl);
      expect(decodeURIComponent(url.password)).toBe("p@ss/word:1");
      expect(url.username).toBe("nestrix");
      expect(url.host).toBe("db.internal:5432");
      expect(url.pathname).toBe("/nestrix");
    });

    it("works together with DATABASE_URL_FILE", () => {
      const result = loadConfig({
        DATABASE_URL_FILE: file("u2", `${URL_NO_PW}?sslmode=require\n`),
        DATABASE_PASSWORD_FILE: file("pw2", "secretpw\n"),
      });
      expect(result.ok && result.config.databaseUrl).toBe(
        "postgres://nestrix:secretpw@db.internal:5432/nestrix?sslmode=require",
      );
    });

    it("is an error when the URL already has a password", () => {
      for (const url of [
        "postgres://nestrix:inline@db/nestrix",
        "postgres://nestrix@db/nestrix?password=inline",
      ]) {
        const messages = errors({
          DATABASE_URL: url,
          DATABASE_PASSWORD_FILE: file("pw3", "other\n"),
        });
        expect(messages).toEqual([
          "DATABASE_PASSWORD_FILE is set but DATABASE_URL already contains a password; remove one of them.",
        ]);
        expect(messages.join()).not.toContain("inline");
      }
    });

    it("is an error without a user name, without a URL, or when the file is bad", () => {
      expect(
        errors({
          DATABASE_URL: "postgres://db/nestrix",
          DATABASE_PASSWORD_FILE: file("pw4", "x\n"),
        })[0],
      ).toMatch(/needs a user name/);
      expect(errors({ DATABASE_PASSWORD_FILE: file("pw5", "x\n") })).toContain(
        "DATABASE_PASSWORD_FILE is set but DATABASE_URL is not.",
      );
      expect(
        errors({
          DATABASE_URL: URL_NO_PW,
          DATABASE_PASSWORD_FILE: file("pw6", "\n"),
        })[0],
      ).toMatch(/^DATABASE_PASSWORD_FILE: .* is empty\.$/);
      expect(
        errors({
          DATABASE_URL: URL_NO_PW,
          DATABASE_PASSWORD_FILE: join(dir, "missing-pw"),
        })[0],
      ).toContain("ENOENT");
    });
  });
});
