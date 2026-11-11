# Security model

The dashboard is closed unless something positive opens it, and its API never emits CORS headers. There are two ways to open it: `ui: 'auto'` for development, and `ui: { enabled: true, auth }` for everything else.

## Local-only default (`ui: 'auto'`)

`ui` defaults to `'auto'`, so installing `@nestrix/ui` is enough in development. The dashboard is served only while all of these hold:

- `NODE_ENV` is `development` or unset. Any other value, an empty string included, turns it off for the whole run, and Nestrix logs one line saying so.
- The request's socket peer is loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x.y.z`), its `Host` header names a loopback host, and none of `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP` and `Via` is present. Nestrix reads the raw socket and raw headers, never `req.ip` or `req.hostname`, which follow client-supplied headers when your app trusts proxies.
- The request carries the startup token cookie.

A request that fails any other check gets a bare `404` with an empty body. A loopback request without the cookie gets a `403` page telling you to open the link from the log.

## Startup token

When the app starts listening, Nestrix logs a link with a fresh random token. Opening it (from loopback only) sets an `HttpOnly`, `SameSite=Strict` session cookie scoped to the dashboard path, named `nestrix_session_<port>`, and redirects without the token in the address bar. Each start makes a new token.

**Why it exists.** The loopback checks cannot tell a browser on your machine from a reverse proxy on the same host. nginx's usual `proxy_pass http://127.0.0.1:3000` adds no forwarding header and rewrites `Host`, so every request through it looks local. With `NODE_ENV` unset, that would put the dashboard on the internet. The proxy's visitors do not have the token, so with it the dashboard stays closed. Set `NODE_ENV` in deployed environments anyway.

`ui: { startupToken: false }` drops the check. Use it only when the app is never behind a proxy on its own host, or when `NODE_ENV` is always set.

## Authentication for everything else

```ts
NestrixModule.forRoot({
  ui: {
    enabled: true,
    auth: { token: process.env.NESTRIX_UI_TOKEN ?? "" }, // at least 32 characters
  },
});
```

With `enabled: true` the dashboard is served in any environment to requests that pass `auth`, and to nobody else. There is no loopback or `NODE_ENV` check. `enabled: true` without `auth` leaves the dashboard off, logs an error and starts the app. So does any invalid `ui` value: unlike other options, `ui` never throws at startup.

**`auth: { token }`.** At least 32 characters (`openssl rand -base64 32`), compared in constant time. Tools send `Authorization: Bearer <token>`. Browsers open `https://your-host/_nestrix/auth?token=<token>` once and get a session cookie (`HttpOnly`, `SameSite=Strict`, `Secure` unless the request came from loopback). That link puts the token in the URL, so it lands in proxy logs and browser history: prefer the header for tools, and rotate the token if it leaked.

**`auth: { authorize(request) }`.** Called for every dashboard request with the raw adapter request, **before any Nest guard has run**, so `request.user` is not populated: read the headers or cookies yourself. Only `true` allows. A throw, a rejection, any other value or no answer within 10 seconds denies.

```ts
auth: {
  authorize: async (request) => {
    const { headers } = request as { headers: IncomingHttpHeaders };
    return isOperator(headers.authorization);
  },
},
```

With `enabled: 'auto'` and an `auth`, both apply: the local-only rules, the startup token and `auth`.

Every mode that serves the dashboard also rejects requests with `Sec-Fetch-Site: cross-site`. A denied request always gets the bare `404`.

## No CORS

The dashboard never sends CORS allow headers, whatever your CORS setup, and removes any `Access-Control-*` header a host layer added. Preflight requests are answered by your CORS layer, not Nestrix. A page on another origin could send a request but could not read the answer, and in `'auto'` mode the cookie is `SameSite=Strict`. The API is read-only, so this is a known limit and not a hole.

## Where it sits

The dashboard's routes are registered with the HTTP adapter's own `get`, so they sit **outside the global prefix, URI versioning, guards, pipes and interceptors**. Host middleware, `helmet`, `compression` and `enableCors()` still apply. The dashboard sets its own `Content-Security-Policy` and other security headers, replacing the host's values.

## What is not there yet

There is no profiler. A profiler would need its own protection (it reads more than spans), and none is shipped.

## What the dashboard exposes

Only what is stored, after redaction: no request or response bodies, no bind parameters, no unlisted headers. See [Privacy](/faq#privacy).
