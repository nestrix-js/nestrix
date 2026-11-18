---
"@nestrix-js/mcp": minor
---

Behaviour change: `@nestrix-js/mcp` now refuses to start when `NESTRIX_URL` is `http://` to a host that is not loopback (`localhost`, `127.0.0.0/8`, `::1`), because `NESTRIX_TOKEN` would be sent as a bearer over plaintext. Use `https://`, or set `NESTRIX_ALLOW_INSECURE_HTTP=1` to keep the old behaviour (a warning on stderr) on a network you trust.
