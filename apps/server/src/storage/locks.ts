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
