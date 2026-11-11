import type { ErrorListResponse } from "../src/index.js";

export const errorList = {
  head: "e.1794400000180.e457b5a2e4d86bd1",
  older: null,
  reset: false,
  items: [
    {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      spanName: "GET /orders/:id",
      spanKind: "server",
      route: "/orders/:id",
      method: "GET",
      statusCode: 500,
      errorType: "BadGatewayException",
      message: "Payments service unavailable",
      timeUnixMs: 1_794_400_000_180.1,
      cursor: "e.1794400000180.e457b5a2e4d86bd1",
    },
    {
      traceId: "6e0c63257de34c926f9efcd91d0ed2b8",
      spanId: "3a9f0c4d8b17e256",
      spanName: "PaymentsClient.refund",
      spanKind: "internal",
      errorType: "TimeoutError",
      message: "refund timed out after 2000ms",
      timeUnixMs: 1_794_399_981_900.4,
      cursor: "e.1794399981900.3a9f0c4d8b17e256",
    },
  ],
} satisfies ErrorListResponse;
