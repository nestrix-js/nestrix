# Install size

`pnpm pack` of @nestrix-js/nestjs, installed with `npm install --omit=dev` into a fresh directory (darwin-arm64, Node v26.13.0, npm 11.20.0). Sizes are `du -sk` (disk blocks, KiB).

- Tarball: 176 KiB; unpacked package: 920 KiB.
- Host stack alone (@nestjs/common, core, platform-express, reflect-metadata, rxjs): 21656 KiB (21.1 MB).
- Host stack plus @nestrix-js/nestjs: 41928 KiB (40.9 MB).
- **Added by Nestrix: 20272 KiB (19.8 MB)**, of which packages not in the host stack sum to 20264 KiB.
- `@opentelemetry/api`, a peer dependency, is counted among the added packages because the host stack above does not include it.

Packages added, largest first:

| package | version | size |
| --- | --- | --- |
| @opentelemetry/semantic-conventions | 1.45.0 | 9824 KiB |
| @opentelemetry/api | 1.10.0 | 1932 KiB |
| @opentelemetry/sdk-metrics | 3.1.1 | 1612 KiB |
| @opentelemetry/otlp-transformer | 0.301.1 | 1084 KiB |
| @opentelemetry/sdk-trace | 3.1.1 | 1056 KiB |
| @opentelemetry/core | 3.1.1 | 1048 KiB |
| @opentelemetry/otlp-exporter-base | 0.301.1 | 932 KiB |
| @nestrix-js/nestjs | 0.0.0 | 920 KiB |
| @opentelemetry/resources | 3.1.1 | 880 KiB |
| @opentelemetry/sdk-logs | 3.1.1 | 700 KiB |
| @opentelemetry/exporter-trace-otlp-http | 0.301.1 | 156 KiB |
| @opentelemetry/context-async-hooks | 3.1.1 | 120 KiB |

Top-level packages with a different size once Nestrix is installed (shared dependencies resolved differently): none (KiB delta).
