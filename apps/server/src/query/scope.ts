/**
 * The data scope of a query (issue #28, D-101): one service or every one, and one environment or
 * every one. Every query that filtered by `service_name` filters through `scopeSql`, so the two
 * filters always travel together.
 *
 * Environment values, as the API takes them (`environment=` beside `service=`):
 * - absent: every environment (the behaviour before environments existed, D-101);
 * - `unset`: rows without an environment (`environment IS NULL`), which includes every row stored
 *   before migration 0016;
 * - any other value: that environment.
 *
 * The ingest never stores `unset` as a name (`environmentOf` in `src/storage/derive.ts` turns it
 * into `NULL`), so the value cannot mean two things.
 */
import { UNSET_ENVIRONMENT } from "../storage/derive.js";

export { UNSET_ENVIRONMENT };

export interface Scope {
  /** `service.name`; `undefined` is every service. */
  readonly service?: string | undefined;
  /** `undefined` is every environment, `unset` the rows without one. */
  readonly environment?: string | undefined;
}

/** Every service, every environment. */
export const ALL: Scope = Object.freeze({});

/** Adds a bound parameter and returns its placeholder (`$n`). */
export type AddParam = (value: unknown) => string;

/** `scope` from parsed query values (`service`, `environment`; an empty string is no filter). */
export function scopeOf(values: {
  readonly service?: unknown;
  readonly environment?: unknown;
}): Scope {
  return {
    service: typeof values.service === "string" ? values.service : undefined,
    environment:
      typeof values.environment === "string" ? values.environment : undefined,
  };
}

/**
 * The SQL condition for an environment value on `column` (`environment`, `t.environment`), or
 * `undefined` for every environment.
 */
export function environmentSql(
  environment: string | null | undefined,
  add: AddParam,
  column = "environment",
): string | undefined {
  if (environment === undefined || environment === null) return undefined;
  if (environment === UNSET_ENVIRONMENT) return `${column} IS NULL`;
  return `${column} = ${add(environment)}`;
}

/**
 * The `WHERE` conditions of `scope` on a table aliased `alias` (`""` for none): `service_name = $n`
 * and the environment's condition, each only when given. Push them onto the query's conditions:
 * `where.push(...scopeSql(scope, params.add, "s"))`.
 *
 * `columns` names the columns when a table calls them otherwise (`instances` has `service`).
 */
export function scopeSql(
  scope: Scope,
  add: AddParam,
  alias = "",
  columns: { service: string; environment: string } = {
    service: "service_name",
    environment: "environment",
  },
): string[] {
  const prefix = alias === "" ? "" : `${alias}.`;
  const out: string[] = [];
  if (scope.service !== undefined) {
    out.push(`${prefix}${columns.service} = ${add(scope.service)}`);
  }
  const env = environmentSql(
    scope.environment,
    add,
    `${prefix}${columns.environment}`,
  );
  if (env !== undefined) out.push(env);
  return out;
}

/** `scopeSql` joined with `AND`, as `WHERE …` (or `""` when the scope is everything). */
export function scopeWhere(scope: Scope, add: AddParam, alias = ""): string {
  const conditions = scopeSql(scope, add, alias);
  return conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
}

/** Whether a stored environment (`null` unset) is inside the scope's environment. */
export function environmentMatches(
  scopeEnvironment: string | null | undefined,
  stored: string | null,
): boolean {
  if (scopeEnvironment === undefined || scopeEnvironment === null) return true;
  if (scopeEnvironment === UNSET_ENVIRONMENT) return stored === null;
  return stored === scopeEnvironment;
}

/** A positional-parameter adder over a plain array (`values.push`), for statements built without `Params`. */
export function adder(values: unknown[]): AddParam {
  return (value) => {
    values.push(value);
    return `$${values.length}`;
  };
}
