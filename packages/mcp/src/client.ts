import type {
  AppMapResponse,
  ClassStatsResponse,
  ErrorListResponse,
  MetaResponse,
  ProfileDetail,
  ProfileListResponse,
  ProfileStartResponse,
  RouteStatsResponse,
  TraceListResponse,
  TraceResponse,
} from "@nestrix-js/protocol";
import type { McpConfig } from "./config.js";

/**
 * A failed call to the query API. `message` is written for the model that will read it (and for
 * the person behind it): it says what to check and never contains the token.
 */
export class NestrixError extends Error {
  override name = "NestrixError";
  constructor(
    message: string,
    /** HTTP status; 0 when no response arrived. */
    readonly status: number,
    /** The parsed JSON body, when the answer had one. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export type QueryValue = string | number | undefined;

/** The part of the query API the tools use, over HTTP with `fetch`. */
export class NestrixClient {
  readonly #base: string;
  readonly #origin: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(config: McpConfig, fetchImpl: typeof fetch = fetch) {
    this.#base = config.url;
    this.#origin = new URL(config.url).origin;
    this.#token = config.token;
    this.#timeoutMs = config.timeoutMs;
    this.#fetch = fetchImpl;
  }

  meta(): Promise<MetaResponse> {
    return this.#get("api/v1/meta", {});
  }
  traces(params: Record<string, QueryValue>): Promise<TraceListResponse> {
    return this.#get("api/v1/traces", params);
  }
  trace(id: string): Promise<TraceResponse> {
    return this.#get("api/v1/trace", { id });
  }
  errors(params: Record<string, QueryValue>): Promise<ErrorListResponse> {
    return this.#get("api/v1/errors", params);
  }
  routes(params: Record<string, QueryValue>): Promise<RouteStatsResponse> {
    return this.#get("api/v1/routes", params);
  }
  classes(params: Record<string, QueryValue>): Promise<ClassStatsResponse> {
    return this.#get("api/v1/classes", params);
  }
  map(params: Record<string, QueryValue>): Promise<AppMapResponse> {
    return this.#get("api/v1/map", params);
  }
  profiles(): Promise<ProfileListResponse> {
    return this.#get("api/v1/profiles", {});
  }
  profile(id: string): Promise<ProfileDetail> {
    return this.#get(`api/v1/profiles/${encodeURIComponent(id)}`, {});
  }

  /**
   * Starts a capture. The endpoint accepts only what the dashboard page itself sends: a JSON body,
   * an `Origin` equal to the request's own origin and `Sec-Fetch-Site: same-origin`. This client
   * is the trusted caller (it holds the token), so it sets them.
   */
  async startProfile(durationSeconds: number): Promise<ProfileStartResponse> {
    try {
      return await this.#startProfile(durationSeconds);
    } catch (error) {
      if (error instanceof NestrixError && error.status === 403) {
        const said = apiMessage(error.body);
        throw new NestrixError(
          `${said ? `The app said: ${said}. ` : ""}The app refused to start the capture (HTTP 403). If NESTRIX_TOKEN is right, the cause is usually the request origin: a reverse proxy in front of the app must pass the original Host header, because the endpoint accepts only requests whose Origin equals their own Host.`,
          403,
          error.body,
        );
      }
      throw error;
    }
  }

  #startProfile(durationSeconds: number): Promise<ProfileStartResponse> {
    return this.#request(
      "api/v1/profiles",
      {},
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: this.#origin,
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ durationSeconds }),
      },
    );
  }

  #get<T>(path: string, params: Record<string, QueryValue>): Promise<T> {
    return this.#request(path, params, { method: "GET" });
  }

  async #request<T>(
    path: string,
    params: Record<string, QueryValue>,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<T> {
    const url = new URL(`${this.#base}/${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(url, {
        ...init,
        headers: {
          accept: "application/json",
          ...init.headers,
          authorization: `Bearer ${this.#token}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw this.#networkError(error);
    }
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (response.ok) {
      if (body === undefined || body === null || typeof body !== "object") {
        throw new NestrixError(
          `${this.#base}/${path} answered HTTP ${response.status} but not with JSON: NESTRIX_URL does not look like a Nestrix dashboard or server.`,
          response.status,
        );
      }
      return body as T;
    }
    throw this.#statusError(path, response.status, body);
  }

  #networkError(error: unknown): NestrixError {
    const name = (error as { name?: unknown })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return new NestrixError(
        `No answer from ${this.#origin} within ${this.#timeoutMs} ms. Is the app running and NESTRIX_URL right? (NESTRIX_TIMEOUT_MS raises the limit.)`,
        0,
      );
    }
    // Never use `error.message`: undici can echo request headers (the token) in it.
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
    const code = (error as { code?: unknown } | null)?.code;
    const raw =
      typeof cause?.code === "string"
        ? cause.code
        : typeof code === "string"
          ? code
          : "";
    const why = /^[A-Z0-9_]{1,40}$/.test(raw) ? raw : "network error";
    return new NestrixError(
      `Could not reach ${this.#origin} (${why}). Is the app or server running, and is NESTRIX_URL right?`,
      0,
    );
  }

  #statusError(path: string, status: number, body: unknown): NestrixError {
    const detail = apiMessage(body);
    const suffix = detail ? ` The server said: ${detail}` : "";
    if (status === 401 || status === 403) {
      return new NestrixError(
        `Nestrix refused the request (HTTP ${status}). Check NESTRIX_TOKEN: for an embedded dashboard it must equal the app's ui.auth.token, for the Nestrix server it must be a valid, unrevoked API token.${suffix}`,
        status,
        body,
      );
    }
    if (status === 404 && path === "api/v1/meta") {
      return new NestrixError(
        "NESTRIX_URL is not a Nestrix dashboard or server: GET api/v1/meta answered 404. Use the dashboard's base path (for example http://localhost:3000/_nestrix) or the server's base URL. An embedded dashboard also answers 404 to a wrong NESTRIX_TOKEN, so check the token too, and that the app runs with `ui: { enabled: true, auth: { token } }`.",
        404,
        body,
      );
    }
    if (status === 404) {
      return new NestrixError(
        `Not found: ${path}.${suffix || " This Nestrix version may not support it."}`,
        404,
        body,
      );
    }
    return new NestrixError(
      `Nestrix answered HTTP ${status} for ${path}.${suffix}`,
      status,
      body,
    );
  }
}

/** `error.message` of an `ApiError` body, if it has one. */
export function apiMessage(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}
