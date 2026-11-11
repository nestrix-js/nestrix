import type { TraceResponse } from "../src/index.js";

/** A GET /orders/:id request: remote parent, guard, handler, a failing client call and an exception event. */
export const trace = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  rootSpanId: "b7ad6b7169203331",
  resource: {
    "service.name": "orders-api",
    "service.version": "1.4.2",
    "deployment.environment.name": "development",
    "process.pid": 41234,
    "telemetry.sdk.language": "nodejs",
  },
  spans: [
    {
      spanId: "b7ad6b7169203331",
      parentSpanId: "00f067aa0ba902b7",
      name: "GET /orders/:id",
      kind: "server",
      startTimeUnixMs: 1_794_400_000_000.25,
      durationMs: 182.4,
      attributes: {
        "http.request.method": "GET",
        "http.route": "/orders/:id",
        "http.response.status_code": 500,
        "url.path": "/orders/42",
        "user_agent.original": "curl/8.9.1",
        "user.id": "u-1842",
      },
      events: [
        {
          name: "exception",
          timeUnixMs: 1_794_400_000_180.1,
          attributes: {
            "exception.type": "BadGatewayException",
            "exception.message": "Payments service unavailable",
            "exception.stacktrace":
              "BadGatewayException: Payments service unavailable\n    at OrdersService.load (orders.service.ts:31:11)",
          },
        },
      ],
      status: { code: "error", message: "Payments service unavailable" },
      links: [],
      scope: "@nestrix/nestjs",
    },
    {
      spanId: "5b8efff798038103",
      parentSpanId: "b7ad6b7169203331",
      name: "guard AuthGuard",
      kind: "internal",
      startTimeUnixMs: 1_794_400_000_001.5,
      durationMs: 3.2,
      attributes: {
        "nestrix.kind": "guard",
        "code.function.name": "AuthGuard.canActivate",
      },
      events: [],
      status: { code: "unset" },
      links: [],
      scope: "@nestrix/nestjs",
    },
    {
      spanId: "e457b5a2e4d86bd1",
      parentSpanId: "b7ad6b7169203331",
      name: "OrdersController.getOrder",
      kind: "internal",
      startTimeUnixMs: 1_794_400_000_005.75,
      durationMs: 175.9,
      attributes: {
        "nestrix.kind": "handler",
        "code.function.name": "OrdersController.getOrder",
      },
      events: [
        {
          name: "exception",
          timeUnixMs: 1_794_400_000_180.0,
          attributes: {
            "exception.type": "BadGatewayException",
            "exception.message": "Payments service unavailable",
          },
        },
      ],
      status: { code: "error", message: "Payments service unavailable" },
      links: [],
      scope: "@nestrix/nestjs",
    },
    {
      spanId: "7ce5f8b3a41d9e60",
      parentSpanId: "e457b5a2e4d86bd1",
      name: "GET",
      kind: "client",
      startTimeUnixMs: 1_794_400_000_020.0,
      durationMs: 150.6,
      attributes: {
        "http.request.method": "GET",
        "url.full": "http://payments.internal/charges/42",
        "server.address": "payments.internal",
        "http.response.status_code": 503,
      },
      events: [],
      status: { code: "error" },
      links: [
        {
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "9a3c1e7d5f20b648",
        },
      ],
      scope: "@opentelemetry/instrumentation-undici",
    },
  ],
} satisfies TraceResponse;
