// Statement sanitising (backlog P3-01 item 5). No global state.
import { describe, expect, it } from "vitest";
import {
  MAX_STATEMENT_LENGTH,
  sanitizeSql,
  sqlOperation,
  sqlTarget,
  UNPARSED_STATEMENT,
} from "../../src/integrations/sql.js";

const pg = (s: string) => sanitizeSql(s, "postgresql");
const my = (s: string) => sanitizeSql(s, "mysql");

describe("sanitizeSql: literals", () => {
  it.each([
    [
      "SELECT * FROM t WHERE a = 'x' AND b = 42",
      "SELECT * FROM t WHERE a = ? AND b = ?",
    ],
    ["SELECT 1.5, .5, 1e10, 2.5E-3, 0x1F, 1_000", "SELECT ?, ?, ?, ?, ?, ?"],
    [
      "SELECT * FROM t1 JOIN t2 ON t1.id = t2.id",
      "SELECT * FROM t1 JOIN t2 ON t1.id = t2.id",
    ],
    [
      "UPDATE t SET flag = TRUE, other = false WHERE x IS NULL",
      "UPDATE t SET flag = ?, other = ? WHERE x IS NULL",
    ],
    [
      "SELECT $1, $2::int FROM t WHERE id = $3",
      "SELECT $1, $2::int FROM t WHERE id = $3",
    ],
    [
      "SELECT * FROM t WHERE id IN (1, 2, 3)",
      "SELECT * FROM t WHERE id IN (?)",
    ],
    [
      "SELECT * FROM t WHERE id in ( 'a' ,'b' )",
      "SELECT * FROM t WHERE id in (?)",
    ],
    [
      "SELECT * FROM t WHERE id IN ($1, $2, $3)",
      "SELECT * FROM t WHERE id IN (?)",
    ],
    [
      "SELECT * FROM t WHERE id IN (SELECT id FROM u)",
      "SELECT * FROM t WHERE id IN (SELECT id FROM u)",
    ],
    ["SELECT   a,\n\t b  FROM t", "SELECT a, b FROM t"],
    ["  SELECT 1  ", "SELECT ?"],
    ["SELECT -5", "SELECT -?"],
  ])("postgresql %j", (input, expected) => {
    expect(pg(input)).toBe(expected);
  });

  it("quotes inside strings (doubled quotes)", () => {
    expect(pg("SELECT 'it''s', 'a''''b' FROM t")).toBe("SELECT ?, ? FROM t");
    expect(my("SELECT 'it''s'")).toBe("SELECT ?");
  });

  it("PostgreSQL: a backslash does not escape in a standard string; it does in E'…'", () => {
    // 'C:\' is a whole literal in PostgreSQL; the next literal must not leak.
    expect(pg("SELECT 'C:\\', 'secret'")).toBe("SELECT ?, ?");
    expect(pg("SELECT E'it\\'s', 'secret'")).toBe("SELECT ?, ?");
    expect(pg("SELECT e'a\\\\', 'secret'")).toBe("SELECT ?, ?");
  });

  it("MySQL: a backslash escapes, as in mysql2's interpolated values", () => {
    expect(
      my("SELECT * FROM t WHERE name = 'O\\'Brien' AND pw = 'hunter2'"),
    ).toBe("SELECT * FROM t WHERE name = ? AND pw = ?");
    expect(my(`SELECT "double \\" quoted", 'x'`)).toBe("SELECT ?, ?");
  });

  it("MySQL: double quotes are strings; PostgreSQL: identifiers", () => {
    expect(my(`SELECT * FROM t WHERE a = "secret"`)).toBe(
      "SELECT * FROM t WHERE a = ?",
    );
    expect(pg(`SELECT "Name" FROM "My Table" WHERE "a""b" = 1`)).toBe(
      `SELECT "Name" FROM "My Table" WHERE "a""b" = ?`,
    );
  });

  it("backtick identifiers are kept", () => {
    expect(my("SELECT `a``b` FROM `t` WHERE `c` = 'x'")).toBe(
      "SELECT `a``b` FROM `t` WHERE `c` = ?",
    );
  });

  it("prefixed strings: E N B X U& and MySQL charset introducers", () => {
    expect(pg("SELECT N'x', B'0101', X'FF', U&'d\\0061t'")).toBe(
      "SELECT ?, ?, ?, ?",
    );
    expect(my("SELECT _utf8mb4'secret', X'00ff', b'01'")).toBe(
      "SELECT ?, ?, ?",
    );
  });

  it("dollar-quoted strings (PostgreSQL)", () => {
    expect(pg("SELECT $$it's $1 'secret'$$, $tag$a $$ b$tag$ FROM t")).toBe(
      "SELECT ?, ? FROM t",
    );
    expect(
      pg(
        "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1 $body$ LANGUAGE sql",
      ),
    ).toBe("CREATE FUNCTION f() RETURNS int AS ? LANGUAGE sql");
  });

  it("mysql2's interpolation of a Buffer, an object and nested arrays", () => {
    expect(my("INSERT INTO t SET `a` = 1, `b` = 'x', `c` = X'0a0b'")).toBe(
      "INSERT INTO t SET `a` = ?, `b` = ?, `c` = ?",
    );
    expect(my("INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y')")).toBe(
      "INSERT INTO t (a, b) VALUES (?, ?), (?, ?)",
    );
  });

  it("identifiers with digits and $ stay whole", () => {
    expect(pg("SELECT col1, t2.c3, a$b FROM t9")).toBe(
      "SELECT col1, t2.c3, a$b FROM t9",
    );
  });
});

describe("sanitizeSql: comments", () => {
  it("drops line and block comments", () => {
    expect(pg("SELECT 1 -- secret 'x'\nFROM t")).toBe("SELECT ? FROM t");
    expect(pg("SELECT /* secret */ a FROM t")).toBe("SELECT a FROM t");
    expect(my("SELECT a # secret\nFROM t")).toBe("SELECT a FROM t");
    expect(my("SELECT /*! STRAIGHT_JOIN */ a FROM t")).toBe("SELECT a FROM t");
  });

  it("PostgreSQL block comments nest; MySQL's do not", () => {
    expect(pg("SELECT /* a /* b */ 'still comment' */ 1")).toBe("SELECT ?");
    expect(my("SELECT /* a /* b */ 1")).toBe("SELECT ?");
  });

  it("# is an operator in PostgreSQL, not a comment", () => {
    expect(pg("SELECT 5 # 3")).toBe("SELECT ? # ?");
  });

  it("comment markers inside strings are part of the string", () => {
    expect(pg("SELECT '-- not a comment', 'x /* y */'")).toBe("SELECT ?, ?");
  });
});

describe("sanitizeSql: fail closed", () => {
  it.each([
    ["SELECT 'unterminated", "postgresql"],
    ["SELECT 'it''s", "postgresql"],
    ["SELECT 'O\\'Brien", "mysql"],
    ['SELECT "unterminated identifier', "postgresql"],
    ['SELECT "unterminated string', "mysql"],
    ["SELECT $tag$ never closed", "postgresql"],
    ["SELECT 1 /* never closed", "postgresql"],
    ["SELECT /* a /* b */ 'secret'", "postgresql"],
    ["SELECT `x", "mysql"],
  ] as const)(
    "%j (%s) becomes the placeholder text, never the raw statement",
    (input, dialect) => {
      const out = sanitizeSql(input, dialect);
      expect(out).toBe(UNPARSED_STATEMENT);
    },
  );

  it("a non-string statement is not recorded", () => {
    expect(pg(undefined as unknown as string)).toBeUndefined();
    expect(sanitizeSql({ text: "x" }, "postgresql")).toBeUndefined();
  });
});

describe("sanitizeSql: length", () => {
  it(`caps the result at ${MAX_STATEMENT_LENGTH} characters`, () => {
    const long = `SELECT ${Array.from({ length: 2000 }, (_, i) => `c${i}`).join(", ")} FROM t`;
    const out = pg(long) as string;
    expect(out.length).toBe(MAX_STATEMENT_LENGTH);
    expect(out.startsWith("SELECT c0, c1, c2")).toBe(true);
  });

  it("a huge literal costs nothing in the output", () => {
    const out = pg(`INSERT INTO t VALUES ('${"x".repeat(1_000_000)}')`);
    expect(out).toBe("INSERT INTO t VALUES (?)");
  });
});

describe("sqlOperation and sqlTarget", () => {
  it.each([
    ["SELECT a FROM users WHERE id = ?", "SELECT", "users"],
    ["select a from public.users", "SELECT", "public.users"],
    ['SELECT a FROM "Users"', "SELECT", '"Users"'],
    ["INSERT INTO orders (a) VALUES (?)", "INSERT", "orders"],
    ["INSERT IGNORE INTO `orders` VALUES (?)", "INSERT", "`orders`"],
    ["UPDATE accounts SET a = ?", "UPDATE", "accounts"],
    ["DELETE FROM sessions WHERE x = ?", "DELETE", "sessions"],
    ["SELECT a FROM t1 JOIN t2 ON t1.id = t2.id", "SELECT", undefined],
    ["SELECT a FROM t1, t2", "SELECT", undefined],
    ["SELECT a FROM t1 x, t2 y", "SELECT", undefined],
    ["SELECT a FROM t WHERE b IN (SELECT b FROM u)", "SELECT", undefined],
    ["SELECT ?", "SELECT", undefined],
    ["(SELECT a FROM t)", "SELECT", "t"],
    ["WITH x AS (SELECT ?) SELECT * FROM x", "WITH", undefined],
    ["BEGIN", "BEGIN", undefined],
  ])("%j → %s %s", (text, operation, target) => {
    expect(sqlOperation(text)).toBe(operation);
    expect(sqlTarget(text, operation)).toBe(target);
  });

  it("no operation for the placeholder text or an empty statement", () => {
    expect(sqlOperation(UNPARSED_STATEMENT)).toBeUndefined();
    expect(sqlOperation("")).toBeUndefined();
    expect(sqlOperation(undefined)).toBeUndefined();
  });
});
