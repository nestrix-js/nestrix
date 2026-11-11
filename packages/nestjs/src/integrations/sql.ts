/**
 * SQL statement sanitising for database spans (backlog P3-01 item 5, AGENTS.md rule 7). One
 * scanner for every SQL driver: literals become `?`, comments are dropped, whitespace runs become
 * one space, `IN (…)` lists of literals or placeholders collapse to `IN (?)`, and the result is
 * capped at {@link MAX_STATEMENT_LENGTH} characters.
 *
 * Fail closed: a statement whose quotes or comments do not balance is replaced by
 * {@link UNPARSED_STATEMENT}, never recorded raw. A wrong guess about where a literal ends could
 * otherwise put the rest of a value into the trace.
 *
 * Dialects differ where it matters for privacy:
 * - `postgresql`: `'…'` doubles quotes to escape them, and a backslash escapes only inside
 *   `E'…'` (`standard_conforming_strings`, on by default since PostgreSQL 9.1). `"…"` is an
 *   identifier and kept. `$tag$…$tag$` is a string. `$1` is a placeholder. Block comments nest.
 * - `mysql`: a backslash escapes inside `'…'` and `"…"` (the default SQL mode, and how mysql2
 *   escapes values it interpolates into `query()` text), so `"…"` is a string too. `#` starts a
 *   comment. Block comments do not nest.
 *
 * Never throws: callers run it inside a guarded body anyway.
 */

export type SqlDialect = "postgresql" | "mysql";

export const MAX_STATEMENT_LENGTH = 2048;

/** Recorded instead of a statement that could not be scanned safely. */
export const UNPARSED_STATEMENT =
  "(statement not recorded: could not be parsed)";

/** Scanning stops once this much output exists; the result is cut to the cap afterwards. */
const SCAN_LIMIT = MAX_STATEMENT_LENGTH * 2;

class Unbalanced extends Error {}

function isIdentStart(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 95 || // _
    c >= 128
  );
}

function isIdentPart(c: number): boolean {
  return isIdentStart(c) || (c >= 48 && c <= 57) || c === 36; // 0-9, $
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isHex(c: number): boolean {
  return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
}

/**
 * Index just after a quoted run that starts at `start` (the opening quote). `''` (the quote
 * doubled) always escapes; `backslash` also lets `\` escape the next character.
 */
function skipQuoted(
  text: string,
  start: number,
  quote: number,
  backslash: boolean,
): number {
  let i = start + 1;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (backslash && c === 92) {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (text.charCodeAt(i + 1) === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  throw new Unbalanced();
}

function skipBlockComment(text: string, start: number, nests: boolean): number {
  let depth = 1;
  let i = start + 2;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 42 && text.charCodeAt(i + 1) === 47) {
      depth--;
      i += 2;
      if (depth === 0 || !nests) return i;
      continue;
    }
    if (nests && c === 47 && text.charCodeAt(i + 1) === 42) {
      depth++;
      i += 2;
      continue;
    }
    i++;
  }
  throw new Unbalanced();
}

function skipLineComment(text: string, start: number): number {
  const end = text.indexOf("\n", start);
  return end === -1 ? text.length : end + 1;
}

/** Index after a number literal starting at `start` (a digit, or `.` followed by a digit). */
function skipNumber(text: string, start: number): number {
  let i = start;
  const n = text.length;
  const c0 = text.charCodeAt(i);
  const c1 = text.charCodeAt(i + 1) | 0x20; // lowercase
  if (c0 === 48 && (c1 === 120 || c1 === 98 || c1 === 111)) {
    // 0x…, 0b…, 0o…
    i += 2;
    while (i < n && (isHex(text.charCodeAt(i)) || text.charCodeAt(i) === 95))
      i++;
    return i;
  }
  while (
    i < n &&
    (isDigit(text.charCodeAt(i)) || text.charCodeAt(i) === 95) // 1_000 (PostgreSQL 16)
  )
    i++;
  if (text.charCodeAt(i) === 46) {
    i++;
    while (i < n && isDigit(text.charCodeAt(i))) i++;
  }
  if ((text.charCodeAt(i) | 0x20) === 101) {
    // e / E exponent, only when digits follow
    let j = i + 1;
    const s = text.charCodeAt(j);
    if (s === 43 || s === 45) j++;
    if (isDigit(text.charCodeAt(j))) {
      i = j;
      while (i < n && isDigit(text.charCodeAt(i))) i++;
    }
  }
  return i;
}

/** For PostgreSQL `$tag$`: the index after the opening tag, or -1 when `$` does not open one. */
function dollarTagEnd(text: string, start: number): number {
  let i = start + 1;
  const n = text.length;
  if (i < n && text.charCodeAt(i) === 36) return i + 1; // $$
  if (i >= n || !isIdentStart(text.charCodeAt(i))) return -1;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 36) return i + 1;
    if (!(isIdentStart(c) || isDigit(c))) return -1;
    i++;
  }
  return -1;
}

const STRING_PREFIX = /^(?:[ebnx]|u&)$/i;
const MYSQL_INTRODUCER = /^_[a-z0-9]+$/i;
const COLLAPSE_IN = /\b(IN)\s*\(\s*(?:\?|\$\d+)(?:\s*,\s*(?:\?|\$\d+))+\s*\)/gi;

/**
 * The statement with literals replaced by `?`, or `undefined` when `text` is not a string.
 * See the module comment for the rules.
 */
export function sanitizeSql(
  text: unknown,
  dialect: SqlDialect,
): string | undefined {
  if (typeof text !== "string") return undefined;
  try {
    return scan(text, dialect);
  } catch {
    // Unbalanced, or anything unexpected: never fall back to the raw text.
    return UNPARSED_STATEMENT;
  }
}

function scan(text: string, dialect: SqlDialect): string {
  const pg = dialect === "postgresql";
  const n = text.length;
  let out = "";
  let pendingSpace = false;
  let i = 0;
  // Previous significant source character, to tell `.5` (a number) from `t.c5`.
  let prev = 0;

  const emit = (s: string): void => {
    if (pendingSpace && out.length > 0) out += " ";
    pendingSpace = false;
    out += s;
  };

  while (i < n && out.length < SCAN_LIMIT) {
    const c = text.charCodeAt(i);

    if (isSpace(c)) {
      pendingSpace = true;
      i++;
      continue;
    }
    // Comments: dropped, and they separate tokens.
    if (c === 45 && text.charCodeAt(i + 1) === 45) {
      i = skipLineComment(text, i);
      pendingSpace = true;
      continue;
    }
    if (!pg && c === 35) {
      i = skipLineComment(text, i);
      pendingSpace = true;
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42) {
      i = skipBlockComment(text, i, pg);
      pendingSpace = true;
      continue;
    }
    // Strings.
    if (c === 39) {
      i = skipQuoted(text, i, 39, !pg);
      emit("?");
      prev = 39;
      continue;
    }
    if (c === 34) {
      const end = skipQuoted(text, i, 34, !pg);
      // PostgreSQL: a quoted identifier, kept. MySQL: a string (without ANSI_QUOTES).
      emit(pg ? text.slice(i, end) : "?");
      i = end;
      prev = 34;
      continue;
    }
    if (c === 96) {
      // `identifier` (MySQL); kept.
      const end = skipQuoted(text, i, 96, false);
      emit(text.slice(i, end));
      i = end;
      prev = 96;
      continue;
    }
    if (pg && c === 36) {
      if (isDigit(text.charCodeAt(i + 1))) {
        // $1 placeholder
        let j = i + 1;
        while (j < n && isDigit(text.charCodeAt(j))) j++;
        emit(text.slice(i, j));
        i = j;
        prev = 48;
        continue;
      }
      const tagEnd = dollarTagEnd(text, i);
      if (tagEnd !== -1) {
        const tag = text.slice(i, tagEnd);
        const close = text.indexOf(tag, tagEnd);
        if (close === -1) throw new Unbalanced();
        i = close + tag.length;
        emit("?");
        prev = 36;
        continue;
      }
    }
    // Numbers, not inside an identifier (identifiers are consumed whole below).
    if (
      isDigit(c) ||
      (c === 46 &&
        isDigit(text.charCodeAt(i + 1)) &&
        !(isIdentPart(prev) || prev === 34 || prev === 96 || prev === 93))
    ) {
      i = skipNumber(text, i);
      emit("?");
      prev = 48;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(text.charCodeAt(j))) j++;
      const word = text.slice(i, j);
      const next = text.charCodeAt(j);
      // Prefixed strings: E'…' N'…' B'…' X'…' U&'…' and MySQL's _charset'…'.
      if (
        next === 39 &&
        (STRING_PREFIX.test(word) || MYSQL_INTRODUCER.test(word))
      ) {
        const backslash =
          !pg || (word.length === 1 && (word === "e" || word === "E"));
        i = skipQuoted(text, j, 39, backslash);
        emit("?");
        prev = 39;
        continue;
      }
      if (
        pg &&
        next === 38 &&
        text.charCodeAt(j + 1) === 39 &&
        (word === "u" || word === "U")
      ) {
        i = skipQuoted(text, j + 1, 39, false);
        emit("?");
        prev = 39;
        continue;
      }
      const upper = word.length <= 5 ? word.toUpperCase() : "";
      emit(upper === "TRUE" || upper === "FALSE" ? "?" : word);
      i = j;
      prev = 97;
      continue;
    }
    emit(text[i] as string);
    prev = c;
    i++;
  }

  const collapsed = out.replace(COLLAPSE_IN, "$1 (?)");
  return collapsed.length > MAX_STATEMENT_LENGTH
    ? collapsed.slice(0, MAX_STATEMENT_LENGTH)
    : collapsed;
}

const FIRST_WORD = /^[\s(]*([A-Za-z]+)/;

/** The statement's first keyword, upper-cased (`SELECT`), or `undefined`. */
export function sqlOperation(
  sanitized: string | undefined,
): string | undefined {
  if (sanitized === undefined || sanitized === UNPARSED_STATEMENT)
    return undefined;
  const m = FIRST_WORD.exec(sanitized);
  return m?.[1] === undefined ? undefined : m[1].toUpperCase();
}

const IDENT = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|[A-Za-z_][\w$]*)`;
const QUALIFIED = `(${IDENT}(?:\\.${IDENT}){0,2})`;
const TARGETS: Readonly<Record<string, RegExp>> = {
  SELECT: new RegExp(`\\bFROM\\s+${QUALIFIED}`, "i"),
  DELETE: new RegExp(`^\\s*DELETE\\s+FROM\\s+${QUALIFIED}`, "i"),
  INSERT: new RegExp(`^\\s*INSERT\\s+(?:IGNORE\\s+)?INTO\\s+${QUALIFIED}`, "i"),
  UPDATE: new RegExp(`^\\s*UPDATE\\s+${QUALIFIED}`, "i"),
};
const SEVERAL_SOURCES =
  /\bJOIN\b|\bFROM\s+[^\s,()]+(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s*,/i;
const SECOND_SELECT = /\bSELECT\b[\s\S]*\bSELECT\b/i;

/**
 * The one table a simple statement works on (`db.collection.name`), or `undefined` when it is
 * not cheaply and unambiguously known (joins, several sources, subqueries, other operations).
 */
export function sqlTarget(
  sanitized: string | undefined,
  operation: string | undefined,
): string | undefined {
  if (sanitized === undefined || operation === undefined) return undefined;
  const pattern = TARGETS[operation];
  if (pattern === undefined) return undefined;
  if (SEVERAL_SOURCES.test(sanitized) || SECOND_SELECT.test(sanitized))
    return undefined;
  const m = pattern.exec(sanitized);
  return m?.[1];
}
