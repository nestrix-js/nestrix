# FAQ

## Can I use it with Sentry?

Yes, side by side. But with Sentry's defaults `@sentry/node` registers no OpenTelemetry provider, so each tool starts its own trace: a request has two traces, and an outgoing call carries both Nestrix's `traceparent` and Sentry's `sentry-trace` and `baggage` headers on different trace ids. Sentry does not continue an incoming `traceparent`.

For one trace, use `Sentry.init({ dsn, defaultIntegrations: false, integrations: [Sentry.openTelemetryIntegration()] })` after Nestrix has registered its provider. The cost is that Sentry loses its default integrations (uncaught exception and unhandled rejection capture, `linkedErrors`, `dedupe`, `contextLines`, `localVariables`, breadcrumbs and others), so add back the ones you need. This was tested in a spike with Express, an ESM host and `@sentry/node` 11.11, not in the package itself. `enableOpenTelemetrySetup: true` is not supported.

Sentry's transport does not mark its requests as untraced, so an error event sent from inside a failing request would become a child span carrying `traceparent`. Add your Sentry ingest host to `ignore.outgoing`:

```ts
ignore: { outgoing: ["https://o123.ingest.sentry.io/"] }
```

## Why does npm stop with `ERESOLVE`? (OpenTelemetry SDK 2)

Nestrix supports OpenTelemetry JS SDK 3 and `@opentelemetry/api` 1.10 only. Its peer range is `>=1.10.0 <1.11.0`, so a host on API 1.9.x makes npm stop:

```text
npm error ERESOLVE unable to resolve dependency tree
npm error peer @opentelemetry/api@">=1.10.0 <1.11.0" from @nestrix/nestjs
```

Upgrade the host's OpenTelemetry packages to SDK 3 and API 1.10. Do not use `--legacy-peer-deps` or `--force`: a second API copy fails silently in both directions, because a copy of another minor version can neither read nor write the global the first one registered, so spans are recorded nowhere. pnpm only warns for the same mismatch; the problem is the same.

## Why are there no method spans in my tests?

`@nestjs/testing` is not supported for method spans: Nest gives `Test.createTestingModule` no `instrument` option and offers no public way to decorate instances there. HTTP spans still work. Run an e2e test with `NestFactory.create` if you need method spans.

## Does it use a `Proxy` or need preload flags?

No. Method wrappers copy reflect-metadata, own properties, `name` and `length`, so a method-level `@UseGuards` keeps applying and `this` stays the real instance. There is no `--require`, `--import` or loader flag to add to `node`, no patching of Nest internals and no global exception filter. Nestrix registers its OpenTelemetry globals during `NestFactory.create`, never at import time. If you start your own SDK in `main.ts`, start it before `NestFactory.create`.

## What do I do if my app already runs an OpenTelemetry SDK?

Nestrix then creates no SDK and its spans go through yours. `serviceName`, `resourceAttributes`, `sampleRate` and every `export.*` option are ignored (they are your SDK's), and `redact` does not apply to what your exporters send. Add `nestrixSpanProcessor()` to your provider to feed the dashboard. Your SDK must be SDK 3.

## Does it work next to another APM?

Nest's request hook is a single slot with no getter, so two tools that install it replace each other. Tools that use only the OpenTelemetry API or diagnostics channels are fine.

## Privacy

By default Nestrix records no request or response bodies, no query bind parameters and no headers outside an allowlist.

- **Request headers recorded:** `content-type`, `content-length`, `x-request-id`. `user-agent` goes to `user_agent.original`.
- **Response headers recorded:** `content-type`, `content-length`.
- **Always `REDACTED`, even if you list them:** `authorization`, `proxy-authorization`, `cookie`, `set-cookie`.
- **Query values replaced by `REDACTED`** for these keys, case-insensitive: `AWSAccessKeyId`, `Signature`, `sig`, `X-Goog-Signature`, `token`, `access_token`, `refresh_token`, `id_token`, `api_key`, `apikey`, `key`, `password`, `passwd`, `secret`, `client_secret`, `code`, `session`, `sessionid`, `jwt`, `auth`, `authorization`.
- **Database statements** have literals replaced by `?`; bind parameters are never recorded. Redis spans record the command and first argument, never values.
- **Server spans** carry no `client.address`. The user id (`user.id`) is off unless you set `user`.
- `url.full` on outgoing requests has credentials removed and the same query keys redacted.

`http.requestHeaders`, `http.responseHeaders` and `http.redactQueryKeys` add to these lists. Key-based redaction cannot clean free text: exception messages and status messages are stored as they are, so use the [`redact` hook](/reference/configuration#redact) for those.

Nothing is sent anywhere unless you set an OTLP endpoint. The embedded dashboard keeps its data in memory and writes nothing to disk.
