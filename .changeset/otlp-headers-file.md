---
"@nestrix-js/nestjs": minor
---

OTLP headers can come from a secret file (#62, D-111). `OTEL_EXPORTER_OTLP_HEADERS_FILE`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS_FILE`, `OTEL_EXPORTER_OTLP_LOGS_HEADERS_FILE` and `OTEL_EXPORTER_OTLP_METRICS_HEADERS_FILE` name a file (a Docker or Kubernetes secret) whose trimmed content is used as the matching headers variable, in the same `key=value,...` format, read once at startup. The variable itself wins when both are set, and `export.otlp.headers` still wins over both, key by key. A missing, unreadable or empty file logs one error (never its content) and Nestrix exports without those headers; the app still starts.
