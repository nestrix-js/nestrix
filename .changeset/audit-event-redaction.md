---
"@nestrix-js/nestjs": patch
---

Nestrix's built-in redaction now also runs on the attributes of span events, not only the span's own (D-111). An event that carries an always-redacted header (`http.request.header.authorization`, `cookie`, `proxy-authorization`, `set-cookie`), a listed query key in `url.query` or `url.full`, or credentials in `url.full` (for example from `recordError(error, attributes)` or `span.addEvent`) is masked before it reaches the dashboard store or the Nestrix-owned OTLP export, and before your `redact` hook, which still sees and can change the event's attributes. Previously such values were stored and exported as given unless a `redact` hook removed them.
