---
"@nestrix-js/nestjs": minor
---

`state` joins the query-string keys whose values are recorded as `REDACTED` by default (#61). OAuth and OpenID Connect callbacks carry `code` (already redacted) and `state`, which binds the callback to the browser session that started it. Routes that use `?state=` as an ordinary filter now record it as `REDACTED` too; nothing else changes, and `http.redactQueryKeys` still only adds keys.
