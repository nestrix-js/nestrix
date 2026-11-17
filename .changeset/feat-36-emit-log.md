---
"@nestrix-js/nestjs": minor
---

Add `emitLog({ level, message, context?, error?, attributes? })`: an application's own logger (a `ConsoleLogger` subclass, a pino destination) can now send its already-redacted lines through the same path as `NestrixLogger`: to `/v1/logs` with the active span's trace and span id when `logs.export` is on, and next to their trace in the dashboard. It never throws, and with Nestrix disabled it returns without reading the record. `NestrixLogger` now uses the same path, with no change in behaviour.
