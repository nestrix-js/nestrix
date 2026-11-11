/**
 * `http.server.request.duration` (P6-02, D-66): recorded by the HTTP request hook at the raw
 * response's `close`, for every request that has a server-span state, recording or not (D-35),
 * so it is right at any sample rate and under a host-owned sampler.
 *
 * Attributes: `http.request.method` (`_OTHER` outside the conventions' list, as on the span),
 * `url.scheme`, `http.route` when a handler matched (the 404 rule of http/server.ts already applied),
 * `http.response.status_code` when a response was sent, and `error.type` on the same outcome
 * rule as the span's error status. The attribute object is the only allocation per request, and
 * there is none while no real `MeterProvider` is registered.
 *
 * Imports `@opentelemetry/api` only (AGENTS.md rule 5). `record` never throws.
 */
import type { Attributes } from "@opentelemetry/api";
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_SCHEME,
} from "@opentelemetry/semantic-conventions";
import type { Diagnostics } from "../diagnostics.js";
import type { RequestState } from "../http/request-state.js";
import type { MeterBinding } from "./binding.js";

export class HttpRequestMetrics {
  constructor(
    private readonly binding: MeterBinding,
    private readonly diagnostics: Diagnostics,
  ) {}

  /**
   * Records one finished request. `status` is the status sent (undefined when nothing was sent);
   * `route` is the matched route template or undefined. Never throws.
   */
  record(
    state: RequestState,
    status: number | undefined,
    route: string | undefined,
  ): void {
    try {
      const histogram = this.binding.requestDuration();
      if (histogram === undefined) return;
      const startedAt = state.startedAt;
      if (startedAt === undefined || startedAt === 0) return;
      const seconds = Math.max(0, performance.now() - startedAt) / 1000;
      const attributes: Attributes = {
        [ATTR_HTTP_REQUEST_METHOD]:
          state.baseName === "HTTP" ? "_OTHER" : state.method,
      };
      if (state.scheme !== undefined)
        attributes[ATTR_URL_SCHEME] = state.scheme;
      if (route !== undefined) attributes[ATTR_HTTP_ROUTE] = route;
      if (status !== undefined) {
        attributes[ATTR_HTTP_RESPONSE_STATUS_CODE] = status;
      }
      const exception = state.exception;
      const exceptionIsError =
        exception !== undefined && exception.status >= 500;
      const isError = status !== undefined ? status >= 500 : exceptionIsError;
      if (isError) {
        attributes[ATTR_ERROR_TYPE] = exceptionIsError
          ? (exception as { type: string }).type
          : String(status);
      }
      histogram.record(seconds, attributes);
    } catch (error) {
      this.diagnostics.countFailure("metrics.http-record", error);
    }
  }
}
