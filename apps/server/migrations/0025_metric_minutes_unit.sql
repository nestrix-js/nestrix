-- Application metrics (issue #87, D-118): with NESTRIX_METRICS=all, metrics of any name are stored in
-- metric_minutes beside the runtime catalog, with the unit they declared. `unit` is that unit ('' when
-- the metric declared none); NULL for the catalog's metrics, whose unit is the catalog's, and for every
-- row written before this migration. Additive (D-109): nullable, no default, so adding it rewrites
-- nothing, and the previous release's upsert, which does not name it, keeps working.
ALTER TABLE metric_minutes ADD COLUMN IF NOT EXISTS unit text;
