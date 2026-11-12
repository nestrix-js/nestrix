import type {
  ApiError,
  AppMapResponse,
  ClassStatsResponse,
  ErrorListResponse,
  MetaResponse,
  ProfileDetail,
  ProfileListResponse,
  ProfileStartRequest,
  ProfileStartResponse,
  QueryStatsResponse,
  RouteStatsResponse,
  Slo,
  SloCreate,
  SloListResponse,
  SloUpdate,
  TraceListResponse,
  TraceResponse,
} from "@nestrix-js/protocol";

import { readConfig } from "@/lib/config";

export type QueryParams = Record<string, string | number | undefined>;

/** A non-2xx answer from the query API (or a body that is not JSON). */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  /** From a `429` problem body (`ProfileCooldownError`). */
  readonly retryAfterSeconds: number | undefined;
  constructor(
    status: number,
    code: string,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
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

let knownMode: MetaResponse["mode"] | undefined;

/** A path next to `<base href>`, such as `login` or `logout`. */
export const baseUrl = (path: string, baseUri = document.baseURI) =>
  new URL(path, baseUri);

/** Sends the browser to the standalone server's login page. */
export function goToLogin(): void {
  window.location.assign(baseUrl("login").href);
}

/** Whether a 401 means "log in": always, unless the API is known to be the embedded one. */
export const shouldLogin = (
  status: number,
  mode: MetaResponse["mode"] | undefined,
) => status === 401 && mode !== "embedded";

async function getJson<T>(endpoint: string, params?: QueryParams): Promise<T> {
  return requestJson<T>("GET", endpoint, params);
}

/**
 * One call to the API. A write sends JSON; the browser adds the same-origin `Origin` header the
 * standalone server requires for it. A 204 answers `undefined`.
 */
async function requestJson<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  endpoint: string,
  params?: QueryParams,
  body?: unknown,
): Promise<T> {
  const response = await fetch(apiUrl(endpoint, params), {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (shouldLogin(response.status, knownMode)) goToLogin();
  if (response.status === 204) return undefined as T;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiRequestError(
      response.status,
      "bad_response",
      `HTTP ${response.status}`,
    );
  }
  if (!response.ok) {
    const error = (parsed as Partial<ApiError> | null)?.error;
    const retry = (parsed as { retryAfterSeconds?: unknown } | null)
      ?.retryAfterSeconds;
    throw new ApiRequestError(
      response.status,
      error?.code ?? "unknown",
      error?.message ?? `HTTP ${response.status}`,
      typeof retry === "number" && Number.isFinite(retry) ? retry : undefined,
    );
  }
  return parsed as T;
}

export async function getMeta(): Promise<MetaResponse> {
  const meta = await getJson<MetaResponse>("meta");
  knownMode = meta.mode;
  return meta;
}

/** Ends the admin session (the server clears the cookie), then shows the login page. */
export async function signOut(): Promise<void> {
  try {
    await fetch(baseUrl("logout"), {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    // Go to the login page anyway; it shows whether the session is still open.
  }
  goToLogin();
}
export const getTraces = (params: QueryParams) =>
  getJson<TraceListResponse>("traces", params);
export const getErrors = (params: QueryParams) =>
  getJson<ErrorListResponse>("errors", params);
export const getRoutes = (params: QueryParams = {}) =>
  getJson<RouteStatsResponse>("routes", params);
export const getTrace = (id: string) => getJson<TraceResponse>("trace", { id });
export const getClasses = (params: QueryParams = {}) =>
  getJson<ClassStatsResponse>("classes", params);
export const getMap = (params: QueryParams = {}) =>
  getJson<AppMapResponse>("map", params);
export const getQueries = (params: QueryParams = {}) =>
  getJson<QueryStatsResponse>("queries", params);

// CPU profiler: the embedded dashboard only, when `meta.profiler.available` (`/api/v1/profiles`).
export const getProfiles = () => getJson<ProfileListResponse>("profiles");
export const getProfile = (id: string) =>
  getJson<ProfileDetail>(`profiles/${encodeURIComponent(id)}`);
/** Starts a capture with `fetch` (the page's CSP has `form-action 'none'`); the browser adds `Origin`. */
export const startProfile = (durationSeconds: number) =>
  requestJson<ProfileStartResponse>("POST", "profiles", undefined, {
    durationSeconds,
  } satisfies ProfileStartRequest);
/** The `.cpuprofile` download, a plain link: the session cookie authenticates it. */
export const profileDownloadUrl = (id: string) =>
  apiUrl(`profiles/${encodeURIComponent(id)}/download`);

// SLOs: the standalone server only (`/api/v1/slos`).
export const getSlos = () => getJson<SloListResponse>("slos");
export const createSlo = (body: SloCreate) =>
  requestJson<Slo>("POST", "slos", undefined, body);
export const updateSlo = (id: string, body: SloUpdate) =>
  requestJson<Slo>("PATCH", `slos/${encodeURIComponent(id)}`, undefined, body);
export const deleteSlo = (id: string) =>
  requestJson<undefined>("DELETE", `slos/${encodeURIComponent(id)}`);
