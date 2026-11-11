# Install size

`pnpm pack` of @nestrix/nestjs, installed with `npm install --omit=dev` into a fresh directory (darwin-arm64, Node v26.13.0, npm 11.20.0). Sizes are `du -sk` (disk blocks, KiB).

- Tarball: 44 KiB; unpacked package: 264 KiB.
- Host stack alone (@nestjs/common, core, platform-express, reflect-metadata, rxjs): 21656 KiB (21.1 MB).
- Host stack plus @nestrix/nestjs: 41272 KiB (40.3 MB).
- **Added by Nestrix: 19616 KiB (19.2 MB)**, of which packages not in the host stack sum to 19608 KiB.
- Peer dependencies the host must supply (@opentelemetry/api) are among the added packages when the host does not already have them.

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
| @nestrix/nestjs | 0.0.0 | 264 KiB |
| @opentelemetry/exporter-trace-otlp-http | 0.301.1 | 156 KiB |
| @opentelemetry/context-async-hooks | 3.1.1 | 120 KiB |

Top-level packages with a different size once Nestrix is installed (shared dependencies resolved differently): none (KiB delta).
