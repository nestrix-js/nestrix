import {
  type SecretDigests,
  secretDigests,
} from "./dashboard/startup-token.js";
import type {
  NestrixModuleOptions,
  NestrixQueueOptions,
  NestrixStoreOptions,
  RedactHook,
  UrlMatcher,
} from "./options.js";
import { parseResourceAttributesEnv } from "./otel/resource-env.js";

/** An OTLP/HTTP destination: `url` is the full traces URL, `/v1/traces` already applied. */
export interface ResolvedOtlp {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMillis: number;
}

/** The `user` option's function type. */
export type NestrixUserFunction = NonNullable<NestrixModuleOptions["user"]>;

/** Every option with its default applied. Deeply frozen. */
export interface ResolvedOptions {
  /** `false` only when `NestrixModule.forRootAsync`'s factory returned `enabled: false`. */
  readonly enabled: boolean;
  readonly serviceName: string | undefined;
  /** `service.version` after the D-63 chain (`resolveServiceVersion`); `undefined` when nothing sets it. */
  readonly serviceVersion: string | undefined;
  /** The `user` option (P3-03), checked to be a function; `undefined` when off. */
  readonly user: NestrixUserFunction | undefined;
  readonly resourceAttributes: Readonly<
    Record<string, string | number | boolean>
  >;
  readonly sampleRate: number;
  readonly export: {
    /** `false` when export is off: `otlp: false`, or no endpoint by option or environment. */
    readonly otlp: ResolvedOtlp | false;
    readonly queue: {
      readonly maxQueueSize: number;
      readonly maxExportBatchSize: number;
      readonly scheduledDelayMillis: number;
    };
  };
  readonly ignore: {
    readonly routes: readonly UrlMatcher[];
    readonly outgoing: readonly UrlMatcher[];
  };
  readonly http: {
    readonly requestHeaders: readonly string[];
    readonly responseHeaders: readonly string[];
    readonly redactQueryKeys: readonly string[];
  };
  readonly redact: RedactHook | undefined;
  /** Raw `OTEL_RESOURCE_ATTRIBUTES`; parsed by the telemetry setup (SDK 3 does not read it). */
  readonly otelResourceAttributes: string | undefined;
  /** The dashboard's static mode (P2-05). Runtime conditions (HTTP adapter, `@nestrix/ui`) are P2-06's. */
  readonly ui: ResolvedUi;
  /** Store limits, defaults applied. Meaningful only while the dashboard is on. */
  readonly store: Readonly<Required<NestrixStoreOptions>>;
  /** Log export. `otlp.url` is the full logs URL, `/v1/logs` already applied. */
  readonly logs: {
    readonly export: boolean;
    readonly otlp: ResolvedOtlp | false;
  };
}

/**
 * Resolved dashboard authentication. A configured token is kept only as digests: the plain token
 * is not in `ResolvedOptions`, so dumping the options (they are injectable) does not reveal it.
 */
export type ResolvedUiAuth =
  | ({ readonly kind: "token" } & SecretDigests)
  | {
      readonly kind: "custom";
      /** The user's function, called with `thisArg` as `this`. */
      readonly authorize: (request: unknown) => unknown;
      readonly thisArg: unknown;
    };

/** Why the dashboard is off before any request arrives. */
export type UiOffReason =
  /** `ui: false` or `ui.enabled: false`. */
  | "disabled"
  /** `'auto'` and `NODE_ENV` set to anything but `development`. */
  | "node-env"
  /** `ui.enabled: true` without `ui.auth`. */
  | "missing-auth"
  /** A `ui` value of the wrong shape: path, auth, token length, `enabled`, `startupToken`. */
  | "invalid";

export interface ResolvedUiOff {
  readonly mode: "off";
  readonly reason: UiOffReason;
  /** `error` for `missing-auth` and `invalid`, `info` otherwise. P2-06 logs `message` at this level. */
  readonly severity: "info" | "error";
  /** The log line. Never contains a token. */
  readonly message: string;
}

export interface ResolvedUiAuto {
  readonly mode: "auto";
  /** Validated: starts with `/`, no trailing slash, only `A-Z a-z 0-9 . _ ~ / -`, no empty or dot segment. */
  readonly path: string;
  /** Whether requests also need the startup-token cookie (default `true`; `false` is the D-46 opt-out). */
  readonly startupToken: boolean;
  /** Checked in addition to the local-only rules, when given. */
  readonly auth: ResolvedUiAuth | undefined;
}

export interface ResolvedUiEnabled {
  readonly mode: "enabled";
  readonly path: string;
  /** Always present: `enabled: true` without `auth` resolves to off. */
  readonly auth: ResolvedUiAuth;
}

/** The dashboard mode as far as options and `NODE_ENV` decide it (backlog P2, "Mode resolution"). */
export type ResolvedUi = ResolvedUiOff | ResolvedUiAuto | ResolvedUiEnabled;

export type Environment = Readonly<Record<string, string | undefined>>;

export const DEFAULT_QUEUE: Required<NestrixQueueOptions> = {
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 5000,
};
/**
 * Store limits, set from measurement (P2-12): see `store/limits.ts` for the reasoning and keep
 * the two in step (`test/dashboard-options.test.ts` checks it).
 */
export const DEFAULT_STORE: Readonly<Required<NestrixStoreOptions>> =
  Object.freeze({
    maxTraces: 5000,
    maxBytes: 32 * 1024 * 1024,
  });
export const DEFAULT_UI_PATH = "/_nestrix";
/** Shortest `ui.auth.token` accepted (architecture §4.7, backlog P2-05). */
export const MIN_UI_TOKEN_LENGTH = 32;
const DEFAULT_TIMEOUT_MILLIS = 10_000;
const TRACES_PATH = "/v1/traces";
const LOGS_PATH = "/v1/logs";

/** Whether `NESTRIX_ENABLED` switches Nestrix off. `false` and `0`, any case, do. */
export function isDisabledByEnv(env: Environment): boolean {
  const value = env.NESTRIX_ENABLED?.trim().toLowerCase();
  return value === "false" || value === "0";
}

function invalid(message: string): never {
  throw new Error(`Invalid Nestrix options: ${message}`);
}

function blank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function checkPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    invalid(`${name} must be a positive integer, got ${String(value)}`);
  }
}

/** `key=value,key2=value2`, values percent-decoded, as `OTEL_EXPORTER_OTLP_HEADERS`. Bad pairs are skipped. */
function parseHeaderList(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const pair of value.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    if (!key) continue;
    const raw = pair.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

function withSignalPath(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** The OTLP destination of one signal: the option, then the signal's variable (as given), then the generic one. */
function resolveOtlp(
  options: NestrixModuleOptions,
  env: Environment,
  signal: "traces" | "logs" = "traces",
): ResolvedOtlp | false {
  const otlp = options.export?.otlp;
  if (otlp === false) return false;

  const path = signal === "logs" ? LOGS_PATH : TRACES_PATH;
  const optionEndpoint = blank(otlp?.endpoint);
  const signalEnv = blank(
    signal === "logs"
      ? env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
      : env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  );
  const genericEnv = blank(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  let url: string;
  if (optionEndpoint) url = withSignalPath(optionEndpoint, path);
  else if (signalEnv) url = signalEnv;
  else if (genericEnv) url = withSignalPath(genericEnv, path);
  else return false;

  const timeoutMillis = otlp?.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS;
  checkPositiveInteger("export.otlp.timeoutMillis", timeoutMillis);

  // Signal-specific variable wins over the generic one, key by key; options win over both.
  const headers = {
    ...parseHeaderList(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseHeaderList(
      signal === "logs"
        ? env.OTEL_EXPORTER_OTLP_LOGS_HEADERS
        : env.OTEL_EXPORTER_OTLP_TRACES_HEADERS,
    ),
    ...otlp?.headers,
  };
  return Object.freeze({
    url,
    headers: Object.freeze(headers),
    timeoutMillis,
  });
}

const PATH_CHARACTERS = /^[A-Za-z0-9._~/-]+$/;

/** The validated path, or an error message. */
function resolveUiPath(path: unknown): { path: string } | { error: string } {
  if (path === undefined) return { path: DEFAULT_UI_PATH };
  if (typeof path !== "string") return { error: "ui.path must be a string" };
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  if (!trimmed.startsWith("/")) return { error: "ui.path must start with /" };
  if (!PATH_CHARACTERS.test(trimmed)) {
    return {
      error: "ui.path may contain only A-Z a-z 0-9 . _ ~ / - characters",
    };
  }
  // `/` alone would put the dashboard over the whole app; `//x` would make the redirect after the
  // token exchange protocol-relative (`Location: //x/`); `.` and `..` segments are rewritten by
  // browsers, so routes and the cookie's Path would never match what the browser requests.
  const segments = trimmed.slice(1).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return {
      error: "ui.path must not be /, or contain an empty, . or .. segment",
    };
  }
  return { path: trimmed };
}

function resolveUiAuth(
  auth: unknown,
): { auth: ResolvedUiAuth | undefined } | { error: string } {
  if (auth === undefined) return { auth: undefined };
  if (auth === null || typeof auth !== "object") {
    return { error: "ui.auth must be { token } or { authorize(request) }" };
  }
  const { token, authorize } = auth as {
    token?: unknown;
    authorize?: unknown;
  };
  if (token !== undefined && authorize !== undefined) {
    return { error: "ui.auth must have token or authorize, not both" };
  }
  if (token !== undefined) {
    if (typeof token !== "string" || token.length < MIN_UI_TOKEN_LENGTH) {
      return {
        error: `ui.auth.token must be a string of at least ${MIN_UI_TOKEN_LENGTH} characters`,
      };
    }
    return {
      auth: Object.freeze({ kind: "token", ...secretDigests("token", token) }),
    };
  }
  if (authorize !== undefined) {
    if (typeof authorize !== "function") {
      return { error: "ui.auth.authorize must be a function" };
    }
    return {
      auth: Object.freeze({
        kind: "custom",
        authorize: authorize as (request: unknown) => unknown,
        thisArg: auth,
      }),
    };
  }
  return { error: "ui.auth must be { token } or { authorize(request) }" };
}

function uiOff(
  reason: UiOffReason,
  severity: "info" | "error",
  message: string,
): ResolvedUiOff {
  return Object.freeze({ mode: "off", reason, severity, message });
}

function uiInvalid(error: string): ResolvedUiOff {
  return uiOff(
    "invalid",
    "error",
    `Nestrix dashboard: off. Invalid option: ${error}. The application starts without the dashboard.`,
  );
}

/**
 * The static half of the mode table. Never throws: a bad `ui` value turns the dashboard off with
 * an error to log, and the application starts (architecture §4.7). `NODE_ENV` comes from `env`,
 * the same object the module factory passes for every other variable.
 */
export function resolveUi(ui: unknown, env: Environment): ResolvedUi {
  try {
    return resolveUiUnguarded(ui, env);
  } catch {
    // A throwing getter or proxy on the option. The message names no option value.
    return uiInvalid("ui could not be read");
  }
}

function resolveUiUnguarded(ui: unknown, env: Environment): ResolvedUi {
  if (ui === false) {
    return uiOff("disabled", "info", "Nestrix dashboard: off (ui: false).");
  }
  let o: {
    enabled?: unknown;
    path?: unknown;
    auth?: unknown;
    startupToken?: unknown;
  };
  if (ui === undefined || ui === "auto") o = {};
  else if (ui !== null && typeof ui === "object") o = ui;
  else return uiInvalid("ui must be false, 'auto' or an object");

  const enabled = o.enabled === undefined ? "auto" : o.enabled;
  if (enabled === false) {
    return uiOff(
      "disabled",
      "info",
      "Nestrix dashboard: off (ui.enabled: false).",
    );
  }
  if (enabled !== true && enabled !== "auto") {
    return uiInvalid("ui.enabled must be true, false or 'auto'");
  }

  const path = resolveUiPath(o.path);
  if ("error" in path) return uiInvalid(path.error);
  const auth = resolveUiAuth(o.auth);
  if ("error" in auth) return uiInvalid(auth.error);
  const startupToken = o.startupToken === undefined ? true : o.startupToken;
  if (typeof startupToken !== "boolean") {
    return uiInvalid("ui.startupToken must be a boolean");
  }

  if (enabled === true) {
    if (!auth.auth) {
      return uiOff(
        "missing-auth",
        "error",
        "Nestrix dashboard: off. ui.enabled is true but ui.auth is missing; set ui.auth to { token } (at least 32 characters) or { authorize(request) }. The application starts without the dashboard.",
      );
    }
    return Object.freeze({ mode: "enabled", path: path.path, auth: auth.auth });
  }

  // 'auto': only `development` or unset. An empty string is set, and is not `development`.
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv !== undefined && nodeEnv !== "development") {
    return uiOff(
      "node-env",
      "info",
      `Nestrix dashboard: off, because NODE_ENV is ${JSON.stringify(nodeEnv)} and ui is 'auto', which serves it only when NODE_ENV is development or unset. ui: { enabled: true, auth } serves it in any environment.`,
    );
  }
  return Object.freeze({
    mode: "auto",
    path: path.path,
    startupToken,
    auth: auth.auth,
  });
}

const MAX_SERVICE_VERSION = 255;

/**
 * `service.version` (D-63), first set value wins: the `serviceVersion` option, then
 * `resourceAttributes['service.version']` (also explicit), then `service.version` in
 * `OTEL_RESOURCE_ATTRIBUTES`, then `GIT_SHA`, then `npm_package_version`. Blank values are
 * skipped. Throws when `serviceVersion` is given and is not a string.
 * Longer than 255 characters throws, the dashboard's `release` filter limit.
 */
export function resolveServiceVersion(
  options: Pick<NestrixModuleOptions, "serviceVersion" | "resourceAttributes">,
  env: Environment,
): string | undefined {
  const option: unknown = options.serviceVersion;
  if (option !== undefined && typeof option !== "string") {
    invalid(`serviceVersion must be a string, got ${typeof option}`);
  }
  if (typeof option === "string" && option.length > MAX_SERVICE_VERSION) {
    invalid(
      `serviceVersion must be at most ${MAX_SERVICE_VERSION} characters, got ${option.length}`,
    );
  }
  const fromAttributes = options.resourceAttributes?.["service.version"];
  return (
    blank(option as string | undefined) ??
    (typeof fromAttributes === "string" ||
    typeof fromAttributes === "number" ||
    typeof fromAttributes === "boolean"
      ? blank(String(fromAttributes))
      : undefined) ??
    blank(
      parseResourceAttributesEnv(env.OTEL_RESOURCE_ATTRIBUTES)?.[
        "service.version"
      ],
    ) ??
    blank(env.GIT_SHA) ??
    blank(env.npm_package_version)
  );
}

/** The `user` option: a function or absent. Throws on anything else. */
export function resolveUser(user: unknown): NestrixUserFunction | undefined {
  if (user === undefined) return undefined;
  if (typeof user !== "function") {
    invalid(`user must be a function, got ${typeof user}`);
  }
  return user as NestrixUserFunction;
}

/**
 * Pure: options and an environment object in, fully defaulted and frozen options out.
 * Throws on invalid options; that is a startup error, not a request-path failure.
 * `NESTRIX_ENABLED=false` in `env` overrides `enabled: true` (a kill switch).
 */
export function resolveOptions(
  options: NestrixModuleOptions | undefined,
  env: Environment,
): ResolvedOptions {
  const o = options ?? {};

  const sampleRate = o.sampleRate ?? 1;
  if (
    typeof sampleRate !== "number" ||
    Number.isNaN(sampleRate) ||
    sampleRate < 0 ||
    sampleRate > 1
  ) {
    invalid(`sampleRate must be between 0 and 1, got ${String(sampleRate)}`);
  }

  const queue = { ...DEFAULT_QUEUE, ...o.export?.queue };
  checkPositiveInteger("export.queue.maxQueueSize", queue.maxQueueSize);
  checkPositiveInteger(
    "export.queue.maxExportBatchSize",
    queue.maxExportBatchSize,
  );
  checkPositiveInteger(
    "export.queue.scheduledDelayMillis",
    queue.scheduledDelayMillis,
  );
  if (queue.maxExportBatchSize > queue.maxQueueSize) {
    invalid(
      `export.queue.maxExportBatchSize (${queue.maxExportBatchSize}) must not exceed export.queue.maxQueueSize (${queue.maxQueueSize})`,
    );
  }

  const store = {
    maxTraces: o.store?.maxTraces ?? DEFAULT_STORE.maxTraces,
    maxBytes: o.store?.maxBytes ?? DEFAULT_STORE.maxBytes,
  };
  checkPositiveInteger("store.maxTraces", store.maxTraces);
  checkPositiveInteger("store.maxBytes", store.maxBytes);

  const enabled = o.enabled !== false && !isDisabledByEnv(env);

  const resolved: ResolvedOptions = {
    enabled,
    serviceName: blank(o.serviceName) ?? blank(env.OTEL_SERVICE_NAME),
    serviceVersion: resolveServiceVersion(o, env),
    user: resolveUser(o.user),
    resourceAttributes: Object.freeze({ ...o.resourceAttributes }),
    sampleRate,
    export: Object.freeze({
      otlp: resolveOtlp(o, env),
      queue: Object.freeze(queue),
    }),
    ignore: Object.freeze({
      routes: Object.freeze([...(o.ignore?.routes ?? [])]),
      outgoing: Object.freeze([...(o.ignore?.outgoing ?? [])]),
    }),
    http: Object.freeze({
      requestHeaders: Object.freeze([...(o.http?.requestHeaders ?? [])]),
      responseHeaders: Object.freeze([...(o.http?.responseHeaders ?? [])]),
      redactQueryKeys: Object.freeze([...(o.http?.redactQueryKeys ?? [])]),
    }),
    redact: o.redact,
    otelResourceAttributes: blank(env.OTEL_RESOURCE_ATTRIBUTES),
    ui: resolveUi(o.ui, env),
    store: Object.freeze(store),
    logs: Object.freeze({
      export: o.logs?.export === true,
      otlp: o.logs?.export === true ? resolveOtlp(o, env, "logs") : false,
    }),
  };
  return Object.freeze(resolved);
}
