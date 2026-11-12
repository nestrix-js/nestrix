---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

Standalone server: browser sign-in works again. The login page's `no-referrer` policy made browsers send `Origin: null` with the form, which the origin check refused, so every browser sign-in got 403. Pages now use `Referrer-Policy: same-origin`, and a missing or `null` Origin is accepted only with `Sec-Fetch-Site: same-origin`; cross-site and same-site requests stay refused. A Playwright test now submits the real login form.
