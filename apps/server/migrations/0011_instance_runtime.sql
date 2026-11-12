-- Latest runtime figures per instance, from the optional `runtimeSample` of the remote-profiling
-- check-in (docs/backlog/phase-15.md P15-03, D-80). Every check-in overwrites them, NULL when it
-- carried none (an older SDK) or a figure was invalid (src/profiler/parse.ts), so a stale figure is
-- never shown. `runtime_sampled_at` is the server's time of that check-in. Existing rows get NULL.
ALTER TABLE instances
  ADD COLUMN cpu_percent double precision,
  ADD COLUMN event_loop_p99_ms double precision,
  ADD COLUMN heap_used_bytes double precision,
  ADD COLUMN rss_bytes double precision,
  ADD COLUMN runtime_sampled_at timestamptz;
