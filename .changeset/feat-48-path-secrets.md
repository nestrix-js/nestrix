---
"@nestrix-js/nestjs": minor
---

Keep secrets in URL path segments out of exported spans (#48). The values of route parameters named `token`, `access_token`, `refresh_token`, `id_token`, `api_key`, `apikey`, `password`, `passwd`, `secret`, `client_secret`, `signature`, `sig`, `jwt`, `session` or `sessionid` are now written as `REDACTED` in the server span's `url.path` by default: a request to `/invitations/abc123` on the route `/invitations/:token` records `/invitations/REDACTED`. `http.redactPathParams` adds names to that list. `http.recordPath: 'template'` records the matched route template as `url.path` instead (no `url.path` for a request that matched no route); the default stays `'raw'`, and `ignore.paths` always matches the raw path. `http.redactOutgoingPath` takes path patterns (`'/v1/invitations/:token'`, optionally after an origin) or regular expressions whose matching segments are written as `REDACTED` in outgoing requests' `url.full`.
