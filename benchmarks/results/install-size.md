# Install size

`pnpm pack` of @nestrix/nestjs, installed with `npm install --omit=dev` into a fresh directory (darwin-arm64, Node v26.13.0, npm 11.20.0). Sizes are `du -sk` (disk blocks, KiB).

- Tarball: 88 KiB; unpacked package: 500 KiB.
- Host stack alone (@nestjs/common, core, platform-express, reflect-metadata, rxjs): 21656 KiB (21.1 MB).
- Host stack plus @nestrix/nestjs: 41508 KiB (40.5 MB).
- **Added by Nestrix: 19852 KiB (19.4 MB)**, of which packages not in the host stack sum to 19844 KiB.
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
| @opentelemetry/resources | 3.1.1 | 880 KiB |
| @opentelemetry/sdk-logs | 3.1.1 | 700 KiB |
| @nestrix/nestjs | 0.0.0 | 500 KiB |
| @opentelemetry/exporter-trace-otlp-http | 0.301.1 | 156 KiB |
| @opentelemetry/context-async-hooks | 3.1.1 | 120 KiB |

Top-level packages with a different size once Nestrix is installed (shared dependencies resolved differently): none (KiB delta).
