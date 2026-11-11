# Compatibility

<!--@include: ../../docs/compatibility.md{3,}-->

## CommonJS apps

- Jest needs `node --experimental-vm-modules node_modules/jest/bin/jest.js`. Vitest works unchanged.
- AWS Lambda disables `require(esm)` on its Node 20, 22 and 24 runtimes; set `NODE_OPTIONS=--experimental-require-module`.
- Upstream `@opentelemetry/instrumentation-*` instances must be constructed after `NestFactory.create`.
- Call `trace.getTracer()` inside the function that creates the span, not at module top level, or the tracer stays a no-op.

## Install size and startup

Measured on one machine (darwin-arm64, Node 26.13, against an Express example): the packed `@nestrix-js/nestjs` tarball is 169 kB; installing it into a Nest host added 19.8 MB on disk including `@opentelemetry/api`; startup added about 33 to 50 ms. `@nestrix-js/ui` adds a 255 kB tarball and no dependencies. Numbers differ on your machine.
