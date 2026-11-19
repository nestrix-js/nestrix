---
"@nestrix-js/nestjs": patch
---

Standalone server: error triage and the live error list follow the order spans were stored in (D-114), so an error from a long job, a late export or a host with a slow clock is no longer missed by triage (no group, count or `new_error_group` alert) or left out of a live `GET errors` poll. Migrations `0023_spans_ingest_seq.sql` and `0024_spans_ingest_seq_index.sql` add `spans.ingest_seq` and an index on error spans; a rolling upgrade is safe (no coordinated stop). Spans stored before the upgrade keep the old behaviour. Rolling back to 0.8.0 for longer than an hour and then upgrading again counts the errors stored meanwhile twice; see the server README, "Upgrading to ingest order on `spans`", which also has optional steps to pre-build the index on large databases.
