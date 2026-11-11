# benchmarks

Private workspace package. Performance and reliability numbers for `@nestrix/nestjs` (architecture §4.9). Plain ESM JavaScript, no build step. Run `pnpm build` at the repository root first: the app loads the built `express-esm` and `@nestrix/nestjs`.

```bash
pnpm --filter benchmarks run all        # everything, full length (about 45 minutes with the 10-minute outage runs)
pnpm --filter benchmarks run smoke      # everything, short (a few minutes); results get a -smoke suffix
pnpm --filter benchmarks run bench:throughput   # or bench:baseline | bench:sink | bench:unreachable | bench:blackhole | bench:upstream
pnpm --filter benchmarks run bench:startup
pnpm --filter benchmarks run bench:outage -- --duration=600
pnpm --filter benchmarks run bench:install-size
```

Every script takes `--flag=value` arguments (or `BENCH_<FLAG>` environment variables); the header of each file in `src/` lists them. Useful ones: `--duration`, `--runs`, `--connections`, `--configs=a,b`, and for the outage run `--duration` (seconds), `--sample`, `--settle`, `--rate`, `--variants`.

Results go to `results/<name>.json` (machine readable, with the raw runs and samples) and `results/<name>.md` (short summary). `all` also writes `results/summary.md`.

## What runs

- `src/app.mjs`: the app, one fresh process per run. Routes `GET /hello` and `GET /users/:id` come from `examples/express-esm`'s `AppModule`. Nestrix configurations add `GET /spans`, which creates three spans with `withSpan`; it exists so the export queue is exercised before HTTP server spans exist, and should stay after they do (it adds a known span rate).
- `src/sink.mjs`: the OTLP endpoint stand-in, a separate process. `sink` answers 200; `blackhole` accepts the request and never answers.
- Configurations: `baseline` (no Nestrix), `noexport` (`forRoot()`, no endpoint), `sink`, `unreachable` (closed port), `blackhole`, `upstream` (OpenTelemetry's `auto-instrumentations-node`, loaded with `node --import .../register`).
- `upstream` is installed on first use into `node_modules/.cache/upstream` (network needed), not into the workspace: adding it to the workspace lockfile changed how `@nestjs/microservices` peers resolve in other packages.
- Load: autocannon, in the parent process. Latency is recorded per response at 10 µs resolution (autocannon's own histogram rounds to milliseconds).
- CPU is the app's `process.cpuUsage()` over each route's run; RSS is read from `ps` outside the process.
