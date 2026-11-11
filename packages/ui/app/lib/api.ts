import type {
  ApiError,
  ErrorListResponse,
  MetaResponse,
  RouteStatsResponse,
  TraceListResponse,
  TraceResponse,
} from "@nestrix/protocol";

import { readConfig } from "@/lib/config";

export type QueryParams = Record<string, string | number | undefined>;

/** A non-2xx answer from the query API (or a body that is not JSON). */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

/** `<base href>` + `apiBase` + endpoint, with the defined parameters in the query string. */
export function apiUrl(
  endpoint: string,
  params: QueryParams = {},
  apiBase = readConfig().apiBase,
  baseUri = document.baseURI,
): URL {
  const url = new URL(`${apiBase}${endpoint}`, baseUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "")
      url.searchParams.set(key, String(value));
  }
  return url;
}

async function getJson<T>(endpoint: string, params?: QueryParams): Promise<T> {
  const response = await fetch(apiUrl(endpoint, params), {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiRequestError(
      response.status,
      "bad_response",
      `HTTP ${response.status}`,
    );
  }
  if (!response.ok) {
    const error = (body as Partial<ApiError> | null)?.error;
    throw new ApiRequestError(
      response.status,
      error?.code ?? "unknown",
      error?.message ?? `HTTP ${response.status}`,
    );
  }
  return body as T;
}

export const getMeta = () => getJson<MetaResponse>("meta");
export const getTraces = (params: QueryParams) =>
  getJson<TraceListResponse>("traces", params);
export const getErrors = (params: QueryParams) =>
  getJson<ErrorListResponse>("errors", params);
export const getRoutes = (params: QueryParams = {}) =>
  getJson<RouteStatsResponse>("routes", params);
export const getTrace = (id: string) => getJson<TraceResponse>("trace", { id });
