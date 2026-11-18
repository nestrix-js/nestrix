# Errors

How Nestrix records exceptions, which of them count as errors, and how to report an error your app handled itself. The same rules apply in the embedded dashboard, the standalone server and the MCP tools.

## What is recorded

- **Level 1.** The first exception a handler or a pipe throws is recorded on the request's server span. Guards and middleware run before Nestrix's interceptor, so their exceptions are not seen there; report them from your exception filter (below).
- **Level 2.** A method span records the exception that leaves its method, so a service's error is recorded on the service span, then again on the controller's span and on the server span as it travels up.
- Jobs, RPC handlers, outgoing calls and `withSpan` record theirs on their own spans.

## One error, one occurrence

An error object is counted once per trace, on the deepest span that recorded it. When the same object is recorded again as it travels up (the parent span, the controller's span, the server span or a job's root), that event carries `nestrix.exception.propagated = true`: it stays in the trace view as context, and the error list, the error groups and the MCP `list_errors` tool do not count it again. A request whose handler throws once is one occurrence, with method spans on or off. Two different errors in one trace stay two, and so does one shared error object thrown from two sibling spans. An exception that was expected where it was first recorded (a `NotFoundException` caught in a job) does not hide the failure it causes higher up. For BullMQ, whose "job failed" event carries only the message, each job attempt is matched on its own, so a retry or a second job with the same message in the same trace counts again. `recordError(new AppError("...", { cause: error }))` with an `error` already recorded in the trace adds no occurrence.

Spans from SDKs that do not set the mark (an older Nestrix, other instrumentations) get the same result when a span and its direct child carry the same exception (same type, message and stack trace): only the child is counted.

A span holds at most one occurrence: the first exception on it that is neither propagated nor expected. A span with error status and no exception event at all (a 5xx answered without a throw, a failed outgoing call) is an occurrence too.

## Expected exceptions (4xx)

An exception that maps to a status below 500 (`NotFoundException`, `BadRequestException`, `ForbiddenException`, any `HttpException` below 500) is an answer, not a defect. It is still recorded on its span and shown in the trace view, marked `nestrix.exception.expected = true`, but it is not an occurrence: it creates no error group and is not in the error list. Route error rates and SLOs are unchanged by this: they follow the response status, and a 4xx was never an error there.

The `errors.expected` option changes the rule:

```ts
NestrixModule.forRoot({
  errors: {
    // Also expected: your own domain errors (subclasses too), by class, name or RegExp.
    expected: [OutOfStockError, "PaymentDeclinedError", /^Validation/],
  },
});

// Or decide per exception: true expected, false not, undefined the default rule.
NestrixModule.forRoot({
  errors: { expected: (e) => (e instanceof ConflictException ? false : undefined) },
});

// Or count every recorded exception again, 4xx included.
NestrixModule.forRoot({ errors: { expected: false } });
```

An exception counts as an occurrence only on a span with error status. With method spans on, a method that throws always has error status, so `expected: false` brings a thrown 404 back as an occurrence there; at level 1 only, the server span of a 404 has no error status and stays out. A failed job attempt, a job's or a scheduled tick's own method and an uncaught exception are never expected, whatever their status. Pass classes in an array: a bare class (`expected: NotFoundException`) is rejected at startup, as is an arrow function inside the array. The rule is applied in the app, and the standalone server honours the mark. With several Nestrix apps in one process, the first app's rule applies.

## Reporting handled errors: `recordError`

```ts
import { recordError } from "@nestrix-js/nestjs";

recordError(error, attributes?, options?);
```

It records `error` on the local root span of the current trace (the request's server span, the job's or the scheduled tick's root, the RPC handler's span) with `exception.escaped = false` and your `attributes` (strings, numbers, booleans and arrays of them; `exception.*` and `nestrix.exception.*` keys are ignored). When that span has ended, it records on the active span; outside any span it starts a short span named `recordError` so the error is not lost. By default it also sets error status on that span, unless the exception is expected; pass `{ fail: false }` to keep the span's status, or `{ fail: true }` to fail it anyway. On a request's span a failed report counts as a failed request in route statistics.

It never throws, it counts an error object once per trace (when a method span or the interceptor already recorded the same object, it adds only a propagated mark), and it does nothing while Nestrix is disabled.

### From a global exception filter

D-14 rules out a global exception filter in Nestrix, so the errors only a filter sees (guards, middleware, anything thrown before the interceptor) are reported by your own filter:

```ts
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { recordError } from "@nestrix-js/nestjs";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly host: HttpAdapterHost) {}

  catch(exception: unknown, args: ArgumentsHost): void {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500) recordError(exception, { "app.error_code": "E_INTERNAL" });
    const response = args.switchToHttp().getResponse();
    this.host.httpAdapter.reply(response, { statusCode: status }, status);
  }
}
```

Register it with `{ provide: APP_FILTER, useClass: AllExceptionsFilter }`. A guard's error then appears once in the error groups with its type and message; a handler's error, already recorded by the interceptor or a method span, is not counted twice.

### From a job

```ts
@Processor("orders")
export class OrdersProcessor extends WorkerHost {
  async process(job: Job): Promise<void> {
    try {
      await this.payments.charge(job.data);
    } catch (error) {
      recordError(error, { "job.id": String(job.id) });
      throw error; // or retry later
    }
  }
}
```

The error lands in the job's trace and in its error group once.

## Finding traces with errors

A trace's `error` marker is the root's own outcome (the request failed). **Has errors** (`hasErrors` in the query API) is wider: any span of the trace failed, for example a job whose processor threw, or an error recorded on a child span while the request answered 200. The request list shows such a trace with an "errors inside" marker, and the Errors filter (Has errors, No errors) narrows the list to it; `GET api/v1/traces?hasErrors=true` and the MCP `find_traces` tool's `hasErrors` do the same. The status filter (`status=error`) still matches the root only. A span whose exceptions are all expected does not count. A dashboard or server from before this filter answers 400 to it; the request list and the MCP tool then say it is too old.
