/**
 * Postgres advisory lock keys, two-int form `(class, id)`. The class is "NSTX" in ASCII so
 * the keys do not collide with another application's locks in a shared database.
 */
export const ADVISORY_CLASS = 0x4e535458;
/** Session lock around the migration run. */
export const MIGRATION_LOCK = 1;
/** Session lock around partition creation and retention. */
export const MAINTENANCE_LOCK = 2;
/** Transaction lock around the `traces` upsert (read-merge-write of summary rows). */
export const TRACES_LOCK = 3;
/** Session lock around one alert evaluation run (only one server instance evaluates at a time). */
export const ALERTS_LOCK = 4;
/**
 * Class of the per-trace transaction locks around a log insert (P9-07): `(LOGS_LOCK_CLASS,
 * hashtext(trace_id))`, so the per-trace cap holds across concurrent writers. "NSTL" in ASCII.
 */
export const LOGS_LOCK_CLASS = 0x4e53544c;
